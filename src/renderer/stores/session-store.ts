import { create } from 'zustand';
import { DEFAULT_THEME_ID, findTheme } from '../../core/themes';
import type { ThemeId } from '../../core/themes';

const SIDEBAR_MIN = 140;
const SIDEBAR_MAX = 400;
const SIDEBAR_DEFAULT = 200;
const SIDEBAR_WIDTH_STORAGE_KEY = 'claude-ide:sidebar-width';
const THEME_ID_STORAGE_KEY = 'claude-ide:theme-id';
const PROJECT_ACTIVITY_STORAGE_KEY = 'claude-ide:project-activity';

function clampSidebarWidth(width: number): number {
  return Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, width));
}

function loadSidebarWidth(): number {
  try {
    const raw = window.localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY);
    if (raw === null) return SIDEBAR_DEFAULT;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) return SIDEBAR_DEFAULT;
    return clampSidebarWidth(parsed);
  } catch {
    return SIDEBAR_DEFAULT;
  }
}

function saveSidebarWidth(width: number): void {
  try {
    window.localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(width));
  } catch {
    // localStorage unavailable (private mode, quota) — silent no-op
  }
}

function loadProjectActivity(): Record<string, number> {
  try {
    const raw = window.localStorage.getItem(PROJECT_ACTIVITY_STORAGE_KEY);
    if (raw === null) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return {};
    // Keep only well-formed numeric entries — guards against hand-edited/corrupt data.
    const result: Record<string, number> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === 'number' && Number.isFinite(value)) result[key] = value;
    }
    return result;
  } catch {
    return {};
  }
}

function saveProjectActivity(activity: Record<string, number>): void {
  try {
    window.localStorage.setItem(PROJECT_ACTIVITY_STORAGE_KEY, JSON.stringify(activity));
  } catch {
    // localStorage unavailable (private mode, quota) — silent no-op
  }
}

function loadThemeId(): ThemeId {
  try {
    const raw = window.localStorage.getItem(THEME_ID_STORAGE_KEY);
    if (raw === null) return DEFAULT_THEME_ID;
    // findTheme returns undefined for unknown IDs (renamed/removed between versions).
    return findTheme(raw as ThemeId) ? (raw as ThemeId) : DEFAULT_THEME_ID;
  } catch {
    return DEFAULT_THEME_ID;
  }
}

function saveThemeId(id: ThemeId): void {
  try {
    window.localStorage.setItem(THEME_ID_STORAGE_KEY, id);
  } catch {
    // localStorage unavailable (private mode, quota) — silent no-op
  }
}

interface SessionState {
  sessions: Map<string, SessionInfo>;
  activeSessionId: string | null;
  processes: Map<string, ChildProcess[]>;
  sdkMessages: Map<string, SdkMessage[]>;
  projectNames: Map<string, string>;
  /** projectPath → last time the user opened/selected it. Persisted; drives the launch-time sidebar sort. */
  projectActivity: Record<string, number>;
  themeId: ThemeId;
  sidebarWidth: number;
  usageSummary: UsageSummary | null;

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
  setUsageSummary: (summary: UsageSummary) => void;
}

export const useSessionStore = create<SessionState>((set) => ({
  sessions: new Map(),
  activeSessionId: null,
  processes: new Map(),
  sdkMessages: new Map(),
  projectNames: new Map(),
  projectActivity: loadProjectActivity(),
  themeId: loadThemeId(),
  sidebarWidth: loadSidebarWidth(),
  usageSummary: null,

  setSessions: (sessions) =>
    set(() => {
      const map = new Map<string, SessionInfo>();
      sessions.forEach((s) => map.set(s.id, s));
      return { sessions: map };
    }),

  updateSession: (id, updates) =>
    set((state) => {
      const existing = state.sessions.get(id);
      if (!existing) return {};
      // No-op guard: if no field actually changes, keep the same Map reference so
      // subscribers (e.g. ProjectTree) don't re-render on redundant activity emits.
      const changed = (Object.keys(updates) as Array<keyof SessionInfo>).some(
        (key) => existing[key] !== updates[key]
      );
      if (!changed) return {};
      const sessions = new Map(state.sessions);
      sessions.set(id, { ...existing, ...updates });
      return { sessions };
    }),

  addSession: (session) =>
    set((state) => {
      const sessions = new Map(state.sessions);
      sessions.set(session.id, session);
      const projectActivity = { ...state.projectActivity, [session.projectPath]: Date.now() };
      saveProjectActivity(projectActivity);
      return { sessions, projectActivity };
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

  selectSession: (id) =>
    set((state) => {
      if (id === null) return { activeSessionId: id };
      const session = state.sessions.get(id);
      if (!session) return { activeSessionId: id };
      // Bump recency for next launch's sort; the live order stays frozen (see ProjectTree).
      const projectActivity = { ...state.projectActivity, [session.projectPath]: Date.now() };
      saveProjectActivity(projectActivity);
      return { activeSessionId: id, projectActivity };
    }),

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

  setThemeId: (id) => {
    saveThemeId(id);
    set({ themeId: id });
  },

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
    set((state) => {
      const sidebarWidth = clampSidebarWidth(state.sidebarWidth + delta);
      saveSidebarWidth(sidebarWidth);
      return { sidebarWidth };
    }),

  setUsageSummary: (summary) => set({ usageSummary: summary }),
}));
