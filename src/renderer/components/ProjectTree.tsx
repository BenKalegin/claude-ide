import React, { useMemo, useState, useRef, useEffect, useCallback } from 'react';
import { useSessionStore } from '../stores/session-store';
import { AgentProvider, SessionMode, SessionActivity, SdkMessageType } from '../../core/constants';

const SESSION_LABEL_PREVIEW_CHARS = 40;

interface ProjectGroup {
  projectPath: string;
  displayName: string;
  sessions: SessionInfo[];
}

// Pure presentation helpers, hoisted to module scope so they don't capture
// component state — keeps them stable for the memoized SessionRow below.
function getSessionLabel(s: SessionInfo): string {
  if (s.title) return s.title;
  // Fallback: first user message
  const msgs = useSessionStore.getState().sdkMessages.get(s.id);
  if (msgs && msgs.length > 0) {
    const firstUser = msgs.find((m) => m.type === SdkMessageType.User);
    if (firstUser) {
      const text = firstUser.content.slice(0, SESSION_LABEL_PREVIEW_CHARS);
      return text.length < firstUser.content.length ? text + '...' : text;
    }
  }
  return s.mode === SessionMode.Terminal ? `${s.projectName} (tty)` : 'New session';
}

function getProviderLabel(provider: AgentProvider | undefined): string {
  switch (provider) {
    case AgentProvider.Codex: return 'Codex';
    case AgentProvider.Kiro: return 'Kiro';
    default: return 'Claude';
  }
}

function formatActivity(activity: string, detail?: string): string {
  switch (activity) {
    case SessionActivity.WaitingForUser: return 'awaiting input';
    case SessionActivity.Thinking: return detail ? `${detail}…` : 'thinking…';
    case SessionActivity.UsingTool: return detail ? `${detail}` : 'tool…';
    case SessionActivity.Streaming: return 'writing…';
    default: return '';
  }
}

interface SessionRowProps {
  session: SessionInfo;
  label: string;
  isActive: boolean;
  isConfirmingClose: boolean;
  onSelect: (id: string) => void;
  onRequestClose: (id: string) => void;
  onConfirmClose: (id: string) => void;
  onCancelClose: () => void;
}

// Memoized so a single session's 750ms activity update re-renders only that
// row, not the whole tree. Relies on the store preserving object identity for
// unchanged sessions and on all callbacks/flags being referentially stable.
const SessionRow = React.memo(function SessionRow({
  session: s,
  label,
  isActive,
  isConfirmingClose,
  onSelect,
  onRequestClose,
  onConfirmClose,
  onCancelClose,
}: SessionRowProps): React.ReactElement {
  return (
    <div
      className={`tree-item ${isActive ? 'tree-active' : ''}`}
      onClick={() => onSelect(s.id)}
      title={s.summary || ''}
      data-status={s.status}
      data-activity={s.activity || SessionActivity.Idle}
      data-waiting={s.activity === SessionActivity.WaitingForUser ? 'true' : undefined}
      data-running={
        s.activity && s.activity !== SessionActivity.Idle && s.activity !== SessionActivity.WaitingForUser
          ? 'true'
          : undefined
      }
    >
      {s.activity === SessionActivity.WaitingForUser ? (
        <span className="tree-glyph-wait" aria-label="waiting for input">!</span>
      ) : (
        <span className="tree-dot" />
      )}
      <span className="tree-name">{label}</span>
      {s.unbounded && (
        <span className="tree-unbounded" title="Unbounded: auto-approves all tools (git blocked)">&#9889;</span>
      )}
      {s.subagentCount !== undefined && s.subagentCount > 0 && (
        <span className="tree-subagent" title={`${s.subagentCount} subagent${s.subagentCount === 1 ? '' : 's'}`}>
          &times;{s.subagentCount}
        </span>
      )}
      {s.activity && s.activity !== SessionActivity.Idle && (
        <span className="tree-activity">{formatActivity(s.activity, s.activityDetail)}</span>
      )}
      {s.mode === SessionMode.Terminal && (
        <span className="tree-mode tree-mode-terminal">{getProviderLabel(s.provider)} TTY</span>
      )}
      {s.mode === SessionMode.Sdk && (
        <span className="tree-mode tree-mode-sdk">{getProviderLabel(s.provider)} SDK</span>
      )}
      {isConfirmingClose ? (
        <span className="tree-confirm-close">
          <button className="tree-confirm-yes" title="Confirm close" onClick={(e) => { e.stopPropagation(); onConfirmClose(s.id); }}>&#10003;</button>
          <button className="tree-confirm-no" title="Cancel" onClick={(e) => { e.stopPropagation(); onCancelClose(); }}>&#10005;</button>
        </span>
      ) : (
        <button
          className="tree-close-btn"
          title="Close session"
          onClick={(e) => { e.stopPropagation(); onRequestClose(s.id); }}
        >&times;</button>
      )}
    </div>
  );
});

