# Hermes Android — 远程网关桥（bridge）

这是方案的核心：把官方 Hermes Desktop 的 renderer（`apps/desktop/src`，一套精致的 React 前端）
编译成纯 Web 产物后，注入一个「远程网关桥」，替代它原本依赖的 Electron `window.hermesDesktop`
对象，让它直接连接任意可配置的远程 hermes gateway。

## 原理

Desktop renderer 是纯 Web 技术（React + Vite + nanostores + `@assistant-ui`），它唯一依赖
Electron 的入口是一个全局对象 `window.hermesDesktop`（Electron preload 通过 `contextBridge`
注入）。这个 bridge 复刻它的最小但完整契约，把核心能力翻译成浏览器原生能力：

| Electron 原生能力 | Web/WebView 等价实现 |
| --- | --- |
| `hermes:api` (REST) | `fetch()` + `X-Hermes-Session-Token` / `Authorization: Bearer` 头 |
| `hermes:gateway:ws-url` | 直接用 `buildGatewayWsUrl()` 拼 `wss://host/api/ws?token=…` |
| `hermes:connections:*` (多连接注册表) | localStorage / IndexedDB 持久化（多连接、主连接、last-used） |
| `selectPaths` (选文件) | `<input type="file">`，并把 File 转 data URL 存入 `path → dataUrl` 映射 |
| `readFileDataUrl` (读文件) | 从上面的映射表取值 |
| `saveImageFromUrl` / `saveGatewayFile` | Android 原生下载（经 `window.__hermesMobile`） |
| token 加密存储 (OS keychain) | Android Keystore（经 `window.__hermesMobile.secureToken`） |
| `writeClipboard` / `readClipboard` | `navigator.clipboard` |
| `openExternal` (开外链) | `window.open` / Android intent（经原生桥） |

其余 Electron 专属能力（`petOverlay`、`hud`、`quickEntry`、多窗口、本地文件系统、系统
keychain）在移动端优雅降级为 `undefined`——renderer 里全部用可选链 `?.` 访问，会自动降级。

## 文件

- `hermes-desktop-bridge.js` — 注入到 WebView、实现 `window.hermesDesktop` 的核心 shim。
  纯 ESM，可被 vite 作为入口打包，或直接内联进 `index.html` 的 `<head>`。

## 关键协议（来自官方源码，已核实）

- REST：`fetch(baseUrl + path, { method, headers: { 'X-Hermes-Session-Token': token, ...custom, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })`，非 2xx 抛 `Error("<status>: <text>")`，2xx 解析 JSON。
- WS：`{ws|wss}://host{prefix}/api/ws?token=<enc>`（token 模式）或 `?ticket=<enc>`（oauth 模式），
  JSON-RPC 2.0：`{"jsonrpc":"2.0","id":N,"method":"…","params":{…}}`，服务端事件 `{"method":"event","params":{"type":"…"}}`。
  （`JsonRpcGatewayClient` 来自 `@hermes/shared`，是纯浏览器实现，直接复用，无需改写。）
