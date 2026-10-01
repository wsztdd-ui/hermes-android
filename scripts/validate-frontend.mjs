#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = process.argv[2] ?? new URL('../android/app/src/main/assets/www', import.meta.url).pathname
const index = join(root, 'index.html')
if (!existsSync(index)) throw new Error(`frontend missing: ${index}`)
const html = readFileSync(index, 'utf8')
const required = [
  'window.hermesDesktop',
  'HERMES_MOBILE_TOUCH_CSS',
  'HERMES_MOBILE_VIEW_CSS',
  'data-hermes-mobile-view',
  'HERMES_MV_PAGES',
  'data-contrib-shell'
]
for (const marker of required) {
  if (!html.includes(marker)) throw new Error(`frontend marker missing: ${marker}`)
}
const bridgeDeclarations = (html.match(/const DB_KEY =/g) ?? []).length
if (bridgeDeclarations !== 1) throw new Error(`expected one bridge declaration, got ${bridgeDeclarations}`)
if ((html.match(/const VIEW_KEY =/g) ?? []).length !== 1) {
  throw new Error('expected exactly one mobile-view installation (VIEW_KEY)')
}
const scriptCount = (html.match(/<script/g) ?? []).length

// Zero-dependency CSS syntax gate: CI runs this script with plain node and no
// installed dependencies, so a full parser (css-tree/stylelint) is not
// available. This state machine catches the failure class that silently
// disables rules — declarations outside a rule block (missing '{'), '}' while
// a selector prelude is still open, unbalanced braces and unterminated
// strings/comments — and reports the offending source line.
function checkCssSyntax(css, label) {
  let line = 1
  const stack = [] // 'at' (@media-like) | 'rule' for each open block
  let inPrelude = false // accumulating a selector / at-rule prelude
  let preludeIsAt = false
  let expectPrelude = true
  const ctx = () => stack[stack.length - 1] ?? 'top'
  const fail = message => {
    throw new Error(`${label}:${line}: CSS syntax error: ${message}`)
  }
  for (let i = 0; i < css.length; i++) {
    const ch = css[i]
    if (ch === '\n') { line++; continue }
    if (ch === '/' && css[i + 1] === '*') {
      const end = css.indexOf('*/', i + 2)
      if (end === -1) fail('unterminated comment')
      for (let j = i; j <= end + 1; j++) if (css[j] === '\n') line++
      i = end + 1
      continue
    }
    if (ch === '"' || ch === "'") {
      let j = i + 1
      while (j < css.length && css[j] !== ch) {
        if (css[j] === '\\') j++
        if (css[j] === '\n') fail('unterminated string')
        j++
      }
      if (j >= css.length) fail('unterminated string')
      for (let k = i; k <= j; k++) if (css[k] === '\n') line++
      i = j
      continue
    }
    if (ch === '{') {
      stack.push(inPrelude && preludeIsAt ? 'at' : 'rule')
      inPrelude = false
      expectPrelude = stack[stack.length - 1] === 'at'
      continue
    }
    if (ch === '}') {
      if (!stack.length) fail("unbalanced '}'")
      if (ctx() !== 'rule' && inPrelude) fail("rule is missing its '{' block")
      stack.pop()
      expectPrelude = !stack.length || stack[stack.length - 1] === 'at'
      inPrelude = false
      continue
    }
    if (ch === ';') {
      if (ctx() !== 'rule' && inPrelude && !preludeIsAt) {
        fail('declaration outside a rule block (missing "{"?)')
      }
      inPrelude = false
      expectPrelude = ctx() !== 'rule'
      continue
    }
    if (/\s/.test(ch)) continue
    if (ctx() !== 'rule' && expectPrelude) {
      inPrelude = true
      preludeIsAt = ch === '@'
      expectPrelude = false
    }
  }
  if (stack.length) fail("unclosed '{'")
  if (inPrelude) fail('selector at end of file without a block')
}

checkCssSyntax(readFileSync(fileURLToPath(new URL('../bridge/mobile-touch.css', import.meta.url)), 'utf8'), 'bridge/mobile-touch.css')
const mobileViewCss = readFileSync(fileURLToPath(new URL('../bridge/mobile-view.css', import.meta.url)), 'utf8')
checkCssSyntax(mobileViewCss, 'bridge/mobile-view.css')
const modelSheetCss = mobileViewCss.match(/\.hmv-sheet\s*\{([^}]*)\}/)?.[1] ?? ''
for (const [property, expected] of [
  ['max-height', 'calc(var(--hermes-mobile-viewport-height, 100dvh) - 24px)'],
  ['overflow-y', 'auto'],
  ['touch-action', 'pan-y']
]) {
  const declaration = modelSheetCss.match(new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]+)`))?.[1]?.trim()
  if (declaration !== expected) throw new Error(`.hmv-sheet must set ${property}: ${expected}`)
}
const injectedStyle = html.match(/<style id="hermes-mobile-touch">([\s\S]*?)<\/style>/)
if (injectedStyle) checkCssSyntax(injectedStyle[1], 'injected hermes-mobile-touch style')
const injectedViewStyle = html.match(/<style id="hermes-mobile-view-style">([\s\S]*?)<\/style>/)
if (injectedViewStyle) checkCssSyntax(injectedViewStyle[1], 'injected hermes-mobile-view style')

// 注入完整性门禁：内联注入的脚本/样式块必须与其源文件一致。
// 拦截 replace 替换串里 $&/$`/$' 等特殊模式展开导致的块损坏（该类损坏会把
// JS 源码变成正文文本，页面白屏且无控制台错误）。
// 注入包装差异（首尾换行、CSS 的 6 空格缩进与标记注释行）先规范化再比较。
const bridgeRoot = fileURLToPath(new URL('../bridge/', import.meta.url))
const injectedExact = [
  ['hermes-mobile-ui', 'mobile-ui.js', false],
  ['hermes-mobile-view', 'mobile-view.js', false],
  ['hermes-mobile-view-pages', 'mobile-view-pages.js', false],
  ['hermes-mobile-touch', 'mobile-touch.css', true],
  ['hermes-mobile-view-style', 'mobile-view.css', true]
]
const normalizeInjected = (raw, indented) => raw
  .split('\n')
  .filter(l => !/^\s*\/\* HERMES_MOBILE.*CSS \*\/\s*$/.test(l))
  .map(l => (indented ? l.replace(/^ {6}/, '') : l))
  .join('\n')
  .replace(/^\n+/, '')
  .replace(/\s+$/, '')
for (const [id, file, indented] of injectedExact) {
  const tag = html.match(new RegExp(`id="${id}">([\\s\\S]*?)<\\/(script|style)>`))
  if (!tag) throw new Error(`injected block missing: ${id}`)
  const source = readFileSync(join(bridgeRoot, file), 'utf8')
  if (normalizeInjected(tag[1], indented) !== source.trim()) {
    throw new Error(`injected block ${id} differs from bridge/${file} (injection corruption? run build to re-inject)`)
  }
}

console.log(`frontend OK: ${root} (${scriptCount} scripts, ${html.length} byte index, CSS syntax OK)`)
