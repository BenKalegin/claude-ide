import React, { useEffect, useState } from 'react';
import { ProjectTree } from './components/ProjectTree';
import { TerminalView } from './components/TerminalView';
import { SdkView } from './components/SdkView';
import { ProcessMonitor } from './components/ProcessMonitor';
import { Resizer } from './components/Resizer';
import { SettingsDialog } from './components/SettingsDialog';
import { SdkPermissionDialog } from './components/SdkPermissionDialog';
import { UsageBar } from './components/UsageBar';
import { SessionHeader } from './components/SessionHeader';
import { useSessionStore } from './stores/session-store';
import { applyTheme } from './lib/theme-applier';
import { AgentProvider, SessionMode } from '../core/constants';

export function App(): React.ReactElement {
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const sessions = useSessionStore((s) => s.sessions);
  const activeSession = activeSessionId ? sessions.get(activeSessionId) : undefined;
  const setSessions = useSessionStore((s) => s.setSessions);
  const updateSession = useSessionStore((s) => s.updateSession);
  const setProcesses = useSessionStore((s) => s.setProcesses);
  const addSdkMessage = useSessionStore((s) => s.addSdkMessage);
  const sidebarWidth = useSessionStore((s) => s.sidebarWidth);
  const resizeSidebar = useSessionStore((s) => s.resizeSidebar);
  const themeId = useSessionStore((s) => s.themeId);

  const addSession = useSessionStore((s) => s.addSession);
  const selectSession = useSessionStore((s) => s.selectSession);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [showNewMenu, setShowNewMenu] = useState(false);

  const handleNewProject = async (mode: SessionMode, provider: AgentProvider, unbounded = false) => {
    setShowNewMenu(false);
    const dir = await window.api.selectDirectory();
    if (!dir) return;
    const session = await window.api.sessions.create(dir, mode, provider, unbounded);
    addSession(session);
    selectSession(session.id);
  };

  useEffect(() => {
    applyTheme(themeId);
  }, []);

  useEffect(() => {
    if (!showNewMenu) return;
    const close = () => setShowNewMenu(false);
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, [showNewMenu]);

  useEffect(() => {
    window.api.sessions.list().then(setSessions);
    window.api.sessions.getProjectNames().then((names) => {
      useSessionStore.getState().setProjectNames(names);
    });

    const unsubStatus = window.api.sessions.onStatusChange(({ id, status }) => {
      updateSession(id, { status: status as SessionInfo['status'] });
    });

    const unsubProcesses = window.api.sessions.onProcesses(({ id, processes }) => {
      setProcesses(id, processes);
    });

    const unsubSdkMessage = window.api.sdk.onMessage(({ id, message }) => {
      addSdkMessage(id, message);
    });

    const unsubSdkCost = window.api.sdk.onCost(({ id, totalCost }) => {
      updateSession(id, { totalCost });
    });

    const unsubSdkTitle = window.api.sdk.onTitle(({ id, title, summary }) => {
      updateSession(id, { title, summary });
    });

    // Model changes made inside the TTY (e.g. /model) are detected from the
    // session transcript in the main process and pushed here so the header
    // dropdown and details popover track the session's true model.
    const unsubModel = window.api.sessions.onModelChanged(({ id, model }) => {
      updateSession(id, { model });
    });

    const unsubSdkActivity = window.api.sdk.onActivity(({ id, activity, detail, subagentCount, lastActiveAt }) => {
      const updates: Partial<SessionInfo> = { activity, activityDetail: detail, subagentCount };
      // Only present for TTY activity transitions; omit when absent so the
      // existing (transcript-seeded) value isn't clobbered with undefined.
      if (lastActiveAt !== undefined) updates.lastActiveAt = lastActiveAt;
      updateSession(id, updates);
    });

    return () => {
      unsubStatus();
      unsubProcesses();
      unsubSdkMessage();
      unsubSdkCost();
      unsubSdkTitle();
      unsubModel();
      unsubSdkActivity();
    };
  }, []);

  const isTerminal = !activeSession || activeSession.mode === SessionMode.Terminal;

  return (
    <div className="app-layout-v2">
      <div className="titlebar-drag" />
      <div className="sidebar-v2" style={{ width: sidebarWidth, minWidth: sidebarWidth }}>
        <div className="sidebar-v2-header">
          <span className="sidebar-v2-title">Sessions</span>
          <div className="sidebar-v2-actions">
            <div className="sidebar-new-wrapper">
              <button
                className="btn-new-project"
                onClick={(e) => { e.stopPropagation(); setShowNewMenu(!showNewMenu); }}
                title="New project session"
              >+</button>
              {showNewMenu && (
                <div className="sidebar-new-menu" onClick={(e) => e.stopPropagation()}>
                  <button onClick={() => handleNewProject(SessionMode.Sdk, AgentProvider.Claude)}>
                    <span className="mode-icon">&#9671;</span> Claude SDK
                  </button>
                  <button onClick={() => handleNewProject(SessionMode.Terminal, AgentProvider.Claude)}>
                    <span className="mode-icon">&#9654;</span> Claude Terminal
                  </button>
                  <button
                    onClick={() => handleNewProject(SessionMode.Terminal, AgentProvider.Claude, true)}
                    title="Auto-approve all tools (git stays blocked)"
                  >
                    <span className="mode-icon">&#9889;</span> Claude Terminal (unbounded)
                  </button>
                  <button onClick={() => handleNewProject(SessionMode.Terminal, AgentProvider.Codex)}>
                    <span className="mode-icon">&#9654;</span> Codex Terminal
                  </button>
                </div>
              )}
            </div>
            <button className="btn-settings" onClick={() => setSettingsOpen(true)} title="Settings">
              &#9881;
            </button>
          </div>
        </div>
        <ProjectTree />
        <UsageBar />
      </div>
      <Resizer direction="horizontal" onResize={resizeSidebar} />
      <div className="main-area">
        {activeSessionId && <SessionHeader sessionId={activeSessionId} />}
        <div className="content-area">
          <div className="view-area">
            {!activeSessionId ? (
              <TerminalView sessionId={null} />
            ) : !activeSession ? (
              <div className="terminal-placeholder">
                <div className="placeholder-text">Loading session...</div>
              </div>
            ) : activeSession.mode === SessionMode.Sdk ? (
              <SdkView sessionId={activeSessionId} />
            ) : (
              <TerminalView sessionId={activeSessionId} />
            )}
          </div>
          {isTerminal && activeSessionId && (
            <div className="process-area">
              <ProcessMonitor sessionId={activeSessionId} />
            </div>
          )}
        </div>
      </div>
      <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <SdkPermissionDialog />
    </div>
  );
}
