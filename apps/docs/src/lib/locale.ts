/** Language and copy for docs URLs after Nimbus strips the deployment base. */
export type DocsLocale = "zh" | "en";

const messages = {
  zh: {
    htmlLang: "zh-CN", darkMode: "深色模式", breadcrumb: "当前位置", home: "概览", search: "搜索文档", skipContent: "跳至正文",
    language: "切换文档语言", openNavigation: "打开导航", closeNavigation: "关闭导航",
    sidebar: "文档导航", guides: "使用指南", development: "开发文档", onThisPage: "本页目录", jumpToSection: "跳至章节", overview: "概览",
    editPage: "编辑本页", previous: "上一篇", next: "下一篇", draft: "草稿", forHumans: "阅读指南",
    searching: "正在搜索…", searchEmpty: "输入关键词开始搜索…", searchMissing: "未找到结果。",
    searchUnavailable: "搜索暂时不可用。", searchBuild: "请构建文档并运行预览后使用搜索。", searchLoad: "无法加载搜索，请检查连接并刷新页面。", results: "搜索结果", navigate: "移动", select: "选择", close: "关闭",
    copyPage: "复制本页", copied: "已复制", copyFailed: "复制失败", viewMarkdown: "查看 Markdown", updated: "更新于",
  },
  en: {
    htmlLang: "en", darkMode: "Dark mode", breadcrumb: "Breadcrumb", home: "Overview", search: "Search documentation", skipContent: "Skip to content",
    language: "Change documentation language", openNavigation: "Open navigation", closeNavigation: "Close navigation",
    sidebar: "Documentation navigation", guides: "Guides", development: "Development", onThisPage: "On this page", jumpToSection: "Jump to section", overview: "Overview",
    editPage: "Edit this page", previous: "Previous", next: "Next", draft: "Draft", forHumans: "For humans",
    searching: "Searching…", searchEmpty: "Type to search…", searchMissing: "No results found.",
    searchUnavailable: "Search is temporarily unavailable.", searchBuild: "Search is available after a production build.", searchLoad: "Search could not load. Check your connection and reload the page.", results: "Results", navigate: "navigate", select: "select", close: "close",
    copyPage: "Copy page", copied: "Copied", copyFailed: "Couldn't copy", viewMarkdown: "View as Markdown", updated: "Updated",
  },
} as const;

/**
 * Read a locale from a deployment-base-free pathname; other pages use Chinese.
 * @param pathname - Path returned by Nimbus stripBase, without query or fragment.
 * @returns The documentation language.
 */
export function docsLocale(pathname: string): DocsLocale {
  return pathname.split("/").filter(Boolean)[0] === "en" ? "en" : "zh";
}

/**
 * Keep the current document when changing language; unknown routes use its overview.
 * @param pathname - Deployment-base-free pathname, without query or fragment.
 * @param locale - Destination documentation language.
 * @returns A canonical base-free URL that callers pass through Nimbus withBase.
 */
export function localizedPath(pathname: string, locale: DocsLocale): string {
  const segments = pathname.split("/").filter(Boolean);
  if (segments[0] !== "en" && segments[0] !== "zh") return `/${locale}/`;
  const document = segments.slice(1).join("/");
  return `/${locale}/${document}${document ? "/" : ""}`;
}

/**
 * Return the locale-owned interface copy shared by server and browser components.
 * @param locale - Documentation language.
 * @returns Copy and the HTML language tag for that locale.
 */
export function docsCopy(locale: DocsLocale) {
  return messages[locale];
}

/**
 * Translate a content-store identifier without assuming whether index files are collapsed.
 * @param entryId - Current docs collection identifier, if the page belongs to it.
 * @param locale - Destination language.
 * @returns Counterpart identifier, or undefined for a route outside localized docs.
 */
export function localizedEntryId(entryId: string | undefined, locale: DocsLocale): string | undefined {
  return entryId && /^(?:zh|en)(?:\/|$)/.test(entryId)
    ? entryId.replace(/^(?:zh|en)/, locale)
    : undefined;
}
