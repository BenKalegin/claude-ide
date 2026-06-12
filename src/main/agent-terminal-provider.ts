import { execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  AgentProvider,
  DEFAULT_CODEX_MODEL,
  DEFAULT_MODEL,
} from '../core/constants';

const TerminalCommand = {
  Claude: 'claude',
  Codex: 'codex',
} as const;

const CliArg = {
  Continue: '--continue',
  Model: '--model',
  Resume: '--resume',
  PermissionMode: '--permission-mode',
  DisallowedTools: '--disallowedTools',
  SessionId: '--session-id',
} as const;

// "Unbounded" sessions auto-run every tool with no prompts, but keep the
// permission layer active so git stays blocked. We use `auto` (not
// `bypassPermissions`, which skips the permission layer entirely and would
// ignore the deny rule below). The pattern matches any command starting
// with "git " — commit, push, etc.
const UNBOUNDED_PERMISSION_MODE = 'auto';
const GIT_DENY_PATTERN = 'Bash(git *)';

const Platform = {
  Windows: 'win32',
} as const;

const ShellCommand = {
  Where: 'where.exe',
  Which: 'which',
} as const;

const ShellPath = {
  Zsh: '/bin/zsh',
} as const;

const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const FIRST_LINE_INDEX = 0;
const WINDOWS_LOCAL_CODEX_DIR = path.join(os.homedir(), 'AppData', 'Local', 'OpenAI', 'Codex', 'bin');
const WINDOWS_CODEX_EXE = 'codex.exe';

export interface TerminalProviderSession {
  model?: string;
  providerSessionId?: string;
  unbounded?: boolean;
}

export interface AgentTerminalProvider {
  readonly provider: AgentProvider;
  resolveExecutable(): string;
  buildStartArgs(model?: string, unbounded?: boolean, sessionId?: string): string[];
  buildResumeArgs(session: TerminalProviderSession): string[];
  getHistoryDir?(projectPath: string): string;
}

// Memoized: resolution shells out synchronously (`which`/`where`), and it runs
// on every session create/resume — at launch that's one sync spawn per resumed
// session, all blocking the main process. The binary's location doesn't change
// within an app run, so resolve each command once.
const resolvedCommandPaths = new Map<string, string>();

function resolveCommandPath(command: string): string {
  const cached = resolvedCommandPaths.get(command);
  if (cached) return cached;
  const resolved = resolveCommandPathUncached(command);
  resolvedCommandPaths.set(command, resolved);
  return resolved;
}

function resolveCommandPathUncached(command: string): string {
  try {
    if (process.platform === Platform.Windows) {
      const localCodexPath = command === TerminalCommand.Codex ? resolveWindowsLocalCodexPath() : null;
      if (localCodexPath) return localCodexPath;

      return execSync(`${ShellCommand.Where} ${command}`, { encoding: 'utf-8' })
        .trim()
        .split(/\r?\n/)[FIRST_LINE_INDEX];
    }

    return execSync(`${ShellCommand.Which} ${command}`, {
      encoding: 'utf-8',
      shell: ShellPath.Zsh,
    }).trim();
  } catch {
    return command;
  }
}

function resolveWindowsLocalCodexPath(): string | null {
  try {
    if (!fs.existsSync(WINDOWS_LOCAL_CODEX_DIR)) return null;

    const candidates = fs.readdirSync(WINDOWS_LOCAL_CODEX_DIR)
      .map((entry) => path.join(WINDOWS_LOCAL_CODEX_DIR, entry, WINDOWS_CODEX_EXE))
      .filter((candidate) => fs.existsSync(candidate))
      .map((candidate) => ({
        path: candidate,
        mtimeMs: fs.statSync(candidate).mtimeMs,
      }))
      .sort((a, b) => b.mtimeMs - a.mtimeMs);

    return candidates[FIRST_LINE_INDEX]?.path || null;
  } catch {
    return null;
  }
}

function buildClaudeModelArgs(model?: string): string[] {
  return [CliArg.Model, model || DEFAULT_MODEL];
}

function buildClaudeUnboundedArgs(unbounded?: boolean): string[] {
  if (!unbounded) return [];
  return [
    CliArg.PermissionMode, UNBOUNDED_PERMISSION_MODE,
    CliArg.DisallowedTools, GIT_DENY_PATTERN,
  ];
}

function buildCodexModelArgs(model?: string): string[] {
  if (!model || model === DEFAULT_CODEX_MODEL) return [];
  return [CliArg.Model, model];
}

const claudeTerminalProvider: AgentTerminalProvider = {
  provider: AgentProvider.Claude,
  resolveExecutable: () => resolveCommandPath(TerminalCommand.Claude),
  // Pin the transcript id to our own session id with --session-id so the file
  // is known deterministically (claude writes <sessionId>.jsonl). This removes
  // the race-prone "watch the dir for a new file" detection on fresh starts —
  // the source of sessions binding to the wrong/old transcript after restart.
  buildStartArgs: (model, unbounded, sessionId) => [
    ...(sessionId ? [CliArg.SessionId, sessionId] : []),
    ...buildClaudeModelArgs(model),
    ...buildClaudeUnboundedArgs(unbounded),
  ],
  buildResumeArgs: (session) => {
    const args = session.providerSessionId
      ? [CliArg.Resume, session.providerSessionId]
      : [CliArg.Continue];
    return [
      ...args,
      ...buildClaudeModelArgs(session.model),
      ...buildClaudeUnboundedArgs(session.unbounded),
    ];
  },
  getHistoryDir: () => CLAUDE_PROJECTS_DIR,
};

const codexTerminalProvider: AgentTerminalProvider = {
  provider: AgentProvider.Codex,
  resolveExecutable: () => resolveCommandPath(TerminalCommand.Codex),
  buildStartArgs: (model) => buildCodexModelArgs(model),
  buildResumeArgs: (session) => buildCodexModelArgs(session.model),
};

export function getTerminalProvider(provider: AgentProvider): AgentTerminalProvider {
  switch (provider) {
    case AgentProvider.Codex:
      return codexTerminalProvider;
    case AgentProvider.Claude:
    default:
      return claudeTerminalProvider;
  }
}

export function getDefaultModelForProvider(provider: AgentProvider): string {
  switch (provider) {
    case AgentProvider.Codex:
      return DEFAULT_CODEX_MODEL;
    case AgentProvider.Claude:
    default:
      return DEFAULT_MODEL;
  }
}
