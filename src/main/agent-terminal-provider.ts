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
} as const;

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
}

export interface AgentTerminalProvider {
  readonly provider: AgentProvider;
  resolveExecutable(): string;
  buildStartArgs(model?: string): string[];
  buildResumeArgs(session: TerminalProviderSession): string[];
  getHistoryDir?(projectPath: string): string;
}

function resolveCommandPath(command: string): string {
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

function buildCodexModelArgs(model?: string): string[] {
  if (!model || model === DEFAULT_CODEX_MODEL) return [];
  return [CliArg.Model, model];
}

const claudeTerminalProvider: AgentTerminalProvider = {
  provider: AgentProvider.Claude,
  resolveExecutable: () => resolveCommandPath(TerminalCommand.Claude),
  buildStartArgs: (model) => buildClaudeModelArgs(model),
  buildResumeArgs: (session) => {
    const args = session.providerSessionId
      ? [CliArg.Resume, session.providerSessionId]
      : [CliArg.Continue];
    return [...args, ...buildClaudeModelArgs(session.model)];
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
