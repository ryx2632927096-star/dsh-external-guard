/**
 * dsh-external-guard · 进程清单
 *
 * 每个条目回答四个问题：
 *   1. 它是什么（id / title / 说明）
 *   2. 怎么判断它活着（probes：端口 / 进程名 / HTTP 健康检查，按需组合）
 *   3. 怎么启动它（start：exec + args + cwd，一律隐藏窗口）
 *   4. 怎么停止它（stop：端口反查 pid + taskkill /T，或直接杀进程名）
 *
 * 设计原则：所有判据都必须能在没有该进程时**快速失败**（默认 1.2s 超时），
 * 绝不因为探测而卡住宿主事件循环。
 *
 * 路径默认值按「本机安装位置」推导，可用 config.entries[].start 覆盖；
 * 路径不存在时该条目会报 unavailable 而不是崩溃，方便同一份配置在不同机器上跑。
 */

import { existsSync, readdirSync, statSync } from 'node:fs'
import { join, isAbsolute, resolve } from 'node:path'

/**
 * 这些是本机（Windows）常见的安装位置。
 * 换机器时不需要改代码 —— 在 cordis.patch.yml 的 entries 里覆盖对应条目的 start 即可，
 * 路径不存在时该条目会显示「路径缺失」而不是崩溃。
 */
const LOCALAPPDATA = process.env.LOCALAPPDATA ?? ''
const SNOWLUMA = join(LOCALAPPDATA, 'SnowLuma')
/** 安装目录：只有 exe，没有日志。 */
const OLLAMA = join(LOCALAPPDATA, 'Programs', 'Ollama')
/** 数据目录：服务端日志（server.log 及滚动）写在这里，不是安装目录。 */
const OLLAMA_DATA = join(LOCALAPPDATA, 'Ollama')
const SURFCORE = process.env.SURFCORE_HOME ?? ''

/**
 * @typedef {Object} Probe
 * @property {'port'|'http'|'process'} kind
 * @property {number} [port]
 * @property {string} [url]
 * @property {string} [name]
 */

/**
 * @typedef {Object} Entry
 * @property {string} id
 * @property {string} title
 * @property {string} [note]
 * @property {Probe[]} probes          全部满足才算 healthy
 * @property {string[]} [dependsOn]    仅展示用；本插件不做「先起依赖」的自动编排
 * @property {{exec:string, args:string[], cwd?:string, env?:Record<string,string>}} [start]
 * @property {'ports'|'name'} [stopBy]
 * @property {number[]} [stopPorts]
 * @property {string[]} [stopNames]
 * @property {{label:string, dir:string, pattern:RegExp}[]} [logSources]
 *   这些进程由别人（surfcore 保活 / 用户自己）拉起时，本插件没有它们的 stdout，
 *   只能读它们自己写的日志文件。dir 不存在时静默跳过。
 */

/** @type {Entry[]} */
export const ENTRIES = [
  {
    id: 'ollama',
    title: 'Ollama',
    note: '向量嵌入后端。dsh-mnemon 与 surfcore 的语义检索都依赖它；没跑时会静默降级成关键词匹配。',
    probes: [
      { kind: 'port', port: 11434 },
      { kind: 'http', url: 'http://127.0.0.1:11434/api/tags' },
    ],
    start: {
      // 关键：用无连字符的 hidden 参数启动 app.exe。实测该参数让窗口不弹出但仍保留托盘图标。
      // 注意这是无连字符的 hidden，--hidden / -hidden 都会被忽略。
      exec: join(OLLAMA, 'ollama app.exe'),
      args: ['hidden'],
      cwd: OLLAMA,
    },
    stopBy: 'ports',
    stopPorts: [11434],
    stopNames: ['ollama app.exe', 'ollama.exe'],
    // Ollama 自己的服务日志写在数据目录（滚动：server.log / server-N.log）
    logSources: [{ label: 'ollama server.log', dir: OLLAMA_DATA, pattern: /^server(-\d+)?\.log$/ }],
  },
  {
    id: 'snowluma',
    title: 'SnowLuma',
    note: 'QQ OneBot 网关。WebUI 5099 / OneBot HTTP 3000 / OneBot WS 3001。关闭它 = QQ 机器人断线。',
    probes: [
      { kind: 'port', port: 5099 },
      { kind: 'port', port: 3000 },
      { kind: 'port', port: 3001 },
    ],
    start: {
      // 一律 -WindowStyle Hidden 等价效果：Node 侧用 detached + windowsHide，
      // 见 supervisor.js。这里只描述可执行与参数。
      exec: join(SNOWLUMA, 'node.exe'),
      args: [join(SNOWLUMA, 'index.mjs')],
      cwd: SNOWLUMA,
    },
    stopBy: 'ports',
    stopPorts: [5099, 3000, 3001],
    stopNames: [],
    // SnowLuma 按天滚动：logs/snowluma-YYYY-MM-DD.log，取最新一份
    logSources: [{ label: 'snowluma 当日日志', dir: join(SNOWLUMA, 'logs'), pattern: /^snowluma-.*\.log$/ }],
  },
  {
    id: 'bridge',
    title: 'surfcore bridge',
    note: 'DSH 与 QQ 之间的桥，监听 3100。一般由 surfcore 插件自动拉起；可用 entries.start 覆盖启动配置。',
    probes: [{ kind: 'port', port: 3100 }],
    dependsOn: ['snowluma'],
    // 不推测 bridge 的脚本入口；需要启停时在 entries.start 明确配置。
    // SURFCORE_HOME 只用于默认日志目录，不会隐式生成启动命令。
    stopBy: 'ports',
    stopPorts: [3100],
    stopNames: [],
    // 真正在记录 bridge 收发的是 surfcore 的状态目录
    ...(SURFCORE === ''
      ? {}
      : { logSources: [{ label: 'surfcore bridge.log', dir: join(SURFCORE, 'state'), pattern: /^bridge\.log$/ }] }),
  },
]

