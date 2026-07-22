# AGENTS.md — Claude IDE

Electron desktop app that manages multiple Claude Code / Codex CLI sessions
across projects. Sessions run in two modes: **Terminal** (a real PTY running the
`claude`/`codex` CLI via node-pty) and **SDK** (headless, driven by the Anthropic
Agent SDK with a custom permission gate).

## Build & Run
- `npm run dev` — start Electron in dev mode (electron-vite)
- `npm run build` — production build to `out/`
- `npm run package` — build + package as a macOS app (electron-builder)
- Logs: `~/.claude-ide/logs/main.log` (electron-log)

There is no test runner or linter configured. TypeScript is the primary
correctness gate; keep `strict` mode clean. Verify changes build with
`npm run build` before considering a task done.

## Architecture
Three Electron layers plus a shared core:

- **`src/main/`** — main process (Node). Owns session lifecycle and process
  management.
  - `session-manager.ts` — Terminal (PTY) sessions via node-pty; spawns the
    `claude`/`codex` CLI, tracks child processes, streams data to renderer.
  - `sdk-session-manager.ts` — headless SDK sessions via `@anthropic-ai/claude-agent-sdk`;
    routes tool use through the `canUseTool` permission callback.
  - `index.ts` — app bootstrap, window creation, IPC handler registration.
  - `model-picker.ts`, `transcript-model.ts` — detect the session's active model
    (incl. `/model` changes made inside the TTY) and push updates to the renderer.
  - `tty-activity.ts`, `agent-terminal-provider.ts` — activity detection + PTY setup.
- **`src/preload/index.ts`** — contextBridge IPC bridge. Exposes `window.api`
  (`sessions`, `sdk`, `usage`, …). All renderer↔main traffic goes through here.
  `SessionInfo`, `SdkMessage`, `UsageSummary` interfaces live here.
- **`src/renderer/`** — React 18 + Zustand + xterm.js UI.
  - `App.tsx` — layout, wires IPC event subscriptions into the store.
  - `stores/session-store.ts` — Zustand store (sessions, active session, todos, …).
  - `components/` — `TerminalView` (xterm), `SdkView`, `ProjectTree`, `SessionHeader`,
    `SdkPermissionDialog`, `ProcessMonitor`, `UsageBar`, etc.
  - `lib/theme-applier.ts` — applies themes as CSS variables.
- **`src/core/`** — code shared across processes (no Electron/React imports).
  - `constants.ts` — the source of truth for enum-like consts: `IpcChannel`,
    `SessionMode`, `SessionStatus`, `AgentProvider`, `ClaudeModel`, SDK payload
    types, PTY defaults, TTY key sequences, etc.
  - `permission-rules.ts` — declarative, ordered rule table deciding which SDK
    tool calls auto-run vs. prompt (first match wins; Prompt rules above Allow
    rules act as exclusions).
  - `themes.ts` — theme definitions.

State is persisted under `~/.claude-ide/` (`sessions.json`, `sdk-sessions.json`,
`messages/*.jsonl`, `project-names.json`).

## Conventions (enforced — see CLAUDE.md)
- **No magic strings.** String literals used as identifiers, statuses, modes,
  event names, or IPC channels must be named constants or `const` objects.
  Exceptions: display text (labels, placeholders, log messages) and CSS classes.
- **No magic numbers.** Named constants for timeouts, sizes, thresholds.
  Exceptions: `0`, `1`, `-1`.
- **Paired const + type pattern:**
  ```ts
  export const Foo = { A: 'a', B: 'b' } as const;
  export type Foo = (typeof Foo)[keyof typeof Foo];
  ```
- **IPC channels** must be added to the `IpcChannel` const in `core/constants.ts`,
  wired in `preload/index.ts`, and handled in the main process — keep all three in sync.
- **TypeScript strict.** Avoid `any` unless truly unavoidable.
- **No catch-all files.** Constants live with the module that owns them
  (shared enum-likes go in `core/constants.ts`).
- **No over-engineering.** Build only what's needed now.

## Git (important)
- **Never commit or push automatically.** Only commit when the user explicitly
  asks (e.g. "commit", "commit and push"). Do not commit after finishing a task
  unless told to.
- The project has a deliberately git-averse permission posture: SDK sessions
  auto-allow only read-only git subcommands (`log`, `status`, `diff`); all git
  writes still prompt.

## Response style
- No trailing summaries — don't recap what you just did at the end of responses.
