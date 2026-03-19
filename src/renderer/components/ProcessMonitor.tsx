import React, { useEffect, useState } from 'react';
import { useSessionStore } from '../stores/session-store';

interface Props {
  sessionId: string | null;
}

export function ProcessMonitor({ sessionId }: Props): React.ReactElement {
  const processes = useSessionStore((s) => (sessionId ? s.processes.get(sessionId) : undefined));
  const [refreshing, setRefreshing] = useState(false);

  const handleRefresh = async () => {
    if (!sessionId) return;
    setRefreshing(true);
    try {
      const procs = await window.api.sessions.getProcesses(sessionId);
      useSessionStore.getState().setProcesses(sessionId, procs);
    } finally {
      setRefreshing(false);
    }
  };

  const handleKill = async (pid: number) => {
    await window.api.sessions.killProcess(pid);
    if (sessionId) {
      const procs = await window.api.sessions.getProcesses(sessionId);
      useSessionStore.getState().setProcesses(sessionId, procs);
    }
  };

  if (!sessionId) {
    return <div className="process-monitor empty">No active session</div>;
  }

  return (
    <div className="process-monitor">
      <div className="process-header">
        <span className="process-title">Child Processes</span>
        <button
          className="btn-refresh"
          onClick={handleRefresh}
          disabled={refreshing}
        >
          {refreshing ? '...' : 'Refresh'}
        </button>
      </div>
      {(!processes || processes.length === 0) ? (
        <div className="process-empty">No child processes</div>
      ) : (
        <table className="process-table">
          <thead>
            <tr>
              <th>PID</th>
              <th>Command</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {processes.map((p) => (
              <tr key={p.pid}>
                <td className="pid-cell">{p.pid}</td>
                <td className="command-cell">{p.command}</td>
                <td className="action-cell">
                  <button className="btn-kill" onClick={() => handleKill(p.pid)}>Kill</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
