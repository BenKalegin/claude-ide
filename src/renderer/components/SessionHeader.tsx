import React from 'react';
import { useSessionStore } from '../stores/session-store';
import {
  AgentProvider,
  ClaudeModel,
  DEFAULT_CODEX_MODEL,
  DEFAULT_MODEL,
} from '../../core/constants';

const CLAUDE_MODELS = [
  { value: ClaudeModel.Sonnet, label: 'Sonnet' },
  { value: ClaudeModel.Opus, label: 'Opus' },
  { value: ClaudeModel.Haiku, label: 'Haiku' },
] as const;

const CODEX_MODELS = [
  { value: DEFAULT_CODEX_MODEL, label: 'Default' },
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

  if (!session) return null;

  const displayProject = projectNames.get(session.projectPath) || session.projectName;
  const displaySession = session.title || 'Untitled';
  const provider = session.provider || AgentProvider.Claude;
  const modelOptions = provider === AgentProvider.Codex ? CODEX_MODELS : CLAUDE_MODELS;
  const fallbackModel = provider === AgentProvider.Codex ? DEFAULT_CODEX_MODEL : DEFAULT_MODEL;
  const providerLabel = provider === AgentProvider.Codex ? 'Codex' : 'Claude';

  const handleModelChange = async (e: React.ChangeEvent<HTMLSelectElement>) => {
    const model = e.target.value;
    updateSession(sessionId, { model });
    await window.api.sessions.setModel(sessionId, model);
  };

  const isTty = session.mode === 'terminal';

  return (
    <div className="session-header">
      <span className="session-header-project">{displayProject}</span>
      <span className="session-header-sep">/</span>
      <span className="session-header-name">{displaySession}</span>
      <span className="session-header-provider">{providerLabel}</span>
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
