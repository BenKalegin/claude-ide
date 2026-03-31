import { BrowserWindow } from 'electron';
import * as crypto from 'crypto';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { createLogger } from './logger';
import { SessionMode, SessionStatus, SdkMessageType, IpcChannel } from '../core/constants';

const log = createLogger('sdk');

export interface SdkMessage {
  type: SdkMessageType;
  content: string;
  timestamp: number;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  cost?: { inputTokens: number; outputTokens: number; totalUsd: number };
  sessionId?: string;
}

export interface SdkSessionInfo {
  id: string;
  projectPath: string;
  projectName: string;
  claudeSessionId?: string;
  status: SessionStatus;
  mode: typeof SessionMode.Sdk;
  messages: SdkMessage[];
  totalCost: number;
  summary?: string;
  title?: string;
}

interface PersistedSdkState {
  sessions: Array<{
    id: string;
    projectPath: string;
    projectName: string;
    claudeSessionId?: string;
    totalCost: number;
    summary?: string;
    title?: string;
  }>;
}

const SUMMARIZE_MODEL = 'haiku';
const TITLE_MAX_CHARS = 40;
const SUMMARY_MAX_CHARS = 200;
const ANSWER_PREVIEW_CHARS = 300;

const STATE_DIR = path.join(os.homedir(), '.claude-ide');
const SDK_STATE_FILE = path.join(STATE_DIR, 'sdk-sessions.json');
const MESSAGES_DIR = path.join(STATE_DIR, 'messages');

export class SdkSessionManager {
  private sessions: Map<string, SdkSessionInfo> = new Map();
  private activeQueries: Map<string, AbortController> = new Map();
  private window: BrowserWindow | null = null;

  setWindow(win: BrowserWindow): void {
    this.window = win;
  }

  async createSession(projectPath: string): Promise<SdkSessionInfo> {
    const id = crypto.randomUUID();
    const projectName = path.basename(projectPath);

    const session: SdkSessionInfo = {
      id,
      projectPath,
      projectName,
      status: SessionStatus.Stopped,
      mode: SessionMode.Sdk,
      messages: [],
      totalCost: 0,
    };

    this.sessions.set(id, session);
    this.persistState();
    return session;
  }

