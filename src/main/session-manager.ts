import { spawn as ptySpawn, IPty } from 'node-pty';
import { BrowserWindow } from 'electron';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { createLogger } from './logger';
import { SessionMode, SessionStatus, IpcChannel, PTY_TERM, PTY_DEFAULT_COLS, PTY_DEFAULT_ROWS } from '../core/constants';

const log = createLogger('session');

function resolveClaudePath(): string {
  try {
    return execSync('which claude', { encoding: 'utf-8', shell: '/bin/zsh' }).trim();
  } catch {
    return 'claude';
  }
}

export interface SessionInfo {
  id: string;
  projectPath: string;
  projectName: string;
  claudeSessionId?: string;
  status: SessionStatus;
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

  createSession(projectPath: string, mode: SessionMode = SessionMode.Terminal): SessionInfo {
    const id = crypto.randomUUID();
    const projectName = path.basename(projectPath);

    if (mode === SessionMode.Sdk) {
      const session: SessionInfo = {
        id,
        projectPath,
        projectName,
        status: SessionStatus.Stopped,
        mode: SessionMode.Sdk,
      };
      this.sessions.set(id, session);
      this.persistState();
      return session;
    }

    log.info(`Creating terminal session: ${projectName} (${projectPath})`);

    const claudePath = resolveClaudePath();
    log.info(`Using claude at: ${claudePath}`);

    let pty: IPty;
    try {
      pty = ptySpawn(claudePath, [], {
        name: PTY_TERM,
        cols: PTY_DEFAULT_COLS,
        rows: PTY_DEFAULT_ROWS,
        cwd: projectPath,
        env: { ...process.env } as Record<string, string>
      });
    } catch (err) {
      log.error(`Failed to spawn PTY:`, err);
      const session: SessionInfo = {
        id,
        projectPath,
        projectName,
        status: SessionStatus.Error,
        mode: SessionMode.Terminal,
      };
      this.sessions.set(id, session);
      this.persistState();
      return session;
    }

    const session: SessionInfo = {
      id,
      projectPath,
      projectName,
      status: SessionStatus.Active,
      pid: pty.pid,
      mode: SessionMode.Terminal,
    };

    log.info(`Session ${id} spawned, pid: ${pty.pid}`);

    this.sessions.set(id, session);
    this.ptys.set(id, pty);

    pty.onData((data) => {
      this.window?.webContents.send(IpcChannel.SessionData, { id, data });
    });

    pty.onExit(({ exitCode }) => {
      log.info(`Session ${id} exited, code: ${exitCode}`);
      const s = this.sessions.get(id);
      if (s) {
        s.status = exitCode === 0 ? SessionStatus.Stopped : SessionStatus.Error;
        s.pid = undefined;
        this.window?.webContents.send(IpcChannel.SessionStatus, { id, status: s.status });
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
    if (session.mode === SessionMode.Sdk) {
      session.status = SessionStatus.Active;
      this.persistState();
      return session;
    }
    if (session.status === SessionStatus.Active && this.ptys.has(id)) return session;

    const claudePath = resolveClaudePath();
    const args = session.claudeSessionId
      ? ['--resume', session.claudeSessionId]
      : ['--continue'];
    log.info(`Resuming session ${id} with args: ${args.join(' ')}`);
    const pty = ptySpawn(claudePath, args, {
      name: PTY_TERM,
      cols: PTY_DEFAULT_COLS,
      rows: PTY_DEFAULT_ROWS,
      cwd: session.projectPath,
      env: { ...process.env } as Record<string, string>
    });

    session.status = SessionStatus.Active;
    session.pid = pty.pid;
    this.ptys.set(id, pty);

    pty.onData((data) => {
      this.window?.webContents.send(IpcChannel.SessionData, { id, data });
    });

    pty.onExit(({ exitCode }) => {
      const s = this.sessions.get(id);
      if (s) {
        s.status = exitCode === 0 ? SessionStatus.Stopped : SessionStatus.Error;
        s.pid = undefined;
        this.window?.webContents.send(IpcChannel.SessionStatus, { id, status: s.status });
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
      session.status = SessionStatus.Stopped;
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
            status: SessionStatus.Stopped,
            mode: s.mode || SessionMode.Terminal,
          });
        }
      }
      return this.getAll();
    } catch {
      return [];
    }
  }

  autoResumeSessions(): void {
    for (const session of this.sessions.values()) {
      if (session.mode === SessionMode.Terminal && session.status === SessionStatus.Stopped && !this.ptys.has(session.id)) {
        log.info(`Auto-resuming terminal session: ${session.id} (${session.projectName})`);
        this.resumeSession(session.id);
      }
    }
  }

  startProcessMonitor(): void {
    this.processTimer = setInterval(() => {
      for (const session of this.sessions.values()) {
        if (session.status === SessionStatus.Active && session.pid) {
          const procs = this.getChildProcesses(session.id);
          this.window?.webContents.send(IpcChannel.SessionProcesses, { id: session.id, processes: procs });
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
