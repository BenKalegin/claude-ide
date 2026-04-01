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
  title?: string;
  summary?: string;
}

interface PersistedState {
  sessions: Array<{
    id: string;
    projectPath: string;
    projectName: string;
    claudeSessionId?: string;
    mode: SessionMode;
    title?: string;
    summary?: string;
  }>;
}

const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const TITLE_MAX_CHARS = 40;
const SUMMARY_MAX_CHARS = 200;
const SUMMARIZE_MODEL = 'haiku';
const TITLE_UPDATE_INTERVAL = 30000;

const STATE_DIR = path.join(os.homedir(), '.claude-ide');
const STATE_FILE = path.join(STATE_DIR, 'sessions.json');

export class SessionManager {
  private sessions: Map<string, SessionInfo> = new Map();
  private ptys: Map<string, IPty> = new Map();
  private window: BrowserWindow | null = null;
  private processTimer: ReturnType<typeof setInterval> | null = null;
  private titleTimer: ReturnType<typeof setInterval> | null = null;

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
          title: s.title,
          summary: s.summary,
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

  startTitleUpdater(): void {
    log.info('Starting TTY title updater');

    // Run immediately for all TTY sessions without titles
    for (const session of this.sessions.values()) {
      if (session.mode === SessionMode.Terminal && !session.title) {
        log.info(`Backfilling TTY title for ${session.id} (${session.projectName})`);
        this.updateTtyTitle(session).catch(() => {});
      }
    }

    // Periodically update titles for active TTY sessions
    this.titleTimer = setInterval(() => {
      for (const session of this.sessions.values()) {
        if (session.mode === SessionMode.Terminal && session.status === SessionStatus.Active) {
          this.updateTtyTitle(session).catch(() => {});
        }
      }
    }, TITLE_UPDATE_INTERVAL);
  }

  private async updateTtyTitle(session: SessionInfo): Promise<void> {
    try {
      const encodedCwd = session.projectPath.replace(/[^a-zA-Z0-9]/g, '-');
      const sessionDir = path.join(CLAUDE_PROJECTS_DIR, encodedCwd);
      log.debug(`TTY title: checking ${sessionDir}`);
      if (!fs.existsSync(sessionDir)) {
        log.debug(`TTY title: dir not found for ${session.projectName}`);
        return;
      }

      const files = fs.readdirSync(sessionDir)
        .filter((f) => f.endsWith('.jsonl'))
        .map((f) => ({ name: f, mtime: fs.statSync(path.join(sessionDir, f)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime);

      if (files.length === 0) {
        log.debug(`TTY title: no JSONL files for ${session.projectName}`);
        return;
      }

      const sessionFile = path.join(sessionDir, files[0].name);
      const lines = fs.readFileSync(sessionFile, 'utf-8').trim().split('\n');
      log.debug(`TTY title: reading ${files[0].name} (${lines.length} lines)`);

      const userMessages: string[] = [];
      // Scan all lines — user messages can be sparse among tool calls and file snapshots
      for (const line of lines) {
        try {
          const msg = JSON.parse(line);
          if (msg.type !== 'user') continue;
          const raw = msg.message?.content ?? msg.content;
          let text = '';
          if (typeof raw === 'string') {
            text = raw;
          } else if (Array.isArray(raw)) {
            text = raw
              .filter((b: { type: string }) => b.type === 'text')
              .map((b: { text: string }) => b.text)
              .join(' ');
          }
          // Skip system/meta messages
          if (text && text.length > 10 && !text.startsWith('<')) {
            userMessages.push(text.slice(0, 100));
          }
        } catch { /* skip malformed lines */ }
      }

      if (userMessages.length === 0) {
        log.debug(`TTY title: no user messages found for ${session.projectName}`);
        return;
      }

      log.info(`TTY title: generating for ${session.projectName} (${userMessages.length} user msgs found)`);

      const excerpt = userMessages.slice(-3).join('\n');
      const prompt = `These are the last few user messages in a coding session:\n${excerpt}\nProvide a short title (3-6 words, max ${TITLE_MAX_CHARS} chars) summarizing what this session is about.\nReply ONLY as JSON: {"title": "..."}`;

      const claudePath = resolveClaudePath();
      const { execFile } = await import('child_process');
      const { promisify } = await import('util');
      const execFileAsync = promisify(execFile);

      const { stdout } = await execFileAsync(claudePath, [
        '-p', prompt,
        '--model', SUMMARIZE_MODEL,
        '--output-format', 'text',
      ], { timeout: 30000 });

      const jsonMatch = stdout.trim().match(/\{[\s\S]*\}/);
      if (!jsonMatch) return;

      const parsed = JSON.parse(jsonMatch[0]) as { title?: string };
      if (parsed.title) {
        session.title = parsed.title.slice(0, TITLE_MAX_CHARS);
        log.info(`TTY session ${session.id} title: "${session.title}"`);
        this.window?.webContents.send(IpcChannel.SdkTitle, {
          id: session.id,
          title: session.title,
          summary: '',
        });
        this.persistState();
      }
    } catch (err) {
      log.error(`Failed to update TTY title for ${session.id}:`, err);
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
    if (this.titleTimer) {
      clearInterval(this.titleTimer);
      this.titleTimer = null;
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
