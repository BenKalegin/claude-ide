import { spawn as ptySpawn, IPty } from 'node-pty';
import { BrowserWindow } from 'electron';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { createLogger } from './logger';
import {
  AgentProvider,
  DEFAULT_AGENT_PROVIDER,
  IpcChannel,
  PTY_DEFAULT_COLS,
  PTY_DEFAULT_ROWS,
  PTY_TERM,
  SessionActivity,
  SessionMode,
  SessionStatus,
  TtyKeySequence,
} from '../core/constants';
import { latestModelAliasInLines } from './transcript-model';
import {
  ModelPickerKey,
  isPickerReady,
  parseModelPicker,
  planPickerNavigation,
} from './model-picker';
import { createTtyState, ingest, snapshot, clearWaiting } from './tty-activity';
import type { TtyActivitySnapshot } from './tty-activity';
import { getDefaultModelForProvider, getTerminalProvider } from './agent-terminal-provider';

const ACTIVITY_POLL_MS = 750;
const PROVIDER_SESSION_ID_DETECT_MS = 6000;
const PROVIDER_SESSION_ID_POLL_MS = 500;
const PROCESS_POLL_MS = 3000;
const PROCESS_POLL_TIMEOUT_MS = 3000;
// A `/clear` (or auto-compaction) mid-session makes claude rotate to a brand-new
// transcript with no parentUuid link, leaving the bound one frozen. We only go
// looking for that continuation once the bound transcript has been quiet this
// long — while it's still growing the conversation is live on its own file.
const FORK_OWN_STABLE_MS = 4000;
// A continuation transcript begins right when the bound one goes quiet. This
// slack absorbs clock skew / line-ordering so we still recognise it as adjacent.
const FORK_ADJACENCY_TOLERANCE_MS = 5000;

const execAsync = promisify(exec);

// Per-session scrollback retained in the main process (like a tmux window
// buffer). Only the focused session streams to the renderer; others accumulate
// here cheaply, off the GUI thread, and replay via a snapshot when focused.
// Sized to survive a renderer refresh (e.g. after laptop sleep) without the
// meaningful output of a long-running session scrolling out of the window:
// at 256KB a multi-day eval session's history was lost on refresh, leaving the
// terminal looking cleared. 2MB × ~30 background sessions is a few tens of MB.
const OUTPUT_BUFFER_MAX_CHARS = 2 * 1024 * 1024;

const log = createLogger('session');

export interface SessionInfo {
  id: string;
  projectPath: string;
  projectName: string;
  provider: AgentProvider;
  providerSessionId?: string;
  status: SessionStatus;
  pid?: number;
  mode: SessionMode;
  title?: string;
  summary?: string;
  model: string;
  activity?: SessionActivity;
  activityDetail?: string;
  subagentCount?: number;
  // When true the session was launched in "unbounded" mode (auto-approve all
  // tools, git still denied). Persisted so resume re-applies the same flags.
  unbounded?: boolean;
  // Epoch ms of this session's most recent transcript activity. Derived at
  // list() time from the transcript file mtime; used by the sidebar's
  // sticky-recency sort to order projects the user hasn't explicitly clicked.
  lastActiveAt?: number;
}

interface PersistedState {
  sessions: Array<{
    id: string;
    projectPath: string;
    projectName: string;
    provider?: AgentProvider;
    providerSessionId?: string;
    claudeSessionId?: string;
    mode: SessionMode;
    title?: string;
    summary?: string;
    model?: string;
    unbounded?: boolean;
  }>;
}

const TITLE_MAX_CHARS = 40;
const SUMMARY_MAX_CHARS = 200;
const SUMMARIZE_MODEL = 'haiku';
const TITLE_GENERATION_DELAY = 10000;
// Don't re-title a session more than once per this interval, even if it goes
// idle repeatedly — each refresh is a haiku call.
const TITLE_REFRESH_MIN_INTERVAL_MS = 90_000;

const STATE_DIR = path.join(os.homedir(), '.claude-ide');
const STATE_FILE = path.join(STATE_DIR, 'sessions.json');
// Terminal scrollback is persisted here so a session's visible history
// survives an app restart even when there's no Claude transcript to --resume
// (e.g. a session used as a plain shell for scripts/eval drivers).
const SCROLLBACK_DIR = path.join(STATE_DIR, 'scrollback');
// Dirty buffers are flushed no more often than this — bounds disk I/O while
// capping worst-case loss on a hard kill to a few seconds of output.
const SCROLLBACK_FLUSH_MS = 3000;

// Picker-driving timings for live model switches. The picker opens fast but we
// poll for its footer rather than guess; arrows are paced so the TUI's input
// handler registers each as a discrete keypress (a burst is dropped).
const PICKER_OPEN_TIMEOUT_MS = 4000;
const PICKER_POLL_MS = 120;
const PICKER_ARROW_DELAY_MS = 120;
const PICKER_SETTLE_MS = 200;

function normalizeAgentProvider(provider?: AgentProvider): AgentProvider {
  switch (provider) {
    case AgentProvider.Codex:
    case AgentProvider.Kiro:
      return provider;
    default:
      return AgentProvider.Claude;
  }
}

