export const SessionMode = {
  Terminal: 'terminal',
  Sdk: 'sdk',
} as const;
export type SessionMode = (typeof SessionMode)[keyof typeof SessionMode];

export const AgentProvider = {
  Claude: 'claude',
  Codex: 'codex',
  Kiro: 'kiro',
} as const;
export type AgentProvider = (typeof AgentProvider)[keyof typeof AgentProvider];

export const DEFAULT_AGENT_PROVIDER: AgentProvider = AgentProvider.Claude;

export const SessionStatus = {
  Active: 'active',
  Stopped: 'stopped',
  Error: 'error',
  Thinking: 'thinking',
} as const;
export type SessionStatus = (typeof SessionStatus)[keyof typeof SessionStatus];

export const IpcChannel = {
  CreateSession: 'create-session',
  ResumeSession: 'resume-session',
  KillSession: 'kill-session',
  RemoveSession: 'remove-session',
  ListSessions: 'list-sessions',
  GetChildProcesses: 'get-child-processes',
  KillChildProcess: 'kill-child-process',
  WriteToSession: 'write-to-session',
  ResizeSession: 'resize-session',
  SetActiveSession: 'set-active-session',
  SdkSendMessage: 'sdk-send-message',
  SdkCancelQuery: 'sdk-cancel-query',
  SdkInterruptQuery: 'sdk-interrupt-query',
  SdkGetMessages: 'sdk-get-messages',
  RenameProject: 'rename-project',
  GetProjectNames: 'get-project-names',
  SelectDirectory: 'select-directory',
  GetLogPath: 'get-log-path',
  SessionData: 'session-data',
  SessionStatus: 'session-status',
  SessionProcesses: 'session-processes',
  SdkMessage: 'sdk-message',
  SdkCost: 'sdk-cost',
  SdkTitle: 'sdk-title',
  SdkActivity: 'sdk-activity',
  UsageUpdate: 'usage-update',
  GetUsageHistory: 'get-usage-history',
  SetSessionModel: 'set-session-model',
  SessionModel: 'session-model',
  SdkPermissionRequest: 'sdk-permission-request',
  SdkPermissionResponse: 'sdk-permission-response',
  SdkTodos: 'sdk-todos',
} as const;
export type IpcChannel = (typeof IpcChannel)[keyof typeof IpcChannel];

// Claude's task-tracking tool. We auto-allow it (no permission prompt — it's
// internal bookkeeping) and render its task list in the SDK view, mirroring
// what the TTY shows inline.
export const TODO_WRITE_TOOL = 'TodoWrite';

export const SdkTodoStatus = {
  Pending: 'pending',
  InProgress: 'in_progress',
  Completed: 'completed',
} as const;
export type SdkTodoStatus = (typeof SdkTodoStatus)[keyof typeof SdkTodoStatus];

export interface SdkTodo {
  content: string;
  status: SdkTodoStatus;
  activeForm?: string;
}

// Interactive confirmation for SDK (Node.js) sessions. Unlike TTY sessions
// (where Claude prints its own permission prompt in the console), SDK sessions
// run headless, so the main process intercepts tool use via the Agent SDK
// `canUseTool` callback, asks the renderer to show a popup, and blocks the
// stream until the user responds.
export const PermissionRequestKind = {
  // A tool wants to run (Bash, Write, …) — render allow/deny radio options.
  Permission: 'permission',
  // Claude called AskUserQuestion — render the questions as tabs with options.
  Question: 'question',
} as const;
export type PermissionRequestKind = (typeof PermissionRequestKind)[keyof typeof PermissionRequestKind];

export const PermissionDecision = {
  AllowOnce: 'allow_once',
  AllowSession: 'allow_session',
  Deny: 'deny',
} as const;
export type PermissionDecision = (typeof PermissionDecision)[keyof typeof PermissionDecision];

// Read-only tools auto-approved without a prompt, matching the TTY claude's
// default posture (writes / Bash / everything else still prompt).
export const PERMISSION_AUTO_ALLOW_TOOLS = ['Read', 'Glob', 'Grep'] as const;

