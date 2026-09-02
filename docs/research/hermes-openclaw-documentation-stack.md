# Hermes Agent and OpenClaw Documentation Technology Stacks

- Research date: 2026-09-01 (Asia/Shanghai)
- Evidence boundary: official repositories, first-party documentation source,
  manifests, and deployment workflows only.
- Evidence labels: **Source fact** is directly visible in the pinned source;
  **Inference** is an interpretation of those facts.

## Project identity and pinned snapshots

“Hermes” is ambiguous in this workspace. This report covers **Hermes Agent by
Nous Research**, not the historical Hermes gateway/plugin code that preceded
this standalone Bridge:

- Official repository: [`NousResearch/hermes-agent`](https://github.com/NousResearch/hermes-agent)
- Official documentation: [`hermes-agent.nousresearch.com/docs`](https://hermes-agent.nousresearch.com/docs/)
- Inspected commit: [`86b50fb43a7716a9fae59bc5539afc59e15d3f3b`](https://github.com/NousResearch/hermes-agent/commit/86b50fb43a7716a9fae59bc5539afc59e15d3f3b)

OpenClaw separates authored documentation from the published-site machinery:

- Authoritative English source: [`openclaw/openclaw/docs`](https://github.com/openclaw/openclaw/tree/d4354ffc8e917d7ba89b33a8f471fe98cba0ecbe/docs)
- Published mirror and site builder: [`openclaw/docs`](https://github.com/openclaw/docs)
- Inspected mirror commit: [`52403a5f8de349441af1179ba56f0c717804620b`](https://github.com/openclaw/docs/commit/52403a5f8de349441af1179ba56f0c717804620b)
- The mirror records its exact upstream content revision as
  [`d4354ffc8e917d7ba89b33a8f471fe98cba0ecbe`](https://github.com/openclaw/openclaw/commit/d4354ffc8e917d7ba89b33a8f471fe98cba0ecbe)
  in [`.openclaw-sync/source.json`](https://github.com/openclaw/docs/blob/52403a5f8de349441af1179ba56f0c717804620b/.openclaw-sync/source.json#L1-L14).
- Official documentation: [`docs.openclaw.ai`](https://docs.openclaw.ai/)

## Executive conclusion

The two sites do **not** use the same runtime stack.

| Area | Hermes Agent | OpenClaw |
|---|---|---|
| Generator | Docusaurus 3.10.2 | Custom Node.js static generator |
| Authoring dialect | Markdown and MDX | Mintlify-flavoured Markdown and MDX |
| Theme | Docusaurus classic preset plus custom CSS | Custom HTML/CSS/JS shell using OpenClaw Carapace assets |
| Navigation | Typed `sidebars.ts` | Mintlify-schema `docs.json`, parsed by the custom builder |
| Search | Hosted Algolia DocSearch | Static Pagefind in-browser search plus a Worker search endpoint |
| Hosting | GitHub Pages artifact; Vercel deploy hook also participates | Cloudflare R2 content behind a Cloudflare Worker router |
| Localization | Docusaurus i18n: English and Simplified Chinese | Published navigation: English plus 18 generated translations |
| Release-doc versioning | Rolling current docs | Rolling current docs with source-SHA provenance |

**Inference:** the reusable common denominator is Markdown/MDX, a Node build,
static artifacts, explicit navigation, localization, and CI validation. Copying
OpenClaw's custom renderer would also copy a substantial site-maintenance
burden. Docusaurus supplies the same basic documentation capabilities with far
less project-owned code.

## 1. Hermes Agent

### Framework, theme, and content

**Source fact:** Hermes uses Docusaurus `3.10.2`, the Docusaurus classic preset,
the Mermaid theme, React 19, and TypeScript. It pins these dependencies in the
[website manifest](https://github.com/NousResearch/hermes-agent/blob/86b50fb43a7716a9fae59bc5539afc59e15d3f3b/website/package.json#L21-L36).
The classic preset enables docs, disables the blog, and applies project-owned
CSS; Mermaid is enabled for Markdown diagrams
([configuration](https://github.com/NousResearch/hermes-agent/blob/86b50fb43a7716a9fae59bc5539afc59e15d3f3b/website/docusaurus.config.ts#L18-L41),
[preset](https://github.com/NousResearch/hermes-agent/blob/86b50fb43a7716a9fae59bc5539afc59e15d3f3b/website/docusaurus.config.ts#L76-L91)).

The primary corpus lives in `website/docs/` as Markdown and MDX. Project-owned
React pages/components add a Skills catalog and richer landing-page content;
prebuild scripts generate skill catalogs, automation catalogs, `llms.txt`, and
`llms-full.txt`
([prebuild contract](https://github.com/NousResearch/hermes-agent/blob/86b50fb43a7716a9fae59bc5539afc59e15d3f3b/website/scripts/prebuild.mjs#L1-L23),
[generated outputs](https://github.com/NousResearch/hermes-agent/blob/86b50fb43a7716a9fae59bc5539afc59e15d3f3b/website/scripts/prebuild.mjs#L122-L145)).

### Navigation and content distribution

**Source fact:** navigation is manually curated in
[`website/sidebars.ts`](https://github.com/NousResearch/hermes-agent/blob/86b50fb43a7716a9fae59bc5539afc59e15d3f3b/website/sidebars.ts).
Its main information architecture is:

- Getting Started;
- Using Hermes;
- Features, with Core, Automation, Media & Web, Management, and Skills;
- Messaging Platforms;
- Integrations;
- Guides and Tutorials;
- Developer Guide;
- Reference.

Navbar and footer links surface the Docs, Skills, Download, developer guide,
reference, source repository, and community
([navbar](https://github.com/NousResearch/hermes-agent/blob/86b50fb43a7716a9fae59bc5539afc59e15d3f3b/website/docusaurus.config.ts#L119-L161),
[footer](https://github.com/NousResearch/hermes-agent/blob/86b50fb43a7716a9fae59bc5539afc59e15d3f3b/website/docusaurus.config.ts#L163-L192)).

### Search, localization, and reference generation

**Source fact:** search is Algolia DocSearch with contextual locale filtering;
the repository contains only the public search credentials and states that the
index is populated by Algolia Crawler
([search configuration](https://github.com/NousResearch/hermes-agent/blob/86b50fb43a7716a9fae59bc5539afc59e15d3f3b/website/docusaurus.config.ts#L93-L108)).

Docusaurus i18n is configured for English and Simplified Chinese, with a locale
switcher in the navbar. Chinese content is stored under
`website/i18n/zh-Hans/docusaurus-plugin-content-docs/current/`
([locale configuration](https://github.com/NousResearch/hermes-agent/blob/86b50fb43a7716a9fae59bc5539afc59e15d3f3b/website/docusaurus.config.ts#L25-L37),
[locale switcher](https://github.com/NousResearch/hermes-agent/blob/86b50fb43a7716a9fae59bc5539afc59e15d3f3b/website/docusaurus.config.ts#L142-L145)).

No OpenAPI, Redoc, or TypeDoc integration is present in the pinned website
manifest or configuration. Reference pages are Markdown/MDX; selected catalogs
are generated by repository scripts. **Inference:** this is a prose-first docs
site with targeted code-derived reference generation, not an API-reference
portal.

### Hosting and deployment

**Source fact:** GitHub Actions builds the bilingual Docusaurus site and uploads
it as a GitHub Pages artifact. The workflow runs for relevant pushes to `main`,
published releases, and manual dispatch
([triggers](https://github.com/NousResearch/hermes-agent/blob/86b50fb43a7716a9fae59bc5539afc59e15d3f3b/.github/workflows/deploy-site.yml#L1-L23),
[build and staging](https://github.com/NousResearch/hermes-agent/blob/86b50fb43a7716a9fae59bc5539afc59e15d3f3b/.github/workflows/deploy-site.yml#L161-L190),
[Pages upload](https://github.com/NousResearch/hermes-agent/blob/86b50fb43a7716a9fae59bc5539afc59e15d3f3b/.github/workflows/deploy-site.yml#L247-L250)).
The same workflow invokes a Vercel deploy hook for releases and manual
deployments
([Vercel job](https://github.com/NousResearch/hermes-agent/blob/86b50fb43a7716a9fae59bc5539afc59e15d3f3b/.github/workflows/deploy-site.yml#L35-L47)).
The exact public edge topology cannot be proven solely from the checked-in
configuration.

CI installs dependencies, regenerates derived catalogs, lints diagrams, and
builds the English locale; the full bilingual build runs in deployment
([docs checks](https://github.com/NousResearch/hermes-agent/blob/86b50fb43a7716a9fae59bc5539afc59e15d3f3b/.github/workflows/docs-site-checks.yml#L26-L55)).

### Versioning and analytics

**Source fact:** the website package version is `0.0.0`; the pinned tree has no
Docusaurus `versions.json`, `versioned_docs`, version dropdown, or versioned
docs configuration. Deployment from `main` means the public site is a rolling
current-documentation site, even though a release publication also triggers a
build
([manifest](https://github.com/NousResearch/hermes-agent/blob/86b50fb43a7716a9fae59bc5539afc59e15d3f3b/website/package.json#L1-L10),
[deploy triggers](https://github.com/NousResearch/hermes-agent/blob/86b50fb43a7716a9fae59bc5539afc59e15d3f3b/.github/workflows/deploy-site.yml#L3-L12)).

No site analytics integration is visible in the public website manifest or
Docusaurus configuration. This does not prove that no analytics exist outside
the repository or at the hosting edge.

## 2. OpenClaw

### Authoring format versus actual site runtime

**Source fact:** OpenClaw authors English documentation inside the product
repository and mirrors it into `openclaw/docs`; generated locale output is
committed only in the mirror
([mirror contract](https://github.com/openclaw/docs/blob/52403a5f8de349441af1179ba56f0c717804620b/README.md#L6-L17),
[editing rules](https://github.com/openclaw/docs/blob/52403a5f8de349441af1179ba56f0c717804620b/README.md#L31-L36)).

The content remains **Mintlify-flavoured**: `docs/docs.json` declares the
Mintlify schema, the `mint` theme, Lucide icons, typography, colors, redirects,
languages, tabs, groups, and page lists
([configuration header](https://github.com/openclaw/docs/blob/52403a5f8de349441af1179ba56f0c717804620b/docs/docs.json#L1-L49),
[navigation start](https://github.com/openclaw/docs/blob/52403a5f8de349441af1179ba56f0c717804620b/docs/docs.json#L1171-L1205)).

However, **the current published stack is not the hosted Mintlify runtime**.
The mirror's own Node scripts parse that configuration and Markdown/MDX, render
static HTML, build navigation and locale routes, and produce a custom site
shell. Its dependencies are `markdown-it`, MDX, Mermaid, Highlight.js, Lucide,
Pagefind, Playwright, and the OpenClaw Carapace design package
([build scripts and dependencies](https://github.com/openclaw/docs/blob/52403a5f8de349441af1179ba56f0c717804620b/package.json#L1-L36),
[builder entry](https://github.com/openclaw/docs/blob/52403a5f8de349441af1179ba56f0c717804620b/scripts/docs-site/build.mjs)).

**Inference:** Mintlify is now an authoring/configuration compatibility format
and legacy/backup surface; OpenClaw owns the rendering and hosting machinery.

### Navigation and content distribution

**Source fact:** `docs.json` is the single explicit navigation tree. It repeats
tabs and groups per language. The English top-level distribution includes:

- Get started and installation;
- product concepts and channel/provider guides;
- Gateway operation and security;
- tools, automation, nodes, and platforms;
- plugin development and references;
- help, diagnostics, and troubleshooting;
- Release & CI, including release notes, release process, maturity, and tests.

The documentation corpus is Markdown/MDX with frontmatter fields such as
`title`, `summary`, `read_when`, status, applicability, and release metadata;
the custom builder derives routes, tables of contents, previous/next links,
Open Graph cards, `llms` output, robots, and sitemaps
([page collection](https://github.com/openclaw/docs/blob/52403a5f8de349441af1179ba56f0c717804620b/scripts/docs-site/build.mjs#L87-L153)).

### Search, localization, and reference generation

**Source fact:** browser search is built statically with Pagefind. The build
also generates a separate search index consumed by the Cloudflare Worker's
`/api/search` endpoint and its small documentation-search MCP surface
([build pipeline](https://github.com/openclaw/docs/blob/52403a5f8de349441af1179ba56f0c717804620b/package.json#L5-L20),
[Worker routes](https://github.com/openclaw/docs/blob/52403a5f8de349441af1179ba56f0c717804620b/workers/docs-router.ts#L42-L80),
[search implementation](https://github.com/openclaw/docs/blob/52403a5f8de349441af1179ba56f0c717804620b/workers/docs-router.ts#L207-L256)).
That Worker/API index deliberately excludes locale paths, so this secondary
search surface is English-only
([index filter](https://github.com/openclaw/docs/blob/52403a5f8de349441af1179ba56f0c717804620b/scripts/docs-site/search-index.mjs#L19-L43)).

The published navigation supports English plus 18 translations, including
Simplified and Traditional Chinese. The mirror can contain additional generated
locale directories that are not exposed by the current navigation. Translation
workflows use source hashes, translate only
pending files for routine changes, retry failures, aggregate locale artifacts,
and run scheduled full reconciliation
([translation behavior](https://github.com/openclaw/docs/blob/52403a5f8de349441af1179ba56f0c717804620b/README.md#L19-L29),
[incremental trigger](https://github.com/openclaw/docs/blob/52403a5f8de349441af1179ba56f0c717804620b/.github/workflows/translate-incremental.yml#L1-L43)).

No OpenAPI, Swagger, Redoc, or TypeDoc generator is present in the pinned site
manifest/build. API and protocol references are authored as ordinary docs.
**Inference:** OpenClaw's automation is aimed at site generation, search, and
translation rather than deriving API reference from a machine-readable schema.

### Hosting and deployment

**Source fact:** the custom build produces static artifacts and a content
manifest, uploads changed objects to Cloudflare R2, and serves them through a
Cloudflare Worker bound to the `openclaw-docs` bucket
([R2 workflow](https://github.com/openclaw/docs/blob/52403a5f8de349441af1179ba56f0c717804620b/.github/workflows/r2-pages.yml#L1-L80),
[build stage](https://github.com/openclaw/docs/blob/52403a5f8de349441af1179ba56f0c717804620b/.github/workflows/r2-pages.yml#L180-L227),
[Worker binding](https://github.com/openclaw/docs/blob/52403a5f8de349441af1179ba56f0c717804620b/wrangler.toml#L1-L12)).
The Worker owns clean URLs, Markdown content negotiation, search, and legacy
host redirects
([router](https://github.com/openclaw/docs/blob/52403a5f8de349441af1179ba56f0c717804620b/workers/docs-router.ts#L31-L112)).

Build, smoke, visual, and Node test commands are checked into the docs mirror;
Playwright supplies rendered-site validation
([manifest scripts](https://github.com/openclaw/docs/blob/52403a5f8de349441af1179ba56f0c717804620b/package.json#L5-L31)).

### Versioning and analytics

**Source fact:** the mirror records the exact source commit used to build the
site, which gives strong provenance. It also publishes dated release-note pages
such as `releases/2026.8.1`. It does **not** expose a version-selector or retain
the complete docs tree at a versioned URL. The R2 deployment runs when the
mirror's `main` documentation changes
([source provenance](https://github.com/openclaw/docs/blob/52403a5f8de349441af1179ba56f0c717804620b/.openclaw-sync/source.json#L1-L14),
[release-note navigation](https://github.com/openclaw/docs/blob/52403a5f8de349441af1179ba56f0c717804620b/docs/docs.json#L2158-L2181),
[deployment trigger](https://github.com/openclaw/docs/blob/52403a5f8de349441af1179ba56f0c717804620b/.github/workflows/r2-pages.yml#L4-L16)).

**Inference:** OpenClaw can identify which product commit supplied the current
docs, but its public documentation is still rolling documentation rather than
an immutable docs snapshot per release/tag.

No visitor analytics client or analytics dependency is visible in the pinned
site manifest, builder, or public configuration. This does not prove that no
analytics exist at Cloudflare or another external edge.

## 3. Implications for Codex Channel Bridge

Neither upstream stack provides the Bridge's required release/documentation
coupling without additional policy:

- Hermes has mature, low-maintenance documentation features, but deploys a
  single rolling site from `main`.
- OpenClaw provides excellent source-SHA provenance, localization automation,
  search, and static hosting control, but its custom builder and Worker/R2
  system are substantially more code to own and still publish one rolling
  current corpus.

The minimum maintainable design to discuss next is therefore:

1. use Docusaurus and Markdown/MDX, following Hermes for the generator and
   OpenClaw for the information architecture;
2. keep English and Chinese in Docusaurus's standard i18n layout;
3. build one immutable docs artifact from each release tag and publish it under
   `/docs/<version>/`;
4. make `/docs/latest/` an alias to the newest stable release and keep
   `/docs/next/` explicitly tied to `main`;
5. retain the source commit, release tag, product version, and docs version in
   the generated artifact and fail CI when they differ;
6. start with Docusaurus's own versioning and a static search option; add hosted
   search, automated translation, or a custom edge router only after scale
   demonstrates the need.

This recommendation reuses the proven content practices while avoiding an
OpenClaw-sized custom documentation platform in the Bridge repository.
