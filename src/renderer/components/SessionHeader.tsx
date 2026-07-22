import React, { useEffect, useState } from 'react';
import { useSessionStore } from '../stores/session-store';
import {
  AgentProvider,
  ClaudeModel,
  DEFAULT_CODEX_MODEL,
  DEFAULT_KIRO_MODEL,
  DEFAULT_MODEL,
} from '../../core/constants';

const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;
const MS_PER_DAY = 24 * MS_PER_HOUR;
// Relative-time labels are recomputed on a slow tick so "3m ago" stays honest
// even while a session sits idle and nothing else re-renders the header.
const RELATIVE_TIME_REFRESH_MS = 30_000;

function formatRelative(ts: number | undefined, now: number): string {
  if (!ts) return 'unknown';
  const diff = Math.max(0, now - ts);
  if (diff < MS_PER_MINUTE) return 'just now';
  if (diff < MS_PER_HOUR) return `${Math.floor(diff / MS_PER_MINUTE)}m ago`;
  if (diff < MS_PER_DAY) return `${Math.floor(diff / MS_PER_HOUR)}h ago`;
  return `${Math.floor(diff / MS_PER_DAY)}d ago`;
}

const CLAUDE_MODELS = [
  { value: ClaudeModel.Sonnet, label: 'Sonnet' },
  { value: ClaudeModel.Opus, label: 'Opus' },
  { value: ClaudeModel.Haiku, label: 'Haiku' },
  { value: ClaudeModel.Fable, label: 'Fable' },
] as const;

const CODEX_MODELS = [
  { value: DEFAULT_CODEX_MODEL, label: 'Default' },
] as const;

const KIRO_MODELS = [
  { value: DEFAULT_KIRO_MODEL, label: 'Default' },
] as const;

const TTY_SHORTCUTS: Array<[string, string]> = [
  ['⌘Z / ⇧⌘Z', 'Undo / redo last typed-or-pasted chunk'],
  ['⌘⌫', 'Clear entire prompt'],
  ['⌘← / ⌘→', 'Jump to line start / end'],
  ['⌥← / ⌥→', 'Move word back / forward'],
  ['⌥⌫', 'Delete previous word'],
];

interface Props {
  sessionId: string;
}

export function SessionHeader({ sessionId }: Props): React.ReactElement | null {
  const session = useSessionStore((s) => s.sessions.get(sessionId));
  const updateSession = useSessionStore((s) => s.updateSession);
  const projectNames = useSessionStore((s) => s.projectNames);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), RELATIVE_TIME_REFRESH_MS);
    return () => clearInterval(timer);
  }, []);

  if (!session) return null;

  const displayProject = projectNames.get(session.projectPath) || session.projectName;
  const displaySession = session.title || 'Untitled';
  const provider = session.provider || AgentProvider.Claude;
  const modelOptions =
    provider === AgentProvider.Codex ? CODEX_MODELS
    : provider === AgentProvider.Kiro ? KIRO_MODELS
    : CLAUDE_MODELS;
  const fallbackModel =
    provider === AgentProvider.Codex ? DEFAULT_CODEX_MODEL
    : provider === AgentProvider.Kiro ? DEFAULT_KIRO_MODEL
    : DEFAULT_MODEL;
  const providerLabel =
    provider === AgentProvider.Codex ? 'Codex'
    : provider === AgentProvider.Kiro ? 'Kiro'
    : 'Claude';

  const handleModelChange = async (e: React.ChangeEvent<HTMLSelectElement>) => {
    const model = e.target.value;
    updateSession(sessionId, { model });
    await window.api.sessions.setModel(sessionId, model);
  };

  const isTty = session.mode === 'terminal';
  const lastActiveRelative = formatRelative(session.lastActiveAt, now);
  const lastActiveAbsolute = session.lastActiveAt
    ? new Date(session.lastActiveAt).toLocaleString()
    : 'No recorded activity';

  return (
    <div className="session-header">
      <span className="session-header-project">{displayProject}</span>
      <span className="session-header-sep">/</span>
      <span className="session-header-name">{displaySession}</span>
      <span className="session-header-provider">{providerLabel}</span>
      <span
        className="session-header-meta"
        aria-label={`Last activity ${lastActiveRelative}`}
        tabIndex={0}
      >
        <span className="session-header-meta-clock" aria-hidden="true">&#9201;</span>
        {lastActiveRelative}
        <span className="session-header-meta-popover" role="tooltip">
          <span className="session-header-help-title">Session details</span>
          <span className="session-header-help-row">
            <span>Last active</span>
            <span>{lastActiveAbsolute}</span>
          </span>
          <span className="session-header-help-row">
            <span>Provider</span>
            <span>{providerLabel}</span>
          </span>
          <span className="session-header-help-row">
            <span>Model</span>
            <span>{session.model || fallbackModel}</span>
          </span>
          <span className="session-header-help-row">
            <span>Mode</span>
            <span>{isTty ? 'Terminal' : 'SDK'}</span>
          </span>
          <span className="session-header-help-row">
            <span>Project</span>
            <span>{session.projectPath}</span>
          </span>
        </span>
      </span>
      {isTty && (
        <span className="session-header-help" aria-label="Prompt editor shortcuts" tabIndex={0}>
          ?
          <span className="session-header-help-popover" role="tooltip">
            <span className="session-header-help-title">Prompt shortcuts</span>
            {TTY_SHORTCUTS.map(([keys, desc]) => (
              <span key={keys} className="session-header-help-row">
                <kbd>{keys}</kbd>
                <span>{desc}</span>
              </span>
            ))}
          </span>
        </span>
      )}
      <select
        className="session-header-model"
        value={session.model || fallbackModel}
        onChange={handleModelChange}
      >
        {modelOptions.map((m) => (
          <option key={m.value} value={m.value}>{m.label}</option>
        ))}
      </select>
    </div>
  );
}
