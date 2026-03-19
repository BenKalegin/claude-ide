import { spawn as ptySpawn, IPty } from 'node-pty';
import { BrowserWindow } from 'electron';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { createLogger } from './logger';

const log = createLogger('session');

export type SessionMode = 'terminal' | 'sdk';

export interface SessionInfo {
  id: string;
  projectPath: string;
  projectName: string;
  claudeSessionId?: string;
  status: 'active' | 'stopped' | 'error' | 'thinking';
  pid?: number;
  mode: SessionMode;
}

interface PersistedState {
  sessions: Array<{
    id: string;
    projectPath: string;
    projectName: string;
    claudeSessionId?: string;
    mode: SessionMode;
  }>;
}

const STATE_DIR = path.join(os.homedir(), '.claude-ide');
const STATE_FILE = path.join(STATE_DIR, 'sessions.json');

export class SessionManager {
  private sessions: Map<string, SessionInfo> = new Map();
  private ptys: Map<string, IPty> = new Map();
  private window: BrowserWindow | null = null;
  private processTimer: ReturnType<typeof setInterval> | null = null;

  setWindow(win: BrowserWindow): void {
    this.window = win;
  }

  createSession(projectPath: string, mode: SessionMode = 'terminal'): SessionInfo {
    const id = crypto.randomUUID();
    const projectName = path.basename(projectPath);

    if (mode === 'sdk') {
      const session: SessionInfo = {
        id,
        projectPath,
        projectName,
        status: 'stopped',
        mode: 'sdk',
      };
      this.sessions.set(id, session);
      this.persistState();
      return session;
    }

    log.info(`Creating terminal session: ${projectName} (${projectPath})`);

    const pty = ptySpawn('claude', [], {
      name: 'xterm-256color',
      cols: 120,
      rows: 30,
      cwd: projectPath,
      env: { ...process.env } as Record<string, string>
    });

    const session: SessionInfo = {
      id,
      projectPath,
      projectName,
      status: 'active',
      pid: pty.pid,
      mode: 'terminal',
    };

    log.info(`Session ${id} spawned, pid: ${pty.pid}`);

    this.sessions.set(id, session);
    this.ptys.set(id, pty);

    pty.onData((data) => {
      this.window?.webContents.send('session-data', { id, data });
    });

    pty.onExit(({ exitCode }) => {
      log.info(`Session ${id} exited, code: ${exitCode}`);
      const s = this.sessions.get(id);
      if (s) {
        s.status = exitCode === 0 ? 'stopped' : 'error';
        s.pid = undefined;
        this.window?.webContents.send('session-status', { id, status: s.status });
      }
      this.ptys.delete(id);
      this.persistState();
    });

    this.persistState();
    return session;
  }

  resumeSession(id: string): SessionInfo | null {
    const session = this.sessions.get(id);
    if (!session) return null;
    if (session.mode === 'sdk') {
      session.status = 'active';
      this.persistState();
      return session;
    }
    if (session.status === 'active' && this.ptys.has(id)) return session;

    const pty = ptySpawn('claude', session.claudeSessionId ? ['--resume', session.claudeSessionId] : [], {
      name: 'xterm-256color',
      cols: 120,
      rows: 30,
      cwd: session.projectPath,
      env: { ...process.env } as Record<string, string>
    });

    session.status = 'active';
    session.pid = pty.pid;
    this.ptys.set(id, pty);

    pty.onData((data) => {
      this.window?.webContents.send('session-data', { id, data });
    });

    pty.onExit(({ exitCode }) => {
      const s = this.sessions.get(id);
      if (s) {
        s.status = exitCode === 0 ? 'stopped' : 'error';
        s.pid = undefined;
        this.window?.webContents.send('session-status', { id, status: s.status });
      }
      this.ptys.delete(id);
      this.persistState();
    });

    this.persistState();
    return session;
  }

  killSession(id: string): boolean {
    const pty = this.ptys.get(id);
    if (pty) {
      pty.kill();
      this.ptys.delete(id);
    }
    const session = this.sessions.get(id);
    if (session) {
      session.status = 'stopped';
      session.pid = undefined;
      this.persistState();
      return true;
    }
    return false;
  }

  removeSession(id: string): void {
    this.killSession(id);
    this.sessions.delete(id);
    this.persistState();
  }

  writeToSession(id: string, data: string): void {
    this.ptys.get(id)?.write(data);
  }

  resizeSession(id: string, cols: number, rows: number): void {
    this.ptys.get(id)?.resize(cols, rows);
  }

  getAll(): SessionInfo[] {
    return Array.from(this.sessions.values());
  }

  getChildProcesses(id: string): Array<{ pid: number; command: string }> {
    const session = this.sessions.get(id);
    if (!session?.pid) return [];

    try {
      const output = execSync(`pgrep -P ${session.pid} -l`, { encoding: 'utf-8', timeout: 3000 });
      return output
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const [pidStr, ...cmdParts] = line.trim().split(/\s+/);
          return { pid: parseInt(pidStr, 10), command: cmdParts.join(' ') };
        });
    } catch {
      return [];
    }
  }

  killChildProcess(pid: number): boolean {
    try {
      process.kill(pid, 'SIGTERM');
      return true;
    } catch {
      return false;
    }
  }

  persistState(): void {
    try {
      if (!fs.existsSync(STATE_DIR)) {
        fs.mkdirSync(STATE_DIR, { recursive: true });
      }
      const state: PersistedState = {
        sessions: Array.from(this.sessions.values()).map((s) => ({
          id: s.id,
          projectPath: s.projectPath,
          projectName: s.projectName,
          claudeSessionId: s.claudeSessionId,
          mode: s.mode,
        }))
      };
      fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
    } catch {
      // silently fail
    }
  }

  restoreState(): SessionInfo[] {
    try {
      if (!fs.existsSync(STATE_FILE)) return [];
      const raw = fs.readFileSync(STATE_FILE, 'utf-8');
      const state: PersistedState = JSON.parse(raw);
      for (const s of state.sessions) {
        if (!this.sessions.has(s.id)) {
          this.sessions.set(s.id, {
            ...s,
            status: 'stopped',
            mode: s.mode || 'terminal',
          });
        }
      }
      return this.getAll();
    } catch {
      return [];
    }
  }

  startProcessMonitor(): void {
    this.processTimer = setInterval(() => {
      for (const session of this.sessions.values()) {
        if (session.status === 'active' && session.pid) {
          const procs = this.getChildProcesses(session.id);
          this.window?.webContents.send('session-processes', { id: session.id, processes: procs });
        }
      }
    }, 3000);
  }

  stopProcessMonitor(): void {
    if (this.processTimer) {
      clearInterval(this.processTimer);
      this.processTimer = null;
    }
  }

  destroy(): void {
    this.stopProcessMonitor();
    for (const [id] of this.ptys) {
      this.killSession(id);
    }
    this.persistState();
  }
}
