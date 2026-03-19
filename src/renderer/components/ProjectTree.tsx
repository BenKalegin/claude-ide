import React, { useMemo } from 'react';
import { useSessionStore } from '../stores/session-store';

interface TreeNode {
  name: string;
  path: string;
  sessions: SessionInfo[];
  children: TreeNode[];
  expanded: boolean;
}

export function ProjectTree(): React.ReactElement {
  const sessions = useSessionStore((s) => s.sessions);
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const selectSession = useSessionStore((s) => s.selectSession);

  const tree = useMemo(() => buildTree(Array.from(sessions.values())), [sessions]);

  const statusColor = (status: string) => {
    switch (status) {
      case 'active': return 'var(--color-green)';
      case 'thinking': return 'var(--color-yellow)';
      case 'error': return 'var(--color-red)';
      default: return 'var(--color-gray)';
    }
  };

  const renderNode = (node: TreeNode, depth: number = 0) => (
    <div key={node.path}>
      {node.sessions.length === 0 && node.children.length > 0 && (
        <div className="tree-folder" style={{ paddingLeft: depth * 12 + 8 }}>
          <span className="tree-folder-icon">&#9662;</span>
          <span className="tree-folder-name">{node.name}</span>
        </div>
      )}
      {node.sessions.map((s) => (
        <div
          key={s.id}
          className={`tree-item ${activeSessionId === s.id ? 'tree-active' : ''}`}
          style={{ paddingLeft: depth * 12 + 8 }}
          onClick={() => selectSession(s.id)}
        >
          <span className="tree-dot" style={{ backgroundColor: statusColor(s.status) }} />
          <span className="tree-name">{s.projectName}</span>
          <span className={`tree-mode tree-mode-${s.mode || 'terminal'}`}>
            {s.mode === 'sdk' ? 'SDK' : 'TTY'}
          </span>
        </div>
      ))}
      {node.children.map((child) => renderNode(child, depth + 1))}
    </div>
  );

  if (tree.length === 0) {
    return (
      <div className="tree-empty">
        No active sessions
      </div>
    );
  }

  return (
    <div className="project-tree">
      {tree.map((node) => renderNode(node))}
    </div>
  );
}

function buildTree(sessions: SessionInfo[]): TreeNode[] {
  const groups = new Map<string, SessionInfo[]>();

  for (const s of sessions) {
    const parent = s.projectPath.split('/').slice(0, -1).join('/');
    const existing = groups.get(parent) || [];
    existing.push(s);
    groups.set(parent, existing);
  }

  if (groups.size <= 1) {
    return sessions.map((s) => ({
      name: s.projectName,
      path: s.projectPath,
      sessions: [s],
      children: [],
      expanded: true,
    }));
  }

  return Array.from(groups.entries()).map(([parentPath, groupSessions]) => ({
    name: parentPath.split('/').pop() || parentPath,
    path: parentPath,
    sessions: [],
    children: groupSessions.map((s) => ({
      name: s.projectName,
      path: s.projectPath,
      sessions: [s],
      children: [],
      expanded: true,
    })),
    expanded: true,
  }));
}
