/**
 * dsh-external-guard · 宿主侧入口
 *
 * 只做两件事：
 *   1. 注册 4 个本机回环 HTTP 路由给客户端面板用
 *   2. 可选的后台巡检（只观察，不自动拉起 —— 自动拉起是有副作用的，
 *      必须由人点按钮或模型按明确指令执行）
 *
 * 注意：本模块**不注册任何模型工具**。早先的注释写「暴露同名工具」，
 * 与代码不符，已于 0.2.0 更正。查状态/启停目前只有上面这 4 条 HTTP 路由。
 *
 * 安全边界：
 *   - 只监听回环请求（socket remoteAddress + Host 头 + Origin 三项校验）
 *   - 不出网：本模块不发起任何外部网络请求
 *   - 启停操作全部走 taskkill / spawn，不接受任意命令字符串
 *     （start 命令只能来自内置清单或本地受信 config.entries，HTTP 侧只传 id）
 */

import { entriesWithAvailability, resolveLogSources, createEffectiveEntries } from './manifest.js'
import {
  probeAll,
  startEntry,
  stopEntry,
  logPaths,
  pidsOnPorts,
} from './supervisor.js'
import { readFileSync, existsSync, statSync } from 'node:fs'

export const name = 'dsh-external-guard'

const ROUTE_PREFIX = '/dsh-external-guard'

/* ---------------------------------------------------------------- HTTP 工具 */

function sendJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  })
  res.end(payload)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (chunk) => {
      data += chunk
      if (data.length > 1e5) req.destroy()
    })
    req.on('end', () => resolve(data))
    req.on('error', reject)
    req.on('aborted', () => reject(new Error('aborted')))
  })
}

function isLoopback(address) {
  if (typeof address !== 'string') return false
  const a = address.replace(/^::ffff:/, '')
  return a === '127.0.0.1' || a === '::1' || a === 'localhost'
}

function isLocalHostHeader(host) {
  if (typeof host !== 'string' || host === '') return false
  const hostname = host.startsWith('[') ? host.slice(1, host.indexOf(']')) : host.split(':')[0]
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1'
}

/** 本机回环 + Host + Origin 三重校验。这是「能杀进程」的接口，必须收紧。 */
function guard(req, res) {
  if (!isLoopback(req.socket && req.socket.remoteAddress)) {
    sendJson(res, 403, { ok: false, error: 'loopback only' })
    return false
  }
  const host = req.headers.host
  if (!isLocalHostHeader(host)) {
    sendJson(res, 403, { ok: false, error: 'unexpected host' })
    return false
  }
  const origin = req.headers.origin
  if (typeof origin === 'string' && origin.length > 0) {
    let originHost = null
    try {
      originHost = new URL(origin).host
    } catch {
      originHost = null
    }
    if (originHost !== host) {
      sendJson(res, 403, { ok: false, error: 'cross-origin request' })
      return false
    }
  }
  return true
}

/* ---------------------------------------------------------------- 状态快照 */

async function buildStatus(config, timeoutMs, entries, configurationErrors) {
  const meta = entriesWithAvailability(entries)
  const byId = new Map(entries.map((e) => [e.id, e]))
  const probes = await probeAll(
    meta.filter((m) => m.available).map((m) => byId.get(m.id)),
    timeoutMs,
  )
  const probeById = new Map(probes.map((p) => [p.id, p]))
  const items = meta.map((m) => {
    const probe = probeById.get(m.id)
    const entry = byId.get(m.id)
    return {
      id: m.id,
      title: m.title,
      note: m.note,
      available: m.available,
      missing: m.missing,
      canStart: m.canStart,
      dependsOn: m.dependsOn,
      healthy: probe ? probe.healthy : false,
      checks: probe ? probe.checks : [],
      pids: probe ? probe.pids : [],
      stopPorts: entry?.stopBy === 'ports' ? (entry.stopPorts ?? []) : [],
      logs: logPaths(m.id),
    }
  })
  return {
    ok: true,
    at: Date.now(),
    writesEnabled: config.writesEnabled !== false,
    monitorOnly: config.monitorOnly !== false,
    items,
    configurationErrors,
  }
}

