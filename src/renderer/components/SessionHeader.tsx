import React from 'react';
import { useSessionStore } from '../stores/session-store';

const MODELS = [
  { value: 'sonnet', label: 'Sonnet' },
  { value: 'opus', label: 'Opus' },
  { value: 'haiku', label: 'Haiku' },
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

  const handleModelChange = async (e: React.ChangeEvent<HTMLSelectElement>) => {
    const model = e.target.value;
    updateSession(sessionId, { model });
    await window.api.sessions.setModel(sessionId, model);
  };

  return (
    <div className="session-header">
      <span className="session-header-project">{displayProject}</span>
      <span className="session-header-sep">/</span>
      <span className="session-header-name">{displaySession}</span>
      <select
        className="session-header-model"
        value={session.model || 'sonnet'}
        onChange={handleModelChange}
      >
        {MODELS.map((m) => (
          <option key={m.value} value={m.value}>{m.label}</option>
        ))}
      </select>
    </div>
  );
}
