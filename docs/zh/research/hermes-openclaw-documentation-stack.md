# Hermes Agent 与 OpenClaw 文档技术栈调研

- 调研日期：2026-09-01（Asia/Shanghai）
- 证据边界：仅使用官方仓库、第一方文档源码、依赖清单和部署工作流。
- 证据标签：**源码事实**表示可由固定源码直接确认；**工程推论**表示基于这些事实作出的判断。

## 项目身份与固定快照

本工作区中的“Hermes”存在歧义。本报告调研的是 **Nous Research 的
Hermes Agent**，不是本独立 Bridge 之前参考过的 Hermes gateway 或插件代码：

- 官方仓库：[`NousResearch/hermes-agent`](https://github.com/NousResearch/hermes-agent)
- 官方文档：[`hermes-agent.nousresearch.com/docs`](https://hermes-agent.nousresearch.com/docs/)
- 调研 commit：[`86b50fb43a7716a9fae59bc5539afc59e15d3f3b`](https://github.com/NousResearch/hermes-agent/commit/86b50fb43a7716a9fae59bc5539afc59e15d3f3b)

OpenClaw 将文档写作源与发布站点实现分开维护：

- 英文权威源：[`openclaw/openclaw/docs`](https://github.com/openclaw/openclaw/tree/d4354ffc8e917d7ba89b33a8f471fe98cba0ecbe/docs)
- 发布镜像与站点构建器：[`openclaw/docs`](https://github.com/openclaw/docs)
- 调研镜像 commit：[`52403a5f8de349441af1179ba56f0c717804620b`](https://github.com/openclaw/docs/commit/52403a5f8de349441af1179ba56f0c717804620b)
- 镜像通过 [`.openclaw-sync/source.json`](https://github.com/openclaw/docs/blob/52403a5f8de349441af1179ba56f0c717804620b/.openclaw-sync/source.json#L1-L14)
  记录对应的产品文档源 commit：
  [`d4354ffc8e917d7ba89b33a8f471fe98cba0ecbe`](https://github.com/openclaw/openclaw/commit/d4354ffc8e917d7ba89b33a8f471fe98cba0ecbe)
- 官方文档：[`docs.openclaw.ai`](https://docs.openclaw.ai/)

## 核心结论

两个站点当前**并不使用相同的运行技术栈**。

| 维度 | Hermes Agent | OpenClaw |
|---|---|---|
| 生成器 | Docusaurus 3.10.2 | 自研 Node.js 静态生成器 |
| 写作格式 | Markdown 与 MDX | Mintlify 风格的 Markdown 与 MDX |
| 主题 | Docusaurus classic preset + 自定义 CSS | 使用 OpenClaw Carapace 资产的自定义 HTML/CSS/JS 外壳 |
| 导航 | 强类型 `sidebars.ts` | Mintlify schema 的 `docs.json`，由自研构建器解析 |
| 搜索 | 托管的 Algolia DocSearch | 浏览器静态 Pagefind + Worker 搜索接口 |
| 托管 | GitHub Pages artifact；另有 Vercel deploy hook | Cloudflare R2 内容 + Cloudflare Worker 路由 |
| 国际化 | Docusaurus i18n：英文、简体中文 | 当前导航发布英文和 18 种生成翻译 |
| Release 文档版本化 | 滚动更新的当前文档 | 带源码 SHA 溯源的滚动当前文档 |

**工程推论：**两者真正可复用的共同部分是 Markdown/MDX、Node 构建、静态产物、
显式导航、国际化和 CI 校验。复制 OpenClaw 的自研渲染器，同时也会复制一套规模较大
的站点维护负担。Docusaurus 能以更少的项目自有代码提供本项目需要的基础文档能力。

## 1. Hermes Agent

### 框架、主题与内容

**源码事实：**Hermes 使用 Docusaurus `3.10.2`、Docusaurus classic preset、
Mermaid theme、React 19 和 TypeScript，版本固定在
[网站 manifest](https://github.com/NousResearch/hermes-agent/blob/86b50fb43a7716a9fae59bc5539afc59e15d3f3b/website/package.json#L21-L36)
中。classic preset 启用文档、关闭 blog，并加载项目自有 CSS；Markdown 中启用 Mermaid
图表（[主配置](https://github.com/NousResearch/hermes-agent/blob/86b50fb43a7716a9fae59bc5539afc59e15d3f3b/website/docusaurus.config.ts#L18-L41)、
[preset 配置](https://github.com/NousResearch/hermes-agent/blob/86b50fb43a7716a9fae59bc5539afc59e15d3f3b/website/docusaurus.config.ts#L76-L91)）。

主要文档位于 `website/docs/`，格式为 Markdown 和 MDX。项目自有的 React 页面及组件
提供 Skills 目录和内容更丰富的落地页；预构建脚本还会生成 Skills 目录、自动化目录、
`llms.txt` 和 `llms-full.txt`（[预构建契约](https://github.com/NousResearch/hermes-agent/blob/86b50fb43a7716a9fae59bc5539afc59e15d3f3b/website/scripts/prebuild.mjs#L1-L23)、
[生成产物](https://github.com/NousResearch/hermes-agent/blob/86b50fb43a7716a9fae59bc5539afc59e15d3f3b/website/scripts/prebuild.mjs#L122-L145)）。

### 导航和内容分布

**源码事实：**导航由 [`website/sidebars.ts`](https://github.com/NousResearch/hermes-agent/blob/86b50fb43a7716a9fae59bc5539afc59e15d3f3b/website/sidebars.ts)
手工维护，主要信息架构包括：

- Getting Started；
- Using Hermes；
- Features，下分 Core、Automation、Media & Web、Management 和 Skills；
- Messaging Platforms；
- Integrations；
- Guides and Tutorials；
- Developer Guide；
- Reference。

Navbar 和 footer 会突出 Docs、Skills、下载入口、开发者指南、参考资料、源码仓库和社区
（[navbar](https://github.com/NousResearch/hermes-agent/blob/86b50fb43a7716a9fae59bc5539afc59e15d3f3b/website/docusaurus.config.ts#L119-L161)、
[footer](https://github.com/NousResearch/hermes-agent/blob/86b50fb43a7716a9fae59bc5539afc59e15d3f3b/website/docusaurus.config.ts#L163-L192)）。

### 搜索、国际化与参考资料生成

**源码事实：**搜索使用 Algolia DocSearch，并按当前 locale 做上下文过滤。仓库中只包含
公开的搜索凭证，配置说明索引由 Algolia Crawler 填充
（[搜索配置](https://github.com/NousResearch/hermes-agent/blob/86b50fb43a7716a9fae59bc5539afc59e15d3f3b/website/docusaurus.config.ts#L93-L108)）。

Docusaurus i18n 配置了英文和简体中文，并在导航栏提供语言切换器。中文内容位于
`website/i18n/zh-Hans/docusaurus-plugin-content-docs/current/`
（[locale 配置](https://github.com/NousResearch/hermes-agent/blob/86b50fb43a7716a9fae59bc5539afc59e15d3f3b/website/docusaurus.config.ts#L25-L37)、
[语言切换器](https://github.com/NousResearch/hermes-agent/blob/86b50fb43a7716a9fae59bc5539afc59e15d3f3b/website/docusaurus.config.ts#L142-L145)）。

固定快照的网站 manifest 与配置中没有 OpenAPI、Redoc 或 TypeDoc 集成。参考资料页面
仍是 Markdown/MDX，只有特定目录由仓库脚本生成。**工程推论：**这是以说明性文档为主、
只对部分参考目录做代码生成的站点，并非以 API schema 为中心的参考门户。

### 托管与部署

**源码事实：**GitHub Actions 构建完整的双语 Docusaurus 站点，并作为 GitHub Pages
artifact 上传。相关 `main` 分支变更、发布 release 和手工调度都会触发工作流
（[触发条件](https://github.com/NousResearch/hermes-agent/blob/86b50fb43a7716a9fae59bc5539afc59e15d3f3b/.github/workflows/deploy-site.yml#L1-L23)、
[构建与暂存](https://github.com/NousResearch/hermes-agent/blob/86b50fb43a7716a9fae59bc5539afc59e15d3f3b/.github/workflows/deploy-site.yml#L161-L190)、
[Pages 上传](https://github.com/NousResearch/hermes-agent/blob/86b50fb43a7716a9fae59bc5539afc59e15d3f3b/.github/workflows/deploy-site.yml#L247-L250)）。
同一工作流会在 release 和手工发布时调用 Vercel deploy hook
（[Vercel job](https://github.com/NousResearch/hermes-agent/blob/86b50fb43a7716a9fae59bc5539afc59e15d3f3b/.github/workflows/deploy-site.yml#L35-L47)）。
仅凭已提交配置无法进一步证明公网边缘流量的精确拓扑。

CI 会安装依赖、重新生成派生目录、检查图表并构建英文 locale；部署时才运行完整的双语
构建（[文档检查](https://github.com/NousResearch/hermes-agent/blob/86b50fb43a7716a9fae59bc5539afc59e15d3f3b/.github/workflows/docs-site-checks.yml#L26-L55)）。

### 版本化与分析

**源码事实：**网站包版本为 `0.0.0`；固定源码中没有 Docusaurus `versions.json`、
`versioned_docs`、版本下拉菜单或版本化文档配置。网站从 `main` 部署，因此即使发布
release 也会触发构建，公网仍是一套持续滚动的当前文档
（[manifest](https://github.com/NousResearch/hermes-agent/blob/86b50fb43a7716a9fae59bc5539afc59e15d3f3b/website/package.json#L1-L10)、
[部署触发条件](https://github.com/NousResearch/hermes-agent/blob/86b50fb43a7716a9fae59bc5539afc59e15d3f3b/.github/workflows/deploy-site.yml#L3-L12)）。

公开的网站 manifest 和 Docusaurus 配置中没有可见的站点分析集成。这不能证明托管平台
或其他外部边缘层完全没有分析功能。

## 2. OpenClaw

### 写作格式与实际运行时

**源码事实：**OpenClaw 在产品仓库中维护英文文档，再同步到 `openclaw/docs`；生成的
locale 内容只提交到镜像仓库
（[镜像契约](https://github.com/openclaw/docs/blob/52403a5f8de349441af1179ba56f0c717804620b/README.md#L6-L17)、
[编辑规则](https://github.com/openclaw/docs/blob/52403a5f8de349441af1179ba56f0c717804620b/README.md#L31-L36)）。

其内容仍为 **Mintlify 风格**：`docs/docs.json` 声明 Mintlify schema、`mint` 主题、
Lucide 图标、字体、颜色、重定向、语言、tab、group 和页面列表
（[配置头部](https://github.com/openclaw/docs/blob/52403a5f8de349441af1179ba56f0c717804620b/docs/docs.json#L1-L49)、
[导航起点](https://github.com/openclaw/docs/blob/52403a5f8de349441af1179ba56f0c717804620b/docs/docs.json#L1171-L1205)）。

但**当前发布栈不是 Mintlify 托管运行时**。镜像仓库内的 Node 脚本会自行解析上述配置
和 Markdown/MDX，渲染静态 HTML，构建导航与 locale 路由，并生成自定义站点外壳。
依赖包括 `markdown-it`、MDX、Mermaid、Highlight.js、Lucide、Pagefind、Playwright
和 OpenClaw Carapace 设计包
（[构建脚本与依赖](https://github.com/openclaw/docs/blob/52403a5f8de349441af1179ba56f0c717804620b/package.json#L1-L36)、
[构建器入口](https://github.com/openclaw/docs/blob/52403a5f8de349441af1179ba56f0c717804620b/scripts/docs-site/build.mjs)）。

**工程推论：**Mintlify 当前主要是写作/配置兼容格式及旧站备份面；OpenClaw 自己拥有
渲染和托管实现。

### 导航和内容分布

**源码事实：**`docs.json` 是唯一显式导航树，并为每种语言重复 tab 和 group。英文顶层
内容主要包括：

- 入门和安装；
- 产品概念以及 Channel/Provider 指南；
- Gateway 运维与安全；
- 工具、自动化、节点和平台；
- 插件开发与参考资料；
- 帮助、诊断与故障排查；
- Release & CI，包括发布说明、发布流程、成熟度和测试。

文档主体是带 frontmatter 的 Markdown/MDX，常见字段包括 `title`、`summary`、
`read_when`、状态、适用范围和 release 元数据。自研构建器会派生路由、目录、上一篇/
下一篇、Open Graph 卡片、`llms` 输出、robots 和 sitemap
（[页面收集](https://github.com/openclaw/docs/blob/52403a5f8de349441af1179ba56f0c717804620b/scripts/docs-site/build.mjs#L87-L153)）。

### 搜索、国际化与参考资料生成

**源码事实：**浏览器搜索由 Pagefind 静态生成。构建还会生成独立搜索索引，供
Cloudflare Worker 的 `/api/search` 和小型文档搜索 MCP 使用
（[构建流水线](https://github.com/openclaw/docs/blob/52403a5f8de349441af1179ba56f0c717804620b/package.json#L5-L20)、
[Worker 路由](https://github.com/openclaw/docs/blob/52403a5f8de349441af1179ba56f0c717804620b/workers/docs-router.ts#L42-L80)、
[搜索实现](https://github.com/openclaw/docs/blob/52403a5f8de349441af1179ba56f0c717804620b/workers/docs-router.ts#L207-L256)）。
Worker/API 索引有意排除了 locale 路径，因此第二种搜索界面只覆盖英文
（[索引过滤](https://github.com/openclaw/docs/blob/52403a5f8de349441af1179ba56f0c717804620b/scripts/docs-site/search-index.mjs#L19-L43)）。

当前发布导航支持英文和 18 种翻译，包括简体中文与繁体中文。镜像中可能还有未在当前
导航公开的生成 locale 目录。翻译工作流使用源内容 hash，常规变更只翻译待处理文件，
失败时重试，汇总 locale artifact，并定期执行全量校准
（[翻译行为](https://github.com/openclaw/docs/blob/52403a5f8de349441af1179ba56f0c717804620b/README.md#L19-L29)、
[增量触发](https://github.com/openclaw/docs/blob/52403a5f8de349441af1179ba56f0c717804620b/.github/workflows/translate-incremental.yml#L1-L43)）。

固定站点 manifest/build 中没有 OpenAPI、Swagger、Redoc 或 TypeDoc 生成器。API 与
协议参考仍以普通文档写作。**工程推论：**OpenClaw 的自动化重点是站点生成、搜索和
翻译，而不是从机器可读 schema 派生 API 参考。

### 托管与部署

**源码事实：**自研构建产出静态文件和内容 manifest，将发生变化的对象上传到
Cloudflare R2，再由绑定 `openclaw-docs` bucket 的 Cloudflare Worker 提供服务
（[R2 工作流](https://github.com/openclaw/docs/blob/52403a5f8de349441af1179ba56f0c717804620b/.github/workflows/r2-pages.yml#L1-L80)、
[构建阶段](https://github.com/openclaw/docs/blob/52403a5f8de349441af1179ba56f0c717804620b/.github/workflows/r2-pages.yml#L180-L227)、
[Worker 绑定](https://github.com/openclaw/docs/blob/52403a5f8de349441af1179ba56f0c717804620b/wrangler.toml#L1-L12)）。
Worker 负责无扩展名 URL、Markdown 内容协商、搜索及旧域名重定向
（[路由实现](https://github.com/openclaw/docs/blob/52403a5f8de349441af1179ba56f0c717804620b/workers/docs-router.ts#L31-L112)）。

文档镜像仓库提供 build、smoke、visual 和 Node test 命令；Playwright 用于渲染站点
验收（[manifest scripts](https://github.com/openclaw/docs/blob/52403a5f8de349441af1179ba56f0c717804620b/package.json#L5-L31)）。

### 版本化与分析

**源码事实：**镜像会记录构建站点所用的精确源 commit，因而具备较强的源码溯源能力；
站点也发布 `releases/2026.8.1` 之类的独立发布说明页面。但它没有版本选择器，也没有
在版本化 URL 下保留每个 release 的完整文档树。R2 部署会在镜像 `main` 的文档变化时
运行（[源码溯源](https://github.com/openclaw/docs/blob/52403a5f8de349441af1179ba56f0c717804620b/.openclaw-sync/source.json#L1-L14)、
[发布说明导航](https://github.com/openclaw/docs/blob/52403a5f8de349441af1179ba56f0c717804620b/docs/docs.json#L2158-L2181)、
[部署触发](https://github.com/openclaw/docs/blob/52403a5f8de349441af1179ba56f0c717804620b/.github/workflows/r2-pages.yml#L4-L16)）。

**工程推论：**OpenClaw 可以证明当前文档来自哪个产品 commit，但它的公网文档仍是
持续滚动的当前文档，而不是每个 release/tag 的不可变文档快照。

固定快照的站点 manifest、构建器和公开配置中没有可见的访问者分析客户端或分析依赖。
这不能证明 Cloudflare 或其他外部边缘层没有分析能力。

## 3. 对 Codex Channel Bridge 的启示

两种上游技术栈都不能直接满足本项目已经确定的 release 与文档严格匹配规则：

- Hermes 的文档能力成熟且维护成本较低，但只从 `main` 发布一套滚动站点；
- OpenClaw 有良好的源码 SHA 溯源、翻译自动化、搜索和静态托管控制，但其自研构建器
  及 Worker/R2 体系需要维护更多代码，最终仍只发布一套滚动的当前文档。

建议下一步讨论的最小可维护方案是：

1. 使用 Docusaurus 与 Markdown/MDX：生成器参考 Hermes，信息架构参考 OpenClaw；
2. 使用 Docusaurus 标准 i18n 目录同时维护英文和中文；
3. 从每个 release tag 构建不可变文档，并发布到 `/docs/<version>/`；
4. `/docs/latest/` 指向最新稳定版，`/docs/next/` 明确对应 `main`；
5. 在生成产物中记录源码 commit、release tag、产品版本和文档版本，CI 在它们不一致时
   直接失败；
6. 首先使用 Docusaurus 自身的版本化能力和静态搜索；只有规模证明有必要时，才引入
   托管搜索、自动翻译或自定义边缘路由。

该方案复用两者已经验证的内容实践，但避免在 Bridge 仓库中维护一套 OpenClaw 规模的
自定义文档平台。