export class SessionManager {
  private sessions: Map<string, SessionInfo> = new Map();
  private ptys: Map<string, IPty> = new Map();
  private window: BrowserWindow | null = null;
  private processTimer: ReturnType<typeof setInterval> | null = null;
  private activityStates: Map<string, ReturnType<typeof createTtyState>> = new Map();
  private activityTimer: ReturnType<typeof setInterval> | null = null;
  private outputBuffers: Map<string, string> = new Map();
  // Sessions whose scrollback changed since the last disk flush, and when we
  // last flushed — together they throttle persistence to SCROLLBACK_FLUSH_MS.
  private scrollbackDirty: Set<string> = new Set();
  private lastScrollbackFlushAt = 0;
  // Epoch ms of the last title generation per session, for refresh throttling.
  private lastTitleGenAt: Map<string, number> = new Map();
  // Byte offset of consumed transcript content per session, for the model
  // watcher. Seeded at spawn to the current file size so only lines appended
  // during this run (e.g. /model confirmations) are scanned — historical
  // content is irrelevant because spawn always passes --model explicitly.
  private transcriptModelOffsets: Map<string, number> = new Map();
  // Tracks the bound transcript's size per session so the fork watcher can tell
  // "still being written" from "gone quiet"; `scanned` debounces the dir scan to
  // once per quiet window so the activity tick stays cheap (one stat) at rest.
  private forkWatch: Map<string, { ownSize: number; stableSince: number; scanned: boolean }> = new Map();
  private focusedSessionId: string | null = null;

  setWindow(win: BrowserWindow): void {
    this.window = win;
  }

  /** Append PTY output to the session's bounded scrollback buffer. */
  private bufferOutput(id: string, data: string): void {
    const next = (this.outputBuffers.get(id) ?? '') + data;
    this.outputBuffers.set(
      id,
      next.length > OUTPUT_BUFFER_MAX_CHARS ? next.slice(next.length - OUTPUT_BUFFER_MAX_CHARS) : next
    );
    this.scrollbackDirty.add(id);
  }

  private scrollbackFile(id: string): string {
    return path.join(SCROLLBACK_DIR, `${id}.log`);
  }

  /** Flush dirty scrollback buffers to disk, throttled to SCROLLBACK_FLUSH_MS. */
  private maybeFlushScrollback(now: number): void {
    if (this.scrollbackDirty.size === 0) return;
    if (now - this.lastScrollbackFlushAt < SCROLLBACK_FLUSH_MS) return;
    this.lastScrollbackFlushAt = now;
    this.flushScrollback();
  }

  private flushScrollback(): void {
    if (this.scrollbackDirty.size === 0) return;
    try {
      if (!fs.existsSync(SCROLLBACK_DIR)) fs.mkdirSync(SCROLLBACK_DIR, { recursive: true });
    } catch {
      return;
    }
    for (const id of this.scrollbackDirty) {
      const buf = this.outputBuffers.get(id);
      if (buf === undefined) continue;
      try {
        fs.writeFileSync(this.scrollbackFile(id), buf);
      } catch {
        // best-effort persistence
      }
    }
    this.scrollbackDirty.clear();
  }

  /** Seed a session's in-memory buffer from disk so a restart can replay it. */
  private loadScrollback(id: string): void {
    try {
      const file = this.scrollbackFile(id);
      if (!fs.existsSync(file)) return;
      const data = fs.readFileSync(file, 'utf-8');
      this.outputBuffers.set(
        id,
        data.length > OUTPUT_BUFFER_MAX_CHARS ? data.slice(data.length - OUTPUT_BUFFER_MAX_CHARS) : data
      );
    } catch {
      // unreadable scrollback — start empty
    }
  }

  private deleteScrollback(id: string): void {
    this.scrollbackDirty.delete(id);
    try {
      const file = this.scrollbackFile(id);
      if (fs.existsSync(file)) fs.unlinkSync(file);
    } catch {
      // best-effort
    }
  }

  /**
   * Handle one chunk of PTY output: always buffer it and feed activity
   * detection, but only stream it to the renderer when this session is the
   * focused (visible) one. This is what keeps the GUI thread free when many
   * background sessions are producing output.
   */
  private handlePtyData(id: string, data: string): void {
    this.bufferOutput(id, data);
    if (id === this.focusedSessionId) this.send(IpcChannel.SessionData, { id, data });
    this.ingestPtyData(id, data);
  }

  /**
   * Mark which terminal session the renderer is currently showing. Sends a
   * one-shot snapshot of that session's buffer (with reset=true) so the
   * terminal repaints its scrollback, then resumes live streaming for it.
   */
  setFocusedSession(id: string | null): void {
    this.focusedSessionId = id;
    if (id === null) return;
    this.send(IpcChannel.SessionData, { id, data: this.outputBuffers.get(id) ?? '', reset: true });
  }

  /** Send IPC to renderer, silently skipping if the window/frame is destroyed. */
  private send(channel: string, ...args: unknown[]): void {
    if (!this.window || this.window.isDestroyed() || this.window.webContents.isDestroyed()) return;
    this.window.webContents.send(channel, ...args);
  }

