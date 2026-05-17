import React, { useState, useRef, useEffect } from 'react';
import { useSessionStore } from '../stores/session-store';
import { AgentProvider, SessionMode, SessionStatus } from '../../core/constants';

export function Sidebar(): React.ReactElement {
  const sessions = useSessionStore((s) => s.sessions);
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const selectSession = useSessionStore((s) => s.selectSession);
  const addSession = useSessionStore((s) => s.addSession);
  const removeSession = useSessionStore((s) => s.removeSession);
  const updateSession = useSessionStore((s) => s.updateSession);

  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; id: string } | null>(null);
  const [showModeMenu, setShowModeMenu] = useState(false);
  const addBtnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (addBtnRef.current?.contains(e.target as Node)) return;
      setContextMenu(null);
      setShowModeMenu(false);
    };
    document.addEventListener('click', handleClick);
    return () => document.removeEventListener('click', handleClick);
  }, []);

  const handleAddProject = async (mode: SessionMode, provider: AgentProvider) => {
    setShowModeMenu(false);
    const dir = await window.api.selectDirectory();
    if (!dir) return;
    const session = await window.api.sessions.create(dir, mode, provider);
    addSession(session);
    selectSession(session.id);
  };

  const handleContextMenu = (e: React.MouseEvent, id: string) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, id });
  };

  const handleResume = async (id: string) => {
    setContextMenu(null);
    const session = await window.api.sessions.resume(id);
    if (session) {
      updateSession(id, session);
      selectSession(id);
    }
  };

  const handleKill = async (id: string) => {
    setContextMenu(null);
    await window.api.sessions.kill(id);
    updateSession(id, { status: SessionStatus.Stopped, pid: undefined });
  };

  const handleRemove = async (id: string) => {
    setContextMenu(null);
    await window.api.sessions.remove(id);
    removeSession(id);
  };

  const statusColor = (status: string) => {
    switch (status) {
      case SessionStatus.Active: return 'var(--color-green)';
      case SessionStatus.Thinking: return 'var(--color-yellow)';
      case SessionStatus.Error: return 'var(--color-red)';
      default: return 'var(--color-gray)';
    }
  };

  const sessionList = Array.from(sessions.values());

  const providerLabel = (provider: AgentProvider | undefined): string =>
    provider === AgentProvider.Codex ? 'Codex' : 'Claude';

  return (
    <div className="sidebar">
      <div className="sidebar-header">
        <span className="sidebar-title">Projects</span>
        <div className="add-menu-wrapper">
          <button
            ref={addBtnRef}
            className="btn-add"
            onClick={() => setShowModeMenu(!showModeMenu)}
            title="Add Project"
          >+</button>
          {showModeMenu && (
            <div className="add-mode-menu">
              <button onClick={() => handleAddProject(SessionMode.Terminal, AgentProvider.Claude)}>
                <span className="mode-icon">&#9654;</span>
                Claude Terminal
                <span className="mode-desc">Raw CLI with xterm.js</span>
              </button>
              <button onClick={() => handleAddProject(SessionMode.Sdk, AgentProvider.Claude)}>
                <span className="mode-icon">&#9671;</span>
                Claude SDK
                <span className="mode-desc">Rich UI with hooks &amp; tools</span>
              </button>
              <button onClick={() => handleAddProject(SessionMode.Terminal, AgentProvider.Codex)}>
                <span className="mode-icon">&#9654;</span>
                Codex Terminal
                <span className="mode-desc">Codex CLI with xterm.js</span>
              </button>
            </div>
          )}
        </div>
      </div>
      <div className="sidebar-list">
        {sessionList.map((s) => (
          <div
            key={s.id}
            className={`sidebar-item ${activeSessionId === s.id ? 'active' : ''}`}
            onClick={() => selectSession(s.id)}
            onContextMenu={(e) => handleContextMenu(e, s.id)}
          >
            <span className="status-dot" style={{ backgroundColor: statusColor(s.status) }} />
            <div className="session-info">
              <div className="session-name-row">
                <span className="project-name">{s.projectName}</span>
                <span className={`mode-badge mode-${s.mode || 'terminal'}`}>
                  {providerLabel(s.provider)} {s.mode === SessionMode.Sdk ? 'SDK' : 'TTY'}
                </span>
              </div>
              <span className="project-path">{s.projectPath}</span>
            </div>
          </div>
        ))}
        {sessionList.length === 0 && (
          <div className="sidebar-empty">No projects. Click + to add one.</div>
        )}
      </div>
      {contextMenu && (
        <div
          ref={menuRef}
          className="context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          <button onClick={() => handleResume(contextMenu.id)}>Resume</button>
          <button onClick={() => handleKill(contextMenu.id)}>Kill</button>
          <button onClick={() => handleRemove(contextMenu.id)} className="danger">Remove</button>
        </div>
      )}
    </div>
  );
}
