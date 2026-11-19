// 纯离线：宿主入口在VM内运行，supervisor完全替换为记录调用的桩。
// 不导入真实supervisor、不发网络请求、不执行子进程，也不读取真实服务日志。
import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import * as fs from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { EventEmitter } from 'node:events'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const cache = process.env.DSH_GUARD_TEST_CACHE || tmpdir()
fs.mkdirSync(cache, { recursive: true })
const fixture = fs.mkdtempSync(join(cache, 'guard-entries-'))
// 模块在导入时推导默认目录；也隔离这些默认路径，不检查真实用户安装目录。
const savedEnvironment = { LOCALAPPDATA: process.env.LOCALAPPDATA, SURFCORE_HOME: process.env.SURFCORE_HOME }
process.env.LOCALAPPDATA = join(fixture, 'local-appdata')
process.env.SURFCORE_HOME = join(fixture, 'surfcore')
const manifest = await import('../lib/manifest.js')
for (const [key, value] of Object.entries(savedEnvironment)) {
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}
const executable = join(fixture, 'fake.exe')
fs.writeFileSync(executable, 'fixture, never execute')
fs.writeFileSync(join(fixture, 'service.log'), 'offline fixture log')
const extra = () => ({ id: 'custom', title: '配置服务', probes: [{ kind: 'port', port: 18888 }],
  start: { exec: executable, args: ['--safe'], cwd: fixture },
  stopBy: 'ports', stopPorts: [18888], stopNames: [],
  logSources: [{ label: 'fixture', dir: fixture, pattern: '^service\\.log$' }] })

async function host(config = {}) {
  const routes = new Map(), calls = [], timers = []
  const engine = {
    probeAll: async (entries) => {
      calls.push({ op: 'probe', entries })
      return entries.map((entry) => ({ id: entry.id, healthy: true, checks: entry.probes, pids: [] }))
    },
    startEntry: (entry) => { calls.push({ op: 'start', entry }); return { ok: true, pid: 123 } },
    stopEntry: async (entry) => { calls.push({ op: 'stop', entry }); return { killed: [], failed: [] } },
    logPaths: (id) => ({ out: join(fixture, id + '.out'), err: join(fixture, id + '.err') }),
    pidsOnPorts: async () => { throw new Error('unexpected real pid lookup') },
  }
  const context = vm.createContext({ console, URL, Buffer, setInterval: (fn) => { timers.push(fn); return 1 }, clearInterval() {} })
  const synthetic = (exports) => new vm.SyntheticModule(Object.keys(exports), function () {
    for (const [key, value] of Object.entries(exports)) this.setExport(key, value)
  }, { context })
  const entry = new vm.SourceTextModule(fs.readFileSync(join(root, 'lib/index.js'), 'utf8'), { context })
  await entry.link((specifier) => {
    if (specifier === './manifest.js') return synthetic(manifest)
    if (specifier === './supervisor.js') return synthetic(engine)
    if (specifier === 'node:fs') return synthetic(fs)
    throw new Error('unexpected import: ' + specifier)
  })
  await entry.evaluate()
  const result = entry.namespace.apply({ get: () => ({ register: (spec) => routes.set(spec.path, spec) }), on() {} },
    { pollIntervalMs: 0, ...config })
  async function request(action, body, overrides = {}) {
    const req = new EventEmitter()
    Object.assign(req, { method: body === undefined ? 'GET' : 'POST',
      url: '/dsh-external-guard/' + action, headers: { host: '127.0.0.1:1' },
      socket: { remoteAddress: '127.0.0.1' } }, overrides)
    let code, response
    const handler = routes.get(req.url.split('?')[0]).handler(req, {
      writeHead: (value) => { code = value }, end: (value) => { response = JSON.parse(value) },
    })
    queueMicrotask(() => { if (body !== undefined) req.emit('data', JSON.stringify(body)); req.emit('end') })
    await handler
    return { code, body: response }
  }
  return { ...result, calls, timers, request }
}

test('默认兼容与深层实例隔离', () => {
  const a = manifest.createEffectiveEntries(), b = manifest.createEffectiveEntries([])
  assert.deepEqual(a.entries, manifest.createEffectiveEntries().entries)
  assert.equal(a.entries.length, 3)
  a.entries[0].start.args.push('mutation')
  a.entries[0].probes[0].port = 9
  assert.equal(b.entries[0].start.args.includes('mutation'), false)
  assert.equal(manifest.ENTRIES[0].probes[0].port, 11434)
  assert.equal(manifest.ENTRIES.find((entry) => entry.id === 'bridge').start, undefined)
})