function readLogTail(id, entries, maxBytes = 8000) {
  const logs = logPaths(id)
  const readOne = (p, label) => {
    if (!existsSync(p)) return { path: p, label, exists: false, text: '' }
    try {
      const size = statSync(p).size
      const start = Math.max(0, size - maxBytes)
      const buf = readFileSync(p)
      return { path: p, label, exists: true, size, text: buf.subarray(start).toString('utf8') }
    } catch (error) {
      return { path: p, label, exists: true, text: `读取失败：${String(error?.message ?? error)}` }
    }
  }
  /**
   * 两路日志：
   *  - out/err：只有「本插件亲手启动」时才有的 stdout/stderr（%TEMP%\<id>-out.log）
   *  - sources：进程自己写的日志（SnowLuma 的按天滚动日志、surfcore 的 bridge.log 等）。
   *    这些进程多半是 surfcore 保活或用户手动拉起的，本插件拿不到它们的 stdout，
   *    所以「日志读不到」的修复就是这一路。来源见 manifest.js 的 logSources。
   */
  const sources = resolveLogSources(id, 2, entries).map((s) => readOne(s.path, s.label))
  return { out: readOne(logs.out, '插件启动的 stdout'), err: readOne(logs.err, '插件启动的 stderr'), sources }
}

/* ---------------------------------------------------------------- 插件入口 */

