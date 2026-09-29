#!/usr/bin/env node
// 注入「远程网关桥」+ 「移动端触控适配 CSS」+「独立移动视图」到编译产物 dist/index.html 的 <head>。
//
// 用法：node inject-bridge.mjs <distPath> <bridgePath> [cssPath] [mobileJsPath] [viewCssPath] [viewJsPath] [viewPagesPath]

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const distPath = process.argv[2]
const bridgePath = process.argv[3]
const cssPath = process.argv[4]
const mobileJsPath = process.argv[5]
const viewCssPath = process.argv[6]
const viewJsPath = process.argv[7]
const viewPagesPath = process.argv[8]

if (!distPath || !bridgePath) {
  console.error('usage: node inject-bridge.mjs <distPath> <bridgePath> [cssPath] [mobileJsPath]')
  process.exit(1)
}

const indexPath = join(distPath, 'index.html')
let html = readFileSync(indexPath, 'utf8')
const bridge = readFileSync(bridgePath, 'utf8')

// Keep the mobile WebView viewport fixed. setSupportZoom(false) controls native
// zoom mechanisms but did not block pinch scale changes on every WebView build.
html = html.replace(
  /<meta\s+name=["']viewport["']\s+content=["'][^"']*["']\s*\/?\s*>/i,
  '<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no" />',
)

// ── 注入或更新 JS 桥（兼容旧版无 id 的内联脚本）──
{
  const bridgeBlock = `    <script id="hermes-desktop-bridge">
      // ── Hermes Android: 远程网关桥（替代 Electron preload 的 window.hermesDesktop）──
${bridge
  .split('\n')
  .map(line => (line.trim() === '' ? '' : `      ${line}`))
  .join('\n')}
    </script>
`
  const previousBlock = /    <script(?: id="hermes-desktop-bridge")?>\n      \/\/ ── Hermes Android: 远程网关桥[\s\S]*?    <\/script>\n/
  if (previousBlock.test(html)) {
    html = html.replace(previousBlock, () => bridgeBlock)
    console.log(`updated bridge in ${indexPath}`)
  } else {
    html = html.replace('  </head>', () => `${bridgeBlock}  </head>`)
    console.log(`injected bridge into ${indexPath}`)
  }
}

// ── 注入移动端触控适配 CSS（幂等：检测 CSS 标记）──
if (cssPath) {
  const css = readFileSync(cssPath, 'utf8')
  const cssBlock = `    <style id="hermes-mobile-touch">
      /* HERMES_MOBILE_TOUCH_CSS */
${css
  .split('\n')
  .map(line => (line.trim() === '' ? '' : `      ${line}`))
  .join('\n')}
    </style>
`
  const previousBlock = /    <style id="hermes-mobile-touch">[\s\S]*?    <\/style>\n/
  if (previousBlock.test(html)) {
    html = html.replace(previousBlock, () => cssBlock)
    console.log(`updated mobile-touch.css in ${indexPath}`)
  } else {
    html = html.replace('  </head>', () => `${cssBlock}  </head>`)
    console.log(`injected mobile-touch.css into ${indexPath}`)
  }
}

if (mobileJsPath) {
  const mobileJs = readFileSync(mobileJsPath, 'utf8')
  const mobileBlock = `    <script id="hermes-mobile-ui">\n${mobileJs}\n    </script>\n`
  const previousBlock = /    <script id="hermes-mobile-ui">[\s\S]*?    <\/script>\n/
  if (previousBlock.test(html)) {
    html = html.replace(previousBlock, () => mobileBlock)
    console.log(`updated mobile-ui.js in ${indexPath}`)
  } else {
    html = html.replace('  </head>', () => `${mobileBlock}  </head>`)
    console.log(`injected mobile-ui.js into ${indexPath}`)
  }
}

// ── 独立移动视图（CSS 先于 JS，保证脚本挂载时样式已就绪）──
if (viewCssPath) {
  const viewCss = readFileSync(viewCssPath, 'utf8')
  const viewCssBlock = `    <style id="hermes-mobile-view-style">
      /* HERMES_MOBILE_VIEW_CSS */
${viewCss
  .split('\n')
  .map(line => (line.trim() === '' ? '' : `      ${line}`))
  .join('\n')}
    </style>
`
  const previousBlock = /    <style id="hermes-mobile-view-style">[\s\S]*?    <\/style>\n/
  if (previousBlock.test(html)) {
    html = html.replace(previousBlock, () => viewCssBlock)
    console.log(`updated mobile-view.css in ${indexPath}`)
  } else {
    html = html.replace('  </head>', () => `${viewCssBlock}  </head>`)
    console.log(`injected mobile-view.css into ${indexPath}`)
  }
}

if (viewJsPath) {
  const viewJs = readFileSync(viewJsPath, 'utf8')
  const viewBlock = `    <script id="hermes-mobile-view">\n${viewJs}\n    </script>\n`
  const previousBlock = /    <script id="hermes-mobile-view">[\s\S]*?    <\/script>\n/
  if (previousBlock.test(html)) {
    html = html.replace(previousBlock, () => viewBlock)
    console.log(`updated mobile-view.js in ${indexPath}`)
  } else {
    html = html.replace('  </head>', () => `${viewBlock}  </head>`)
    console.log(`injected mobile-view.js into ${indexPath}`)
  }
}

if (viewPagesPath) {
  const pagesJs = readFileSync(viewPagesPath, 'utf8')
  const pagesBlock = `    <script id="hermes-mobile-view-pages">\n${pagesJs}\n    </script>\n`
  const previousBlock = /    <script id="hermes-mobile-view-pages">[\s\S]*?    <\/script>\n/
  if (previousBlock.test(html)) {
    html = html.replace(previousBlock, () => pagesBlock)
    console.log(`updated mobile-view-pages.js in ${indexPath}`)
  } else {
    html = html.replace('  </head>', () => `${pagesBlock}  </head>`)
    console.log(`injected mobile-view-pages.js into ${indexPath}`)
  }
}

writeFileSync(indexPath, html, 'utf8')
console.log(`html now ${html.length} bytes`)
