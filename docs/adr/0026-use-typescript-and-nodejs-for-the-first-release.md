# Use TypeScript and Node.js for the first release

The first release will use TypeScript on a supported Node.js LTS runtime for the Bridge core and both Channel adapters. A monorepo will keep core, Profile worker, QQ adapter, WhatsApp adapter, Archive MCP Server, CLI, and platform packaging behind explicit package boundaries. This aligns with the official QQ Node SDK and Baileys, avoids a cross-runtime protocol in the initial macOS, Linux, Windows, and Docker distributions, and leaves a second runtime contingent on a later accepted ADR.
