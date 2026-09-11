import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Check, FolderOpenIcon, Languages, Monitor, Moon, Sun } from "lucide-react";
import { getWorkspaceSetting, setWorkspaceSetting, type WorkspaceSettingInfo } from "@/api";

import {
  loadCloseBehavior,
  loadTheme,
  loadUiFont,
  setCloseBehavior,
  setTheme,
  setUiFont,
  UI_FONTS,
  type CloseBehavior,
  type ThemePreference,
  type UiFontKey,
} from "@/lib/appearance";
import {
  loadLanguagePreference,
  setLanguagePreference,
  useT,
  type LanguagePreference,
} from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

/** 可选中卡片（语言/主题选项）：预览块 + 名称，选中时粗边框加角标。 */
function OptionCard({
  selected,
  label,
  preview,
  onClick,
}: {
  selected: boolean;
  label: string;
  preview: ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onClick}
      className={cn(
        "relative w-28 rounded-lg border-2 p-1 transition-colors",
        selected
          ? "border-primary"
          : "border-transparent hover:border-border",
      )}
    >
      <div className="flex h-14 items-center justify-center rounded-md bg-muted text-muted-foreground">
        {preview}
      </div>
      <div className="px-1 pt-2 pb-1 text-center text-sm">{label}</div>
      {selected ? (
        <span className="absolute -right-1.5 -top-1.5 flex size-5 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-sm">
          <Check size={12} strokeWidth={3} />
        </span>
      ) : null}
    </button>
  );
}