// Claude's shell tool. SDK (node) sessions route every Bash command through
// `canUseTool`, so the permission rules inspect its command string.
export const BASH_TOOL = 'Bash';

// The built-in tool Claude calls to ask the user a multiple-choice question.
export const ASK_USER_QUESTION_TOOL = 'AskUserQuestion';

export interface SdkQuestionOption {
  label: string;
  description?: string;
}

export interface SdkQuestion {
  question: string;
  header: string;
  options: SdkQuestionOption[];
  multiSelect?: boolean;
}

export interface SdkPermissionRequestPayload {
  requestId: string;
  sessionId: string;
  kind: PermissionRequestKind;
  toolName: string;
  // kind=Permission: short human-readable description of what will happen.
  summary?: string;
  // kind=Question: the questions to render as tabs.
  questions?: SdkQuestion[];
}

export interface SdkPermissionResponsePayload {
  requestId: string;
  kind: PermissionRequestKind;
  // kind=Permission
  decision?: PermissionDecision;
  message?: string; // free-text feedback supplied with a Deny
  // kind=Question: map of question text -> chosen answer (custom text allowed)
  answers?: Record<string, string>;
}

export const SdkMessageType = {
  Assistant: 'assistant',
  User: 'user',
  System: 'system',
  Result: 'result',
  ToolUse: 'tool_use',
  ToolResult: 'tool_result',
} as const;
export type SdkMessageType = (typeof SdkMessageType)[keyof typeof SdkMessageType];

export const SessionActivity = {
  Idle: 'idle',
  Thinking: 'thinking',
  UsingTool: 'using_tool',
  Streaming: 'streaming',
  WaitingForUser: 'waiting_for_user',
} as const;
export type SessionActivity = (typeof SessionActivity)[keyof typeof SessionActivity];

export const ClaudeModel = {
  Sonnet: 'sonnet',
  Opus: 'opus',
  Haiku: 'haiku',
  Fable: 'fable',
} as const;
export type ClaudeModel = (typeof ClaudeModel)[keyof typeof ClaudeModel];

export const CodexModel = {
  Default: 'default',
} as const;
export type CodexModel = (typeof CodexModel)[keyof typeof CodexModel];

// Kiro CLI has its own configured default model; we don't hardcode a catalog of
// names (they change), so the dropdown offers just "Default" and we omit the
// --model flag, letting `kiro-cli chat` use whatever the user configured.
export const KiroModel = {
  Default: 'default',
} as const;
export type KiroModel = (typeof KiroModel)[keyof typeof KiroModel];

export const DEFAULT_MODEL: ClaudeModel = ClaudeModel.Sonnet;
export const DEFAULT_CODEX_MODEL: CodexModel = CodexModel.Default;
export const DEFAULT_KIRO_MODEL: KiroModel = KiroModel.Default;

export const PTY_TERM = 'xterm-256color';
export const PTY_DEFAULT_COLS = 120;
export const PTY_DEFAULT_ROWS = 30;

export const SdkImageMediaType = {
  Jpeg: 'image/jpeg',
  Png: 'image/png',
  Gif: 'image/gif',
  Webp: 'image/webp',
} as const;
export type SdkImageMediaType = (typeof SdkImageMediaType)[keyof typeof SdkImageMediaType];

export const SDK_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
export const SDK_IMAGE_MAX_PER_MESSAGE = 10;

export interface SdkImage {
  mediaType: SdkImageMediaType;
  base64: string;
}

// Control bytes the Claude CLI's line editor responds to (standard readline conventions).
export const TtyKeySequence = {
  Backspace: '\x7f',
  KillLine: '\x15', // Ctrl+U — clear from cursor to start of line
  KillWord: '\x17', // Ctrl+W — delete previous word
  LineStart: '\x01', // Ctrl+A
  LineEnd: '\x05', // Ctrl+E
  WordBack: '\x1bb', // Esc+b
  WordForward: '\x1bf', // Esc+f
} as const;
export type TtyKeySequence = (typeof TtyKeySequence)[keyof typeof TtyKeySequence];
