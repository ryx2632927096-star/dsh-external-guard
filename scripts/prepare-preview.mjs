// 发行快照工具：显式允许清单，不复制原Git历史或私人开发日志。
import { readFileSync, writeFileSync, mkdirSync, existsSync, lstatSync } from 'node:fs'
import { resolve, dirname, isAbsolute, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'

const source = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
if (args.length !== 2 || args[0] !== '--out' || !isAbsolute(args[1])) {
  throw new Error('Usage: node scripts/prepare-preview.mjs --out <new absolute directory>')
}
const output = resolve(args[1])
const relation = relative(source, output)
if (!relation || (!relation.startsWith('..' + sep) && relation !== '..' && !isAbsolute(relation)) || existsSync(output)) {
  throw new Error('Output must be a new directory outside the source tree; existing paths are never overwritten')
}
const allowed = [
  'LICENSE', 'README.md', 'package.json', 'cordis.patch.yml', '.gitignore', '.npmignore',
  'lib/index.js', 'lib/manifest.js', 'lib/supervisor.js', 'src/client.js',
  'scripts/config-entries.test.mjs', 'scripts/smoke.mjs', 'scripts/prepare-preview.mjs',
  'docs/DEVLOG.public.md',
]
const checks = [
  ['local-user-path', /[a-z]:[\\/]+Users[\\/]+(?!<)[a-z0-9_.-]+/i],
  ['email', /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i],
  ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['credential-value', /(?:api[_-]?key|access[_-]?token|password|secret)\s*[=:]\s*["'][a-z0-9_+/=-]{12,}["']/i],
  ['account-number', /(?:uin|qq|account)\s*[=:]\s*["']?[1-9][0-9]{5,11}\b/i],
]
const content = new Map()
const hits = []
for (const name of allowed) {
  // 不跟随文件或父目录的链接，避免从允许清单跳到其它本地资料。
  let current = source
  for (const part of name.split('/')) {
    current = resolve(current, part)
    if (lstatSync(current).isSymbolicLink()) throw new Error('Symlink forbidden: ' + name)
  }
  const buffer = readFileSync(current)
  content.set(name, buffer)
  buffer.toString('utf8').split(/\r?\n/).forEach((line, index) => {
    for (const [category, pattern] of checks) if (pattern.test(line)) hits.push({ file: name, line: index + 1, category })
  })
}
if (hits.length) throw new Error('Review candidate findings (values omitted): ' + JSON.stringify(hits))
content.set('DEVLOG.md', content.get('docs/DEVLOG.public.md'))
content.set('PREVIEW.md', Buffer.from('# Release preview snapshot\n\nGenerated from an explicit allowlist. This is not a second development source.\nNo private Git history, original sessions, or private development journal is included.\nDEVLOG.md is generated from docs/DEVLOG.public.md.\nOffline checks do not constitute real DSH integration or process-control acceptance.\nDo not push the original private repository history with this snapshot.\n'))
const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex')
const files = [...content].map(([path, buffer]) => ({ path, bytes: buffer.length, sha256: sha256(buffer),
  source: path === 'DEVLOG.md' ? 'docs/DEVLOG.public.md' : path === 'PREVIEW.md' ? 'generated' : path }))
const manifest = { kind: 'release-preview-only', package: 'dsh-external-guard',
  generatedAt: new Date().toISOString(), includesGitHistory: false,
  scan: { files: allowed.length, categories: checks.map(([name]) => name), findings: 0,
    limitation: 'Pattern scan only; not a proof of absence of sensitive content' }, files }
content.set('RELEASE-MANIFEST.json', Buffer.from(JSON.stringify(manifest, null, 2) + '\n'))
const sums = [...content].map(([path, buffer]) => sha256(buffer) + '  ' + path).join('\n') + '\n'
content.set('SHA256SUMS', Buffer.from(sums))
mkdirSync(output, { recursive: true })
for (const [name, buffer] of content) {
  const target = resolve(output, name)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, buffer, { flag: 'wx' })
}
console.log(JSON.stringify({ kind: manifest.kind, files: content.size, findings: 0 }))