  createSession(
    projectPath: string,
    mode: SessionMode = SessionMode.Terminal,
    provider: AgentProvider = DEFAULT_AGENT_PROVIDER,
    unbounded = false
  ): SessionInfo {
    const id = crypto.randomUUID();
    const projectName = path.basename(projectPath);
    const model = getDefaultModelForProvider(provider);

    if (mode === SessionMode.Sdk) {
      const session: SessionInfo = {
        id,
        projectPath,
        projectName,
        provider,
        status: SessionStatus.Stopped,
        mode: SessionMode.Sdk,
        model,
      };
      this.sessions.set(id, session);
      this.persistState();
      return session;
    }

    log.info(`Creating ${provider} terminal session: ${projectName} (${projectPath})`);

    const terminalProvider = getTerminalProvider(provider);
    const executablePath = terminalProvider.resolveExecutable();
    log.info(`Using ${provider} at: ${executablePath}`);

    // Claude lets us pin the transcript id via --session-id, so bind it to our
    // own session id up front — deterministic, no dir-watching race. Codex has
    // no such flag, so it still falls back to post-spawn detection.
    const pinnedSessionId = provider === AgentProvider.Claude ? id : undefined;
    const historyBaseline = this.snapshotProviderHistory(provider, projectPath);
    let pty: IPty;
    try {
      pty = ptySpawn(executablePath, terminalProvider.buildStartArgs(model, unbounded, pinnedSessionId), {
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
        provider,
        status: SessionStatus.Error,
        mode: SessionMode.Terminal,
        model,
        unbounded,
        providerSessionId: pinnedSessionId,
      };
      this.sessions.set(id, session);
      this.persistState();
      return session;
    }

    const session: SessionInfo = {
      id,
      projectPath,
      projectName,
      provider,
      status: SessionStatus.Active,
      pid: pty.pid,
      mode: SessionMode.Terminal,
      model,
      unbounded,
      providerSessionId: pinnedSessionId,
    };

    log.info(`Session ${id} spawned, pid: ${pty.pid}`);

    this.sessions.set(id, session);
    this.ptys.set(id, pty);

    this.activityStates.set(id, createTtyState());
    this.outputBuffers.delete(id);
    this.seedTranscriptModelOffset(session);

    pty.onData((data) => this.handlePtyData(id, data));

    pty.onExit(({ exitCode }) => {
      log.info(`Session ${id} exited, code: ${exitCode}`);
      const s = this.sessions.get(id);
      if (s) {
        s.status = exitCode === 0 ? SessionStatus.Stopped : SessionStatus.Error;
        s.pid = undefined;
        this.send(IpcChannel.SessionStatus, { id, status: s.status });
      }
      this.ptys.delete(id);
      this.activityStates.delete(id);
      this.persistState();
    });

    this.persistState();
    this.scheduleTitleGeneration(id);
    // For Claude, pinnedSessionId makes this a cheap confirmation; for Codex it
    // detects the real transcript. Either way it guards against a wrong binding.
    this.detectProviderSessionId(id, historyBaseline, pinnedSessionId).catch((e) =>
      log.warn(`providerSessionId detect failed for ${id}: ${e}`)
    );
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

    const terminalProvider = getTerminalProvider(session.provider);
    const executablePath = terminalProvider.resolveExecutable();
    // Guard against resuming a transcript that no longer exists. A Claude
    // session pinned via --session-id only gets its <id>.jsonl once a turn is
    // persisted; if the app quit before that (or the file was removed),
    // `--resume <id>` spawns a blank "from scratch" session — and usually one
    // that isn't re-pinned, so it stays broken on every later restart. When the
    // pinned transcript is missing, relaunch as a fresh session still pinned to
    // our id so it persists correctly going forward, rather than --resume a ghost.
    const resumeFresh = this.shouldResumeFresh(session);
    const args = resumeFresh
      ? terminalProvider.buildStartArgs(session.model, session.unbounded, session.providerSessionId)
      : terminalProvider.buildResumeArgs(session);
    log.info(`Resuming session ${id} with args: ${args.join(' ')}`);
    const historyBaseline = session.providerSessionId
      ? new Set<string>()
      : this.snapshotProviderHistory(session.provider, session.projectPath);
    const pty = ptySpawn(executablePath, args, {
      name: PTY_TERM,
      cols: PTY_DEFAULT_COLS,
      rows: PTY_DEFAULT_ROWS,
      cwd: session.projectPath,
      env: { ...process.env } as Record<string, string>
    });

    session.status = SessionStatus.Active;
    session.pid = pty.pid;
    this.ptys.set(id, pty);
    this.activityStates.set(id, createTtyState());
    // A --resume session redraws its own history into the terminal, so drop the
    // stale buffer to avoid duplicated content. A fresh (no-transcript) session
    // has nothing to redraw — keep the restored scrollback as its history.
    if (!resumeFresh) this.outputBuffers.delete(id);
    this.seedTranscriptModelOffset(session);

    pty.onData((data) => this.handlePtyData(id, data));

    pty.onExit(({ exitCode }) => {
      const s = this.sessions.get(id);
      if (s) {
        s.status = exitCode === 0 ? SessionStatus.Stopped : SessionStatus.Error;
        s.pid = undefined;
        this.send(IpcChannel.SessionStatus, { id, status: s.status });
      }
      this.ptys.delete(id);
      this.activityStates.delete(id);
      this.persistState();
    });

    this.persistState();
    this.scheduleTitleGeneration(id);
    if (!session.providerSessionId) {
      this.detectProviderSessionId(id, historyBaseline).catch((e) =>
        log.warn(`providerSessionId detect failed for ${id}: ${e}`)
      );
    }
    return session;
  }

  killSession(id: string): boolean {
    const pty = this.ptys.get(id);
    if (pty) {
      pty.kill();
      this.ptys.delete(id);
    }
    this.activityStates.delete(id);
    const session = this.sessions.get(id);
    if (session) {
      session.status = SessionStatus.Stopped;
      session.activity = SessionActivity.Idle;
      session.activityDetail = undefined;
      session.subagentCount = 0;
      this.send(IpcChannel.SdkActivity, { id, activity: SessionActivity.Idle, subagentCount: 0 });
      session.pid = undefined;
      this.persistState();
      return true;
    }
    return false;
  }

  removeSession(id: string): void {
    this.killSession(id);
    this.sessions.delete(id);
    this.outputBuffers.delete(id);
    this.deleteScrollback(id);
    this.transcriptModelOffsets.delete(id);
    this.forkWatch.delete(id);
    if (this.focusedSessionId === id) this.focusedSessionId = null;
    this.persistState();
  }

  setModel(id: string, model: string): void {
    const session = this.sessions.get(id);
    if (!session) return;
    session.model = model;
    this.persistState();
    log.info(`Session ${id} model set to: ${model}`);
    void this.injectModelSelection(session, model).catch((e) =>
      log.warn(`model injection failed for ${id}: ${e}`)
    );
  }

  // Forward a dropdown model change into the live TTY by driving the `/model`
  // picker to a session-only switch — the persisted value (above) already
  // covers the next resume. We drive the picker rather than typing
  // `/model <name>` because the argument form, like the digit/Enter paths,
  // saves the choice as the GLOBAL default; only the picker's `s` key scopes
  // the switch to this session. Skipped while the CLI is producing output: a
  // command sent mid-response queues with unclear timing. On any failure the
  // transcript watcher still reconciles the dropdown with the real model.
  private async injectModelSelection(session: SessionInfo, model: string): Promise<void> {
    if (session.mode !== SessionMode.Terminal || session.provider !== AgentProvider.Claude) return;
    const pty = this.ptys.get(session.id);
    if (session.status !== SessionStatus.Active || !pty) return;
    if (session.activity === SessionActivity.Thinking || session.activity === SessionActivity.Streaming) {
      log.info(`Session ${session.id} busy; ${ModelPickerKey.Open} ${model} not injected (applies on next resume)`);
      return;
    }

    // Anchor parsing to output produced after this point so a picker the user
    // opened earlier in the session can't be mistaken for the current one.
    const baseline = (this.outputBuffers.get(session.id) ?? '').length;
    // KillLine clears any half-typed prompt so the command starts at column 0;
    // a draft would otherwise absorb the text and submit it as a message.
    this.writeToSession(session.id, `${TtyKeySequence.KillLine}${ModelPickerKey.Open}\r`);

    const rendered = await this.awaitPickerRender(session.id, baseline);
    if (!rendered) {
      log.warn(`Session ${session.id} model picker did not render; ${model} not switched live`);
      return;
    }
    const state = parseModelPicker(rendered);
    const nav = planPickerNavigation(state, model);
    if (!nav.reachable) {
      log.warn(`Session ${session.id} cannot select "${model}" in picker (${nav.reason}); closing picker`);
      pty.write(ModelPickerKey.Escape);
      return;
    }

    const key = nav.delta >= 0 ? ModelPickerKey.Down : ModelPickerKey.Up;
    for (let i = 0; i < Math.abs(nav.delta); i++) {
      pty.write(key);
      await this.delay(PICKER_ARROW_DELAY_MS);
    }
    await this.delay(PICKER_SETTLE_MS);
    pty.write(ModelPickerKey.SessionOnly);
    log.info(`Session ${session.id} model switched live to "${model}" (${Math.abs(nav.delta)} step${Math.abs(nav.delta) === 1 ? '' : 's'})`);
  }

  private delay(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  // Poll the session's output buffer until the picker has fully drawn, then
  // return the post-baseline slice for parsing. Reads from the same scrollback
  // the renderer streams from, so it sees exactly what the picker rendered.
  private async awaitPickerRender(id: string, baseline: number): Promise<string | null> {
    const start = Date.now();
    while (Date.now() - start < PICKER_OPEN_TIMEOUT_MS) {
      await this.delay(PICKER_POLL_MS);
      const buf = this.outputBuffers.get(id) ?? '';
      // If the bounded buffer rotated past the baseline, fall back to the whole
      // tail — picker output is tiny and won't have been evicted yet.
      const since = buf.length >= baseline ? buf.slice(baseline) : buf;
      if (isPickerReady(since)) return since;
    }
    return null;
  }

  writeToSession(id: string, data: string): void {
    this.ptys.get(id)?.write(data);
    const state = this.activityStates.get(id);
    if (state) clearWaiting(state);
  }

  resizeSession(id: string, cols: number, rows: number): void {
    this.ptys.get(id)?.resize(cols, rows);
  }

  getAll(): SessionInfo[] {
    return Array.from(this.sessions.values()).map((s) => ({
      ...s,
      lastActiveAt: this.sessionLastActiveAt(s),
    }));
  }

  // Async on purpose: a synchronous spawn here blocks the main process event
  // loop — the IPC broker for every keystroke — and with many sessions the
  // stalls compound into visible input lag and beachballs.
  async getChildProcesses(id: string): Promise<Array<{ pid: number; command: string }>> {
    const session = this.sessions.get(id);
    if (!session?.pid) return [];

    try {
      const { stdout } = await execAsync(`pgrep -P ${session.pid} -l`, {
        encoding: 'utf-8',
        timeout: PROCESS_POLL_TIMEOUT_MS,
      });
      return stdout
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
          provider: s.provider,
          providerSessionId: s.providerSessionId,
          mode: s.mode,
          title: s.title,
          summary: s.summary,
          model: s.model,
          unbounded: s.unbounded,
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
          const provider = normalizeAgentProvider(s.provider);
          this.sessions.set(s.id, {
            ...s,
            provider,
            providerSessionId: s.providerSessionId || s.claudeSessionId,
            status: SessionStatus.Stopped,
            mode: s.mode || SessionMode.Terminal,
            model: s.model || getDefaultModelForProvider(provider),
          });
          // Seed the buffer from disk so the focused session replays its prior
          // scrollback after a restart, even with no transcript to --resume.
          this.loadScrollback(s.id);
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
    log.info('Starting TTY title updater (event-driven, no background polling)');

    // Backfill titles once for sessions that were persisted without one
    for (const session of this.sessions.values()) {
      if (session.mode === SessionMode.Terminal && !session.title) {
        log.info(`Backfilling TTY title for ${session.id} (${session.projectName})`);
        this.updateTtyTitle(session).catch(() => {});
      }
    }
  }

  /** Schedule a one-shot title generation for a session after a short delay. */
  scheduleTitleGeneration(id: string): void {
    const session = this.sessions.get(id);
    if (!session || session.mode !== SessionMode.Terminal || session.title) return;
    setTimeout(() => {
      this.updateTtyTitle(session).catch(() => {});
    }, TITLE_GENERATION_DELAY);
  }

  private async updateTtyTitle(session: SessionInfo, refresh = false): Promise<void> {
    if (session.title && !refresh) return;
    try {
      const terminalProvider = getTerminalProvider(session.provider);
      const projectsDir = terminalProvider.getHistoryDir?.(session.projectPath);
      if (!projectsDir) return;

      const encodedCwd = session.projectPath.replace(/[^a-zA-Z0-9]/g, '-');
      const sessionDir = path.join(projectsDir, encodedCwd);
      log.debug(`TTY title: checking ${sessionDir}`);
      if (!fs.existsSync(sessionDir)) {
        log.debug(`TTY title: dir not found for ${session.projectName}`);
        return;
      }

      // Prefer the session's own transcript so multi-session projects don't
      // cross-title from a sibling's newer file; fall back to newest by mtime.
      const ownFile = session.providerSessionId
        ? path.join(sessionDir, `${session.providerSessionId}.jsonl`)
        : null;
      let sessionFile: string;
      if (ownFile && fs.existsSync(ownFile)) {
        sessionFile = ownFile;
      } else {
        const files = fs.readdirSync(sessionDir)
          .filter((f) => f.endsWith('.jsonl'))
          .map((f) => ({ name: f, mtime: fs.statSync(path.join(sessionDir, f)).mtimeMs }))
          .sort((a, b) => b.mtime - a.mtime);
        if (files.length === 0) {
          log.debug(`TTY title: no JSONL files for ${session.projectName}`);
          return;
        }
        sessionFile = path.join(sessionDir, files[0].name);
      }
      const lines = fs.readFileSync(sessionFile, 'utf-8').trim().split('\n');
      log.debug(`TTY title: reading ${path.basename(sessionFile)} (${lines.length} lines)`);

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

      const claudePath = getTerminalProvider(AgentProvider.Claude).resolveExecutable();
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
        this.lastTitleGenAt.set(session.id, Date.now());
        log.info(`TTY session ${session.id} title: "${session.title}"`);
        this.send(IpcChannel.SdkTitle, {
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

  // Poll child processes for the focused session only: the ProcessMonitor
  // panel is the sole consumer and it displays just the visible session, so
  // polling every active session was pure waste that scaled with session count.
  startProcessMonitor(): void {
    this.processTimer = setInterval(() => {
      const id = this.focusedSessionId;
      if (!id) return;
      const session = this.sessions.get(id);
      if (!session || session.status !== SessionStatus.Active || !session.pid) return;
      void this.getChildProcesses(id).then((procs) => {
        this.send(IpcChannel.SessionProcesses, { id, processes: procs });
      });
    }, PROCESS_POLL_MS);
  }

  stopProcessMonitor(): void {
    if (this.processTimer) {
      clearInterval(this.processTimer);
      this.processTimer = null;
    }
  }

  startActivityMonitor(): void {
    this.activityTimer = setInterval(() => {
      const now = Date.now();
      for (const [id, state] of this.activityStates) {
        const session = this.sessions.get(id);
        if (!session || session.status !== SessionStatus.Active) continue;
        this.applyActivity(session, snapshot(state, now));
        this.pollTranscriptModel(session);
        this.pollTranscriptFork(session, now);
      }
      this.maybeFlushScrollback(now);
    }, ACTIVITY_POLL_MS);
  }

  stopActivityMonitor(): void {
    if (this.activityTimer) {
      clearInterval(this.activityTimer);
      this.activityTimer = null;
    }
  }

  private providerSessionDir(provider: AgentProvider, projectPath: string): string | null {
    const historyDir = getTerminalProvider(provider).getHistoryDir?.(projectPath);
    if (!historyDir) return null;
    const encodedCwd = projectPath.replace(/[^a-zA-Z0-9]/g, '-');
    return path.join(historyDir, encodedCwd);
  }

  /** Path to the session's own transcript file, or null when not yet bound. */
  private transcriptPath(session: SessionInfo): string | null {
    if (!session.providerSessionId) return null;
    const dir = this.providerSessionDir(session.provider, session.projectPath);
    return dir ? path.join(dir, `${session.providerSessionId}.jsonl`) : null;
  }

  // True when a "resume" should instead start a fresh (re-pinned) session
  // because the bound transcript is gone. Only applies to Claude sessions that
  // are pinned to a provider session id: the path is deterministic, so a
  // missing file means there is genuinely nothing to resume. Codex (no pin) and
  // unbound sessions fall through to their normal resume path untouched.
  private shouldResumeFresh(session: SessionInfo): boolean {
    if (session.provider !== AgentProvider.Claude || !session.providerSessionId) return false;
    const own = this.transcriptPath(session);
    if (!own) return false;
    return !fs.existsSync(own);
  }

  // Mark the transcript's current content as consumed by the model watcher.
  // Called at spawn: --model on the command line makes the persisted model
  // authoritative at that point, so only lines appended afterwards matter.
  private seedTranscriptModelOffset(session: SessionInfo): void {
    let size = 0;
    const file = this.transcriptPath(session);
    if (file) {
      try {
        size = fs.statSync(file).size;
      } catch {
        // not created yet — everything claude writes will be new
      }
    }
    this.transcriptModelOffsets.set(session.id, size);
  }

  // Detect model changes made inside the TTY (e.g. via /model) by tailing the
  // session transcript: assistant lines carry `message.model`, and the /model
  // confirmation lands as command stdout. Reads only bytes appended since the
  // last poll — one stat per tick when nothing changed — and unlike scraping
  // PTY output it never re-sees old content on TUI repaints.
  private pollTranscriptModel(session: SessionInfo): void {
    if (session.mode !== SessionMode.Terminal || session.provider !== AgentProvider.Claude) return;
    const file = this.transcriptPath(session);
    if (!file) return;
    let size: number;
    try {
      size = fs.statSync(file).size;
    } catch {
      return;
    }
    const offset = this.transcriptModelOffsets.get(session.id) ?? size;
    if (size < offset) {
      // Rewritten shorter (e.g. by --resume) — treat current content as consumed.
      this.transcriptModelOffsets.set(session.id, size);
      return;
    }
    if (size === offset) return;
    let buf: Buffer;
    try {
      const fd = fs.openSync(file, 'r');
      try {
        buf = Buffer.alloc(size - offset);
        const read = fs.readSync(fd, buf, 0, buf.length, offset);
        buf = buf.subarray(0, read);
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return;
    }
    // Consume only complete lines; a trailing partial line is re-read next
    // poll. Splitting on the newline byte (never part of a multibyte UTF-8
    // sequence) keeps the byte offset exact.
    const lastNewline = buf.lastIndexOf('\n');
    if (lastNewline === -1) return;
    this.transcriptModelOffsets.set(session.id, offset + lastNewline + 1);
    const alias = latestModelAliasInLines(buf.toString('utf-8', 0, lastNewline).split('\n'));
    if (!alias || alias === session.model) return;
    session.model = alias;
    this.persistState();
    log.info(`Session ${session.id} model detected from transcript: ${alias}`);
    this.send(IpcChannel.SessionModel, { id: session.id, model: alias });
  }

  // Epoch ms of the last genuine activity recorded in a transcript. We read the
  // file's own content rather than its mtime because `--resume` rewrites every
  // transcript at launch (appending untimestamped `mode`/`permission-mode`
  // lines), which would collapse mtime-based recency into resume order. The
  // last line carrying a `timestamp` reflects real user/assistant activity.
  private lastTimestampInTranscript(filePath: string): number {
    try {
      const lines = fs.readFileSync(filePath, 'utf-8').split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i].trim();
        if (!line) continue;
        let parsed: { timestamp?: string | number };
        try {
          parsed = JSON.parse(line);
        } catch {
          continue;
        }
        const ts = parsed.timestamp;
        if (typeof ts === 'number' && Number.isFinite(ts)) return ts;
        if (typeof ts === 'string') {
          const ms = Date.parse(ts);
          if (!Number.isNaN(ms)) return ms;
        }
      }
    } catch {
      // unreadable transcript — treat as no activity
    }
    return 0;
  }

  // Epoch ms of the first genuine activity in a transcript. A `/clear` fork
  // begins exactly when its parent goes quiet, so this anchors the adjacency
  // test that tells a continuation apart from a parallel session's transcript.
  // Reads only the head of the file — the first timestamped line is all we need.
  private firstTimestampInTranscript(filePath: string): number {
    try {
      const lines = fs.readFileSync(filePath, 'utf-8').split('\n');
      for (const raw of lines) {
        const line = raw.trim();
        if (!line) continue;
        let parsed: { timestamp?: string | number };
        try {
          parsed = JSON.parse(line);
        } catch {
          continue;
        }
        const ts = parsed.timestamp;
        if (typeof ts === 'number' && Number.isFinite(ts)) return ts;
        if (typeof ts === 'string') {
          const ms = Date.parse(ts);
          if (!Number.isNaN(ms)) return ms;
        }
      }
    } catch {
      // unreadable transcript — no usable start time
    }
    return 0;
  }

  // Finds the transcript a `/clear`/compaction fork moved the conversation into,
  // or null when the session is still on its bound file. A candidate qualifies
  // only if it is (a) not the bound file, (b) not claimed by another session,
  // (c) more recently active than the bound file, and (d) *began* at/after the
  // bound file went quiet — (d) is what distinguishes a continuation from a
  // parallel chat in the same project that merely happens to be more recent.
  private findContinuationTranscript(session: SessionInfo): string | null {
    if (session.mode !== SessionMode.Terminal || session.provider !== AgentProvider.Claude) return null;
    if (!session.providerSessionId) return null;
    const dir = this.providerSessionDir(session.provider, session.projectPath);
    if (!dir || !fs.existsSync(dir)) return null;
    const ownFile = `${session.providerSessionId}.jsonl`;
    const ownPath = path.join(dir, ownFile);
    const ownLast = fs.existsSync(ownPath) ? this.lastTimestampInTranscript(ownPath) : 0;
    const claimed = new Set(
      Array.from(this.sessions.values())
        .filter((s) => s.id !== session.id && s.providerSessionId)
        .map((s) => `${s.providerSessionId}.jsonl`)
    );
    let bestId: string | null = null;
    let bestLast = ownLast;
    try {
      for (const f of fs.readdirSync(dir)) {
        // `agent-*.jsonl` are subagent sidechains, never a top-level session.
        if (!f.endsWith('.jsonl') || f === ownFile || f.startsWith('agent-') || claimed.has(f)) continue;
        const p = path.join(dir, f);
        const last = this.lastTimestampInTranscript(p);
        if (last <= bestLast) continue;
        const first = this.firstTimestampInTranscript(p);
        if (first < ownLast - FORK_ADJACENCY_TOLERANCE_MS) continue;
        bestId = f.replace(/\.jsonl$/, '');
        bestLast = last;
      }
    } catch {
      return null;
    }
    return bestId;
  }

  // Cheap per-tick guard over the bound transcript: while it keeps growing the
  // conversation is live on its own file and we do nothing. Once it has been
  // quiet for FORK_OWN_STABLE_MS we scan the project dir once for a continuation
  // and rebind to it, so the next --resume targets the real latest transcript.
  private pollTranscriptFork(session: SessionInfo, now: number): void {
    if (session.mode !== SessionMode.Terminal || session.provider !== AgentProvider.Claude) return;
    if (!session.providerSessionId) return;
    const own = this.transcriptPath(session);
    if (!own) return;
    let size: number;
    try {
      size = fs.statSync(own).size;
    } catch {
      return;
    }
    const state = this.forkWatch.get(session.id);
    if (!state || state.ownSize !== size) {
      this.forkWatch.set(session.id, { ownSize: size, stableSince: now, scanned: false });
      return;
    }
    if (state.scanned || now - state.stableSince < FORK_OWN_STABLE_MS) return;
    state.scanned = true;
    const picked = this.findContinuationTranscript(session);
    if (!picked || picked === session.providerSessionId) return;
    log.info(`Session ${session.id} followed transcript fork: ${session.providerSessionId} → ${picked}`);
    session.providerSessionId = picked;
    this.seedTranscriptModelOffset(session);
    this.forkWatch.delete(session.id);
    this.persistState();
    this.scheduleTitleGeneration(session.id);
  }

  // Most recent activity time (epoch ms) for a session, used as the sidebar's
  // recency fallback. Prefers the session's own transcript when providerSessionId
  // is known, else the most-active transcript in the project dir. Returns 0 when
  // nothing is found — the same neutral value as "never opened".
  private sessionLastActiveAt(session: SessionInfo): number {
    const dir = this.providerSessionDir(session.provider, session.projectPath);
    if (!dir || !fs.existsSync(dir)) return 0;
    try {
      if (session.providerSessionId) {
        const own = path.join(dir, `${session.providerSessionId}.jsonl`);
        if (fs.existsSync(own)) return this.lastTimestampInTranscript(own);
      }
      let newest = 0;
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith('.jsonl')) continue;
        const ts = this.lastTimestampInTranscript(path.join(dir, f));
        if (ts > newest) newest = ts;
      }
      return newest;
    } catch {
      return 0;
    }
  }

  private snapshotProviderHistory(provider: AgentProvider, projectPath: string): Set<string> {
    const dir = this.providerSessionDir(provider, projectPath);
    if (!dir || !fs.existsSync(dir)) return new Set();
    return new Set(fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')));
  }

  // Watches the project dir for the transcript this session's process creates.
  // `expectedId` (set when we launched with --session-id) flips this from
  // "detect" to "confirm-or-correct": if the new file matches, we're done; if
  // claude used a different id despite --session-id, we rebind to the real one.
  private async detectProviderSessionId(
    sessionId: string,
    baseline: Set<string>,
    expectedId?: string
  ): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    // Without an expectation, an already-bound session is left alone.
    if (!expectedId && session.providerSessionId) return;
    const sessionDir = this.providerSessionDir(session.provider, session.projectPath);
    if (!sessionDir) return;
    const claimed = new Set(
      Array.from(this.sessions.values())
        .filter((s) => s.id !== sessionId && s.providerSessionId)
        .map((s) => `${s.providerSessionId}.jsonl`)
    );
    const start = Date.now();
    while (Date.now() - start < PROVIDER_SESSION_ID_DETECT_MS) {
      await new Promise((r) => setTimeout(r, PROVIDER_SESSION_ID_POLL_MS));
      if (!fs.existsSync(sessionDir)) continue;
      const current = fs.readdirSync(sessionDir).filter((f) => f.endsWith('.jsonl'));
      // The pinned transcript appearing means --session-id was honored — done.
      if (expectedId && current.includes(`${expectedId}.jsonl`)) return;
      const candidates = current.filter((f) => !baseline.has(f) && !claimed.has(f));
      if (candidates.length === 0) continue;
      const sorted = candidates
        .map((f) => ({ f, mtime: fs.statSync(path.join(sessionDir, f)).mtimeMs }))
        .sort((a, b) => a.mtime - b.mtime);
      const picked = sorted[0].f.replace(/\.jsonl$/, '');
      if (picked === session.providerSessionId) return;
      session.providerSessionId = picked;
      this.persistState();
      log.info(`Session ${sessionId} bound to providerSessionId ${picked}${expectedId ? ` (corrected from ${expectedId})` : ''}`);
      return;
    }
    log.warn(`Failed to detect providerSessionId for session ${sessionId} within ${PROVIDER_SESSION_ID_DETECT_MS}ms`);
  }

  migrateProviderSessionIds(): void {
    const byProject = new Map<string, SessionInfo[]>();
    for (const s of this.sessions.values()) {
      if (s.mode !== SessionMode.Terminal || s.providerSessionId) continue;
      const key = `${s.provider}::${s.projectPath}`;
      const list = byProject.get(key) || [];
      list.push(s);
      byProject.set(key, list);
    }
    for (const sessions of byProject.values()) {
      const first = sessions[0];
      const sessionDir = this.providerSessionDir(first.provider, first.projectPath);
      if (!sessionDir || !fs.existsSync(sessionDir)) continue;
      const claimed = new Set(
        Array.from(this.sessions.values())
          .filter((s) => s.providerSessionId)
          .map((s) => `${s.providerSessionId}.jsonl`)
      );
      const available = fs.readdirSync(sessionDir)
        .filter((f) => f.endsWith('.jsonl') && !claimed.has(f))
        .map((f) => ({ f, mtime: fs.statSync(path.join(sessionDir, f)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime);
      sessions.sort((a, b) => a.id.localeCompare(b.id));
      for (let i = 0; i < sessions.length && i < available.length; i++) {
        const id = available[i].f.replace(/\.jsonl$/, '');
        sessions[i].providerSessionId = id;
        log.info(`Migrated session ${sessions[i].id} → providerSessionId ${id}`);
      }
    }
    this.persistState();
  }

  // Only `ingest` runs per chunk (cheap: strips ANSI from the chunk and
  // latches pattern flags). Evaluating `snapshot` here too meant regex passes
  // over the 16KB tail buffer for every chunk of every session — heavy on the
  // main thread during busy streaming. The ACTIVITY_POLL_MS timer already
  // snapshots all sessions, so UI transitions lag at most one poll tick.
  private ingestPtyData(id: string, data: string): void {
    const state = this.activityStates.get(id);
    if (!state) return;
    ingest(state, data, Date.now());
  }

  private applyActivity(session: SessionInfo, snap: TtyActivitySnapshot): void {
    const changed =
      session.activity !== snap.activity ||
      session.activityDetail !== snap.detail ||
      session.subagentCount !== snap.subagentCount;
    if (!changed) return;
    // A produce→idle transition marks the end of a response cycle — a good,
    // low-frequency moment to re-title so the label tracks the current topic.
    const wasProducing =
      session.activity === SessionActivity.Thinking || session.activity === SessionActivity.Streaming;
    session.activity = snap.activity;
    session.activityDetail = snap.detail;
    session.subagentCount = snap.subagentCount;
    // Refresh "last active" on each state transition (cheap — fires once per
    // response cycle, not per chunk). Seeded from the transcript at launch.
    session.lastActiveAt = snap.lastDataAt;
    this.send(IpcChannel.SdkActivity, {
      id: session.id,
      activity: snap.activity,
      detail: snap.detail,
      subagentCount: snap.subagentCount,
      lastActiveAt: snap.lastDataAt,
    });
    if (wasProducing && snap.activity === SessionActivity.Idle) {
      this.maybeRefreshTitleOnIdle(session);
    }
  }

  // Re-title on idle, throttled so repeated short responses don't spam haiku.
  private maybeRefreshTitleOnIdle(session: SessionInfo): void {
    if (session.mode !== SessionMode.Terminal) return;
    const now = Date.now();
    const last = this.lastTitleGenAt.get(session.id) ?? 0;
    if (now - last < TITLE_REFRESH_MIN_INTERVAL_MS) return;
    this.lastTitleGenAt.set(session.id, now);
    this.updateTtyTitle(session, true).catch(() => {});
  }

  destroy(): void {
    this.stopProcessMonitor();
    this.stopActivityMonitor();
    for (const [id] of this.ptys) {
      this.killSession(id);
    }
    this.flushScrollback();
    this.persistState();
  }
}
