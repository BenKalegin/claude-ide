/// <reference types="vite/client" />

type SessionMode = 'terminal' | 'sdk';

interface SessionInfo {
  id: string;
  projectPath: string;
  projectName: string;
  label?: string;
  claudeSessionId?: string;
  status: 'active' | 'stopped' | 'error' | 'thinking';
  pid?: number;
  mode: SessionMode;
  totalCost?: number;
  title?: string;
  summary?: string;
  activity?: string;
  activityDetail?: string;
}

interface ChildProcess {
  pid: number;
  command: string;
}

interface SdkMessage {
  type: 'assistant' | 'user' | 'system' | 'result' | 'tool_use' | 'tool_result';
  content: string;
  timestamp: number;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  cost?: { inputTokens: number; outputTokens: number; totalUsd: number };
  sessionId?: string;
}

interface Window {
  api: {
    sessions: {
      create: (projectPath: string, mode?: SessionMode) => Promise<SessionInfo>;
      resume: (id: string) => Promise<SessionInfo | null>;
      kill: (id: string) => Promise<boolean>;
      remove: (id: string) => Promise<boolean>;
      renameProject: (projectPath: string, name: string) => Promise<boolean>;
      getProjectNames: () => Promise<Record<string, string>>;
      list: () => Promise<SessionInfo[]>;
      getProcesses: (id: string) => Promise<ChildProcess[]>;
      killProcess: (pid: number) => Promise<boolean>;
      write: (id: string, data: string) => void;
      resize: (id: string, cols: number, rows: number) => void;
      onData: (callback: (event: { id: string; data: string }) => void) => () => void;
      onStatusChange: (callback: (event: { id: string; status: string }) => void) => () => void;
      onProcesses: (callback: (event: { id: string; processes: ChildProcess[] }) => void) => () => void;
    };
    sdk: {
      sendMessage: (id: string, prompt: string) => Promise<void>;
      cancelQuery: (id: string) => Promise<void>;
      getMessages: (id: string) => Promise<SdkMessage[]>;
      onMessage: (callback: (event: { id: string; message: SdkMessage }) => void) => () => void;
      onCost: (callback: (event: { id: string; totalCost: number }) => void) => () => void;
      onTitle: (callback: (event: { id: string; title: string; summary: string }) => void) => () => void;
      onActivity: (callback: (event: { id: string; activity: string; detail?: string }) => void) => () => void;
    };
    selectDirectory: () => Promise<string | null>;
    getLogPath: () => Promise<string>;
  };
}
