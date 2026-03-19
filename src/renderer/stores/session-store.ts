import { create } from 'zustand';
import { DEFAULT_THEME_ID } from '../../core/themes';
import type { ThemeId } from '../../core/themes';

const SIDEBAR_MIN = 140;
const SIDEBAR_MAX = 400;
const SIDEBAR_DEFAULT = 200;

interface SessionState {
  sessions: Map<string, SessionInfo>;
  activeSessionId: string | null;
  processes: Map<string, ChildProcess[]>;
  sdkMessages: Map<string, SdkMessage[]>;
  projectNames: Map<string, string>;
  themeId: ThemeId;
  sidebarWidth: number;

  setSessions: (sessions: SessionInfo[]) => void;
  updateSession: (id: string, updates: Partial<SessionInfo>) => void;
  addSession: (session: SessionInfo) => void;
  removeSession: (id: string) => void;
  selectSession: (id: string | null) => void;
  setProcesses: (id: string, procs: ChildProcess[]) => void;
  addSdkMessage: (id: string, message: SdkMessage) => void;
  setSdkMessages: (id: string, messages: SdkMessage[]) => void;
  setThemeId: (id: ThemeId) => void;
  setProjectName: (path: string, name: string) => void;
  setProjectNames: (names: Record<string, string>) => void;
  resizeSidebar: (delta: number) => void;
}

export const useSessionStore = create<SessionState>((set) => ({
  sessions: new Map(),
  activeSessionId: null,
  processes: new Map(),
  sdkMessages: new Map(),
  projectNames: new Map(),
  themeId: DEFAULT_THEME_ID as ThemeId,
  sidebarWidth: SIDEBAR_DEFAULT,

  setSessions: (sessions) =>
    set(() => {
      const map = new Map<string, SessionInfo>();
      sessions.forEach((s) => map.set(s.id, s));
      return { sessions: map };
    }),

  updateSession: (id, updates) =>
    set((state) => {
      const sessions = new Map(state.sessions);
      const existing = sessions.get(id);
      if (existing) {
        sessions.set(id, { ...existing, ...updates });
      }
      return { sessions };
    }),

  addSession: (session) =>
    set((state) => {
      const sessions = new Map(state.sessions);
      sessions.set(session.id, session);
      return { sessions };
    }),

  removeSession: (id) =>
    set((state) => {
      const sessions = new Map(state.sessions);
      sessions.delete(id);
      const processes = new Map(state.processes);
      processes.delete(id);
      const sdkMessages = new Map(state.sdkMessages);
      sdkMessages.delete(id);
      const activeSessionId = state.activeSessionId === id ? null : state.activeSessionId;
      return { sessions, processes, sdkMessages, activeSessionId };
    }),

  selectSession: (id) => set({ activeSessionId: id }),

  setProcesses: (id, procs) =>
    set((state) => {
      const processes = new Map(state.processes);
      processes.set(id, procs);
      return { processes };
    }),

  addSdkMessage: (id, message) =>
    set((state) => {
      const sdkMessages = new Map(state.sdkMessages);
      const existing = sdkMessages.get(id) || [];
      sdkMessages.set(id, [...existing, message]);
      return { sdkMessages };
    }),

  setSdkMessages: (id, messages) =>
    set((state) => {
      const sdkMessages = new Map(state.sdkMessages);
      sdkMessages.set(id, messages);
      return { sdkMessages };
    }),

  setThemeId: (id) => set({ themeId: id }),

  setProjectName: (path, name) =>
    set((state) => {
      const projectNames = new Map(state.projectNames);
      projectNames.set(path, name);
      return { projectNames };
    }),

  setProjectNames: (names) =>
    set(() => {
      const projectNames = new Map(Object.entries(names));
      return { projectNames };
    }),

  resizeSidebar: (delta) =>
    set((state) => ({
      sidebarWidth: Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, state.sidebarWidth + delta)),
    })),
}));
