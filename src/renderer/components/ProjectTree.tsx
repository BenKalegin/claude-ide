import React, { useMemo, useState, useRef, useEffect } from 'react';
import { useSessionStore } from '../stores/session-store';
import { SessionMode, SessionStatus, SessionActivity, SdkMessageType } from '../../core/constants';

interface ProjectGroup {
  projectPath: string;
  displayName: string;
  sessions: SessionInfo[];
}

export function ProjectTree(): React.ReactElement {
  const sessions = useSessionStore((s) => s.sessions);
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const selectSession = useSessionStore((s) => s.selectSession);
  const projectNames = useSessionStore((s) => s.projectNames);
  const setProjectName = useSessionStore((s) => s.setProjectName);
  const addSession = useSessionStore((s) => s.addSession);
  const [editingPath, setEditingPath] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const [addMenuPath, setAddMenuPath] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const groups = useMemo(() => {
    const map = new Map<string, ProjectGroup>();
    for (const s of sessions.values()) {
      const existing = map.get(s.projectPath);
      if (existing) {
        existing.sessions.push(s);
      } else {
        map.set(s.projectPath, {
          projectPath: s.projectPath,
          displayName: projectNames.get(s.projectPath) || s.projectName,
          sessions: [s],
        });
      }
    }
    return Array.from(map.values());
  }, [sessions, projectNames]);

  useEffect(() => {
    if (editingPath && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editingPath]);

  const handleStartRename = (e: React.MouseEvent, path: string, currentName: string) => {
    e.stopPropagation();
    setEditingPath(path);
    setEditValue(currentName);
  };

  const handleRenameCommit = async () => {
    if (!editingPath || !editValue.trim()) {
      setEditingPath(null);
      return;
    }
    setProjectName(editingPath, editValue.trim());
    await window.api.sessions.renameProject(editingPath, editValue.trim());
    setEditingPath(null);
  };

  const handleRenameKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') handleRenameCommit();
    else if (e.key === 'Escape') setEditingPath(null);
  };

  const handleNewSession = async (projectPath: string, mode: SessionMode) => {
    setAddMenuPath(null);
    const session = await window.api.sessions.create(projectPath, mode);
    addSession(session);
    selectSession(session.id);
  };

  useEffect(() => {
    if (!addMenuPath) return;
    const close = () => setAddMenuPath(null);
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, [addMenuPath]);

  const getSessionLabel = (s: SessionInfo): string => {
    if (s.title) return s.title;
    // Fallback: first user message
    const msgs = useSessionStore.getState().sdkMessages.get(s.id);
    if (msgs && msgs.length > 0) {
      const firstUser = msgs.find((m) => m.type === SdkMessageType.User);
      if (firstUser) {
        const text = firstUser.content.slice(0, 40);
        return text.length < firstUser.content.length ? text + '...' : text;
      }
    }
    return s.mode === SessionMode.Terminal ? `${s.projectName} (tty)` : 'New session';
  };

  const statusColor = (status: string) => {
    switch (status) {
      case SessionStatus.Active: return 'var(--color-green)';
      case SessionStatus.Thinking: return 'var(--color-yellow)';
      case SessionStatus.Error: return 'var(--color-red)';
      default: return 'var(--color-gray)';
    }
  };

  const formatActivity = (activity: string, detail?: string): string => {
    switch (activity) {
      case SessionActivity.Thinking: return 'thinking...';
      case SessionActivity.UsingTool: return detail ? `${detail}` : 'tool...';
      case SessionActivity.Streaming: return 'writing...';
      default: return '';
    }
  };

  if (groups.length === 0) {
    return <div className="tree-empty">No active sessions</div>;
  }

  return (
    <div className="project-tree">
      {groups.map((group) => (
        <div key={group.projectPath} className="tree-project">
          <div className="tree-project-header">
            <span className="tree-folder-icon">&#9662;</span>
            {editingPath === group.projectPath ? (
              <input
                ref={inputRef}
                className="tree-rename-input"
                value={editValue}
                onChange={(e) => setEditValue(e.target.value)}
                onBlur={handleRenameCommit}
                onKeyDown={handleRenameKeyDown}
                onClick={(e) => e.stopPropagation()}
              />
            ) : (
              <span className="tree-folder-name">{group.displayName}</span>
            )}
            <div className="tree-project-actions">
              <button
                className="tree-action-btn"
                title="Rename project"
                onClick={(e) => handleStartRename(e, group.projectPath, group.displayName)}
              >&#9998;</button>
              <button
                className="tree-action-btn"
                title="New session"
                onClick={(e) => { e.stopPropagation(); setAddMenuPath(addMenuPath === group.projectPath ? null : group.projectPath); }}
              >+</button>
            </div>
          </div>
          {addMenuPath === group.projectPath && (
            <div className="tree-add-menu" onClick={(e) => e.stopPropagation()}>
              <button onClick={() => handleNewSession(group.projectPath, SessionMode.Sdk)}>
                <span className="mode-icon">&#9671;</span> SDK
              </button>
              <button onClick={() => handleNewSession(group.projectPath, SessionMode.Terminal)}>
                <span className="mode-icon">&#9654;</span> Terminal
              </button>
            </div>
          )}
          {group.sessions.map((s) => (
            <div
              key={s.id}
              className={`tree-item ${activeSessionId === s.id ? 'tree-active' : ''}`}
              onClick={() => selectSession(s.id)}
              title={s.summary || ''}
            >
              <span className="tree-dot" style={{ backgroundColor: statusColor(s.status) }} />
              <span className="tree-name">{getSessionLabel(s)}</span>
              {s.activity && s.activity !== SessionActivity.Idle && (
                <span className="tree-activity">{formatActivity(s.activity, s.activityDetail)}</span>
              )}
              {s.mode === SessionMode.Terminal && (
                <span className="tree-mode tree-mode-terminal">TTY</span>
              )}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
