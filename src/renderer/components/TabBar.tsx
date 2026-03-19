import React, { useState, useRef, useEffect } from 'react';
import { useSessionStore } from '../stores/session-store';

export function TabBar(): React.ReactElement {
  const sessions = useSessionStore((s) => s.sessions);
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const selectSession = useSessionStore((s) => s.selectSession);
  const addSession = useSessionStore((s) => s.addSession);
  const removeSession = useSessionStore((s) => s.removeSession);
  const updateSession = useSessionStore((s) => s.updateSession);

  const [showAddMenu, setShowAddMenu] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; id: string } | null>(null);
  const addBtnRef = useRef<HTMLButtonElement>(null);
  const tabsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (addBtnRef.current?.contains(e.target as Node)) return;
      setShowAddMenu(false);
      setContextMenu(null);
    };
    document.addEventListener('click', handleClick);
    return () => document.removeEventListener('click', handleClick);
  }, []);

  const handleAddProject = async (mode: SessionMode) => {
    setShowAddMenu(false);
    const dir = await window.api.selectDirectory();
    if (!dir) return;
    const session = await window.api.sessions.create(dir, mode);
    addSession(session);
    selectSession(session.id);
  };

  const handleClose = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    await window.api.sessions.kill(id);
    await window.api.sessions.remove(id);
    removeSession(id);
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

  const handleReload = async (id: string) => {
    setContextMenu(null);
    await window.api.sessions.kill(id);
    updateSession(id, { status: 'stopped', pid: undefined });
    const session = await window.api.sessions.resume(id);
    if (session) {
      updateSession(id, session);
    }
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
    <>
      <div className="tab-bar" ref={tabsRef}>
        <div className="tab-bar-scroll">
          {sessionList.map((s) => (
            <div
              key={s.id}
              className={`tab ${activeSessionId === s.id ? 'tab-active' : ''}`}
              onClick={() => selectSession(s.id)}
              onContextMenu={(e) => handleContextMenu(e, s.id)}
            >
              <span className="tab-dot" style={{ backgroundColor: statusColor(s.status) }} />
              <span className="tab-name">{s.projectName}</span>
              {s.mode === 'terminal' && (
                <span className="tab-mode tab-mode-terminal">TTY</span>
              )}
              <button
                className="tab-close"
                onClick={(e) => handleClose(e, s.id)}
                title="Close"
              >&times;</button>
            </div>
          ))}
        </div>
        <div className="tab-bar-actions">
          <button
            ref={addBtnRef}
            className="btn-add-tab"
            onClick={() => setShowAddMenu(!showAddMenu)}
            title="New Session"
          >+</button>
          {showAddMenu && (
            <div className="tab-add-menu">
              <button onClick={() => handleAddProject('terminal')}>
                <span className="mode-icon">&#9654;</span>
                Terminal (TTY)
              </button>
              <button onClick={() => handleAddProject('sdk')}>
                <span className="mode-icon">&#9671;</span>
                SDK Mode
              </button>
            </div>
          )}
        </div>
      </div>

      {contextMenu && (
        <div
          className="context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          <button onClick={() => handleResume(contextMenu.id)}>Resume</button>
          <button onClick={() => handleReload(contextMenu.id)}>Reload</button>
          <button onClick={() => handleKill(contextMenu.id)}>Stop</button>
          <button onClick={() => { handleClose({ stopPropagation: () => {} } as React.MouseEvent, contextMenu.id); setContextMenu(null); }} className="danger">Close</button>
        </div>
      )}
    </>
  );
}
