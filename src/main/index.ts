import { app, BrowserWindow, ipcMain, dialog, nativeImage } from 'electron';
import { join } from 'path';
import * as fs from 'fs';
import * as os from 'os';
import log, { createLogger, getLogPath } from './logger';
import { SessionManager } from './session-manager';
import { SdkSessionManager } from './sdk-session-manager';
import { IpcChannel, SessionMode, SessionStatus } from '../core/constants';

const mainLog = createLogger('main');
const ipcLog = createLogger('ipc');
const isDev = !app.isPackaged;

const sessionManager = new SessionManager();
const sdkSessionManager = new SdkSessionManager();

function createWindow(): BrowserWindow {
  mainLog.info('Creating window', { isDev });

  const iconPath = join(__dirname, '../../resources/icon.png');
  const icon = nativeImage.createFromPath(iconPath);

  if (process.platform === 'darwin' && !icon.isEmpty()) {
    app.dock.setIcon(icon);
  }

  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#252525',
    icon,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  });

  sessionManager.setWindow(win);
  sdkSessionManager.setWindow(win);

  if (isDev && process.env['ELECTRON_RENDERER_URL']) {
    mainLog.info('Loading dev URL:', process.env['ELECTRON_RENDERER_URL']);
    win.loadURL(process.env['ELECTRON_RENDERER_URL']);
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'));
  }

  win.webContents.on('did-finish-load', () => {
    mainLog.info('Renderer loaded');
  });

  win.webContents.on('render-process-gone', (_e, details) => {
    mainLog.error('Renderer crashed:', details);
  });

  return win;
}

// Pipe renderer console to log file
log.initialize({ preload: true });

app.whenReady().then(() => {
  mainLog.info('App ready, pid:', process.pid);
  mainLog.info('Log file:', getLogPath());

  const restored = sessionManager.restoreState();
  const sdkRestored = sdkSessionManager.restoreState();
  mainLog.info(`Restored ${restored.length} terminal + ${sdkRestored.length} SDK sessions`);

  sessionManager.startProcessMonitor();

  ipcMain.handle(IpcChannel.CreateSession, async (_e, projectPath: string, mode: SessionMode = SessionMode.Terminal) => {
    ipcLog.info('create-session', { projectPath, mode });
    if (mode === SessionMode.Sdk) {
      const s = await sdkSessionManager.createSession(projectPath);
      ipcLog.info('SDK session created:', s.id);
      return s;
    }
    const s = sessionManager.createSession(projectPath, mode);
    ipcLog.info('Terminal session created:', s.id, 'pid:', s.pid);
    return s;
  });

  ipcMain.handle(IpcChannel.ResumeSession, async (_e, id: string) => {
    ipcLog.info('resume-session', id);
    const sdkSession = sdkSessionManager.getSession(id);
    if (sdkSession) {
      sdkSession.status = SessionStatus.Active;
      return sdkSession;
    }
    return sessionManager.resumeSession(id);
  });

  ipcMain.handle(IpcChannel.KillSession, async (_e, id: string) => {
    ipcLog.info('kill-session', id);
    const sdkSession = sdkSessionManager.getSession(id);
    if (sdkSession) {
      return sdkSessionManager.killSession(id);
    }
    return sessionManager.killSession(id);
  });

  ipcMain.handle(IpcChannel.RenameProject, async (_e, projectPath: string, name: string) => {
    ipcLog.info('rename-project', projectPath, name);
    const namesFile = join(os.homedir(), '.claude-ide', 'project-names.json');
    let names: Record<string, string> = {};
    try { names = JSON.parse(fs.readFileSync(namesFile, 'utf-8')); } catch {}
    names[projectPath] = name;
    fs.mkdirSync(join(os.homedir(), '.claude-ide'), { recursive: true });
    fs.writeFileSync(namesFile, JSON.stringify(names, null, 2));
    return true;
  });

  ipcMain.handle(IpcChannel.GetProjectNames, async () => {
    const namesFile = join(os.homedir(), '.claude-ide', 'project-names.json');
    try { return JSON.parse(fs.readFileSync(namesFile, 'utf-8')); } catch { return {}; }
  });

  ipcMain.handle(IpcChannel.RemoveSession, async (_e, id: string) => {
    ipcLog.info('remove-session', id);
    const sdkSession = sdkSessionManager.getSession(id);
    if (sdkSession) {
      sdkSessionManager.removeSession(id);
    } else {
      sessionManager.removeSession(id);
    }
    return true;
  });

  ipcMain.handle(IpcChannel.ListSessions, async () => {
    const terminal = sessionManager.getAll();
    const sdk = sdkSessionManager.getAll().map((s) => ({
      id: s.id,
      projectPath: s.projectPath,
      projectName: s.projectName,
      claudeSessionId: s.claudeSessionId,
      status: s.status,
      mode: SessionMode.Sdk,
      totalCost: s.totalCost,
      title: s.title,
      summary: s.summary,
    }));
    return [...terminal, ...sdk];
  });

  ipcMain.handle(IpcChannel.GetChildProcesses, async (_e, id: string) => {
    return sessionManager.getChildProcesses(id);
  });

  ipcMain.handle(IpcChannel.KillChildProcess, async (_e, pid: number) => {
    ipcLog.info('kill-child-process', pid);
    return sessionManager.killChildProcess(pid);
  });

  ipcMain.on(IpcChannel.WriteToSession, (_e, { id, data }: { id: string; data: string }) => {
    sessionManager.writeToSession(id, data);
  });

  ipcMain.on(IpcChannel.ResizeSession, (_e, { id, cols, rows }: { id: string; cols: number; rows: number }) => {
    ipcLog.debug('resize-session', id, `${cols}x${rows}`);
    sessionManager.resizeSession(id, cols, rows);
  });

  ipcMain.handle(IpcChannel.SdkSendMessage, async (_e, id: string, prompt: string) => {
    ipcLog.info('sdk-send-message', id, prompt.substring(0, 80));
    await sdkSessionManager.sendMessage(id, prompt);
  });

  ipcMain.handle(IpcChannel.SdkCancelQuery, async (_e, id: string) => {
    ipcLog.info('sdk-cancel-query', id);
    sdkSessionManager.cancelQuery(id);
  });

  ipcMain.handle(IpcChannel.SdkGetMessages, async (_e, id: string) => {
    return sdkSessionManager.getMessages(id);
  });

  ipcMain.handle(IpcChannel.SelectDirectory, async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory']
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    ipcLog.info('Directory selected:', result.filePaths[0]);
    return result.filePaths[0];
  });

  ipcMain.handle(IpcChannel.GetLogPath, async () => {
    return getLogPath();
  });

  createWindow();
  sessionManager.autoResumeSessions();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainLog.info('Reactivating — creating window');
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  mainLog.info('All windows closed');
  sessionManager.destroy();
  sdkSessionManager.destroy();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  mainLog.info('Quitting');
  sessionManager.destroy();
  sdkSessionManager.destroy();
});

process.on('uncaughtException', (err) => {
  mainLog.error('Uncaught exception:', err);
});

process.on('unhandledRejection', (reason) => {
  mainLog.error('Unhandled rejection:', reason);
});
