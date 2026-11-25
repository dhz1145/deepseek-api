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

本项目最初基于 [LiJiaHua1024/deepseek-app-replica](https://github.com/LiJiaHua1024/deepseek-app-replica)。DeepSeek API 由 [dhz1145](https://github.com/dhz1145) 根据自己的使用习惯修改并独立维护。感谢原项目作者。本版不是 DeepSeek 官方应用，应用内更新来自本仓库。

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

聊天内核源自 DeepSeek 官方 [chat-demo](https://github.com/deepseek-ai/chat-demo)，已同步 [v0.1.3](https://github.com/deepseek-ai/chat-demo/releases/tag/v0.1.3) 的回复链接和附件处理逻辑。Android 仍由原生 HTTPS 层访问 API，不改用浏览器跨域请求；官方图片上传采用 4096 像素长边限制，保留本地原件，自定义服务沿用原有策略。

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

在 `main` 上提交本次修改，将 `package.json` 中的 `version` 提升一版，并递增 `android/app/build.gradle` 中的 `versionCode`。签名文件 `android/app/release.jks` 与 `android/keystore.properties` 只保存在本机；在 `keystore.properties` 中用 `keyAlias` 指定现有签名密钥的别名（默认 `dsapi`）。请在安全的位置备份，后续所有版本都用同一把签名密钥。不要把这两个文件提交到 Git。

本地安装依赖，使用有本仓库写入权限的账号登录 GitHub CLI（`gh auth login`），然后运行：

```powershell
pwsh -File scripts/publish-release.ps1 -Notes '填写本次更新说明'
```

脚本先生成并检查正式签名 APK，再通过 Git 推送 `main` 和版本标签，并将 `deepseek-api-v<版本>.apk` 发布到本仓库的 GitHub Releases。仅推送源码或创建标签不会向应用提供更新。Android 应用启动或重新进入前台时会检查本仓库的最新正式 Release，发现新版才弹窗，也可以从设置手动检查。草稿或预发行版本不作为更新。下载后会校验文件和签名，最后由系统安装器询问是否安装。

正式 Release 发布后，Actions 中的 `Publish Android update mirror` 会校验 APK 的大小及 SHA-256，再将 APK 和版本清单一起部署到本仓库的 GitHub Pages。镜像部署可能晚于 Release；部署失败可在 Actions 里从 `main` 手动运行该工作流（`package.json` 的版本须与最新正式 Release 一致）。仓库的 Pages 发布源须设为 GitHub Actions，`github-pages` 部署环境须允许 `main` 分支和 `v*` 版本标签。

### Cloudflare R2 更新镜像

v0.7.6 起，Android 可以直接从本项目的 R2 镜像检查和下载更新；镜像异常时仍可使用 GitHub Pages / Releases。v0.7.5 及更早版本需先从原渠道更新一次。当前小规模使用已有 `r2.dev` 入口；它有限流，不保证所有网络可访问，长期使用建议绑定自定义域名。

如需启用自动同步，在 GitHub 仓库的 **Settings → Secrets and variables → Actions** 设置 `R2_UPDATE_ORIGIN`（HTTPS 域名，不带 `/updates`）、`R2_ACCOUNT_ID`、`R2_BUCKET`，并把仅对此桶有对象读写权限的 R2 凭证存为 `R2_ACCESS_KEY_ID` 和 `R2_SECRET_ACCESS_KEY` 两个 Secrets。发布脚本会用 `R2_UPDATE_ORIGIN` 覆盖默认地址。Actions 从正式 Release 下载并校验 APK，上传后再从公网验证一次，最后更新 `latest.json`；R2 自动同步与 Pages 部署互不阻塞。

未配置自动同步时，可用 `python scripts/build-update-mirror.py <输出目录>` 生成与已发布正式版一致的镜像文件，然后手动上传到 R2 的 `updates/` 下。先上传 APK 并验证公网下载内容，再上传 `latest.json`；不要覆盖同版本 APK。

### 思考档位别名表

优先使用网关声明的档位。网关未声明时，可以为同一个请求地址、协议和完整模型 ID 补充档位。别名表只影响档位选项，不会替换聊天请求里的模型 ID，也不会向镜像发送 API Key。

维护 `src/services/api/reasoning-aliases.json`。每条记录填写 `baseUrl`、`format`（`messages` / `chat` / `responses`）、`model` 和 `efforts`；空的 `efforts` 可显式禁用该匹配的档位。配置 R2 自动同步后，正式发布会一并上传此表。只更新别名时，把同一个 JSON 单独上传到 R2 的 `updates/reasoning-aliases.json` 即可，无需重新发布 APK。Android 启动时在后台读取，读不到或文件无效时用上次有效缓存或内置表。

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
