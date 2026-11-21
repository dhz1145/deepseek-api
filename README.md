<div align="center">

# DeepSeek API

支持自定义 Anthropic 和 OpenAI 兼容 API 的非官方 Android 客户端

[![Release](https://img.shields.io/github/v/release/dhz1145/deepseek-api?style=flat-square&color=2563eb&label=Release)](https://github.com/dhz1145/deepseek-api/releases/latest)
[![Platform](https://img.shields.io/badge/Platform-Android%2010%2B-3DDC84?style=flat-square&logo=android&logoColor=white)](https://github.com/dhz1145/deepseek-api)
[![License](https://img.shields.io/badge/License-GPL%20v3-blue?style=flat-square)](LICENSE)

<br />

[**📥 前往 Releases 下载 APK 安装包**](https://github.com/dhz1145/deepseek-api/releases/latest) · [**反馈问题**](https://github.com/dhz1145/deepseek-api/issues)

</div>

---

本项目最初基于 [LiJiaHua1024/deepseek-app-replica](https://github.com/LiJiaHua1024/deepseek-app-replica)，是我根据自己的使用习惯修改的版本。感谢原项目作者；本版独立发布，不是 DeepSeek 官方应用，也不会从上游仓库获取更新。

与官方客户端的区别在于未接入官方账号体系，改为直接输入用户自己的 DeepSeek 开放平台 API Key。官方 App 通过账号登录受限于日常用量配额，而直接接入个人 API Key 采用按量计费（Pay-as-you-go），只要账户额度充裕即可自由使用不受限额打断；同时所有会话数据均保存在设备本地。

## 下载与安装

可从[备用下载页](https://dhz1145.github.io/deepseek-api/)或 [GitHub Releases](https://github.com/dhz1145/deepseek-api/releases) 获取最新 APK。旧版（v0.7.2 及以前）如果在应用内下载较慢，可从备用页下载后覆盖安装，无需卸载。

安装本仓库发布的签名 APK 后，应用进入前台时会自动检查本仓库的新版本，发现更新会弹窗提醒。也可以在「设置 → 检查更新」手动检查。下载后由 Android 系统确认安装；如有提示，请为 DeepSeek API 开启「允许安装未知应用」。应用不会静默安装，也不会自动推送通知。v0.7.3 起会并行查询本仓库的 GitHub Pages 轻量清单和 GitHub Releases，并优先从 Pages 下载 APK，失败则回退到 Releases。两个渠道均不经过第三方代理，实际速度取决于所在网络。

> 之前通过调试 APK 安装的版本与正式版签名不同，不能直接覆盖。请先在旧版导出聊天记录，卸载旧版，再安装正式版。卸载会清除本地设置，API Key 需重新输入。

> 当前源码构建的 APK 支持 Android 10（API 级别 29）及以上版本。兼容测试覆盖 Android 10 的预装 WebView 74、升级后的 WebView 83，以及 Android 11 的预装 WebView 83。

## 使用步骤

1. 安装并打开应用，点击左上角抽屉菜单进入「设置」。
2. Android 首次启动时，填写 API Key；「请求地址」可留空，默认使用 DeepSeek 官方 API：聊天发往 `https://api.deepseek.com/anthropic/v1/messages`，校验 Key 和加载模型使用 `https://api.deepseek.com/models`。
   在请求地址上方可选 Anthropic Messages（默认）、OpenAI Chat Completions 或 OpenAI Responses。留空仍走官方 DeepSeek，并使用所选协议。自定义服务可填写 HTTPS 基础地址（如 `https://example.com/v1`），也可贴同协议的完整接口地址。应用向同一服务请求 `/models` 校验 Key 并读取可用模型。Android 通过原生网络层发出 HTTPS 请求，不需要服务端放行 WebView 跨域访问，也不跟随 API 重定向。附件和语音仍需要服务端支持对应接口，不会回退到官方服务。初始化后可在「设置 → 账号管理」点击 API Key 行的箭头编辑。地址框会显示当前自定义地址：不修改则保留，清空并保存则切回官方接口。保存时需要输入对应服务的 API Key。
3. 模型列表由当前 API 服务提供，可在「设置 → 账号管理」切换。首次连接时，服务返回多个模型就先选择；只有一个则自动选中。选择会保存在本机。

---

## 技术架构

项目采用 Android 原生容器承载高性能 Web 交互内核的架构：

- **Android 原生层**：基于 Java 17 与 Android SDK 37（最低兼容 Android 10 / API 29）。通过 WebView 加载本地构建产物，并封装系统级能力：API Key 经 Android Keystore 加密存储、原生麦克风录音采集（`AudioRecord`）、系统相册快速预取以及独立的网页浏览器（`SourceBrowserActivity`）。
- **Web 交互层**：React 18 + TypeScript + Zustand 状态管理，基于 CSS Modules 进行交互细节调优，引入 KaTeX、Mermaid 与 Prism.js 提供排版渲染。
- **构建系统**：Rspack 2 高速打包，与 Gradle `buildWeb` 构建任务无缝联动。

## 源码构建

如果你希望自行从源码编译 APK：

### 环境要求
- Node.js 22.12+ 与 pnpm
- JDK 17+
- Android SDK Platform 37

### 构建步骤
```powershell
# 1. 克隆代码并安装前端依赖
git clone https://github.com/dhz1145/deepseek-api.git
cd deepseek-api
pnpm install

# 2. 编译生成 Android Debug APK（会自动触发前端构建打包）
.\android\gradlew.bat -p android :app:assembleDebug
```

编译输出路径：`android/app/build/outputs/apk/debug/app-debug.apk`

### 维护者：发布更新

在 `main` 上提交本次修改，将 `package.json` 中的 `version` 提升一版，并递增 `android/app/build.gradle` 中的 `versionCode`。签名文件 `android/app/release.jks` 与 `android/keystore.properties` 只保存在本机；请在安全的位置备份，后续所有版本都用同一把签名密钥。不要把这两个文件提交到 Git。

本地安装依赖，使用有本仓库写入权限的账号登录 GitHub CLI（`gh auth login`），然后运行：

```powershell
pwsh -File scripts/publish-release.ps1 -Notes '填写本次更新说明'
```

脚本先生成并检查正式签名 APK，再通过 Git 推送 `main` 和版本标签，并将 `deepseek-api-v<版本>.apk` 发布到本仓库的 GitHub Releases。仅推送源码或创建标签不会向应用提供更新。Android 应用启动或重新进入前台时会检查本仓库的最新正式 Release，发现新版才弹窗，也可以从设置手动检查。草稿或预发行版本不作为更新。下载后会校验文件和签名，最后由系统安装器询问是否安装。

正式 Release 发布后，Actions 中的 `Publish Android update mirror` 会校验 APK 的大小及 SHA-256，再将 APK 和版本清单一起部署到本仓库的 GitHub Pages。镜像部署可能晚于 Release；部署失败可在 Actions 里从 `main` 手动重跑该工作流。仓库的 Pages 发布源须设为 GitHub Actions，`github-pages` 部署环境须允许 `main` 分支和 `v*` 版本标签。

### 低版本 Android 回归

在 Android Studio 中启动 API 29 或 API 30 模拟器，保留系统镜像预装的 WebView，安装 Debug APK 并保持 API Key 未配置。将下列命令中的序列号换成 `adb devices` 显示的模拟器序列号。

```powershell
node scripts/test-android-onboarding.mjs emulator-5554
```

脚本使用测试 Key 和模拟 API 响应，检查无效 Key 提示、保存 Key 后聊天界面的实际尺寸和可点击性、键盘和侧栏、流式回复，以及重启后能否读取已保存的 Key。

---

## 项目结构

```text
├── android/            # Android 原生容器源码与 Gradle 工程
│   └── app/src/main/   # 原生代码（Keystore 存储、录音机、相册、沙箱浏览器）
├── src/
│   ├── app/            # 应用整体布局、主题体系与 Android 平台适配
│   ├── components/     # UI 组件库（聊天流、输入框、搜索抽屉、设置面板等）
│   ├── services/       # 业务逻辑（API 请求、流式解析、会话存储与备份）
│   ├── i18n/           # 多语言文案（中/英）
│   └── utils/          # 通用工具函数
├── rspack.config.ts    # Rspack 打包配置
└── package.json        # 项目配置与脚本入口
```

---

## 免责声明

本项目仅供个人技术研究与前端/移动端交互学习交流使用，非 DeepSeek 官方发布版本。项目内所有商标、标识及版权均归其各自所有者所有。

## 开源协议

本项目采用 [GPL-3.0 许可证](LICENSE)。部分基础代码源自 DeepSeek 官方开源的 [chat-demo](https://github.com/deepseek-ai/chat-demo)（基于 MIT 许可证），依其条款保留原作者版权声明。