  async sendMessage(id: string, prompt: string): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) return;

    log.info(`SDK query: session=${id}, prompt="${prompt.substring(0, 80)}"`);

    session.status = SessionStatus.Thinking;
    this.emitStatus(id, SessionStatus.Thinking);

    const userMsg: SdkMessage = {
      type: SdkMessageType.User,
      content: prompt,
      timestamp: Date.now(),
    };
    session.messages.push(userMsg);
    this.emitMessage(id, userMsg);

    const controller = new AbortController();
    this.activeQueries.set(id, controller);

    try {
      const { query } = await import('@anthropic-ai/claude-agent-sdk');

      const options: Record<string, unknown> = {
        cwd: session.projectPath,
        allowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep', 'Agent'],
        permissionMode: 'acceptEdits',
      };

      if (session.claudeSessionId) {
        (options as Record<string, unknown>).resume = session.claudeSessionId;
      }

      for await (const message of query({
        prompt,
        options: options as Parameters<typeof query>[0]['options'],
        signal: controller.signal,
      })) {
        if (controller.signal.aborted) break;

        const sdkMsg = this.transformMessage(message);
        if (sdkMsg) {
          session.messages.push(sdkMsg);
          this.emitMessage(id, sdkMsg);

          if (sdkMsg.type === SdkMessageType.System && sdkMsg.sessionId) {
            session.claudeSessionId = sdkMsg.sessionId;
          }

          if (sdkMsg.cost) {
            session.totalCost += sdkMsg.cost.totalUsd;
            this.emitCost(id, session.totalCost);
          }
        }
      }

      log.info(`SDK query complete: session=${id}`);

      // Check if any background processes were spawned and warn
      const bgWarning = this.detectBackgroundProcesses(session);
      if (bgWarning) {
        const warnMsg: SdkMessage = {
          type: SdkMessageType.System,
          content: bgWarning,
          timestamp: Date.now(),
        };
        session.messages.push(warnMsg);
        this.emitMessage(id, warnMsg);
      }

      session.status = SessionStatus.Active;
      this.emitStatus(id, SessionStatus.Active);

      // Update title in background (non-blocking)
      this.updateSessionSummary(session).catch(() => {});
    } catch (err: unknown) {
      if ((err as Error).name === 'AbortError') {
        log.info(`SDK query cancelled: session=${id}`);
        session.status = SessionStatus.Stopped;
        this.emitStatus(id, SessionStatus.Stopped);
      } else {
        log.error(`SDK query error: session=${id}`, err);
        session.status = SessionStatus.Error;
        const errorMsg: SdkMessage = {
          type: SdkMessageType.System,
          content: `Error: ${(err as Error).message}`,
          timestamp: Date.now(),
        };
        session.messages.push(errorMsg);
        this.emitMessage(id, errorMsg);
        this.emitStatus(id, SessionStatus.Error);
      }
    } finally {
      this.activeQueries.delete(id);
      this.persistState();
    }
  }

  private async updateSessionSummary(session: SdkSessionInfo): Promise<void> {
    try {
      const lastUser = [...session.messages]
        .reverse()
        .find((m) => m.type === SdkMessageType.User);
      const lastAssistant = [...session.messages]
        .reverse()
        .find((m) => m.type === SdkMessageType.Assistant || m.type === SdkMessageType.Result);

      if (!lastUser) return;

      const answerPreview = lastAssistant
        ? lastAssistant.content.slice(0, ANSWER_PREVIEW_CHARS)
        : '';

      const existingSummary = session.summary || '';

      const prompt = existingSummary
        ? `Current session summary: "${existingSummary}"\nNew exchange — User: "${lastUser.content}" Assistant: "${answerPreview}"\nUpdate the summary (1-2 sentences, max ${SUMMARY_MAX_CHARS} chars) blending the new exchange with existing context. Earlier details can fade.\nAlso provide a short title (3-6 words, max ${TITLE_MAX_CHARS} chars).\nReply ONLY as JSON: {"summary": "...", "title": "..."}`
        : `First exchange — User: "${lastUser.content}" Assistant: "${answerPreview}"\nSummarize this exchange in 1-2 sentences (max ${SUMMARY_MAX_CHARS} chars).\nAlso provide a short title (3-6 words, max ${TITLE_MAX_CHARS} chars).\nReply ONLY as JSON: {"summary": "...", "title": "..."}`;

      const claudePath = this.resolveClaudePath();
      const { execFile } = await import('child_process');
      const { promisify } = await import('util');
      const execFileAsync = promisify(execFile);

      const { stdout } = await execFileAsync(claudePath, [
        '-p', prompt,
        '--model', SUMMARIZE_MODEL,
        '--output-format', 'text',
      ], { timeout: 30000 });

      const text = stdout.trim();
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return;

      const parsed = JSON.parse(jsonMatch[0]) as { summary?: string; title?: string };
      if (parsed.summary) {
        session.summary = parsed.summary.slice(0, SUMMARY_MAX_CHARS);
      }
      if (parsed.title) {
        session.title = parsed.title.slice(0, TITLE_MAX_CHARS);
      }

      log.info(`Session ${session.id} title: "${session.title}"`);
      this.emitTitle(session.id, session.title || '', session.summary || '');
      this.persistState();
    } catch (err) {
      log.error(`Failed to summarize session ${session.id}:`, err);
    }
  }

  private resolveClaudePath(): string {
    try {
      const { execSync: execSyncLocal } = require('child_process');
      return execSyncLocal('which claude', { encoding: 'utf-8', shell: '/bin/zsh' }).trim();
    } catch {
      return 'claude';
    }
  }

  cancelQuery(id: string): void {
    const controller = this.activeQueries.get(id);
    if (controller) {
      controller.abort();
      this.activeQueries.delete(id);
    }
  }

  private transformMessage(message: Record<string, unknown>): SdkMessage | null {
    const type = message.type as string;

    switch (type) {
      case SdkMessageType.System: {
        const sessionId = message.session_id as string | undefined;
        return {
          type: SdkMessageType.System,
          content: sessionId ? `Session initialized: ${sessionId}` : 'System message',
          timestamp: Date.now(),
          sessionId,
        };
      }
      case SdkMessageType.Assistant: {
        const content = this.extractContent(message.message || message.content || message);
        if (!content) return null;
        return { type: SdkMessageType.Assistant, content, timestamp: Date.now() };
      }
      case SdkMessageType.ToolUse: {
        return {
          type: SdkMessageType.ToolUse,
          content: `Using tool: ${message.name}`,
          timestamp: Date.now(),
          toolName: message.name as string,
          toolInput: message.input as Record<string, unknown>,
        };
      }
      case SdkMessageType.ToolResult: {
        const content = this.extractContent(message.content || message.output || message);
        return {
          type: SdkMessageType.ToolResult,
          content: content || 'Tool completed',
          timestamp: Date.now(),
          toolName: message.tool_name as string | undefined,
        };
      }
      case SdkMessageType.Result: {
        const cost = message.cost as { input_tokens?: number; output_tokens?: number; total_usd?: number } | undefined;
        return {
          type: SdkMessageType.Result,
          content: (message.result as string) || 'Completed',
          timestamp: Date.now(),
          cost: cost ? {
            inputTokens: cost.input_tokens || 0,
            outputTokens: cost.output_tokens || 0,
            totalUsd: cost.total_usd || 0,
          } : undefined,
        };
      }
      default:
        return null;
    }
  }

  private extractContent(value: unknown): string {
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) {
      return value
        .map((block) => {
          if (typeof block === 'string') return block;
          if (block && typeof block === 'object' && 'text' in block) return (block as { text: string }).text;
          return '';
        })
        .filter(Boolean)
        .join('\n');
    }
    if (value && typeof value === 'object' && 'text' in value) {
      return (value as { text: string }).text;
    }
    return '';
  }

  private detectBackgroundProcesses(session: SdkSessionInfo): string | null {
    const lastMessages = session.messages.slice(-10);
    const bashMessages = lastMessages.filter(
      (m) => m.type === SdkMessageType.ToolUse && m.toolName === 'Bash'
    );
    if (bashMessages.length === 0) return null;

    const longRunningPatterns = [
      'npm run dev', 'npm start', 'yarn dev', 'pnpm dev',
      'npx ', 'node ', 'python ', 'cargo run',
      '--watch', 'serve', 'nodemon',
    ];

    for (const msg of bashMessages) {
      const input = JSON.stringify(msg.toolInput || '').toLowerCase();
      if (longRunningPatterns.some((p) => input.includes(p.toLowerCase()))) {
        return 'Note: Background processes started during this query may have been terminated. Use Terminal (TTY) mode for long-running processes like dev servers.';
      }
    }
    return null;
  }

  getMessages(id: string): SdkMessage[] {
    const session = this.sessions.get(id);
    if (!session) return [];
    if (session.messages.length === 0) {
      session.messages = this.loadMessages(id);
    }
    return session.messages;
  }

  getSession(id: string): SdkSessionInfo | undefined {
    return this.sessions.get(id);
  }

  getAll(): SdkSessionInfo[] {
    return Array.from(this.sessions.values());
  }

  killSession(id: string): boolean {
    this.cancelQuery(id);
    const session = this.sessions.get(id);
    if (session) {
      session.status = SessionStatus.Stopped;
      this.persistState();
      return true;
    }
    return false;
  }

  removeSession(id: string): void {
    this.cancelQuery(id);
    this.sessions.delete(id);
    this.deleteMessages(id);
    this.persistState();
  }

  private appendMessage(id: string, message: SdkMessage): void {
    try {
      if (!fs.existsSync(MESSAGES_DIR)) {
        fs.mkdirSync(MESSAGES_DIR, { recursive: true });
      }
      const file = path.join(MESSAGES_DIR, `${id}.jsonl`);
      fs.appendFileSync(file, JSON.stringify(message) + '\n');
    } catch {
      // silently fail
    }
  }

  private loadMessages(id: string): SdkMessage[] {
    try {
      const file = path.join(MESSAGES_DIR, `${id}.jsonl`);
      if (!fs.existsSync(file)) return [];
      const raw = fs.readFileSync(file, 'utf-8');
      return raw.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
    } catch {
      return [];
    }
  }

  private deleteMessages(id: string): void {
    try {
      const file = path.join(MESSAGES_DIR, `${id}.jsonl`);
      if (fs.existsSync(file)) fs.unlinkSync(file);
    } catch {
      // silently fail
    }
  }

  private emitMessage(id: string, message: SdkMessage): void {
    this.appendMessage(id, message);
    this.window?.webContents.send(IpcChannel.SdkMessage, { id, message });
  }

  private emitStatus(id: string, status: string): void {
    this.window?.webContents.send(IpcChannel.SessionStatus, { id, status });
  }

  private emitCost(id: string, totalCost: number): void {
    this.window?.webContents.send(IpcChannel.SdkCost, { id, totalCost });
  }

  private emitTitle(id: string, title: string, summary: string): void {
    this.window?.webContents.send(IpcChannel.SdkTitle, { id, title, summary });
  }

  persistState(): void {
    try {
      if (!fs.existsSync(STATE_DIR)) {
        fs.mkdirSync(STATE_DIR, { recursive: true });
      }
      const state: PersistedSdkState = {
        sessions: Array.from(this.sessions.values()).map((s) => ({
          id: s.id,
          projectPath: s.projectPath,
          projectName: s.projectName,
          claudeSessionId: s.claudeSessionId,
          totalCost: s.totalCost,
          summary: s.summary,
          title: s.title,
        })),
      };
      fs.writeFileSync(SDK_STATE_FILE, JSON.stringify(state, null, 2));
    } catch {
      // silently fail
    }
  }

  restoreState(): SdkSessionInfo[] {
    try {
      if (!fs.existsSync(SDK_STATE_FILE)) return [];
      const raw = fs.readFileSync(SDK_STATE_FILE, 'utf-8');
      const state: PersistedSdkState = JSON.parse(raw);
      for (const s of state.sessions) {
        if (!this.sessions.has(s.id)) {
          this.sessions.set(s.id, {
            ...s,
            status: SessionStatus.Stopped,
            mode: SessionMode.Sdk,
            messages: [],
            summary: s.summary,
            title: s.title,
          });
        }
      }
      // Backfill titles for sessions that have messages but no title
      this.backfillTitles();
      return this.getAll();
    } catch {
      return [];
    }
  }

  private backfillTitles(): void {
    for (const session of this.sessions.values()) {
      if (session.title) continue;
      // Load messages from disk to check if there's content
      const msgs = this.loadMessages(session.id);
      if (msgs.length > 0) {
        session.messages = msgs;
        log.info(`Backfilling title for session ${session.id}`);
        this.updateSessionSummary(session).catch(() => {});
      }
    }
  }

  destroy(): void {
    for (const [id] of this.activeQueries) {
      this.cancelQuery(id);
    }
    this.persistState();
  }
}
