import type { Config } from "@docusaurus/types";
import type { Options, ThemeConfig } from "@docusaurus/preset-classic";

const config: Config = {
  title: "Codex Channel Bridge",
  tagline: "Connect QQ and WhatsApp conversations directly to Codex App Server",
  url: process.env.DOCS_URL ?? "http://localhost:3000",
  baseUrl: process.env.DOCS_BASE_URL ?? "/",
  noIndex: true,
  onBrokenLinks: "throw",
  markdown: {
    format: "detect",
    hooks: {
      onBrokenMarkdownLinks: "throw"
    }
  },
  i18n: {
    defaultLocale: "en",
    locales: ["en", "zh-Hans"],
    localeConfigs: {
      en: { label: "English" },
      "zh-Hans": { label: "简体中文", htmlLang: "zh-CN" }
    }
  },
  presets: [
    [
      "classic",
      {
        docs: {
          path: "../docs",
          routeBasePath: "docs",
          sidebarPath: "./sidebars.ts",
          exclude: ["zh/**"],
          lastVersion: "current",
          versions: {
            current: {
              label: "Next",
              path: "next",
              banner: "unreleased"
            },
            "0.2.0-rc.1": {
              label: "0.2.0-rc.1 (prerelease)",
              path: "0.2.0-rc.1",
              banner: "none"
            },
            "0.1.0-rc.4": {
              label: "0.1.0-rc.4 (prerelease)",
              path: "0.1.0-rc.4",
              banner: "none"
            }
          }
        },
        blog: false
      } satisfies Options
    ]
  ],
  themeConfig: {
    colorMode: { respectPrefersColorScheme: true },
    navbar: {
      title: "Codex Channel Bridge",
      items: [
        { type: "docSidebar", sidebarId: "docs", label: "Docs", position: "left" },
        { type: "docsVersionDropdown", position: "right" },
        { type: "localeDropdown", position: "right" }
      ]
    },
    footer: {
      style: "dark",
      copyright: "Copyright © 2026 Codex Channel Bridge contributors"
    }
  } satisfies ThemeConfig
};

export default config;
