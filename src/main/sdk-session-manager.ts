import { BrowserWindow } from 'electron';
import * as crypto from 'crypto';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { createLogger } from './logger';
import {
  AgentProvider,
  ASK_USER_QUESTION_TOOL,
  BASH_TOOL,
  DEFAULT_AGENT_PROVIDER,
  IpcChannel,
  PermissionDecision,
  PermissionRequestKind,
  SessionActivity,
  SessionMode,
  SessionStatus,
  SdkMessageType,
  TODO_WRITE_TOOL,
} from '../core/constants';
import { evaluatePermission, PermissionEffect } from '../core/permission-rules';
import type {
  SdkImage,
  SdkPermissionRequestPayload,
  SdkPermissionResponsePayload,
  SdkQuestion,
  SdkTodo,
} from '../core/constants';

// Shared empty allowlist for sessions that haven't approved any tool yet —
// avoids allocating a throwaway Set on every permission check.
const NO_SESSION_TOOLS: ReadonlySet<string> = new Set<string>();

// The two shapes the Agent SDK's canUseTool callback may return.
type PermissionResult =
  | { behavior: 'allow'; updatedInput?: Record<string, unknown> }
  | { behavior: 'deny'; message: string };

// A tool request awaiting the user's decision in the renderer popup.
interface PendingPermission {
  sessionId: string;
  toolName: string;
  kind: PermissionRequestKind;
  input: Record<string, unknown>;
  resolve: (result: PermissionResult) => void;
}

const TOOL_SUMMARY_MAX_CHARS = 300;
const STREAM_DETAIL_MAX_CHARS = 60;

// Live, per-block streaming state used to surface what a tool is actually
// doing (the command / file / pattern) as its input streams in.
interface StreamState {
  toolName: string;
  json: string;
  detail?: string;
}
import { getDefaultModelForProvider } from './agent-terminal-provider';

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
  provider: AgentProvider;
  providerSessionId?: string;
  status: SessionStatus;
  mode: typeof SessionMode.Sdk;
  messages: SdkMessage[];
  totalCost: number;
  summary?: string;
  title?: string;
  activity?: SessionActivity;
  activityDetail?: string;
  contextTokens?: number;
  maxContextTokens?: number;
  model: string;
  todos?: SdkTodo[];
}

interface PersistedSdkState {
  sessions: Array<{
    id: string;
    projectPath: string;
    projectName: string;
    provider?: AgentProvider;
    providerSessionId?: string;
    claudeSessionId?: string;
    totalCost: number;
    summary?: string;
    title?: string;
    model?: string;
  }>;
}

const SUMMARIZE_MODEL = 'haiku';
const TITLE_MAX_CHARS = 40;
const SUMMARY_MAX_CHARS = 200;
const ANSWER_PREVIEW_CHARS = 300;
const USAGE_WINDOW_MS = 2 * 60 * 60 * 1000; // 2 hours

const STATE_DIR = path.join(os.homedir(), '.claude-ide');
const SDK_STATE_FILE = path.join(STATE_DIR, 'sdk-sessions.json');
const MESSAGES_DIR = path.join(STATE_DIR, 'messages');
const USAGE_FILE = path.join(STATE_DIR, 'usage-history.json');

export interface UsageEntry {
  timestamp: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  sessionId: string;
}

function normalizeAgentProvider(provider?: AgentProvider): AgentProvider {
  return provider === AgentProvider.Codex ? AgentProvider.Codex : AgentProvider.Claude;
}

// Build a one-shot async iterable of SDKUserMessage with mixed text + image
// content blocks. The SDK closes stdin once this generator returns.
function buildMultimodalPrompt(text: string, images: SdkImage[]): AsyncIterable<unknown> {
  return {
    async *[Symbol.asyncIterator]() {
      const content: Array<Record<string, unknown>> = images.map((img) => ({
        type: 'image',
        source: { type: 'base64', media_type: img.mediaType, data: img.base64 },
      }));
      if (text) content.push({ type: 'text', text });
      yield {
        type: 'user',
        session_id: '',
        parent_tool_use_id: null,
        message: { role: 'user', content },
      };
    },
  };
}

interface ActiveQuery {
  controller: AbortController;
  query?: { interrupt(): Promise<void> };
  interrupted: boolean;
}

