import React, { useState, useRef, useEffect } from 'react';
import { useSessionStore } from '../stores/session-store';

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

  const handleAddProject = async (mode: SessionMode) => {
    setShowModeMenu(false);
    const dir = await window.api.selectDirectory();
    if (!dir) return;
    const session = await window.api.sessions.create(dir, mode);
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
    updateSession(id, { status: 'stopped', pid: undefined });
  };

  const handleRemove = async (id: string) => {
    setContextMenu(null);
    await window.api.sessions.remove(id);
    removeSession(id);
  };

  const statusColor = (status: string) => {
    switch (status) {
      case 'active': return 'var(--color-green)';
      case 'thinking': return 'var(--color-yellow)';
      case 'error': return 'var(--color-red)';
      default: return 'var(--color-gray)';
    }
  };

  const sessionList = Array.from(sessions.values());

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
              <button onClick={() => handleAddProject('terminal')}>
                <span className="mode-icon">&#9654;</span>
                Terminal Mode
                <span className="mode-desc">Raw CLI with xterm.js</span>
              </button>
              <button onClick={() => handleAddProject('sdk')}>
                <span className="mode-icon">&#9671;</span>
                SDK Mode
                <span className="mode-desc">Rich UI with hooks &amp; tools</span>
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
                  {s.mode === 'sdk' ? 'SDK' : 'TTY'}
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