test('伪客户端面板展示覆盖/新增items，只监测不提供启停，错误配置可见', async () => {
  const app = await host({ entries: [{ id: 'ollama', title: '覆盖后的服务' }, extra()] })
  const status = (await app.request('status')).body
  let exported, panel, stateIndex = 0, current = status
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState: (initial) => [stateIndex++ === 0 ? { loading: false, data: current, error: null } : initial, () => {}],
    useEffect() {}, useCallback: (fn) => fn, useRef: (value) => ({ current: value }),
  }
  vm.runInNewContext(fs.readFileSync(join(root, 'src/client.js'), 'utf8'), {
    console, window: { __ModuleLoader__: { load: ({ factory }) => { exported = factory((name) => {
      assert.equal(name, 'react'); return react
    }) } } },
    fetch() { throw new Error('unexpected real fetch') },
  })
  exported.apply({ slots: { inject: (_name, register) => register(), register: (spec, component) => {
    if (spec.name === 'main') panel = component
  } } })
  assert.equal(typeof panel, 'function')
  const walk = (node, visit) => {
    if (Array.isArray(node)) { node.forEach((child) => walk(child, visit)); return }
    if (node && typeof node === 'object') { visit(node); walk(node.children, visit) }
  }
  const tree = panel(), cards = []
  walk(tree, (node) => { if (node.props.item) cards.push(node) })
  assert.equal(cards.length, 4)
  assert.equal(cards[0].props.item.title, '覆盖后的服务')
  assert.equal(cards.at(-1).props.item.id, 'custom')
  for (const card of cards) {
    assert.equal(card.props.monitorOnly, true)
    const buttons = []
    walk(card.type(card.props), (node) => { if (node.type === 'button') buttons.push(node.children.flat().join('')) })
    assert.equal(buttons.some((label) => /启动|停止/.test(label)), false)
  }
  current = (await (await host({ entries: [{ id: 'ollama', badField: true }] })).request('status')).body
  stateIndex = 0
  let errorVisible = false
  walk(panel(), (node) => { if (node.props.key === 'config-errors') errorVisible = true })
  assert.equal(errorVisible, true)
})

test('覆盖start字段、数组替换、添加新项、显式清空', () => {
  const { entries, errors } = manifest.createEffectiveEntries([
    { id: 'ollama', start: { exec: executable, cwd: null, env: { CUSTOM: 'value' } },
      probes: [{ kind: 'process', name: 'fake.exe' }], stopNames: [], logSources: [] }, extra(),
    { id: 'snowluma', start: null },
  ])
  assert.deepEqual(errors, [])
  assert.equal(entries.length, 4)
  assert.deepEqual(entries[0].start.args, ['hidden'])
  assert.equal(entries[0].start.cwd, undefined)
  assert.deepEqual(entries[0].probes, [{ kind: 'process', name: 'fake.exe' }])
  assert.deepEqual(entries[0].stopNames, [])
  assert.equal(entries[1].start, undefined)
  assert.equal(entries[3].logSources[0].pattern.test('service.log'), true)
})

test('类型、重复id、未知字段、未知依赖、路径和正则错误全部关闭清单', () => {
  const invalid = [null, {}, 5, 'bad', [null], [{ id: '../x' }], [{ id: 'unknown' }],
    [{ id: 'ollama' }, { id: 'ollama' }], [{ id: 'ollama', typo: true }],
    [{ id: 'ollama', start: { args: 'x' } }], [{ id: 'ollama', start: { exec: 'relative.exe' } }],
    [{ id: 'ollama', start: { env: { TOKEN: 42 } } }], [{ id: 'ollama', start: { nope: 1 } }],
    [{ id: 'ollama', probes: [] }], [{ id: 'ollama', probes: [{ kind: 'port', port: 65536 }] }],
    [{ id: 'ollama', probes: [{ kind: 'http', url: 'https://example.com/' }] }],
    [{ id: 'ollama', dependsOn: ['missing'] }], [{ id: 'ollama', stopNames: ['*.exe'] }],
    [{ id: 'ollama', logSources: [{ label: 'x', dir: fixture, pattern: '[' }] }],
    [{ id: 'ollama', logSources: null }], [{ id: 'ollama', title: false }],
  ]
  for (const value of invalid) {
    const result = manifest.createEffectiveEntries(value)
    assert.equal(result.entries.length, 0)
    assert.ok(result.errors.length > 0)
  }
  assert.equal(manifest.createEffectiveEntries([{ id: 'ollama', dependsOn: ['custom'] }, extra()]).errors.length, 0)
})

