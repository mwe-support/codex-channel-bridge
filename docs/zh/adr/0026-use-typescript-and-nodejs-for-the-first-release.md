# 首版使用 TypeScript 和 Node.js

首版的 Bridge Core 与两个 Channel Adapter 将使用 TypeScript，并运行在受支持的 Node.js LTS Runtime 上。Monorepo 将 Core、Profile Worker、QQ Adapter、WhatsApp Adapter、Archive MCP Server、CLI 和平台打包保持为明确的 Package Boundary。这与 QQ 官方 Node SDK 和 Baileys 一致，可避免在首批 macOS、Linux、Windows 与 Docker 发行版中引入跨 Runtime 协议；只有后续获批 ADR 才能引入第二种 Runtime。
