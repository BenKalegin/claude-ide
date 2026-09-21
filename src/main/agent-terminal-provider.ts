import { execFile, execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';
import {
  AgentProvider,
  DEFAULT_CODEX_MODEL,
  DEFAULT_KIRO_MODEL,
  DEFAULT_MODEL,
} from '../core/constants';

const TerminalCommand = {
  Claude: 'claude',
  Codex: 'codex',
  Kiro: 'kiro-cli',
} as const;

// Kiro CLI is invoked as `kiro-cli chat`; these flags live on the `chat`
// subcommand (see `kiro-cli chat --help`). `--resume` continues the most recent
// conversation in the cwd (the analog of Claude's `--continue`).
const KiroCliArg = {
  Chat: 'chat',
  Resume: '--resume',
  ResumeId: '--resume-id',
  Model: '--model',
  ListSessions: '--list-sessions',
  AllCwds: '--all-cwds',
  Format: '--format',
} as const;

const KiroOutputFormat = {
  Json: 'json',
} as const;

const KiroSessionSource = {
  V2: 'v2',
} as const;

const KIRO_SESSION_LIST_TIMEOUT_MS = 10_000;
const KIRO_SESSION_LIST_MAX_BUFFER_BYTES = 10 * 1024 * 1024;
const KIRO_UNTITLED_SESSION = '(no title)';

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
const execFileAsync = promisify(execFile);

export interface TerminalProviderSavedSession {
  id: string;
  projectPath: string;
  title?: string;
  updatedAt: number;
  messageCount: number;
}

export interface TerminalProviderSession {
  model?: string;
  providerSessionId?: string;
  unbounded?: boolean;
}

export interface AgentTerminalProvider {
  readonly provider: AgentProvider;
  // True when the CLI repaints its full conversation history into the terminal
  // on resume (Claude does). When true, the session manager drops its own saved
  // scrollback on resume to avoid duplicated output; when false/absent, it keeps
  // the scrollback so the user still sees prior output (Kiro/Codex don't repaint).
  readonly redrawsHistoryOnResume?: boolean;
  resolveExecutable(): string;
  buildStartArgs(model?: string, unbounded?: boolean, sessionId?: string): string[];
  buildResumeArgs(session: TerminalProviderSession): string[];
  getHistoryDir?(projectPath: string): string;
  listSessions?(projectPath?: string): Promise<TerminalProviderSavedSession[]>;
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

// Kiro's "Default" model means "use the CLI's configured default", so we omit
// --model entirely for it; any other value is passed through verbatim.
function buildKiroModelArgs(model?: string): string[] {
  if (!model || model === DEFAULT_KIRO_MODEL) return [];
  return [KiroCliArg.Model, model];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

async function listKiroSessions(projectPath?: string): Promise<TerminalProviderSavedSession[]> {
  const executable = resolveCommandPath(TerminalCommand.Kiro);
  const args = [
    KiroCliArg.Chat,
    KiroCliArg.ListSessions,
    ...(projectPath ? [] : [KiroCliArg.AllCwds]),
    KiroCliArg.Format,
    KiroOutputFormat.Json,
  ];
  const { stdout } = await execFileAsync(executable, args, {
    cwd: projectPath || os.homedir(),
    encoding: 'utf-8',
    timeout: KIRO_SESSION_LIST_TIMEOUT_MS,
    maxBuffer: KIRO_SESSION_LIST_MAX_BUFFER_BYTES,
  });
  const parsed: unknown = JSON.parse(stdout);
  if (!Array.isArray(parsed)) return [];

  const sessions: TerminalProviderSavedSession[] = [];
  for (const envelope of parsed) {
    if (!isRecord(envelope) || typeof envelope.cwd !== 'string' || !Array.isArray(envelope.sessions)) continue;
    for (const candidate of envelope.sessions) {
      if (!isRecord(candidate) || candidate.source !== KiroSessionSource.V2) continue;
      if (typeof candidate.sessionId !== 'string') continue;
      const updatedAt = typeof candidate.updatedAt === 'string' ? Date.parse(candidate.updatedAt) : 0;
      const title = typeof candidate.title === 'string' && candidate.title !== KIRO_UNTITLED_SESSION
        ? candidate.title
        : undefined;
      sessions.push({
        id: candidate.sessionId,
        projectPath: envelope.cwd,
        title,
        updatedAt: Number.isNaN(updatedAt) ? 0 : updatedAt,
        messageCount: typeof candidate.messageCount === 'number' ? candidate.messageCount : 0,
      });
    }
  }
  return sessions;
}

const claudeTerminalProvider: AgentTerminalProvider = {
  provider: AgentProvider.Claude,
  redrawsHistoryOnResume: true,
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

// Kiro runs as `kiro-cli chat` and exposes its saved conversations through the
// CLI. Bind each app session to that stable id so parallel sessions in one
// project resume independently instead of all selecting the newest conversation.
const kiroTerminalProvider: AgentTerminalProvider = {
  provider: AgentProvider.Kiro,
  resolveExecutable: () => resolveCommandPath(TerminalCommand.Kiro),
  buildStartArgs: (model) => [KiroCliArg.Chat, ...buildKiroModelArgs(model)],
  buildResumeArgs: (session) => [
    KiroCliArg.Chat,
    ...(session.providerSessionId
      ? [KiroCliArg.ResumeId, session.providerSessionId]
      : [KiroCliArg.Resume]),
    ...buildKiroModelArgs(session.model),
  ],
  listSessions: listKiroSessions,
};

export function getTerminalProvider(provider: AgentProvider): AgentTerminalProvider {
  switch (provider) {
    case AgentProvider.Codex:
      return codexTerminalProvider;
    case AgentProvider.Kiro:
      return kiroTerminalProvider;
    case AgentProvider.Claude:
    default:
      return claudeTerminalProvider;
  }
}

export function getDefaultModelForProvider(provider: AgentProvider): string {
  switch (provider) {
    case AgentProvider.Codex:
      return DEFAULT_CODEX_MODEL;
    case AgentProvider.Kiro:
      return DEFAULT_KIRO_MODEL;
    case AgentProvider.Claude:
    default:
      return DEFAULT_MODEL;
  }
}