export class SdkSessionManager {
  private sessions: Map<string, SdkSessionInfo> = new Map();
  private activeQueries: Map<string, ActiveQuery> = new Map();
  private window: BrowserWindow | null = null;
  private usageHistory: UsageEntry[] = [];
  // Tool requests awaiting a user decision, keyed by requestId (the SDK's
  // toolUseID). The SDK stream is paused on each entry's resolve().
  private pendingPermissions: Map<string, PendingPermission> = new Map();
  // Tools the user chose "Allow for session" on, per session id.
  private sessionAllowedTools: Map<string, Set<string>> = new Map();
  // In-flight tool block per session, for live "what is it doing" detail.
  private streamState: Map<string, StreamState> = new Map();
  // Live output-token tally for the current turn, per session. `base` is the
  // total from completed assistant messages this turn; `current` is the
  // in-progress message's cumulative output tokens. Displayed sum grows
  // monotonically across a multi-step turn as a progress indicator.
  private liveTokens: Map<string, { base: number; current: number }> = new Map();

  constructor() {
    this.loadUsageHistory();
  }

  setWindow(win: BrowserWindow): void {
    this.window = win;
  }

  /** Send IPC to renderer, silently skipping if the window/frame is destroyed. */
  private send(channel: string, ...args: unknown[]): void {
    if (!this.window || this.window.isDestroyed() || this.window.webContents.isDestroyed()) return;
    this.window.webContents.send(channel, ...args);
  }

  async createSession(
    projectPath: string,
    provider: AgentProvider = DEFAULT_AGENT_PROVIDER
  ): Promise<SdkSessionInfo> {
    const id = crypto.randomUUID();
    const projectName = path.basename(projectPath);

    const session: SdkSessionInfo = {
      id,
      projectPath,
      projectName,
      provider,
      status: SessionStatus.Stopped,
      mode: SessionMode.Sdk,
      messages: [],
      totalCost: 0,
      model: getDefaultModelForProvider(provider),
    };

    this.sessions.set(id, session);
    this.persistState();
    return session;
  }