test('有效本地HTTP探测、缺失路径及路径类型如实报告', () => {
  for (const url of ['http://localhost:8080/health', 'https://127.0.0.1/', 'http://[::1]/']) {
    assert.equal(manifest.createEffectiveEntries([{ id: 'ollama', probes: [{ kind: 'http', url }] }]).errors.length, 0)
  }
  const entries = manifest.createEffectiveEntries([{ ...extra(), start: { exec: fixture, args: [], cwd: executable } }]).entries
  const meta = manifest.entriesWithAvailability(entries).find((entry) => entry.id === 'custom')
  assert.equal(meta.available, false)
  assert.deepEqual(meta.missing, [fixture, executable])
  fs.writeFileSync(join(fixture, 'relative.mjs'), '// fixture')
  const relative = manifest.createEffectiveEntries([{ ...extra(),
    start: { exec: executable, cwd: fixture, args: ['relative.mjs'] } }]).entries
  assert.equal(manifest.entriesWithAvailability(relative).at(-1).available, true)
  relative.at(-1).start.args = ['missing.mjs']
  assert.deepEqual(manifest.entriesWithAvailability(relative).at(-1).missing, [join(fixture, 'missing.mjs')])
})

test('status/探测/logs/start/stop以及巡检共用有效清单，HTTP额外命令不能覆盖', async () => {
  const config = { monitorOnly: false, pollIntervalMs: 1000, entries: [
    { id: 'ollama', start: { exec: executable, args: [], cwd: fixture },
      probes: [{ kind: 'port', port: 18889 }], stopPorts: [18889], stopNames: [] }, extra(),
  ] }
  const app = await host(config)
  config.entries[1].title = 'outside mutation'
  const status = await app.request('status')
  assert.equal(status.code, 200)
  assert.equal(status.body.items.length, 4)
  assert.equal(status.body.items.find((item) => item.id === 'custom').title, '配置服务')
  const logs = await app.request('logs?id=custom')
  assert.equal(logs.code, 200)
  assert.equal(logs.body.sources[0].text, 'offline fixture log')
  assert.equal((await app.request('start', { id: 'custom', exec: 'untrusted.exe', args: ['bad'] })).code, 200)
  assert.equal((await app.request('stop', { id: 'custom' })).code, 200)
  assert.equal((await app.request('start', { id: 'ollama' })).code, 200)
  assert.equal(app.calls.find((call) => call.op === 'start').entry.start.exec, executable)
  assert.deepEqual(app.calls.find((call) => call.op === 'stop').entry.stopPorts, [18888])
  const probes = app.calls.find((call) => call.op === 'probe').entries
  const custom = probes.find((entry) => entry.id === 'custom')
  assert.equal(app.calls.find((call) => call.op === 'start').entry, custom)
  assert.equal(app.calls.find((call) => call.op === 'stop').entry, custom)
  assert.equal(probes.find((entry) => entry.id === 'ollama').probes[0].port, 18889)
  assert.deepEqual(probes.find((entry) => entry.id === 'ollama').start.args, [])
  await app.timers[0]()
  assert.equal(app.calls.filter((call) => call.op === 'probe').length, 2)
  assert.equal(app.calls.at(-1).entries.find((entry) => entry.id === 'custom'), custom)
})

test('新增服务默认只监测和writesEnabled防护，未知id/坏JSON形状', async () => {
  for (const config of [{}, { monitorOnly: false, writesEnabled: false }]) {
    const app = await host({ ...config, entries: [extra()] })
    for (const action of ['start', 'stop']) assert.equal((await app.request(action, { id: 'custom' })).code, 403)
    assert.equal(app.calls.length, 0)
    assert.throws(() => app.internals.startEntry('custom'))
  }
  const app = await host({ monitorOnly: false, entries: [extra()] })
  for (const action of ['start', 'stop']) {
    assert.equal((await app.request(action, { id: 'missing' })).code, 404)
    assert.equal((await app.request(action, null)).code, 404)
  }
  assert.equal((await app.request('logs?id=missing')).code, 404)
  assert.equal((await app.request('start', { id: 'custom' }, { socket: { remoteAddress: '10.0.0.1' } })).code, 403)
})

