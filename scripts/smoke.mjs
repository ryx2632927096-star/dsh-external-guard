#!/usr/bin/env node
/**
 * 本机诊断（不需要宿主；会探测回环服务并读真实日志，不启停进程）。
 *
 *   node scripts/smoke.mjs
 *
 * 做四件事：
 *   1. 四个模块的语法（import 本身就等于语法检查）
 *   2. 用一个桩 webServer 跑 apply()，确认 4 条路由都注册
 *   3. 打一遍 /status，打印每个条目的健康状态
 *   4. 打一遍 /logs，确认能读到「进程自己的日志」（logSources）
 *
 * 退出码：0 = 全过；1 = 有断言失败。
 */

import { apply } from '../lib/index.js'
import { ENTRIES, entriesWithAvailability, resolveLogSources } from '../lib/manifest.js'

let failures = 0
function check(name, ok, detail = '') {
  if (ok) {
    console.log('  ok   ' + name + (detail ? '  (' + detail + ')' : ''))
  } else {
    failures += 1
    console.log('  FAIL ' + name + (detail ? '  (' + detail + ')' : ''))
  }
}

/** 最小的 webServer 桩：只记录注册进来的路由。 */
function makeServer() {
  const routes = new Map()
  return {
    routes,
    register(spec) {
      routes.set(spec.path, spec)
      return () => routes.delete(spec.path)
    },
  }
}

/** 造成一次请求。opts.url 用来带 query，opts.method 默认 GET。 */
function request(server, path, opts = {}) {
  const spec = server.routes.get(path)
  if (!spec) return Promise.resolve({ status: 0, body: '{"ok":false,"error":"no route"}' })
  return new Promise((resolve) => {
    const req = {
      method: opts.method ?? 'GET',
      url: opts.url ?? path,
      headers: { host: '127.0.0.1:1', ...(opts.headers ?? {}) },
      socket: { remoteAddress: opts.remoteAddress ?? '127.0.0.1' },
    }
    req.on = (event, fn) => {
      if (event === 'end') fn()
      return req
    }
    let status = 0
    const res = {
      writeHead(code) {
        status = code
      },
      end(body) {
        resolve({ status, body: String(body) })
      },
    }
    Promise.resolve(spec.handler(req, res)).catch((error) =>
      resolve({ status: -1, body: String(error?.message ?? error) }),
    )
  })
}

console.log('\n[1] 模块加载')
check('lib/manifest.js 可导入', Array.isArray(ENTRIES) && ENTRIES.length > 0, ENTRIES.length + ' 个条目')
check('导出 resolveLogSources', typeof resolveLogSources === 'function')

console.log('\n[2] 路由注册（桩 webServer）')
const server = makeServer()
apply({ get: (k) => (k === 'webServer' ? server : undefined), on: () => {} }, { pollIntervalMs: 0 })
const expected = ['/dsh-external-guard/status', '/dsh-external-guard/start', '/dsh-external-guard/stop', '/dsh-external-guard/logs']
for (const path of expected) check('已注册 ' + path, server.routes.has(path))

console.log('\n[3] GET /status')
const statusRes = await request(server, '/dsh-external-guard/status')
let statusJson = null
try {
  statusJson = JSON.parse(statusRes.body)
} catch {
  /* 下面会判 */
}
check('HTTP 200', statusRes.status === 200, 'got ' + statusRes.status)
check('body 是 JSON 且 ok=true', Boolean(statusJson && statusJson.ok))
check('返回 monitorOnly 字段', statusJson !== null && typeof statusJson.monitorOnly === 'boolean')
check('条目数与清单一致', statusJson?.items?.length === ENTRIES.length)
for (const item of statusJson?.items ?? []) {
  const state = item.healthy ? '运行中' : item.available ? '未运行' : '路径缺失'
  console.log('       - ' + item.id.padEnd(10) + state)
}

console.log('\n[4] GET /logs?id=')
for (const entry of ENTRIES) {
  const res = await request(server, '/dsh-external-guard/logs', {
    url: '/dsh-external-guard/logs?id=' + encodeURIComponent(entry.id),
  })
  let json = null
  try {
    json = JSON.parse(res.body)
  } catch {
    /* 下面会判 */
  }
  const sources = (json?.sources ?? []).filter((s) => s.exists)
  const detail =
    sources.length > 0
      ? sources.map((s) => s.label + ' ' + s.size + 'B').join(', ')
      : '没有可读的日志来源（进程日志目录不存在或为空）'
  check('/logs ' + entry.id + ' 返回 200', res.status === 200, detail)
}

console.log('\n[5] 参数校验')
const unknown = await request(server, '/dsh-external-guard/logs', { url: '/dsh-external-guard/logs?id=nope' })
check('未知 id → 404', unknown.status === 404, 'got ' + unknown.status)

console.log('\n[6] 路径推导')
for (const item of entriesWithAvailability()) {
  console.log('       - ' + item.id.padEnd(10) + 'available=' + item.available + ' canStart=' + item.canStart)
}

console.log('')
if (failures > 0) {
  console.log('失败 ' + failures + ' 项')
  process.exit(1)
}
console.log('全部通过')
