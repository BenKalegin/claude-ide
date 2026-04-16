import { contextBridge, ipcRenderer } from 'electron';
import { IpcChannel, SessionMode } from '../core/constants';

export interface UsageSummary {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
  tokensPerHour: number;
  windowMs: number;
}

export interface SessionInfo {
  id: string;
  projectPath: string;
  projectName: string;
  claudeSessionId?: string;
  status: 'active' | 'stopped' | 'error' | 'thinking';
  pid?: number;
  mode: 'terminal' | 'sdk';
  totalCost?: number;
  model?: string;
}

export interface ChildProcess {
  pid: number;
  command: string;
}

export interface SdkMessage {
  type: 'assistant' | 'user' | 'system' | 'result' | 'tool_use' | 'tool_result';
  content: string;
  timestamp: number;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  cost?: { inputTokens: number; outputTokens: number; totalUsd: number };
  sessionId?: string;
}

const api = {
  sessions: {
    create: (projectPath: string, mode: SessionMode = SessionMode.Terminal): Promise<SessionInfo> =>
      ipcRenderer.invoke(IpcChannel.CreateSession, projectPath, mode),

    resume: (id: string): Promise<SessionInfo | null> =>
      ipcRenderer.invoke(IpcChannel.ResumeSession, id),

    kill: (id: string): Promise<boolean> =>
      ipcRenderer.invoke(IpcChannel.KillSession, id),

    remove: (id: string): Promise<boolean> =>
      ipcRenderer.invoke(IpcChannel.RemoveSession, id),

    renameProject: (projectPath: string, name: string): Promise<boolean> =>
      ipcRenderer.invoke(IpcChannel.RenameProject, projectPath, name),

    getProjectNames: (): Promise<Record<string, string>> =>
      ipcRenderer.invoke(IpcChannel.GetProjectNames),

    list: (): Promise<SessionInfo[]> =>
      ipcRenderer.invoke(IpcChannel.ListSessions),

    getProcesses: (id: string): Promise<ChildProcess[]> =>
      ipcRenderer.invoke(IpcChannel.GetChildProcesses, id),

    killProcess: (pid: number): Promise<boolean> =>
      ipcRenderer.invoke(IpcChannel.KillChildProcess, pid),

    write: (id: string, data: string): void =>
      ipcRenderer.send(IpcChannel.WriteToSession, { id, data }),

    resize: (id: string, cols: number, rows: number): void =>
      ipcRenderer.send(IpcChannel.ResizeSession, { id, cols, rows }),

    setModel: (id: string, model: string): Promise<boolean> =>
      ipcRenderer.invoke(IpcChannel.SetSessionModel, id, model),

    onData: (callback: (event: { id: string; data: string }) => void) => {
      const handler = (_e: Electron.IpcRendererEvent, payload: { id: string; data: string }) =>
        callback(payload);
      ipcRenderer.on(IpcChannel.SessionData, handler);
      return () => ipcRenderer.removeListener(IpcChannel.SessionData, handler);
    },

    onStatusChange: (callback: (event: { id: string; status: string }) => void) => {
      const handler = (_e: Electron.IpcRendererEvent, payload: { id: string; status: string }) =>
        callback(payload);
      ipcRenderer.on(IpcChannel.SessionStatus, handler);
      return () => ipcRenderer.removeListener(IpcChannel.SessionStatus, handler);
    },

    onProcesses: (callback: (event: { id: string; processes: ChildProcess[] }) => void) => {
      const handler = (_e: Electron.IpcRendererEvent, payload: { id: string; processes: ChildProcess[] }) =>
        callback(payload);
      ipcRenderer.on(IpcChannel.SessionProcesses, handler);
      return () => ipcRenderer.removeListener(IpcChannel.SessionProcesses, handler);
    }
  },

  sdk: {
    sendMessage: (id: string, prompt: string): Promise<void> =>
      ipcRenderer.invoke(IpcChannel.SdkSendMessage, id, prompt),

    cancelQuery: (id: string): Promise<void> =>
      ipcRenderer.invoke(IpcChannel.SdkCancelQuery, id),

    interruptQuery: (id: string): Promise<boolean> =>
      ipcRenderer.invoke(IpcChannel.SdkInterruptQuery, id),

    getMessages: (id: string): Promise<SdkMessage[]> =>
      ipcRenderer.invoke(IpcChannel.SdkGetMessages, id),

    onMessage: (callback: (event: { id: string; message: SdkMessage }) => void) => {
      const handler = (_e: Electron.IpcRendererEvent, payload: { id: string; message: SdkMessage }) =>
        callback(payload);
      ipcRenderer.on(IpcChannel.SdkMessage, handler);
      return () => ipcRenderer.removeListener(IpcChannel.SdkMessage, handler);
    },

    onCost: (callback: (event: { id: string; totalCost: number }) => void) => {
      const handler = (_e: Electron.IpcRendererEvent, payload: { id: string; totalCost: number }) =>
        callback(payload);
      ipcRenderer.on(IpcChannel.SdkCost, handler);
      return () => ipcRenderer.removeListener(IpcChannel.SdkCost, handler);
    },

    onTitle: (callback: (event: { id: string; title: string; summary: string }) => void) => {
      const handler = (_e: Electron.IpcRendererEvent, payload: { id: string; title: string; summary: string }) =>
        callback(payload);
      ipcRenderer.on(IpcChannel.SdkTitle, handler);
      return () => ipcRenderer.removeListener(IpcChannel.SdkTitle, handler);
    },

    onActivity: (callback: (event: { id: string; activity: string; detail?: string }) => void) => {
      const handler = (_e: Electron.IpcRendererEvent, payload: { id: string; activity: string; detail?: string }) =>
        callback(payload);
      ipcRenderer.on(IpcChannel.SdkActivity, handler);
      return () => ipcRenderer.removeListener(IpcChannel.SdkActivity, handler);
    },
  },

  selectDirectory: (): Promise<string | null> =>
    ipcRenderer.invoke(IpcChannel.SelectDirectory),

  getLogPath: (): Promise<string> =>
    ipcRenderer.invoke(IpcChannel.GetLogPath),

  usage: {
    getSummary: (): Promise<UsageSummary> =>
      ipcRenderer.invoke(IpcChannel.GetUsageHistory),

    onUpdate: (callback: (summary: UsageSummary) => void) => {
      const handler = (_e: Electron.IpcRendererEvent, payload: UsageSummary) =>
        callback(payload);
      ipcRenderer.on(IpcChannel.UsageUpdate, handler);
      return () => ipcRenderer.removeListener(IpcChannel.UsageUpdate, handler);
    },
  },
};

contextBridge.exposeInMainWorld('api', api);

export type API = typeof api;