function SettingRow({
  label,
  description,
  children,
}: {
  label: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-8 py-4">
      <div className="min-w-0">
        <div className="text-sm font-medium">{label}</div>
        {description ? (
          <div className="mt-0.5 text-xs text-muted-foreground">{description}</div>
        ) : null}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

/** 默认工作区配置行：路径展示 + 系统目录选择对话框更改。 */
function WorkspaceRow() {
  const t = useT();
  const [setting, setSetting] = useState<WorkspaceSettingInfo>();
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);

  const refresh = useCallback(() => {
    void getWorkspaceSetting().then(setSetting).catch(() => undefined);
  }, []);

  useEffect(refresh, [refresh]);

  const change = async (dir?: string | null) => {
    if (saving) return;
    let next = dir;
    if (!next) {
      if ("__TAURI_INTERNALS__" in window) {
        try {
          const { open } = await import("@tauri-apps/plugin-dialog");
          const selected = await open({ directory: true, multiple: false });
          if (typeof selected !== "string") return;
          next = selected;
        } catch {
          return;
        }
      } else {
        const input = window.prompt(t("general.workspace.desc"));
        if (!input?.trim()) return;
        next = input.trim();
      }
    }
    setSaving(true);
    setError(undefined);
    try {
      setSetting(await setWorkspaceSetting(next));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "保存失败");
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingRow
      label={t("general.workspace")}
      description={setting ? undefined : t("general.workspace.desc")}
    >
      <div className="flex max-w-md flex-col items-end gap-1">
        <div className="flex items-center gap-2">
          <span
            className="max-w-64 truncate font-mono text-xs text-muted-foreground"
            title={setting?.path}
          >
            {setting?.path ?? "…"}
          </span>
          <Badge variant={setting?.configured ? "secondary" : "outline"}>
            {setting?.configured ? t("general.workspace.custom") : t("general.workspace.default")}
          </Badge>
          <Button size="sm" variant="outline" disabled={saving} onClick={() => void change()}>
            <FolderOpenIcon className="size-3.5" />
            {t("general.workspace.change")}
          </Button>
        </div>
        {setting ? (
          <span className="text-xs text-muted-foreground">{t("general.workspace.desc")}</span>
        ) : null}
        {error ? <span className="text-xs text-destructive">{error}</span> : null}
      </div>
    </SettingRow>
  );
}

/** 设置页的常规分区（参考 PI-Desktop 的常规页）：外观与关闭行为。 */
export function GeneralSection() {
  const t = useT();
  const [language, setLanguage] = useState<LanguagePreference>(loadLanguagePreference);
  const [theme, setThemeState] = useState<ThemePreference>(loadTheme);
  const [font, setFontState] = useState<UiFontKey>(loadUiFont);
  const [closeBehavior, setCloseBehaviorState] =
    useState<CloseBehavior>(loadCloseBehavior);

  const languageOptions: {
    value: LanguagePreference;
    label: string;
    preview: ReactNode;
  }[] = [
    { value: "system", label: t("general.language.system"), preview: <Languages size={20} /> },
    { value: "zh-CN", label: t("general.language.zh"), preview: <span className="text-base font-medium">文</span> },
    { value: "en", label: t("general.language.en"), preview: <span className="text-base font-medium">A</span> },
  ];

  const themeOptions: { value: ThemePreference; label: string; preview: ReactNode }[] = [
    { value: "system", label: t("general.theme.system"), preview: <Monitor size={20} /> },
    { value: "light", label: t("general.theme.light"), preview: <Sun size={20} /> },
    { value: "dark", label: t("general.theme.dark"), preview: <Moon size={20} /> },
  ];

  const closeOptions: { value: CloseBehavior; label: string }[] = [
    { value: "tray", label: t("general.close.tray") },
    { value: "quit", label: t("general.close.quit") },
  ];

  return (
    <div className="flex h-full flex-col">
      <div className="px-6 pt-6 pb-2">
        <h2 className="text-xl font-semibold">{t("general.title")}</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("general.description")}
        </p>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="px-6 pb-8">
          <section>
            <h3 className="py-2 text-xs font-medium text-muted-foreground">
              {t("general.workspace")}
            </h3>
            <WorkspaceRow />
          </section>
          <section>
            <h3 className="py-2 text-xs font-medium text-muted-foreground">
              {t("general.appearance")}
            </h3>
            <SettingRow
              label={t("general.language")}
              description={t("general.language.desc")}
            >
              <div className="flex gap-2">
                {languageOptions.map((option) => (
                  <OptionCard
                    key={option.value}
                    selected={language === option.value}
                    label={option.label}
                    preview={option.preview}
                    onClick={() => {
                      setLanguage(option.value);
                      setLanguagePreference(option.value);
                    }}
                  />
                ))}
              </div>
            </SettingRow>
            <Separator />
            <SettingRow
              label={t("general.theme")}
              description={t("general.theme.desc")}
            >
              <div className="flex gap-2">
                {themeOptions.map((option) => (
                  <OptionCard
                    key={option.value}
                    selected={theme === option.value}
                    label={option.label}
                    preview={option.preview}
                    onClick={() => {
                      setThemeState(option.value);
                      setTheme(option.value);
                    }}
                  />
                ))}
              </div>
            </SettingRow>
            <Separator />
            <SettingRow label={t("general.font")} description={t("general.font.desc")}>
              <Select
                value={font}
                onValueChange={(value) => {
                  const next = value as UiFontKey;
                  setFontState(next);
                  setUiFont(next);
                }}
              >
                <SelectTrigger className="w-40" aria-label={t("general.font")}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {UI_FONTS.map((option) => (
                    <SelectItem
                      key={option.key}
                      value={option.key}
                      style={{ fontFamily: option.stack }}
                    >
                      {t(option.labelKey)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </SettingRow>
          </section>
          <Separator className="my-2" />
          <section>
            <h3 className="py-2 text-xs font-medium text-muted-foreground">
              {t("general.close")}
            </h3>
            <SettingRow label={t("general.close.desc")}>
              <div className="inline-flex rounded-lg bg-muted p-1">
                {closeOptions.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    aria-pressed={closeBehavior === option.value}
                    onClick={() => {
                      setCloseBehaviorState(option.value);
                      setCloseBehavior(option.value);
                    }}
                    className={cn(
                      "rounded-md px-4 py-1.5 text-sm transition-colors",
                      closeBehavior === option.value
                        ? "bg-background font-medium shadow-sm"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </SettingRow>
          </section>
        </div>
      </ScrollArea>
    </div>
  );
}
