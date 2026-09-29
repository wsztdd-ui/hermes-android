# Hermes Android

> **重要 / Important:** 这是非官方社区客户端，与 Nous Research 无隶属关系。使用前，你必须自行准备一个可从手机访问、并且你有权使用的 **Hermes Gateway**。本项目不提供 Gateway、托管服务、账号或访问凭据。<br>
> **This is an unofficial community client and is not affiliated with Nous Research. Before using it, you must provide your own reachable Hermes Gateway that you are authorized to access. This project does not provide a Gateway, hosting, accounts, or credentials.**

[English](README.en.md) · 简体中文

Hermes Android 是一个原生 Android 客户端，以 Android WebView 承载 Hermes Desktop renderer，并提供适配触屏的独立交互层。renderer 固定在 Hermes Agent 上游提交，并由本仓库补丁适配；详见 [`patches/`](patches/) 和 [Android CI 工作流](.github/workflows/android.yml)。

## 当前状态

- 当前源码版本：`1.0.0`（Android `versionCode 55`，首个公开版本）。
- 项目处于 preview 阶段；不同 Gateway 版本、Android 厂商 WebView、折叠屏形态仍需用户环境验证。
- 明暗主题重复切换导致的 renderer 崩溃已通过真机复测；修复以可审阅补丁维护，并由 CI 应用到固定的 Hermes 上游提交。
- 语音输入、生产签名、系统通知及完整设备矩阵尚未验收。1.0.0 Debug 版已在 vivo Android 16 真机连接真实 Gateway 完成 67/67 项回归；该机系统级应用通知开关关闭，因此通知栏展示仍未验证。请查看 [测试说明](TESTING.md) 与 [发布说明](docs/RELEASING.md)。

## 功能

- **单界面全功能客户端**（所有屏幕尺寸均使用自渲染界面）：聊天、会话管理（置顶/改名/归档/删除）、任务（执行确认/提问卡片与定时任务）、技能与工具开关、MCP 管理、文件浏览（预览/编辑/下载到手机）。
- 聊天内搜索（本会话高亮跳转）与跨会话全文搜索；产物中心、命令中心、消息平台状态、Agents 进程一览。
- 后台消息通知：切出应用后可收到新回复与执行确认提醒，点按跳回对应会话；可在「更多」中关闭（需要 Android 通知权限及厂商通知开关允许）。
- 会话级模型切换（输入区上方胶囊）与全局默认模型设置（提供商 → 模型两步选择）。
- 发送失败自动补发（断网挂起、恢复后自动重发）；发出的图片在气泡内缩略图回显，点按全屏查看。
- 多 Gateway 连接管理与切换；认证凭据通过 Android Keystore 加密存储。
- 桌面 renderer 保留在应用内部，负责 Gateway 桥接与认证/恢复；应用内已移除桌面模式入口。StarMap 暂不出现在导航中，待移动页面实现后再加入。

## 从源码构建

### 环境

- macOS、Linux 或 Windows/WSL（Android Gradle Plugin 支持的平台）
- JDK 17
- Android SDK：Android 14 / API 34 平台和 Build Tools
- Node.js 22 与 npm
- `git`、网络访问上游 Hermes 仓库

### 构建 Debug APK

先克隆本仓库，在仓库根目录运行以下命令：

```bash
git clone https://github.com/NousResearch/hermes-agent.git /tmp/hermes-agent
git -C /tmp/hermes-agent checkout 26f178e5fa78c691cadf847058ef1d55a707bfb0
git -C /tmp/hermes-agent apply --unidiff-zero "$PWD/patches/hermes-android-theme-async-effect.patch"
(cd /tmp/hermes-agent && npm ci)
export ANDROID_HOME="$HOME/Android/Sdk" # 按本机 SDK 路径修改
export JAVA_HOME="/path/to/jdk-17"      # 按本机 JDK 路径修改
HERMES_SRC=/tmp/hermes-agent/apps/desktop bash scripts/build-all.sh
```

产物：`android/app/build/outputs/apk/debug/app-debug.apk`。`build-all.sh` 会构建 renderer、注入 Android 桥和移动样式、校验资源并运行 Gradle Wrapper。首次构建需要下载依赖。

仅在 Android 工程已有生成的 `assets/www` 时，也可用 `BUILD_TYPE=debug bash scripts/build-apk.sh` 打包。新克隆项目应优先运行完整 `build-all.sh`。

### 安装和连接

安装 Debug APK 后，在 **Settings → Connections** 添加你自行准备且可访问的 Gateway URL，并按该 Gateway 的认证方式登录。不要将密码、session cookie、访问令牌或私有 Gateway 地址写入源代码、问题报告或截图。

### 下载 APK

从 [Releases](https://github.com/wsztdd-ui/hermes-android/releases/latest) 下载：

| 文件 | 说明 |
|---|---|
| `Hermes-Android-1.0.0-debug.apk` | Debug 签名，已在 vivo Android 16 真机连接 Gateway 完成 67/67 回归，可直接安装。 |

下载后可用 Release 页面的 `SHA256SUMS` 校验完整性，构建与版本信息见 `BUILD_INFO.txt`。目前没有经签名和真机验收的正式 Release APK。

> 注意：Debug APK 使用 debug 签名，无法覆盖升级由其他签名（含正式签名）的已安装版本；如设备上已有其他签名版本，请先卸载再安装。

## 测试与 CI

```bash
node scripts/validate-frontend.mjs
./scripts/debug-smoke.sh
```

GitHub Actions 会检出固定上游版本、应用本仓库补丁、运行主题回归测试、构建 Debug 与 unsigned Release APK，并检查生成资源。无 Android 模拟器的 CI smoke 不等同于真机验收。更多测试边界见 [TESTING.md](TESTING.md)。

## 隐私和安全

App 连接你配置的 Gateway；Android 版本通过 Keystore 保护连接令牌。Gateway 会收到正常使用所需的聊天内容、附件和 API 请求。请只连接可信服务，并阅读 [隐私说明](PRIVACY.md) 与 [安全政策](SECURITY.md)。

## 致谢与许可

本项目复用并适配了 [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent) 的 Hermes Desktop renderer，固定上游提交为 [`26f178e`](https://github.com/NousResearch/hermes-agent/tree/26f178e5fa78c691cadf847058ef1d55a707bfb0)，上游项目采用 MIT License。上游版权和许可声明保留在本仓库的 [LICENSE](LICENSE) 中；改动以 [`patches/`](patches/) 追踪。Android 原生依赖采用 Apache-2.0，许可证全文见 [`third_party/Apache-2.0.txt`](third_party/Apache-2.0.txt)。Android 与 Web renderer 的第三方依赖说明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)；Web 依赖清单随构建生成。

Hermes、Hermes Agent、Nous Research 名称和标识归其各自权利人所有。本项目为非官方客户端，不代表 Nous Research。

---

<sub>本文档提供简体中文和英文版本：[简体中文](README.md) · [English](README.en.md)。</sub>
