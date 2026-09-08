import { useCallback, useSyncExternalStore } from "react";

export type LanguagePreference = "system" | "zh-CN" | "en";
export type Language = "zh-CN" | "en";

const LANGUAGE_KEY = "openharness.language";

const zh: Record<string, string> = {
  "settings.back": "返回",

  "nav.group.preferences": "偏好",
  "nav.group.agents": "智能体",
  "nav.group.workspace": "工作区",
  "nav.general": "常规",
  "nav.projects": "项目",
  "nav.archive": "归档",
  "nav.agents": "Agent",
  "nav.subagents": "子智能体",
  "nav.skills": "技能",
  "nav.mcp": "MCP",
  "nav.models": "模型",
  "nav.tools": "工具",

  "general.title": "常规",
  "general.description": "配置应用的外观与基础行为。",
  "general.appearance": "外观",
  "general.language": "语言",
  "general.language.desc": "界面显示语言",
  "general.language.system": "跟随系统",
  "general.language.zh": "简体中文",
  "general.language.en": "English",
  "general.theme": "主题",
  "general.theme.desc": "应用的深浅色外观",
  "general.theme.system": "系统",
  "general.theme.light": "浅色",
  "general.theme.dark": "深色",
  "general.font": "字体",
  "general.font.desc": "全局界面字体",
  "general.font.default": "默认",
  "general.font.system": "系统 UI",
  "general.font.yahei": "微软雅黑",
  "general.font.dengxian": "等线",
  "general.font.simsun": "宋体",
  "general.font.simhei": "黑体",
  "general.font.kaiti": "楷体",
  "general.close": "关闭行为",
  "general.close.desc": "关闭主窗口时：",
  "general.close.tray": "关闭到托盘",
  "general.close.quit": "退出应用",
};

const en: Record<string, string> = {
  "settings.back": "Back",

  "nav.group.preferences": "Preferences",
  "nav.group.agents": "Agents",
  "nav.group.workspace": "Workspace",
  "nav.general": "General",
  "nav.projects": "Projects",
  "nav.archive": "Archive",
  "nav.agents": "Agent",
  "nav.subagents": "Sub-agents",
  "nav.skills": "Skills",
  "nav.mcp": "MCP",
  "nav.models": "Models",
  "nav.tools": "Tools",

  "general.title": "General",
  "general.description": "Configure appearance and basic app behavior.",
  "general.appearance": "Appearance",
  "general.language": "Language",
  "general.language.desc": "Interface display language",
  "general.language.system": "Follow system",
  "general.language.zh": "简体中文",
  "general.language.en": "English",
  "general.theme": "Theme",
  "general.theme.desc": "Light or dark appearance",
  "general.theme.system": "System",
  "general.theme.light": "Light",
  "general.theme.dark": "Dark",
  "general.font": "Font",
  "general.font.desc": "Global interface font",
  "general.font.default": "Default",
  "general.font.system": "System UI",
  "general.font.yahei": "Microsoft YaHei",
  "general.font.dengxian": "DengXian",
  "general.font.simsun": "SimSun",
  "general.font.simhei": "SimHei",
  "general.font.kaiti": "KaiTi",
  "general.close": "Close behavior",
  "general.close.desc": "When the main window is closed:",
  "general.close.tray": "Close to tray",
  "general.close.quit": "Quit app",
};

const DICTIONARIES: Record<Language, Record<string, string>> = {
  "zh-CN": zh,
  en,
};

export function loadLanguagePreference(): LanguagePreference {
  const stored = localStorage.getItem(LANGUAGE_KEY);
  return stored === "zh-CN" || stored === "en" ? stored : "system";
}

function resolveSystemLanguage(): Language {
  return navigator.language.toLowerCase().startsWith("zh") ? "zh-CN" : "en";
}

export function resolveLanguage(
  preference: LanguagePreference = loadLanguagePreference(),
): Language {
  return preference === "system" ? resolveSystemLanguage() : preference;
}

const listeners = new Set<() => void>();

function notify() {
  for (const listener of listeners) listener();
}

export function setLanguagePreference(preference: LanguagePreference) {
  localStorage.setItem(LANGUAGE_KEY, preference);
  document.documentElement.lang = resolveLanguage();
  notify();
}

/** 启动时把有效语言同步到 <html lang>。StrictMode 下重复调用安全。 */
let initialized = false;
export function initLanguage() {
  if (initialized) return;
  initialized = true;
  document.documentElement.lang = resolveLanguage();
}

function subscribe(callback: () => void) {
  listeners.add(callback);
  return () => {
    listeners.delete(callback);
  };
}

/** 当前有效语言（跟随系统时已解析为 zh-CN / en）。 */
export function useLanguage(): Language {
  return useSyncExternalStore(
    subscribe,
    () => resolveLanguage(),
    () => "zh-CN",
  );
}

export function translate(language: Language, key: string): string {
  return DICTIONARIES[language][key] ?? zh[key] ?? key;
}

/** 绑定当前语言的翻译函数；语言切换时使用它的组件会重新渲染。 */
export function useT() {
  const language = useLanguage();
  return useCallback((key: string) => translate(language, key), [language]);
}