  async sendMessage(id: string, prompt: string, images?: SdkImage[]): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) return;

    const imageCount = images?.length ?? 0;
    log.info(`SDK query: session=${id}, prompt="${prompt.substring(0, 80)}", images=${imageCount}`);

    if (session.provider !== AgentProvider.Claude) {
      const errorMsg: SdkMessage = {
        type: SdkMessageType.System,
        content: 'Codex SDK sessions are not wired yet. Use Codex Terminal mode for now.',
        timestamp: Date.now(),
      };
      session.messages.push(errorMsg);
      this.emitMessage(id, errorMsg);
      return;
    }

    session.status = SessionStatus.Thinking;
    this.emitStatus(id, SessionStatus.Thinking);
    this.liveTokens.set(id, { base: 0, current: 0 });

    const userBubbleText = imageCount > 0
      ? (prompt ? `${prompt}\n[${imageCount} image${imageCount === 1 ? '' : 's'} attached]` : `[${imageCount} image${imageCount === 1 ? '' : 's'} attached]`)
      : prompt;
    const userMsg: SdkMessage = {
      type: SdkMessageType.User,
      content: userBubbleText,
      timestamp: Date.now(),
    };
    session.messages.push(userMsg);
    this.emitMessage(id, userMsg);

    const active: ActiveQuery = { controller: new AbortController(), interrupted: false };
    this.activeQueries.set(id, active);

    try {
      const { query } = await import('@anthropic-ai/claude-agent-sdk');

      const options: Record<string, unknown> = {
        cwd: session.projectPath,
        // `default` mode routes every non-pre-approved tool to canUseTool, so
        // we (not the SDK) decide what to auto-allow vs. prompt for. No
        // allowedTools allow-list: an allow rule would short-circuit canUseTool
        // and we'd never get to prompt. AskUserQuestion also arrives here.
        permissionMode: 'default',
        canUseTool: (toolName: string, input: Record<string, unknown>, o: { signal?: AbortSignal; toolUseID?: string }) =>
          this.requestPermission(id, toolName, input, o),
        includePartialMessages: true,
        model: session.model,
        abortController: active.controller,
      };

      if (session.providerSessionId) {
        (options as Record<string, unknown>).resume = session.providerSessionId;
      }

      const queryPrompt = imageCount > 0
        ? buildMultimodalPrompt(prompt, images!)
        : prompt;

      const q = query({
        prompt: queryPrompt as Parameters<typeof query>[0]['prompt'],
        options: options as Parameters<typeof query>[0]['options'],
      });
      active.query = q;

      for await (const message of q) {
        if (active.controller.signal.aborted) break;

        // Handle streaming events for activity tracking
        const msg = message as Record<string, unknown>;
        if (msg.type === 'stream_event') {
          this.handleStreamEvent(id, session, msg.event as Record<string, unknown>);
          continue;
        }

        const sdkMsg = this.transformMessage(message);
        if (sdkMsg) {
          session.messages.push(sdkMsg);
          this.emitMessage(id, sdkMsg);

          if (sdkMsg.type === SdkMessageType.System && sdkMsg.sessionId) {
            session.providerSessionId = sdkMsg.sessionId;
          }

          if (sdkMsg.cost) {
            session.totalCost += sdkMsg.cost.totalUsd;
            this.emitCost(id, session.totalCost);
            this.recordUsage({
              timestamp: Date.now(),
              inputTokens: sdkMsg.cost.inputTokens,
              outputTokens: sdkMsg.cost.outputTokens,
              costUsd: sdkMsg.cost.totalUsd,
              sessionId: id,
            });
          }

          // Track context-window usage from result messages. Token counts live
          // on `usage` (snake_case) but the window size is only on `modelUsage`.
          if (sdkMsg.type === SdkMessageType.Result) {
            const { inputTokens, outputTokens } = this.parseResultUsage(message as Record<string, unknown>);
            session.contextTokens = inputTokens + outputTokens;
            session.maxContextTokens = this.extractContextWindow(message as Record<string, unknown>);
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
      session.activity = SessionActivity.Idle;
      session.activityDetail = undefined;
      this.emitStatus(id, SessionStatus.Active);
      this.emitActivity(id, SessionActivity.Idle);

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
    if (session.provider !== AgentProvider.Claude) return;

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

  setModel(id: string, model: string): void {
    const session = this.sessions.get(id);
    if (!session) return;
    session.model = model;
    this.persistState();
    log.info(`Session ${id} model set to: ${model}`);
  }

  /** Soft interrupt: asks Claude to stop gracefully. Returns true if interrupted, false if hard-aborted. */
  async interruptQuery(id: string): Promise<boolean> {
    const active = this.activeQueries.get(id);
    if (!active) return false;

    if (!active.interrupted && active.query) {
      active.interrupted = true;
      log.info(`SDK query interrupted (soft): session=${id}`);
      try {
        await active.query.interrupt();
        return true;
      } catch {
        // If interrupt fails, fall through to hard abort
      }
    }

    // Second press or no query ref — hard abort
    this.cancelQuery(id);
    return false;
  }

  cancelQuery(id: string): void {
    const active = this.activeQueries.get(id);
    if (active) {
      active.controller.abort();
      this.activeQueries.delete(id);
    }
    this.streamState.delete(id);
    this.liveTokens.delete(id);
    // Unblock any popup still waiting on this session so the stream can unwind.
    this.rejectPendingForSession(id, 'Cancelled.');
  }

  // Agent SDK canUseTool callback. Auto-allows read-only tools and tools the
  // user pre-approved for this session; otherwise asks the renderer to show a
  // popup and returns a Promise that resolves when the user decides. The SDK
  // stream stays paused for as long as this Promise is pending.
  private requestPermission(
    sessionId: string,
    toolName: string,
    input: Record<string, unknown>,
    opts: { signal?: AbortSignal; toolUseID?: string }
  ): Promise<PermissionResult> {
    // Task tracking: capture the list for the UI and auto-allow (no prompt).
    if (toolName === TODO_WRITE_TOOL) {
      this.captureTodos(sessionId, input);
      return Promise.resolve({ behavior: 'allow', updatedInput: input });
    }

    const isQuestion = toolName === ASK_USER_QUESTION_TOOL;
    if (!isQuestion) {
      const effect = evaluatePermission({
        toolName,
        command: toolName === BASH_TOOL && typeof input.command === 'string' ? input.command : undefined,
        sessionAllowedTools: this.sessionAllowedTools.get(sessionId) ?? NO_SESSION_TOOLS,
      });
      if (effect === PermissionEffect.Allow) {
        return Promise.resolve({ behavior: 'allow', updatedInput: input });
      }
    }

    const requestId = opts.toolUseID || crypto.randomUUID();
    const kind = isQuestion ? PermissionRequestKind.Question : PermissionRequestKind.Permission;
    const payload: SdkPermissionRequestPayload = {
      requestId,
      sessionId,
      kind,
      toolName,
      summary: isQuestion ? undefined : this.describeToolUse(toolName, input),
      questions: isQuestion ? (input.questions as SdkQuestion[] | undefined) : undefined,
    };

    const session = this.sessions.get(sessionId);
    if (session) {
      session.activity = SessionActivity.WaitingForUser;
      this.emitActivity(sessionId, SessionActivity.WaitingForUser);
    }

    return new Promise<PermissionResult>((resolve) => {
      this.pendingPermissions.set(requestId, { sessionId, toolName, kind, input, resolve });
      this.send(IpcChannel.SdkPermissionRequest, payload);
      // If the query is aborted while we wait, deny so the stream can unwind.
      opts.signal?.addEventListener('abort', () => {
        if (this.pendingPermissions.delete(requestId)) {
          resolve({ behavior: 'deny', message: 'Cancelled.' });
        }
      });
    });
  }

  // Called from the renderer (via IPC) when the user answers a popup.
  resolvePermission(response: SdkPermissionResponsePayload): void {
    const pending = this.pendingPermissions.get(response.requestId);
    if (!pending) return;
    this.pendingPermissions.delete(response.requestId);

    let result: PermissionResult;
    if (pending.kind === PermissionRequestKind.Question) {
      // AskUserQuestion: echo the questions back unchanged and attach answers.
      result = {
        behavior: 'allow',
        updatedInput: { questions: pending.input.questions, answers: response.answers ?? {} },
      };
    } else if (response.decision === PermissionDecision.Deny) {
      result = { behavior: 'deny', message: response.message?.trim() || 'User denied this action.' };
    } else {
      if (response.decision === PermissionDecision.AllowSession) {
        const set = this.sessionAllowedTools.get(pending.sessionId) ?? new Set<string>();
        set.add(pending.toolName);
        this.sessionAllowedTools.set(pending.sessionId, set);
      }
      result = { behavior: 'allow', updatedInput: pending.input };
    }

    const session = this.sessions.get(pending.sessionId);
    if (session) {
      session.activity = SessionActivity.Thinking;
      this.emitActivity(pending.sessionId, SessionActivity.Thinking);
    }
    pending.resolve(result);
  }

  private rejectPendingForSession(sessionId: string, message: string): void {
    for (const [requestId, pending] of this.pendingPermissions) {
      if (pending.sessionId !== sessionId) continue;
      this.pendingPermissions.delete(requestId);
      pending.resolve({ behavior: 'deny', message });
    }
  }

  // Short, human-readable description of a tool request for the popup header.
  private describeToolUse(toolName: string, input: Record<string, unknown>): string {
    if (toolName === 'Bash' && typeof input.command === 'string') return input.command;
    if ((toolName === 'Write' || toolName === 'Edit') && typeof input.file_path === 'string') {
      return input.file_path;
    }
    return JSON.stringify(input).slice(0, TOOL_SUMMARY_MAX_CHARS);
  }

  // Pull token counts and dollar cost out of an Agent SDK `result` message.
  // The SDK reports tokens under `usage` (snake_case, straight from the
  // Anthropic API) and the run's dollar cost under top-level `total_cost_usd`.
  // `usage.input_tokens` counts only *uncached* input, so we fold in cache
  // reads/writes — otherwise prompt caching makes the input look near-zero.
  private parseResultUsage(message: Record<string, unknown>): {
    inputTokens: number;
    outputTokens: number;
    totalUsd: number;
  } {
    const usage = (message.usage ?? {}) as Record<string, number>;
    const inputTokens =
      (usage.input_tokens || 0) +
      (usage.cache_read_input_tokens || 0) +
      (usage.cache_creation_input_tokens || 0);
    const outputTokens = usage.output_tokens || 0;
    const totalUsd = typeof message.total_cost_usd === 'number' ? message.total_cost_usd : 0;
    return { inputTokens, outputTokens, totalUsd };
  }

  // The context-window size is reported per-model under `modelUsage` (camelCase,
  // SDK-aggregated) rather than on `usage`. Take the largest window across the
  // models touched this turn.
  private extractContextWindow(message: Record<string, unknown>): number {
    const modelUsage = message.modelUsage as Record<string, { contextWindow?: number }> | undefined;
    if (!modelUsage) return 0;
    let max = 0;
    for (const m of Object.values(modelUsage)) {
      if (m.contextWindow && m.contextWindow > max) max = m.contextWindow;
    }
    return max;
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
        const { inputTokens, outputTokens, totalUsd } = this.parseResultUsage(message);
        const hasUsage = inputTokens > 0 || outputTokens > 0 || totalUsd > 0;
        return {
          type: SdkMessageType.Result,
          content: (message.result as string) || 'Completed',
          timestamp: Date.now(),
          cost: hasUsage ? { inputTokens, outputTokens, totalUsd } : undefined,
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
    this.sessionAllowedTools.delete(id);
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
    this.send(IpcChannel.SdkMessage, { id, message });
  }

  private emitStatus(id: string, status: string): void {
    this.send(IpcChannel.SessionStatus, { id, status });
  }

  private emitCost(id: string, totalCost: number): void {
    this.send(IpcChannel.SdkCost, { id, totalCost });
  }

  private emitActivity(id: string, activity: SessionActivity, detail?: string, tokens?: number): void {
    this.send(IpcChannel.SdkActivity, { id, activity, detail, tokens });
  }

  // Snapshot the latest TodoWrite task list onto the session and push it to the
  // renderer. TodoWrite always sends the full list, so this replaces (not
  // appends) — the panel always reflects the current state.
  private captureTodos(sessionId: string, input: Record<string, unknown>): void {
    const raw = input.todos;
    if (!Array.isArray(raw)) return;
    const todos: SdkTodo[] = raw
      .filter((t): t is Record<string, unknown> => !!t && typeof t === 'object')
      .map((t) => ({
        content: String(t.content ?? ''),
        status: (t.status as SdkTodo['status']) ?? 'pending',
        activeForm: typeof t.activeForm === 'string' ? t.activeForm : undefined,
      }))
      .filter((t) => t.content);
    const session = this.sessions.get(sessionId);
    if (session) session.todos = todos;
    this.send(IpcChannel.SdkTodos, { id: sessionId, todos });
  }

  private handleStreamEvent(id: string, session: SdkSessionInfo, event: Record<string, unknown>): void {
    const eventType = event.type as string;

    switch (eventType) {
      case 'content_block_start': {
        const block = event.content_block as Record<string, unknown> | undefined;
        if (!block) break;
        if (block.type === 'thinking') {
          this.streamState.delete(id);
          session.activity = SessionActivity.Thinking;
          session.activityDetail = undefined;
          this.emitActivity(id, SessionActivity.Thinking);
        } else if (block.type === 'tool_use') {
          const toolName = (block.name as string) || 'tool';
          // Seed live state; the real command/file streams in via deltas.
          this.streamState.set(id, { toolName, json: '', detail: toolName });
          session.activity = SessionActivity.UsingTool;
          session.activityDetail = toolName;
          this.emitActivity(id, SessionActivity.UsingTool, toolName);
        } else if (block.type === 'text') {
          this.streamState.delete(id);
          session.activity = SessionActivity.Streaming;
          session.activityDetail = undefined;
          this.emitActivity(id, SessionActivity.Streaming);
        }
        break;
      }
      case 'content_block_delta': {
        const delta = event.delta as Record<string, unknown> | undefined;
        if (!delta || delta.type !== 'input_json_delta' || typeof delta.partial_json !== 'string') break;
        const st = this.streamState.get(id);
        if (!st) break;
        st.json += delta.partial_json;
        const detail = this.streamingToolDetail(st.toolName, st.json);
        if (detail !== st.detail) {
          st.detail = detail;
          session.activity = SessionActivity.UsingTool;
          session.activityDetail = detail;
          this.emitActivity(id, SessionActivity.UsingTool, detail);
        }
        break;
      }
      case 'content_block_stop': {
        const st = this.streamState.get(id);
        if (st) {
          // Args finished streaming; the tool now actually runs. Keep showing
          // the command/file (not a generic "Thinking") for the duration.
          this.streamState.delete(id);
          session.activity = SessionActivity.UsingTool;
          session.activityDetail = st.detail;
          this.emitActivity(id, SessionActivity.UsingTool, st.detail);
        } else {
          session.activity = SessionActivity.Thinking;
          session.activityDetail = undefined;
          this.emitActivity(id, SessionActivity.Thinking);
        }
        break;
      }
      case 'message_delta': {
        const usage = event.usage as { output_tokens?: number } | undefined;
        if (usage && typeof usage.output_tokens === 'number') {
          const lt = this.liveTokens.get(id) ?? { base: 0, current: 0 };
          lt.current = usage.output_tokens;
          this.liveTokens.set(id, lt);
          this.emitActivity(
            id,
            session.activity ?? SessionActivity.Streaming,
            session.activityDetail,
            lt.base + lt.current
          );
        }
        break;
      }
      case 'message_stop': {
        // Fold this message's tokens into the turn total so the next message
        // continues growing from here rather than resetting.
        const lt = this.liveTokens.get(id);
        if (lt) {
          lt.base += lt.current;
          lt.current = 0;
        }
        this.streamState.delete(id);
        session.activity = SessionActivity.Idle;
        session.activityDetail = undefined;
        this.emitActivity(id, SessionActivity.Idle);
        break;
      }
    }
  }

  // Extract a human-readable action from a tool's (possibly partial) streamed
  // JSON input — the command for Bash, the path for Write/Edit/Read, etc. Falls
  // back to the tool name until a recognizable field has streamed in.
  private streamingToolDetail(toolName: string, json: string): string {
    const patterns = [
      /"command"\s*:\s*"((?:[^"\\]|\\.)*)"/,
      /"file_path"\s*:\s*"((?:[^"\\]|\\.)*)"/,
      /"path"\s*:\s*"((?:[^"\\]|\\.)*)"/,
      /"pattern"\s*:\s*"((?:[^"\\]|\\.)*)"/,
      /"url"\s*:\s*"((?:[^"\\]|\\.)*)"/,
    ];
    for (const re of patterns) {
      const m = json.match(re);
      if (m && m[1]) {
        const clean = m[1].replace(/\\n/g, ' ').replace(/\\"/g, '"').replace(/\\\\/g, '\\').trim();
        if (clean) {
          const short = clean.length > STREAM_DETAIL_MAX_CHARS
            ? `${clean.slice(0, STREAM_DETAIL_MAX_CHARS)}…`
            : clean;
          return `${toolName}: ${short}`;
        }
      }
    }
    return toolName;
  }

  private emitTitle(id: string, title: string, summary: string): void {
    this.send(IpcChannel.SdkTitle, { id, title, summary });
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
          provider: s.provider,
          providerSessionId: s.providerSessionId,
          totalCost: s.totalCost,
          summary: s.summary,
          title: s.title,
          model: s.model,
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
          const provider = normalizeAgentProvider(s.provider);
          this.sessions.set(s.id, {
            ...s,
            provider,
            providerSessionId: s.providerSessionId || s.claudeSessionId,
            status: SessionStatus.Stopped,
            mode: SessionMode.Sdk,
            messages: [],
            summary: s.summary,
            title: s.title,
            model: s.model || getDefaultModelForProvider(provider),
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

  private recordUsage(entry: UsageEntry): void {
    this.usageHistory.push(entry);
    this.pruneUsageHistory();
    this.persistUsageHistory();
    this.emitUsageUpdate();
  }

  private pruneUsageHistory(): void {
    const cutoff = Date.now() - USAGE_WINDOW_MS;
    this.usageHistory = this.usageHistory.filter((e) => e.timestamp > cutoff);
  }

  private emitUsageUpdate(): void {
    const summary = this.getUsageSummary();
    this.send(IpcChannel.UsageUpdate, summary);
  }

  getUsageSummary(): UsageSummary {
    this.pruneUsageHistory();
    const now = Date.now();
    let inputTokens = 0;
    let outputTokens = 0;
    let costUsd = 0;
    let oldest = now;

    for (const e of this.usageHistory) {
      inputTokens += e.inputTokens;
      outputTokens += e.outputTokens;
      costUsd += e.costUsd;
      if (e.timestamp < oldest) oldest = e.timestamp;
    }

    const totalTokens = inputTokens + outputTokens;
    const elapsedHours = this.usageHistory.length > 0
      ? Math.max((now - oldest) / (60 * 60 * 1000), 0.01)
      : 1;
    const tokensPerHour = Math.round(totalTokens / elapsedHours);

    return { inputTokens, outputTokens, totalTokens, costUsd, tokensPerHour, windowMs: USAGE_WINDOW_MS };
  }

  private persistUsageHistory(): void {
    try {
      fs.writeFileSync(USAGE_FILE, JSON.stringify(this.usageHistory));
    } catch { /* ignore */ }
  }

  private loadUsageHistory(): void {
    try {
      if (!fs.existsSync(USAGE_FILE)) return;
      const raw = fs.readFileSync(USAGE_FILE, 'utf-8');
      this.usageHistory = JSON.parse(raw) as UsageEntry[];
      this.pruneUsageHistory();
    } catch {
      this.usageHistory = [];
    }
  }

  destroy(): void {
    for (const [id] of this.activeQueries) {
      this.cancelQuery(id);
    }
    this.persistState();
    this.persistUsageHistory();
  }
}

export interface UsageSummary {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
  tokensPerHour: number;
  windowMs: number;
}