/**
 * 找出该条目「真实在写日志」的文件：在 logSources 里按目录 + 文件名正则挑最新的一个。
 * 目录不存在时返回空数组 —— 这是正常情况（换机器、进程没装）。
 */
export function resolveLogSources(id, limit = 2, entries = ENTRIES) {
  const entry = entries.find((e) => e.id === id)
  const sources = entry?.logSources ?? []
  const found = []
  for (const source of sources) {
    if (!existsSync(source.dir)) continue
    let best = null
    try {
      for (const name of readdirSync(source.dir)) {
        source.pattern.lastIndex = 0
        if (!source.pattern.test(name)) continue
        const full = join(source.dir, name)
        let st
        try {
          st = statSync(full)
        } catch {
          continue
        }
        if (!st.isFile()) continue
        if (!best || st.mtimeMs > best.mtimeMs) best = { path: full, mtimeMs: st.mtimeMs }
      }
    } catch {
      continue
    }
    if (best) found.push({ label: source.label, path: best.path })
    if (found.length >= limit) break
  }
  return found
}

/**
 * 把清单里所有本机路径检查一遍，标注哪些条目因路径缺失而不可用。
 * 不修改 ENTRIES 本身，返回一份带 availability 的副本。
 */
export function entriesWithAvailability(entries = ENTRIES) {
  return entries.map((entry) => {
    const missing = []
    if (entry.start) {
      const isType = (path, directory) => {
        try { return directory ? statSync(path).isDirectory() : statSync(path).isFile() } catch { return false }
      }
      if (!isType(entry.start.exec, false)) missing.push(entry.start.exec)
      if (entry.start.cwd && !isType(entry.start.cwd, true)) missing.push(entry.start.cwd)
      for (const arg of entry.start.args) {
        // 脚本参数按实际 spawn 的 cwd 解析；不把开关或普通业务参数当文件。
        if (!arg.startsWith('-') && /\.(js|mjs|cjs|exe)$/i.test(arg)) {
          const target = resolve(entry.start.cwd ?? process.cwd(), arg)
          if (!isType(target, false)) missing.push(target)
        }
      }
    }
    return {
      id: entry.id,
      title: entry.title,
      note: entry.note ?? '',
      dependsOn: entry.dependsOn ?? [],
      available: missing.length === 0,
      missing,
      canStart: Boolean(entry.start) && missing.length === 0,
    }
  })
}

const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/
const text = (value) => typeof value === 'string' && !value.includes('\0')
const nonempty = (value) => text(value) && value.trim().length > 0
const object = (value) => value !== null && typeof value === 'object' &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value))
const keysOnly = (value, keys) => object(value) && Object.keys(value).every((key) => keys.includes(key))
const strings = (value) => Array.isArray(value) && value.every(nonempty)
const port = (value) => Number.isInteger(value) && value >= 1 && value <= 65535
const path = (value) => nonempty(value) && isAbsolute(value)

function validProbe(probe) {
  if (!object(probe)) return false
  if (probe.kind === 'port') return keysOnly(probe, ['kind', 'port']) && port(probe.port)
  if (probe.kind === 'process') return keysOnly(probe, ['kind', 'name']) && nonempty(probe.name)
  if (probe.kind !== 'http' || !keysOnly(probe, ['kind', 'url']) || !text(probe.url)) return false
  try {
    const url = new URL(probe.url)
    return ['http:', 'https:'].includes(url.protocol) &&
      ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) && !url.username && !url.password
  } catch { return false }
}

