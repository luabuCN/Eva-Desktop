<div align="center">

<img src="docs/images/logo.png" alt="Eva Desktop logo" width="120" />

# Eva Desktop

**A local-first AI agent desktop client**

Bring your own models. Your conversations, workspace, and data stay on your machine.

[![Release](https://img.shields.io/github/v/release/luabuCN/OpenHarness-Desktop?include_prereleases&label=release)](https://github.com/luabuCN/OpenHarness-Desktop/releases/latest)
[![CI](https://img.shields.io/github/actions/workflow/status/luabuCN/OpenHarness-Desktop/ci.yml?label=CI)](https://github.com/luabuCN/OpenHarness-Desktop/actions/workflows/ci.yml)
![Platforms](https://img.shields.io/badge/platform-Windows%20%C2%B7%20macOS%20%C2%B7%20Linux-4c8dd8)

[Download](#download) · [Getting started](#getting-started) · [Highlights](#highlights) · [Skills](#skills) · [How it works](#how-it-works) · [Development](#development) · [简体中文](README.md)

<br/>

<img src="docs/images/hero.png" alt="Eva Desktop workbench with project-grouped sidebar and a web-search conversation" width="88%" />

</div>

## What is Eva Desktop?

Eva Desktop puts a tool-using AI agent in a native desktop app: read files, edit code, run Git, search the web, delegate to subagents — with every step surfaced for your approval. There is no account and no cloud in the middle: connect the model provider you already use, and everything else — sessions, settings, API keys — stays local.

## Highlights

- **Any model, your keys.** 24 preset providers (OpenAI, Anthropic, DeepSeek, Zhipu, Tongyi, Moonshot, SiliconFlow, OpenRouter, Groq, …), any OpenAI-compatible endpoint, and local gateways like Ollama / LM Studio. Configure several providers and switch per conversation.
- **A workspace that works.** File browsing and reading, code editing, workspace change tracking, and Git tools. Writes ask first ("confirm before changes" by default); the `bash` tool is off unless you enable it.
- **Background subagents.** Delegate separable work — wide searches, multi-file changes — to subagents that run in their own context and report back via Delegate / DelegateWait. When a decision is needed, the agent asks you with interactive `askUser` prompts.
- **Web search out of the box.** `webSearch` / `webFetch` work with zero configuration (keyless Sogou / DuckDuckGo fallback); add a key to upgrade to Tavily / Bocha / Brave / Zhipu.
- **SKILL.md skills.** Type `/` to open the skill menu. The app also scans your local Claude Code / Codex / cc-switch skill directories, and custom skills can be managed in Settings.
- **Project instructions (AGENTS.md).** Drop an `AGENTS.md` at the workspace root (`CLAUDE.md` / `EVA.md` also recognized, first match wins) and it is injected into the system prompt every turn: write project conventions, commands, and coding style once — the main agent and delegated subagents both follow them (auto-truncated past 32K characters).
- **Automatic context compaction.** When a long session's estimated tokens pass roughly 70% of the context window, older messages are summarized into a persistent brief and the model continues with "summary + recent messages" — no more mid-task amnesia from hard truncation. Chat history and replay stay intact; compaction failures fall back to hard truncation.
- **Plan mode.** Switch the permission mode to "Plan" and the agent researches read-only first — every mutating tool and command is blocked at runtime and redirected toward planning. It then presents a markdown plan via ExitPlanMode; approve it to continue (auto-edit mode), approve with full access for the rest of the turn, or reject with feedback for a revised plan. On approval the same turn continues executing, and already-spawned subagents unlock too.
- **Command-level allow rules.** Approvals get command granularity: a built-in table of read-only commands (git status / diff / log, ls, cat, grep, Get-ChildItem, ...) runs without prompting; choose "Always allow this command" on a command approval card to create a prefix rule in one click (global or per-project), or manage rules under **Settings → Tools**. Safety rails: compound commands are checked segment by segment (`git status && rm -rf /` still prompts), commands with redirects or substitution (`>`, `$()`, backticks) are never auto-approved, matching is token-boundary based ("pnpm test" does not match "pnpm test2"), and dangerous commands (rm, git push, ...) refuse rule creation.
- **Built-in terminal.** A new "Terminal" tab in the right panel: a full interactive shell (PowerShell on Windows, $SHELL elsewhere) with the project root as cwd, multiple sessions, resize support, and 256-color output. You drive it directly — it never goes through the agent's approval chain. Output keeps a 256KB ring buffer, so switching tabs or reloading replays history; exited sessions reopen in one click. Powered by node-pty in dev mode; packaged sidecars don't ship the native module yet, so the tab shows an unavailable notice there (everything else keeps working).
- **Configurable default workspace.** First launch guides you through picking the default workspace — the root directory for agent file operations, generated files, and attachments. Browse to a folder you use daily or accept the default location; change it any time under **Settings → General**, and the file browser, terminal cwd, and project-less sessions switch immediately.
- **MCP servers.** Add stdio (local process) or HTTP (Streamable HTTP / SSE) servers under **Settings → MCP**, with global / per-project scopes, connection testing, and tool introspection. Enabled servers contribute their tools to the model as `mcp__<server>__<tool>`, governed by the same permission and approval policies as built-in tools.
- **Projects and sessions.** A multi-project sidebar with pinning, archiving, and renaming for both sessions and projects.
- **Knowledge base (llm-wiki).** Finished conversation turns are automatically distilled into a persistent wiki: entity, concept, and query pages cross-referenced with `[[wikilinks]]`, with project conversations landing in a per-project wiki. Manually upload documents (md / txt / html / pdf / docx / xlsx / pptx) to extract text into source pages and entity/concept entries. Browse the tree on the left, click to preview or edit, export an Obsidian-compatible vault in one click, and explore connections in a force-directed knowledge graph with community clustering — or rebuild the wiki from session history.
- **Built-in browser preview.** Preview generated pages and local dev servers inside the app — no window switching.
- **Reasoning control.** Pick off / low / medium / high reasoning per model support to balance speed and depth.
- **Resilient runs.** The agent loop is decoupled from the window: close it and the task keeps running; reopen to resume the stream.
- **Local-first and private.** Data lives in SQLite, the API listens on `127.0.0.1` only, API keys never enter the frontend bundle, and there is no telemetry.

<table>
  <tr>
    <td width="50%"><img src="docs/images/providers.png" alt="Model provider management in settings" /></td>
    <td width="50%"><img src="docs/images/skills.png" alt="Skill management in settings" /></td>
  </tr>
  <tr>
    <td align="center"><sub>24 preset providers — paste a Base URL and key, configure several, switch per conversation</sub></td>
    <td align="center"><sub>Toggle SKILL.md skills by source; reuse existing Claude / Codex / cc-switch skills</sub></td>
  </tr>
</table>

## Download

Grab the latest build from the [Releases page](https://github.com/luabuCN/OpenHarness-Desktop/releases/latest).

| Platform | Package | Status |
|---|---|---|
| Windows (x64) | `.msi` / `.exe` | ✅ Published with each release |
| macOS (Apple Silicon) | `.dmg` | ✅ Published with each release |
| Linux (x64) | `.deb` / `.AppImage` | ✅ Published with each release |

> **macOS note:** builds are not code-signed or notarized. If macOS refuses to open the app, right-click it and choose **Open**, or clear the quarantine flag:
>
> ```bash
> xattr -cr /Applications/Eva\ Desktop.app
> ```

Pushing a `v*.*.*` tag triggers GitHub Actions to build all platforms and publish the Release automatically (see [Releasing](#releasing-automated-builds)).

## Getting started

1. **Add a model provider.** Open **Settings → Models → Add provider**: pick a preset (or OpenAI Compatible), paste the base URL and API key, and fill in a model ID.
2. **Start a conversation.** Describe the task — research, file edits, searches all work; the agent shows every tool call and asks before writing changes.
3. **Extend when needed.** Type `/` to use skills; enable bash in `.env` if you want command execution; ask the agent to delegate via Delegate when a task is splittable.

Provider configuration is stored in local SQLite — no environment variables required to get started.

### Advanced configuration (optional `.env`)

The packaged app reads `.env` from the system data directory:

- Windows: `%APPDATA%/com.openharness.desktop/.env`
- macOS: `~/Library/Application Support/com.openharness.desktop/.env`
- Linux: `~/.config/com.openharness.desktop/.env`

```dotenv
# Allow the agent to run bash commands (off by default)
OPENHARNESS_ENABLE_BASH=true

# Search API key (Tavily / Bocha / Brave / Zhipu; keyless fallback scrapes Sogou / DuckDuckGo)
OPENHARNESS_WEBSEARCH_API_KEY=tvly-...
# Force an engine: zhipu / bocha / tavily / brave / sogou / duckduckgo / auto (default auto)
OPENHARNESS_WEBSEARCH_ENGINE=auto

# API port (default 8878)
OPENHARNESS_PORT=8878
# Context window size (default 128000)
OPENHARNESS_CONTEXT_WINDOW=128000
```

The `webSearch` engine picks, in order: a configured **Zhipu** provider key (apiBase containing `bigmodel.cn`) → `OPENHARNESS_WEBSEARCH_API_KEY` (`tvly-` → Tavily, `sk-` → Bocha, otherwise Brave) → keyless scraping.

The SQLite database, workspace, and skills directory all live under the same data directory — nothing is written to the install directory, and tables are created automatically on first start.

## Skills

Skills are directories with a `SKILL.md` instruction document. The app scans three local Agent CLI skill directories plus its own custom directory (manage everything under **Settings → Skills**):

| Source | Directory | Notes |
| --- | --- | --- |
| Custom | `<data dir>/skills/<id>/SKILL.md` | Created in settings; editable/deletable |
| Claude | `~/.claude/skills/` | Claude Code skills (symlinks supported) |
| Codex | `~/.codex/skills/` | Codex skills |
| cc-switch | `~/.cc-switch/skills/` | cc-switch skills |

Enablement is persisted in SQLite (`SkillRecord`); same-named skills deduplicate with priority Custom > Claude > Codex > cc-switch. Enabled skills work through two paths:

1. **Auto discovery**: the skill catalog is injected into the agent, and the model loads bodies on demand via built-in `skill` / `skill_read` tools;
2. **Explicit invocation**: type `/` to open the skill menu and send `/skill-name args`; the server expands the body in the copy sent to the model while the chat history keeps the compact command text.

## Security boundaries

- The API listens on `127.0.0.1` only — never exposed to the network
- File tools are confined to the `workspace` under the data directory
- The bash tool is off by default; set `OPENHARNESS_ENABLE_BASH=true` to enable
- API keys live only in the sidecar process, never in the frontend bundle

## How it works

Eva Desktop separates the UI, the agent runtime, and desktop capabilities:

- **Web frontend** (`web/`) — a Vite + React workbench with streaming Markdown, syntax highlighting, Mermaid, and math rendering;
- **Agent sidecar** (`server/`) — a Hono + Prisma + SQLite Node service owning the agent loop, model calls, tool execution, and local data; compiled into a Node Single Executable Application (SEA) for distribution;
- **Rust shell** (`src-tauri/`) — Tauri 2 window, system tray, and sidecar lifecycle management.

On launch the Rust shell spawns the sidecar with the data directory injected, and the frontend talks to it over the loopback interface. The agent loop is decoupled from the window connection, so tasks survive a closed window and streams resume on reopen.

## Development

Prerequisites: Node.js ≥ 24, pnpm ≥ 11 (the repo pins `11.22.0`), Rust 1.88+ (only for desktop packaging).

```bash
pnpm install   # install deps and generate the Prisma client
pnpm dev       # API (8878) + Vite (5173) + Tauri window, all at once
```

The database is created automatically under `.local-data/`; run `pnpm dev:api` / `pnpm dev:web` separately when you only need one part.

| Command | Purpose |
| --- | --- |
| `pnpm dev` | Full desktop dev mode |
| `pnpm typecheck` | Workspace-wide typecheck (what CI runs) |
| `pnpm build:desktop` | Build the sidecar and package installers for the current platform |

> **Proxy note:** `src-tauri/.cargo/config.toml` is untracked on purpose (it contained a local proxy that would break CI). If you need a Cargo proxy, create that file locally — it is already gitignored.

## Releasing (automated builds)

CI/CD runs entirely on GitHub Actions — no local cross-platform toolchain needed:

- **CI** (`.github/workflows/ci.yml`): typecheck, web build, and `cargo check` on pushes and PRs;
- **Release** (`.github/workflows/release.yml`): triggered by a `v*.*.*` tag; builds Windows MSI/NSIS, macOS DMG, and Linux deb/AppImage in a matrix, syncs the tag version into the artifacts, and creates the GitHub Release with generated notes.

```bash
git tag v0.2.0
git push origin v0.2.0   # → installers appear on the Release page in ~15 minutes
```

Tags with a prerelease suffix (e.g. `v0.2.0-beta.1`) are automatically marked as prereleases.

## Project layout

| Directory | Purpose |
| --- | --- |
| `web/` | Vite + React frontend (chat UI, settings, skill menu) |
| `server/` | Hono + Prisma + SQLite agent sidecar (agent runtime, tools, providers) |
| `src-tauri/` | Tauri 2 Rust shell (window, tray, sidecar lifecycle) |
| `scripts/` | Dev and packaging helpers (SEA sidecar preparation, etc.) |
| `docs/` | Documentation and README images |

## License

Not yet chosen. If you plan to open-source this project, add a license (MIT / Apache-2.0, …) soon — otherwise others have no default right to use it.
