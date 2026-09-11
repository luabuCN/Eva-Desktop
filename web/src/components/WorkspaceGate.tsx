import { useEffect, useState } from "react";
import { FolderOpenIcon, Loader2Icon } from "lucide-react";
import {
  getWorkspaceSetting,
  setWorkspaceSetting,
  type WorkspaceSettingInfo,
} from "@/api";

/** Tauri 桌面环境检测（v2 注入 __TAURI_INTERNALS__）。 */
function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** 系统目录选择对话框；非 Tauri 环境返回 null（走手动输入）。 */
async function pickDirectory(): Promise<string | null> {
  if (!isTauri()) return null;
  try {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const selected = await open({ directory: true, multiple: false });
    return typeof selected === "string" ? selected : null;
  } catch {
    return null;
  }
}

export interface WorkspaceGateProps {
  /** 工作区已就绪（已配置或用户本次选定）后放行进入主界面。 */
  onReady: () => void;
}

/**
 * 首次启动的工作区引导：默认工作区未配置过时以全屏遮罩拦住主界面，
 * 用户必须选择一次（自定义目录或采纳默认位置）才能进入。此后在
 * 设置 → 常规 里随时可改。
 */
export function WorkspaceGate({ onReady }: WorkspaceGateProps) {
  const [setting, setSetting] = useState<WorkspaceSettingInfo>();
  const [manualPath, setManualPath] = useState("");
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void getWorkspaceSetting()
      .then((info) => {
        // 已配置过：直接放行（引导只在真正首次出现）。
        if (info.configured) onReady();
        else setSetting(info);
      })
      .catch(() =>
        setError("无法连接本地服务，请确认应用已完全启动后重试"),
      );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const apply = async (path: string) => {
    if (saving || !path.trim()) return;
    setSaving(true);
    setError(undefined);
    try {
      await setWorkspaceSetting(path);
      onReady();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "保存工作区失败，请重试");
      setSaving(false);
    }
  };

  const browse = async () => {
    const dir = await pickDirectory();
    if (dir) void apply(dir);
    // 非 Tauri / 用户取消：留在引导页，可走手动输入
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/95 backdrop-blur">
      <div className="mx-6 w-full max-w-lg rounded-2xl border bg-card p-8 shadow-xl">
        <div className="flex items-center gap-3">
          <div className="flex size-11 items-center justify-center rounded-xl bg-primary/10 text-primary">
            <FolderOpenIcon className="size-5" />
          </div>
          <div>
            <h1 className="text-lg font-semibold">选择默认工作区</h1>
            <p className="text-xs text-muted-foreground">首次使用需要设置一次，之后可随时在 设置 → 常规 中修改</p>
          </div>
        </div>

        <p className="mt-5 text-sm leading-relaxed text-muted-foreground">
          默认工作区是智能体读写文件、保存生成页面与附件的根目录——
          不属于任何项目的会话都会在这里工作。你可以指向一个常用的代码目录，
          也可以先采用默认位置。
        </p>

        {setting ? (
          <div className="mt-4 rounded-lg border bg-muted/40 px-3 py-2">
            <div className="text-xs text-muted-foreground">默认位置</div>
            <div className="mt-0.5 break-all font-mono text-xs">{setting.defaultPath}</div>
          </div>
        ) : null}

        {error ? <p className="mt-3 text-xs text-destructive">{error}</p> : null}

        <div className="mt-5 flex flex-col gap-2">
          <button
            type="button"
            disabled={saving}
            onClick={() => void browse()}
            className="flex items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
          >
            {saving ? <Loader2Icon className="size-4 animate-spin" /> : <FolderOpenIcon className="size-4" />}
            浏览并选择文件夹
          </button>
          <button
            type="button"
            disabled={saving || !setting}
            onClick={() => setting && void apply(setting.defaultPath)}
            className="rounded-lg border px-4 py-2.5 text-sm transition-colors hover:bg-accent disabled:opacity-50"
          >
            使用默认位置
          </button>

          {!isTauri() ? (
            <div className="mt-1 flex gap-2">
              <input
                className="min-w-0 flex-1 rounded-md border bg-background px-3 py-2 font-mono text-xs outline-none focus:ring-2 focus:ring-primary/40"
                placeholder="浏览器模式下请手动输入绝对路径…"
                value={manualPath}
                onChange={(event) => setManualPath(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void apply(manualPath);
                }}
              />
              <button
                type="button"
                disabled={saving || !manualPath.trim()}
                onClick={() => void apply(manualPath)}
                className="shrink-0 rounded-lg border px-3 py-2 text-xs transition-colors hover:bg-accent disabled:opacity-50"
              >
                保存
              </button>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
