/**
 * dsh-external-guard · 探测与启停引擎
 *
 * 全部 Windows 原生实现，不依赖任何第三方包：
 *   - 端口探测：net.connect 试连（比读 netstat 快且不会被防火墙表误导）
 *   - HTTP 探测：原生 fetch + AbortSignal 超时
 *   - 进程枚举：走 `tasklist /FO CSV`（唯一稳定拿到 pid+镜像名的方式）
 *   - 停止：`taskkill /PID <pid> /T /F`，先按端口反查 pid
 *   - 启动：child_process.spawn 带 detached + windowsHide + stdio 落盘
 *
 * 所有子进程调用都带超时，失败只返回结构化错误，绝不抛到宿主。
 */

import { spawn, execFile } from 'node:child_process'
import net from 'node:net'
import { existsSync, mkdirSync, openSync, closeSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const IS_WIN = process.platform === 'win32'

/* ------------------------------------------------------------------ 基础工具 */

function run(cmd, args, timeoutMs = 4000) {
  return new Promise((resolve) => {
    let done = false
    const finish = (payload) => {
      if (done) return
      done = true
      resolve(payload)
    }
    let child
    try {
      child = execFile(
        cmd,
        args,
        { windowsHide: true, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 },
        (error, stdout, stderr) => {
          finish({
            ok: !error,
            code: error && typeof error.code === 'number' ? error.code : 0,
            stdout: String(stdout ?? ''),
            stderr: String(stderr ?? ''),
            error: error ? String(error.message ?? error) : null,
          })
        },
      )
    } catch (error) {
      finish({ ok: false, code: -1, stdout: '', stderr: '', error: String(error?.message ?? error) })
      return
    }
    child.on('error', (error) => finish({ ok: false, code: -1, stdout: '', stderr: '', error: String(error?.message ?? error) }))
  })
}

/** TCP 试连：连上即认为端口在监听。 */
export function probePort(port, host = '127.0.0.1', timeoutMs = 1200) {
  return new Promise((resolve) => {
    const socket = new net.Socket()
    let settled = false
    const finish = (open) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(open)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(false))
    socket.once('error', () => finish(false))
    try {
      socket.connect(port, host)
    } catch {
      finish(false)
    }
  })
}

/** HTTP 探测：2xx/3xx 视为健康。 */
export async function probeHttp(url, timeoutMs = 1200) {
  if (typeof fetch !== 'function') return false
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, { signal: controller.signal, redirect: 'manual' })
    return res.status >= 200 && res.status < 400
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 枚举进程：返回 [{ pid, name }]。
 * tasklist 输出是 CSV，镜像名可能带引号，按行解析。
 */
export async function listProcesses() {
  if (!IS_WIN) return []
  const result = await run('tasklist', ['/FO', 'CSV', '/NH'])
  if (!result.ok) return []
  const out = []
  for (const line of result.stdout.split(/\r?\n/)) {
    if (!line.trim()) continue
    // "name","pid","session","sess#","mem"
    const cells = []
    let cur = ''
    let inQuotes = false
    for (const ch of line) {
      if (ch === '"') {
        inQuotes = !inQuotes
        continue
      }
      if (ch === ',' && !inQuotes) {
        cells.push(cur)
        cur = ''
        continue
      }
      cur += ch
    }
    cells.push(cur)
    if (cells.length < 2) continue
    const pid = Number.parseInt(cells[1], 10)
    if (!Number.isFinite(pid)) continue
    out.push({ pid, name: cells[0] })
  }
  return out
}

/** 按端口反查占用它的 pid（netstat -ano）。 */
export async function pidsOnPorts(ports) {
  if (!IS_WIN) return []
  if (ports.length === 0) return []
  const result = await run('netstat', ['-ano', '-p', 'TCP'])
  if (!result.ok && result.stdout === '') return []
  const wanted = new Set(ports)
  const pids = new Set()
  for (const line of result.stdout.split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/)
    // Proto  Local Address  Foreign Address  State  PID
    if (cols.length < 5) continue
    if (cols[0].toUpperCase() !== 'TCP') continue
    const local = cols[1]
    const state = cols[3]
    if (state.toUpperCase() !== 'LISTENING') continue
    const port = Number.parseInt(local.slice(local.lastIndexOf(':') + 1), 10)
    if (!wanted.has(port)) continue
    const pid = Number.parseInt(cols[4], 10)
    if (Number.isFinite(pid) && pid > 0) pids.add(pid)
  }
  return [...pids]
}

/** 杀一棵进程树。 */
export async function killPid(pid) {
  const result = await run('taskkill', ['/PID', String(pid), '/T', '/F'], 6000)
  return { pid, ok: result.ok, detail: (result.stdout || result.stderr || '').trim() }
}

/* ------------------------------------------------------------------ 单条目探测 */

/**
 * 探测一个条目。probes 全部满足才 healthy。
 * 返回 { id, healthy, checks: [{kind, target, ok}], pids }
 */