/**
 * 每次 apply 独立生成清单。按 id 合并；start 逐字段合并，数组/env 整体替换。
 * 任何配置错误都返回空清单，避免悄悄回退到旧启动命令。诊断不包含配置值。
 */
export function createEffectiveEntries(overrides) {
  const clone = (entry) => ({
    ...entry,
    probes: entry.probes.map((probe) => ({ ...probe })),
    dependsOn: [...(entry.dependsOn ?? [])],
    stopPorts: [...(entry.stopPorts ?? [])],
    stopNames: [...(entry.stopNames ?? [])],
    ...(entry.start ? { start: { ...entry.start, args: [...entry.start.args],
      ...(entry.start.env ? { env: { ...entry.start.env } } : {}) } } : {}),
    logSources: (entry.logSources ?? []).map((source) => ({ ...source,
      pattern: new RegExp(source.pattern.source, source.pattern.flags) })),
  })
  const entries = ENTRIES.map(clone)
  const errors = []
  if (overrides === undefined) return { entries, errors }
  if (!Array.isArray(overrides) || overrides.length > 100) {
    return { entries: [], errors: ['entries 必须是最多 100 项的数组'] }
  }
  const seen = new Set()
  const fields = ['id', 'title', 'note', 'probes', 'start', 'stopBy', 'stopPorts', 'stopNames', 'dependsOn', 'logSources']
  overrides.forEach((patch, index) => {
    const fail = (field) => errors.push(`entries[${index}].${field} 无效`)
    if (!keysOnly(patch, fields)) { fail('字段'); return }
    if (!text(patch.id) || !ID.test(patch.id)) { fail('id'); return }
    if (seen.has(patch.id)) { fail('id（重复）'); return }
    seen.add(patch.id)
    const position = entries.findIndex((entry) => entry.id === patch.id)
    const base = position < 0 ? { id: patch.id, title: patch.id, probes: [] } : entries[position]
    const candidate = { ...base, ...patch }
    if (Object.hasOwn(patch, 'start')) {
      if (patch.start === null) delete candidate.start
      else if (!keysOnly(patch.start, ['exec', 'args', 'cwd', 'env'])) fail('start')
      else {
        candidate.start = { args: [], ...base.start, ...patch.start }
        if (candidate.start.cwd === null) delete candidate.start.cwd
        if (candidate.start.env === null) delete candidate.start.env
        const start = candidate.start
        if (!path(start.exec) || !Array.isArray(start.args) || !start.args.every(text) ||
          (start.cwd !== undefined && !path(start.cwd)) ||
          (start.env !== undefined && (!object(start.env) || !Object.entries(start.env).every(([key, value]) =>
            /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key) && !['__proto__', 'constructor', 'prototype'].includes(key) && text(value))))) fail('start')
      }
    }
    if (!nonempty(candidate.title)) fail('title')
    if (candidate.note !== undefined && !text(candidate.note)) fail('note')
    if (!Array.isArray(candidate.probes) || candidate.probes.length === 0 || !candidate.probes.every(validProbe)) fail('probes')
    if (candidate.stopBy !== undefined && !['ports', 'name'].includes(candidate.stopBy)) fail('stopBy')
    if (candidate.stopPorts !== undefined && (!Array.isArray(candidate.stopPorts) || !candidate.stopPorts.every(port))) fail('stopPorts')
    if (candidate.stopNames !== undefined && (!strings(candidate.stopNames) || candidate.stopNames.some((name) => /[\\/*?]/.test(name)))) fail('stopNames')
    if (candidate.dependsOn !== undefined && (!strings(candidate.dependsOn) || !candidate.dependsOn.every((id) => ID.test(id)))) fail('dependsOn')
    if (Object.hasOwn(patch, 'logSources')) {
      if (!Array.isArray(patch.logSources)) fail('logSources')
      else {
        candidate.logSources = []
        for (const source of patch.logSources) {
          if (!keysOnly(source, ['label', 'dir', 'pattern']) || !nonempty(source.label) || !path(source.dir) || !text(source.pattern)) {
            fail('logSources'); continue
          }
          try { candidate.logSources.push({ ...source, pattern: new RegExp(source.pattern) }) }
          catch { fail('logSources.pattern') }
        }
      }
    }
    // 失败项不克隆，避免错误形状的对象触发宿主异常。
    if (errors.length > 0) return
    if (position < 0) entries.push(clone(candidate))
    else entries[position] = clone(candidate)
  })
  const ids = new Set(entries.map((entry) => entry.id))
  if (errors.length === 0 && entries.some((entry) => entry.dependsOn.some((id) => !ids.has(id)))) {
    errors.push('entries.dependsOn 引用了未知 id')
  }
  return errors.length ? { entries: [], errors } : { entries, errors }
}
