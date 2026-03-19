import { contextBridge, ipcRenderer } from 'electron';

export interface SessionInfo {
  id: string;
  projectPath: string;
  projectName: string;
  claudeSessionId?: string;
  status: 'active' | 'stopped' | 'error' | 'thinking';
  pid?: number;
  mode: 'terminal' | 'sdk';
  totalCost?: number;
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
    create: (projectPath: string, mode: 'terminal' | 'sdk' = 'terminal'): Promise<SessionInfo> =>
      ipcRenderer.invoke('create-session', projectPath, mode),

    resume: (id: string): Promise<SessionInfo | null> =>
      ipcRenderer.invoke('resume-session', id),

    kill: (id: string): Promise<boolean> =>
      ipcRenderer.invoke('kill-session', id),

    remove: (id: string): Promise<boolean> =>
      ipcRenderer.invoke('remove-session', id),

    list: (): Promise<SessionInfo[]> =>
      ipcRenderer.invoke('list-sessions'),

    getProcesses: (id: string): Promise<ChildProcess[]> =>
      ipcRenderer.invoke('get-child-processes', id),

    killProcess: (pid: number): Promise<boolean> =>
      ipcRenderer.invoke('kill-child-process', pid),

    write: (id: string, data: string): void =>
      ipcRenderer.send('write-to-session', { id, data }),

    resize: (id: string, cols: number, rows: number): void =>
      ipcRenderer.send('resize-session', { id, cols, rows }),

    onData: (callback: (event: { id: string; data: string }) => void) => {
      const handler = (_e: Electron.IpcRendererEvent, payload: { id: string; data: string }) =>
        callback(payload);
      ipcRenderer.on('session-data', handler);
      return () => ipcRenderer.removeListener('session-data', handler);
    },

    onStatusChange: (callback: (event: { id: string; status: string }) => void) => {
      const handler = (_e: Electron.IpcRendererEvent, payload: { id: string; status: string }) =>
        callback(payload);
      ipcRenderer.on('session-status', handler);
      return () => ipcRenderer.removeListener('session-status', handler);
    },

    onProcesses: (callback: (event: { id: string; processes: ChildProcess[] }) => void) => {
      const handler = (_e: Electron.IpcRendererEvent, payload: { id: string; processes: ChildProcess[] }) =>
        callback(payload);
      ipcRenderer.on('session-processes', handler);
      return () => ipcRenderer.removeListener('session-processes', handler);
    }
  },

  sdk: {
    sendMessage: (id: string, prompt: string): Promise<void> =>
      ipcRenderer.invoke('sdk-send-message', id, prompt),

    cancelQuery: (id: string): Promise<void> =>
      ipcRenderer.invoke('sdk-cancel-query', id),

    getMessages: (id: string): Promise<SdkMessage[]> =>
      ipcRenderer.invoke('sdk-get-messages', id),

    onMessage: (callback: (event: { id: string; message: SdkMessage }) => void) => {
      const handler = (_e: Electron.IpcRendererEvent, payload: { id: string; message: SdkMessage }) =>
        callback(payload);
      ipcRenderer.on('sdk-message', handler);
      return () => ipcRenderer.removeListener('sdk-message', handler);
    },

    onCost: (callback: (event: { id: string; totalCost: number }) => void) => {
      const handler = (_e: Electron.IpcRendererEvent, payload: { id: string; totalCost: number }) =>
        callback(payload);
      ipcRenderer.on('sdk-cost', handler);
      return () => ipcRenderer.removeListener('sdk-cost', handler);
    },
  },

  selectDirectory: (): Promise<string | null> =>
    ipcRenderer.invoke('select-directory'),

  getLogPath: (): Promise<string> =>
    ipcRenderer.invoke('get-log-path'),
};

contextBridge.exposeInMainWorld('api', api);

export type API = typeof api;
