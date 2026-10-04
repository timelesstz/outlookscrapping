// Zero-dependency static quality gate: syntax-check every module and fail on
// debug/placeholder anti-patterns or a leaked API key. Runs in CI before build.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

let errors = 0
const fail = (m) => { console.error('✗ ' + m); errors++ }

function walk(dir) {
  for (const e of readdirSync(dir)) {
    const p = `${dir}/${e}`
    if (statSync(p).isDirectory()) walk(p)
    else if (e.endsWith('.js')) checkFile(p)
  }
}

function checkFile(p) {
  // 1) syntax
  try {
    execFileSync(process.execPath, ['--check', p], { stdio: 'pipe' })
  } catch (err) {
    fail(`syntax error in ${p}: ${String(err.stderr || err).split('\n')[0]}`)
  }
  const src = readFileSync(p, 'utf8')
  // 2) no leftover debug / unfinished markers in shipped source
  src.split('\n').forEach((ln, i) => {
    if (/\bconsole\.(log|debug)\b/.test(ln)) fail(`debug console in ${p}:${i + 1}`)
    if (/\b(TODO|FIXME|XXX|HACK)\b/.test(ln)) fail(`unfinished marker in ${p}:${i + 1}`)
    if (/\bdebugger\b/.test(ln)) fail(`debugger statement in ${p}:${i + 1}`)
  })
  // 3) never ship a DeepSeek / OpenAI-style secret key
  if (/\bsk-[a-zA-Z0-9]{20,}\b/.test(src)) fail(`possible hardcoded API key in ${p}`)
}

walk('src')
if (/\bsk-[a-zA-Z0-9]{20,}\b/.test(readFileSync('index.html', 'utf8'))) fail('possible API key in index.html')

if (errors) {
  console.error(`\nquality gate: ${errors} problem(s).`)
  process.exit(1)
}
console.log('quality gate: OK (syntax checked, no debug/markers/keys)')
