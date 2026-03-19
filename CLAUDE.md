# CLAUDE.md — Claude IDE

## Build & Run
- `npm run dev` — start in dev mode
- `npm run build` — production build
- `npm run package` — build + package as macOS app
- Logs at `~/.claude-ide/logs/main.log`

## Code Style
- **No magic strings.** All string literals used as identifiers, statuses, modes, event names, or IPC channels must be named constants or enum-like `const` objects. The only exceptions are display text (labels, placeholders, log messages) and CSS class names.
- **No magic numbers.** Every numeric literal (timeouts, sizes, thresholds) must be a named constant. Exceptions: `0`, `1`, `-1`.
- **Paired const + type pattern.** Use `export const Foo = { ... } as const;` paired with `export type Foo = (typeof Foo)[keyof typeof Foo];` for enum-like values.
- **TypeScript strict mode.** No `any` unless absolutely unavoidable.
- **No catch-all files.** Constants live with the module that owns them.
- **No over-engineering.** Only build what's needed now.
- **No trailing summaries.** Don't summarize what you just did at the end of responses.

## Architecture
- Electron main process: session management, PTY (node-pty), SDK integration
- Preload: IPC bridge via contextBridge
- Renderer: React + Zustand + xterm.js
- Themes: `src/core/themes.ts` → CSS variables via `theme-applier.ts`
- State persisted to `~/.claude-ide/` (sessions.json, sdk-sessions.json, messages/*.jsonl, project-names.json)