export function apply(ctx, config = {}) {
  const { entries, errors: configurationErrors } = createEffectiveEntries(config.entries)
  const settings = {
    pollIntervalMs: Number.isFinite(config.pollIntervalMs) ? config.pollIntervalMs : 15000,
    probeTimeoutMs: Number.isFinite(config.probeTimeoutMs) ? config.probeTimeoutMs : 1200,
    writesEnabled: config.writesEnabled !== false,
    /**
     * 只监测模式（monitorOnly）。
     *
     * 为什么默认开启：surfcore 插件已经有一个 maybeStartQqChain() 每 120 秒
     * 检查 SnowLuma / Ollama 端口并按需拉起（带 windowsHide，不弹窗）。
     * 本插件再提供「启动」按钮就是第二套拉起机制，两者会互相打架：
     * 用户在这里点停止，2 分钟内又被 surfcore 拉回来，看起来像按钮失灵。
     *
     * 所以默认退化为纯看板：只报状态、不提供启停。
     * 需要手动控制时把 monitorOnly 设成 false。
     */
    monitorOnly: config.monitorOnly !== false,
  }

  // 工具层/测试入口也只能按 id 读取本实例清单，不接收外部 entry/exec。
  const writableEntry = (id) => {
    if (settings.monitorOnly || !settings.writesEnabled) throw new Error('当前禁止启停')
    const entry = entries.find((item) => item.id === id)
    if (!entry) throw new Error('未知条目或配置无效')
    return entry
  }
  const startById = (id) => {
    const entry = writableEntry(id)
    const meta = entriesWithAvailability([entry])[0]
    if (!meta.available) return { ok: false, error: '启动路径缺失或类型不符', missing: meta.missing }
    return startEntry(entry)
  }
  const stopById = (id) => stopEntry(writableEntry(id))

  /**
   * cordis 的 fiber.effect 负责在插件卸载时自动注销路由。
   * 少数环境（或测试桩）拿不到 effect，此时退化为直接注册 ——
   * 路由仍可用，只是不会随插件卸载而回收。注册失败不抛，
   * 让其余路由照常工作。
   */
  const register = (fiber, spec) => {
    try {
      if (fiber && typeof fiber.effect === 'function') {
        return fiber.effect(() => spec.register())
      }
    } catch {
      /* fall through to direct registration */
    }
    try {
      spec.register()
    } catch {
      /* ignore */
    }
    return undefined
  }

  const registerRoutes = (webServer, fiber) => {
    const mount = (spec) => register(fiber, { register: () => webServer.register(spec) })

    // --- 状态（只读）---
    mount({
        kind: 'exact',
        path: `${ROUTE_PREFIX}/status`,
        handler: async (req, res) => {
          if (!guard(req, res)) return
          try {
            const status = await buildStatus(settings, settings.probeTimeoutMs, entries, configurationErrors)
            sendJson(res, 200, status)
          } catch (error) {
            sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
          }
        },
      })

    // --- 启动 ---
    mount({
        kind: 'exact',
        path: `${ROUTE_PREFIX}/start`,
        handler: async (req, res) => {
          if (!guard(req, res)) return
          if (req.method !== 'POST') {
            sendJson(res, 405, { ok: false, error: 'POST only' })
            return
          }
          if (!settings.writesEnabled) {
            sendJson(res, 403, { ok: false, error: '写操作已关闭（config.writesEnabled=false）' })
            return
          }
          if (settings.monitorOnly) {
            sendJson(res, 403, {
              ok: false,
              code: 'monitor-only',
              error: '当前是只监测模式（config.monitorOnly=true）。SnowLuma/Ollama 由 surfcore 每 2 分钟自动保活，手动启停会与它打架；如需手动控制，把 cordis.patch.yml 里的 monitorOnly 设为 false 并重启宿主。',
            })
            return
          }
          let body = {}
          try {
            const raw = await readBody(req)
            if (raw) body = JSON.parse(raw)
          } catch {
            sendJson(res, 400, { ok: false, error: 'malformed JSON body' })
            return
          }
          const id = typeof body?.id === 'string' ? body.id.trim() : ''
          const entry = entries.find((e) => e.id === id)
          if (!entry) {
            sendJson(res, 404, { ok: false, error: `未知条目：${id}` })
            return
          }
          try {
            const result = await startById(id)
            sendJson(res, result.ok ? 200 : 500, { ok: result.ok, id, ...result })
          } catch (error) {
            sendJson(res, 500, { ok: false, id, error: String(error?.message ?? error) })
          }
        },
      })

    // --- 停止 ---
    mount({
        kind: 'exact',
        path: `${ROUTE_PREFIX}/stop`,
        handler: async (req, res) => {
          if (!guard(req, res)) return
          if (req.method !== 'POST') {
            sendJson(res, 405, { ok: false, error: 'POST only' })
            return
          }
          if (!settings.writesEnabled) {
            sendJson(res, 403, { ok: false, error: '写操作已关闭（config.writesEnabled=false）' })
            return
          }
          if (settings.monitorOnly) {
            sendJson(res, 403, {
              ok: false,
              code: 'monitor-only',
              error: '当前是只监测模式（config.monitorOnly=true）。停止后 surfcore 会在 2 分钟内把进程拉回来，所以这里不提供停止；如需手动控制，把 monitorOnly 设为 false 并重启宿主。',
            })
            return
          }
          let body = {}
          try {
            const raw = await readBody(req)
            if (raw) body = JSON.parse(raw)
          } catch {
            sendJson(res, 400, { ok: false, error: 'malformed JSON body' })
            return
          }
          const id = typeof body?.id === 'string' ? body.id.trim() : ''
          const entry = entries.find((e) => e.id === id)
          if (!entry) {
            sendJson(res, 404, { ok: false, error: `未知条目：${id}` })
            return
          }
          try {
            const result = await stopById(id)
            sendJson(res, 200, { ok: true, id, ...result })
          } catch (error) {
            sendJson(res, 500, { ok: false, id, error: String(error?.message ?? error) })
          }
        },
      })

    // --- 日志尾部（只读）---
    mount({
        kind: 'exact',
        path: `${ROUTE_PREFIX}/logs`,
        handler: async (req, res) => {
          if (!guard(req, res)) return
          let id = ''
          try {
            const url = new URL(req.url ?? '/', 'http://127.0.0.1')
            id = (url.searchParams.get('id') ?? '').trim()
          } catch {
            id = ''
          }
          if (id === '') {
            sendJson(res, 400, { ok: false, error: 'id required' })
            return
          }
          if (!entries.some((e) => e.id === id)) {
            sendJson(res, 404, { ok: false, error: `未知条目：${id}` })
            return
          }
          try {
            sendJson(res, 200, { ok: true, id, ...readLogTail(id, entries) })
          } catch (error) {
            sendJson(res, 500, { ok: false, id, error: String(error?.message ?? error) })
          }
        },
      })
  }

  const webServer = ctx.get('webServer')
  if (webServer) {
    registerRoutes(webServer, ctx)
  } else {
    ctx.inject(['webServer'], (sub) => registerRoutes(sub.webServer, sub))
  }

  // 可选后台巡检：只在内存里记状态，日志降噪；不做自动拉起。
  if (settings.pollIntervalMs > 0) {
    let lastSignature = ''
    const tick = async () => {
      try {
        const status = await buildStatus(settings, settings.probeTimeoutMs, entries, configurationErrors)
        const signature = status.items.map((i) => `${i.id}:${i.healthy ? 1 : 0}`).join(',')
        if (signature !== lastSignature) {
          lastSignature = signature
          const down = status.items.filter((i) => i.available && !i.healthy).map((i) => i.title)
          if (down.length > 0) {
            try {
              console.warn(`[process-guard] 检出未运行：${down.join(' / ')}（不会自动拉起，请在面板里点启动）`)
            } catch {
              /* ignore */
            }
          }
        }
      } catch {
        /* 巡检失败静默，不影响宿主 */
      }
    }
    const timer = setInterval(tick, settings.pollIntervalMs)
    if (typeof timer.unref === 'function') timer.unref()
    ctx.on?.('dispose', () => clearInterval(timer))
  }

  // 供工具层与测试直接调用
  return {
    internals: {
      entriesWithAvailability: () => entriesWithAvailability(entries),
      buildStatus: () => buildStatus(settings, settings.probeTimeoutMs, entries, configurationErrors),
      startEntry: startById,
      stopEntry: stopById,
      pidsOnPorts,
      logPaths,
    },
  }
}
