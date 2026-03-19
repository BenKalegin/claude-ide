import { BrowserWindow } from 'electron';
import * as crypto from 'crypto';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { createLogger } from './logger';

const log = createLogger('sdk');

export interface SdkMessage {
  type: 'assistant' | 'user' | 'system' | 'result' | 'tool_use' | 'tool_result';
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
  status: 'active' | 'stopped' | 'error' | 'thinking';
  mode: 'sdk';
  messages: SdkMessage[];
  totalCost: number;
}

interface PersistedSdkState {
  sessions: Array<{
    id: string;
    projectPath: string;
    projectName: string;
    claudeSessionId?: string;
    totalCost: number;
  }>;
}

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
      status: 'stopped',
      mode: 'sdk',
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

    session.status = 'thinking';
    this.emitStatus(id, 'thinking');

    const userMsg: SdkMessage = {
      type: 'user',
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

          if (sdkMsg.type === 'system' && sdkMsg.sessionId) {
            session.claudeSessionId = sdkMsg.sessionId;
          }

          if (sdkMsg.cost) {
            session.totalCost += sdkMsg.cost.totalUsd;
            this.emitCost(id, session.totalCost);
          }
        }
      }

      log.info(`SDK query complete: session=${id}`);
      session.status = 'active';
      this.emitStatus(id, 'active');
    } catch (err: unknown) {
      if ((err as Error).name === 'AbortError') {
        log.info(`SDK query cancelled: session=${id}`);
        session.status = 'stopped';
        this.emitStatus(id, 'stopped');
      } else {
        log.error(`SDK query error: session=${id}`, err);
        session.status = 'error';
        const errorMsg: SdkMessage = {
          type: 'system',
          content: `Error: ${(err as Error).message}`,
          timestamp: Date.now(),
        };
        session.messages.push(errorMsg);
        this.emitMessage(id, errorMsg);
        this.emitStatus(id, 'error');
      }
    } finally {
      this.activeQueries.delete(id);
      this.persistState();
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
      case 'system': {
        const sessionId = message.session_id as string | undefined;
        return {
          type: 'system',
          content: sessionId ? `Session initialized: ${sessionId}` : 'System message',
          timestamp: Date.now(),
          sessionId,
        };
      }
      case 'assistant': {
        const content = this.extractContent(message.message || message.content || message);
        if (!content) return null;
        return { type: 'assistant', content, timestamp: Date.now() };
      }
      case 'tool_use': {
        return {
          type: 'tool_use',
          content: `Using tool: ${message.name}`,
          timestamp: Date.now(),
          toolName: message.name as string,
          toolInput: message.input as Record<string, unknown>,
        };
      }
      case 'tool_result': {
        const content = this.extractContent(message.content || message.output || message);
        return {
          type: 'tool_result',
          content: content || 'Tool completed',
          timestamp: Date.now(),
          toolName: message.tool_name as string | undefined,
        };
      }
      case 'result': {
        const cost = message.cost as { input_tokens?: number; output_tokens?: number; total_usd?: number } | undefined;
        return {
          type: 'result',
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
      session.status = 'stopped';
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
    this.window?.webContents.send('sdk-message', { id, message });
  }

  private emitStatus(id: string, status: string): void {
    this.window?.webContents.send('session-status', { id, status });
  }

  private emitCost(id: string, totalCost: number): void {
    this.window?.webContents.send('sdk-cost', { id, totalCost });
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
            status: 'stopped',
            mode: 'sdk',
            messages: [],
          });
        }
      }
      return this.getAll();
    } catch {
      return [];
    }
  }

  destroy(): void {
    for (const [id] of this.activeQueries) {
      this.cancelQuery(id);
    }
    this.persistState();
  }
}
