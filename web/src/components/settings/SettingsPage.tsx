import { useState } from "react";
import { Archive, ArrowLeft, Bot, BotIcon, Cloud, FolderOpen, Settings, Sparkles, Wrench } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { SidebarPeekTrigger } from "@/components/SidebarPeekTrigger";
import {
  isTauriWindow,
  windowControlsReserveClass,
} from "@/components/WindowControls";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { GeneralSection } from "./GeneralSection";
import { ArchiveSection } from "./ArchiveSection";
import { ProvidersSection } from "./ProvidersSection";
import { AgentsSection } from "./AgentsSection";
import { ProjectsSection } from "./ProjectsSection";
import { SkillsSection } from "./SkillsSection";
import { SubAgentsSection } from "./SubAgentsSection";
import { ToolsSection } from "./ToolsSection";

export type SettingsSectionKey =
  | "general"
  | "projects"
  | "archive"
  | "agents"
  | "subagents"
  | "skills"
  | "models"
  | "tools";

/** 分组导航（参考 PI-Desktop：偏好 / 智能体 / 工作区）。 */
const NAV_GROUPS: {
  labelKey: string;
  items: {
    key: SettingsSectionKey;
    labelKey: string;
    icon: typeof Cloud;
  }[];
}[] = [
  {
    labelKey: "nav.group.preferences",
    items: [{ key: "general", labelKey: "nav.general", icon: Settings }],
  },
  {
    labelKey: "nav.group.agents",
    items: [
      { key: "agents", labelKey: "nav.agents", icon: Bot },
      { key: "subagents", labelKey: "nav.subagents", icon: BotIcon },
      { key: "skills", labelKey: "nav.skills", icon: Sparkles },
      { key: "models", labelKey: "nav.models", icon: Cloud },
      { key: "tools", labelKey: "nav.tools", icon: Wrench },
    ],
  },
  {
    labelKey: "nav.group.workspace",
    items: [
      { key: "projects", labelKey: "nav.projects", icon: FolderOpen },
      { key: "archive", labelKey: "nav.archive", icon: Archive },
    ],
  },
];

const NAV_ITEMS = NAV_GROUPS.flatMap((group) => group.items);

interface SettingsPageProps {
  onExit: () => void;
  onChanged?: () => void;
  /** 初始展示的分区（全局搜索等入口直达用；配合外层 key 重挂载生效）。 */
  initialSection?: SettingsSectionKey;
}

export function SettingsPage({ onExit, onChanged, initialSection }: SettingsPageProps) {
  const t = useT();
  const [section, setSection] = useState<SettingsSectionKey>(
    initialSection ?? "general",
  );
  const active = NAV_ITEMS.find((item) => item.key === section) ?? NAV_ITEMS[0];

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
      {/* 无边框窗口下兼任标题栏：空白处可拖拽窗口，右侧留给自绘窗口按钮。 */}
      <header
        data-tauri-drag-region="deep"
        className={cn(
          "flex h-11 shrink-0 items-center gap-3 border-b px-4 select-none",
          isTauriWindow() && windowControlsReserveClass,
        )}
      >
        <SidebarPeekTrigger />
        <Button variant="ghost" size="icon-sm" onClick={onExit} title={t("settings.back")}>
          <ArrowLeft size={16} />
        </Button>
        <Separator orientation="vertical" className="h-4!" />
        <span className="truncate text-sm text-muted-foreground">{t(active.labelKey)}</span>
      </header>

      <div className="flex min-h-0 flex-1">
        <nav className="h-full w-48 shrink-0 overflow-y-auto border-r p-4">
          {NAV_GROUPS.map((group, groupIndex) => (
            <div key={group.labelKey} className={groupIndex > 0 ? "mt-5" : undefined}>
              <div className="px-3 pb-1.5 text-xs font-medium text-muted-foreground">
                {t(group.labelKey)}
              </div>
              <ul className="space-y-1">
                {group.items.map((item) => (
                  <li key={item.key}>
                    <button
                      type="button"
                      aria-current={section === item.key ? "page" : undefined}
                      className={cn(
                        "flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors hover:bg-muted",
                        section === item.key &&
                          "bg-accent text-accent-foreground hover:bg-accent",
                      )}
                      onClick={() => setSection(item.key)}
                    >
                      <item.icon size={16} />
                      <span className="truncate">{t(item.labelKey)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>

        <div className="min-w-0 flex-1 overflow-y-auto">
          {section === "general" ? <GeneralSection /> : null}
          {section === "projects" ? <ProjectsSection onChanged={onChanged} /> : null}
          {section === "archive" ? <ArchiveSection onChanged={onChanged} /> : null}
          {section === "agents" ? <AgentsSection onChanged={onChanged} /> : null}
          {section === "subagents" ? <SubAgentsSection /> : null}
          {section === "skills" ? <SkillsSection /> : null}
          {section === "models" ? <ProvidersSection onChanged={onChanged} /> : null}
          {section === "tools" ? <ToolsSection /> : null}
        </div>
      </div>
    </section>
  );
}
