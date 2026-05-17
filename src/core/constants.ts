export const SessionMode = {
  Terminal: 'terminal',
  Sdk: 'sdk',
} as const;
export type SessionMode = (typeof SessionMode)[keyof typeof SessionMode];

export const AgentProvider = {
  Claude: 'claude',
  Codex: 'codex',
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
} as const;
export type IpcChannel = (typeof IpcChannel)[keyof typeof IpcChannel];

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
} as const;
export type ClaudeModel = (typeof ClaudeModel)[keyof typeof ClaudeModel];

export const CodexModel = {
  Default: 'default',
} as const;
export type CodexModel = (typeof CodexModel)[keyof typeof CodexModel];

export const DEFAULT_MODEL: ClaudeModel = ClaudeModel.Sonnet;
export const DEFAULT_CODEX_MODEL: CodexModel = CodexModel.Default;

export const PTY_TERM = 'xterm-256color';
export const PTY_DEFAULT_COLS = 120;
export const PTY_DEFAULT_ROWS = 30;