test('两个宿主实例和内部入口隔离，不泄露配置环境变量', async () => {
  const a = await host({ monitorOnly: false, entries: [extra()] })
  const b = await host({ entries: [{ id: 'ollama', title: '另一个实例' }] })
  assert.equal((await a.request('status')).body.items.length, 4)
  assert.equal((await b.request('status')).body.items.length, 3)
  assert.equal((await b.request('logs?id=custom')).code, 404)
  assert.equal((await a.internals.buildStatus()).items.length, 4)
  assert.equal(b.internals.entriesWithAvailability()[0].title, '另一个实例')
  const c = await host({ entries: [{ id: 'ollama', start: { env: { EXAMPLE: 'private-fixture-value' } } }] })
  assert.equal(JSON.stringify((await c.request('status')).body).includes('private-fixture-value'), false)
})

test('无效配置不抛异常，状态提供诊断且所有动作不可执行', async () => {
  const app = await host({ monitorOnly: false, entries: [{ id: 'ollama', start: 'invalid' }] })
  const status = await app.request('status')
  assert.equal(status.code, 200)
  assert.deepEqual(status.body.items, [])
  assert.ok(status.body.configurationErrors.length > 0)
  assert.equal((await app.request('start', { id: 'ollama' })).code, 404)
  assert.equal((await app.request('logs?id=ollama')).code, 404)
  assert.ok(app.calls.every((call) => call.op === 'probe' && call.entries.length === 0))
})

test('缺失启动路径不得落入启动执行器，禁用启动条目仍可探测', async () => {
  const app = await host({ monitorOnly: false, entries: [{ ...extra(), start: { exec: join(fixture, 'missing.exe') } }] })
  const status = (await app.request('status')).body
  const item = status.items.find((entry) => entry.id === 'custom')
  assert.equal(item.available, false)
  assert.equal(item.canStart, false)
  assert.equal((await app.request('start', { id: 'custom' })).code, 500)
  assert.equal(app.calls.some((call) => call.op === 'start'), false)
  const disabled = await host({ entries: [{ id: 'ollama', start: null }] })
  assert.equal((await disabled.request('status')).body.items[0].canStart, false)
})

test('启动执行器接住异步spawn错误，不起实际进程或写真实临时日志', async () => {
  for (const outcome of ['error', 'spawn', 'throw']) {
    const closed = [], spawned = []
    const context = vm.createContext({ console, setTimeout, clearTimeout, AbortController, process })
    const synthetic = (exports) => new vm.SyntheticModule(Object.keys(exports), function () {
      for (const [key, value] of Object.entries(exports)) this.setExport(key, value)
    }, { context })
    const module = new vm.SourceTextModule(fs.readFileSync(join(root, 'lib/supervisor.js'), 'utf8'), { context })
    await module.link((specifier) => {
      if (specifier === 'node:child_process') return synthetic({
        execFile() { throw new Error('unexpected subprocess') },
        spawn(exec, args, options) {
          spawned.push({ exec, args, options })
          if (outcome === 'throw') throw new Error('synthetic spawn failure')
          const child = new EventEmitter()
          child.pid = 456
          child.unref = () => {}
          queueMicrotask(() => child.emit(outcome, new Error('synthetic spawn failure')))
          return child
        },
      })
      if (specifier === 'node:fs') return synthetic({ existsSync: () => true, mkdirSync() {},
        openSync: () => 42, closeSync: (fd) => closed.push(fd) })
      if (specifier === 'node:path') return synthetic({ join })
      if (specifier === 'node:os') return synthetic({ tmpdir: () => fixture })
      if (specifier === 'node:net') return synthetic({ default: { Socket() { throw new Error('unexpected socket') } } })
      throw new Error('unexpected import')
    })
    await module.evaluate()
    const result = await module.namespace.startEntry(extra())
    assert.equal(result.ok, outcome === 'spawn')
    assert.equal(spawned[0].exec, executable)
    assert.equal(spawned[0].options.windowsHide, true)
    assert.equal(closed.length, 2)
  }
})