export async function probeEntry(entry, timeoutMs = 1200) {
  const checks = []
  for (const probe of entry.probes) {
    if (probe.kind === 'port') {
      const ok = await probePort(probe.port, '127.0.0.1', timeoutMs)
      checks.push({ kind: 'port', target: String(probe.port), ok })
    } else if (probe.kind === 'http') {
      const ok = await probeHttp(probe.url, timeoutMs)
      checks.push({ kind: 'http', target: probe.url, ok })
    } else if (probe.kind === 'process') {
      const procs = await listProcesses()
      const hits = procs.filter((p) => p.name.toLowerCase() === String(probe.name).toLowerCase())
      checks.push({ kind: 'process', target: probe.name, ok: hits.length > 0 })
    } else {
      checks.push({ kind: String(probe.kind), target: '?', ok: false })
    }
  }
  const healthy = checks.length > 0 && checks.every((c) => c.ok)
  const pids = entry.stopBy === 'ports' ? await pidsOnPorts(entry.stopPorts ?? []) : []
  return { id: entry.id, healthy, checks, pids }
}

/* ------------------------------------------------------------------ 启动 */

/**
 * 以隐藏窗口方式启动一个条目。
 *
 * Windows 上让 node 子进程彻底无控制台窗口的关键三件套：
 *   detached: true       —— 不挂在调用者的控制台上
 *   windowsHide: true    —— 不要给子进程分配/显示控制台窗口
 *   stdio: 落盘文件       —— 避免 'pipe'（父进程退出后管道断裂会让子进程 EPIPE）
 *
 * 日志写到 %TEMP%\<id>-out.log / -err.log，面板里可以点开看。
 */
export function logPaths(id) {
  return {
    out: join(tmpdir(), `${id}-out.log`),
    err: join(tmpdir(), `${id}-err.log`),
  }
}

export function startEntry(entry) {
  if (!entry.start) {
    return { ok: false, error: '该条目没有配置启动命令' }
  }
  const { exec, args = [], cwd, env } = entry.start
  if (!existsSync(exec)) {
    return { ok: false, error: `可执行文件不存在：${exec}` }
  }
  const logs = logPaths(entry.id)
  try {
    mkdirSync(tmpdir(), { recursive: true })
  } catch {
    /* tmpdir 一定存在 */
  }
  let outFd
  let errFd
  try {
    outFd = openSync(logs.out, 'a')
    errFd = openSync(logs.err, 'a')
  } catch (error) {
    return { ok: false, error: `日志文件打不开：${String(error?.message ?? error)}` }
  }
  try {
    const child = spawn(exec, args, {
      cwd: cwd && existsSync(cwd) ? cwd : undefined,
      detached: true,
      windowsHide: true,
      stdio: ['ignore', outFd, errFd],
      env: { ...process.env, ...(env ?? {}) },
    })
    // 无效可执行文件等错误会异步发出 error，必须接住，不能让宿主崩溃。
    return new Promise((resolve) => {
      child.once('error', (error) => resolve({ ok: false, error: String(error?.message ?? error) }))
      child.once('spawn', () => {
        child.unref()
        resolve({ ok: true, pid: child.pid, logs })
      })
    })
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) }
  } finally {
    // 子进程已继承这两个 fd，父侧可以关掉自己的句柄
    try {
      closeSync(outFd)
    } catch {
      /* ignore */
    }
    try {
      closeSync(errFd)
    } catch {
      /* ignore */
    }
  }
}

/* ------------------------------------------------------------------ 停止 */

/**
 * 停止一个条目。
 * 优先按端口反查 pid（最准，能定位到真正监听的那个进程），
 * 其次按镜像名兜底（Ollama 这种有 GUI 壳 + 服务两个进程的）。
 */
export async function stopEntry(entry) {
  const killed = []
  const failed = []

  if (entry.stopBy === 'ports') {
    const pids = await pidsOnPorts(entry.stopPorts ?? [])
    for (const pid of pids) {
      const res = await killPid(pid)
      ;(res.ok ? killed : failed).push({ pid, detail: res.detail })
    }
  }

  const names = entry.stopNames ?? []
  if (names.length > 0) {
    for (const name of names) {
      const result = await run('taskkill', ['/IM', name, '/T', '/F'], 6000)
      // taskkill 在没有匹配进程时返回非 0，这不算失败
      const notFound = /not found|没有运行|找不到/i.test(result.stdout + result.stderr)
      if (result.ok) killed.push({ name, detail: (result.stdout || '').trim() })
      else if (!notFound) failed.push({ name, detail: (result.stderr || result.stdout || '').trim() })
    }
  }

  // 停完复核：端口应该都释放了
  const still = entry.stopBy === 'ports' ? await pidsOnPorts(entry.stopPorts ?? []) : []
  return { killed, failed, stillListening: still }
}

/* ------------------------------------------------------------------ 汇总 */

/** 并发探测所有条目（并发上限 4，避免瞬间拉起大量 netstat/tasklist）。 */
export async function probeAll(entries, timeoutMs = 1200) {
  const results = []
  const queue = [...entries]
  const workers = []
  const worker = async () => {
    for (;;) {
      const next = queue.shift()
      if (next === undefined) return
      let row
      try {
        row = await probeEntry(next, timeoutMs)
      } catch (error) {
        row = { id: next.id, healthy: false, checks: [], pids: [], error: String(error?.message ?? error) }
      }
      results.push(row)
    }
  }
  for (let i = 0; i < Math.min(4, entries.length); i++) workers.push(worker())
  await Promise.all(workers)
  // 按 ENTRIES 顺序还原
  const order = new Map(entries.map((e, i) => [e.id, i]))
  results.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))
  return results
}