export function ProjectTree(): React.ReactElement {
  const sessions = useSessionStore((s) => s.sessions);
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const selectSession = useSessionStore((s) => s.selectSession);
  const removeSession = useSessionStore((s) => s.removeSession);
  const projectNames = useSessionStore((s) => s.projectNames);
  const projectActivity = useSessionStore((s) => s.projectActivity);
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

  // "Sticky recency" ordering. The displayed order lives in this ref and is held
  // frozen while you work: switching between projects never moves them. It only
  // changes in two ways — at launch the whole list sorts by recency, and a project
  // that newly appears is prepended (it's the one you just opened). Closed projects
  // drop out. Recency itself (projectActivity) is bumped on select/create in the store.
  const orderRef = useRef<string[]>([]);
  const orderedGroups = useMemo(() => {
    const byPath = new Map(groups.map((g) => [g.projectPath, g]));
    const currentPaths = groups.map((g) => g.projectPath);
    const prev = orderRef.current;
    // Effective recency = the later of an explicit select/create (projectActivity)
    // and the project's most recent session transcript activity (lastActiveAt).
    // The latter ensures projects you've worked in but never clicked the row for
    // still sort by real recency instead of collapsing to 0.
    const recencyOf = (p: string): number => {
      const group = byPath.get(p);
      const sessionRecency = group
        ? group.sessions.reduce((max, s) => Math.max(max, s.lastActiveAt ?? 0), 0)
        : 0;
      return Math.max(projectActivity[p] ?? 0, sessionRecency);
    };
    const byRecencyDesc = (a: string, b: string) => recencyOf(b) - recencyOf(a);

    let order: string[];
    if (prev.length === 0) {
      // First populated render (launch): sort everything by recency, most recent first.
      order = [...currentPaths].sort(byRecencyDesc);
    } else {
      const kept = prev.filter((p) => byPath.has(p));
      const added = currentPaths.filter((p) => !prev.includes(p)).sort(byRecencyDesc);
      order = [...added, ...kept];
    }
    orderRef.current = order;
    return order.map((p) => byPath.get(p)).filter((g): g is ProjectGroup => g !== undefined);
  }, [groups, projectActivity]);

  // The session ids in the exact order they're rendered (project order, then
  // sessions within each project). Kept in a ref so close-on-delete can pick the
  // visible neighbor without making its callback depend on the changing list —
  // that would defeat the memoized SessionRow.
  const flatOrderRef = useRef<string[]>([]);
  flatOrderRef.current = orderedGroups.flatMap((g) => g.sessions.map((s) => s.id));

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

  const handleNewSession = async (
    projectPath: string,
    mode: SessionMode,
    provider: AgentProvider,
    unbounded = false,
  ) => {
    setAddMenuPath(null);
    const session = await window.api.sessions.create(projectPath, mode, provider, unbounded);
    addSession(session);
    selectSession(session.id);
  };

  const [confirmCloseId, setConfirmCloseId] = useState<string | null>(null);

  // Stable callbacks: passed to the memoized SessionRow, so they must keep the
  // same reference across renders or they'd defeat the memo. setConfirmCloseId
  // and removeSession are already stable references.
  const handleRequestClose = useCallback((id: string) => setConfirmCloseId(id), []);
  const handleCancelClose = useCallback(() => setConfirmCloseId(null), []);
  const handleConfirmClose = useCallback(async (id: string) => {
    // If we're closing the session that's currently open, fall through to its
    // visible neighbor (the next row, or the previous one if it was last) so the
    // list highlight and the right pane stay in sync — like closing a tab.
    const wasActive = useSessionStore.getState().activeSessionId === id;
    let neighbor: string | null = null;
    if (wasActive) {
      const flat = flatOrderRef.current;
      const idx = flat.indexOf(id);
      neighbor = flat[idx + 1] ?? flat[idx - 1] ?? null;
    }
    await window.api.sessions.kill(id);
    await window.api.sessions.remove(id);
    removeSession(id);
    if (wasActive) selectSession(neighbor);
    setConfirmCloseId(null);
  }, [removeSession, selectSession]);

  useEffect(() => {
    if (!addMenuPath) return;
    const close = () => setAddMenuPath(null);
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, [addMenuPath]);

  if (orderedGroups.length === 0) {
    return <div className="tree-empty">No active sessions</div>;
  }

  return (
    <div className="project-tree">
      {orderedGroups.map((group) => (
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
              <button onClick={() => handleNewSession(group.projectPath, SessionMode.Sdk, AgentProvider.Claude)}>
                <span className="mode-icon">&#9671;</span> Claude SDK
              </button>
              <button onClick={() => handleNewSession(group.projectPath, SessionMode.Terminal, AgentProvider.Claude)}>
                <span className="mode-icon">&#9654;</span> Claude Terminal
              </button>
              <button
                onClick={() => handleNewSession(group.projectPath, SessionMode.Terminal, AgentProvider.Claude, true)}
                title="Auto-approve all tools (git stays blocked)"
              >
                <span className="mode-icon">&#9889;</span> Claude Terminal (unbounded)
              </button>
              <button onClick={() => handleNewSession(group.projectPath, SessionMode.Terminal, AgentProvider.Codex)}>
                <span className="mode-icon">&#9654;</span> Codex Terminal
              </button>
              <button onClick={() => handleNewSession(group.projectPath, SessionMode.Terminal, AgentProvider.Kiro)}>
                <span className="mode-icon">&#9654;</span> Kiro Terminal
              </button>
            </div>
          )}
          {group.sessions.map((s) => (
            <SessionRow
              key={s.id}
              session={s}
              label={getSessionLabel(s)}
              isActive={activeSessionId === s.id}
              isConfirmingClose={confirmCloseId === s.id}
              onSelect={selectSession}
              onRequestClose={handleRequestClose}
              onConfirmClose={handleConfirmClose}
              onCancelClose={handleCancelClose}
            />
          ))}
        </div>
      ))}
    </div>
  );
}
