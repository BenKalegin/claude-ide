import { app, BrowserWindow, ipcMain, dialog, nativeImage } from 'electron';
import { join } from 'path';
import log, { createLogger, getLogPath } from './logger';
import { SessionManager, SessionMode } from './session-manager';
import { SdkSessionManager } from './sdk-session-manager';

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
    backgroundColor: '#2B2B2B',
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

  ipcMain.handle('create-session', async (_e, projectPath: string, mode: SessionMode = 'terminal') => {
    ipcLog.info('create-session', { projectPath, mode });
    if (mode === 'sdk') {
      const s = await sdkSessionManager.createSession(projectPath);
      ipcLog.info('SDK session created:', s.id);
      return s;
    }
    const s = sessionManager.createSession(projectPath, mode);
    ipcLog.info('Terminal session created:', s.id, 'pid:', s.pid);
    return s;
  });

  ipcMain.handle('resume-session', async (_e, id: string) => {
    ipcLog.info('resume-session', id);
    const sdkSession = sdkSessionManager.getSession(id);
    if (sdkSession) {
      sdkSession.status = 'active';
      return sdkSession;
    }
    return sessionManager.resumeSession(id);
  });

  ipcMain.handle('kill-session', async (_e, id: string) => {
    ipcLog.info('kill-session', id);
    const sdkSession = sdkSessionManager.getSession(id);
    if (sdkSession) {
      return sdkSessionManager.killSession(id);
    }
    return sessionManager.killSession(id);
  });

  ipcMain.handle('remove-session', async (_e, id: string) => {
    ipcLog.info('remove-session', id);
    const sdkSession = sdkSessionManager.getSession(id);
    if (sdkSession) {
      sdkSessionManager.removeSession(id);
    } else {
      sessionManager.removeSession(id);
    }
    return true;
  });

  ipcMain.handle('list-sessions', async () => {
    const terminal = sessionManager.getAll();
    const sdk = sdkSessionManager.getAll().map((s) => ({
      id: s.id,
      projectPath: s.projectPath,
      projectName: s.projectName,
      claudeSessionId: s.claudeSessionId,
      status: s.status,
      mode: 'sdk' as const,
      totalCost: s.totalCost,
    }));
    return [...terminal, ...sdk];
  });

  ipcMain.handle('get-child-processes', async (_e, id: string) => {
    return sessionManager.getChildProcesses(id);
  });

  ipcMain.handle('kill-child-process', async (_e, pid: number) => {
    ipcLog.info('kill-child-process', pid);
    return sessionManager.killChildProcess(pid);
  });

  ipcMain.on('write-to-session', (_e, { id, data }: { id: string; data: string }) => {
    sessionManager.writeToSession(id, data);
  });

  ipcMain.on('resize-session', (_e, { id, cols, rows }: { id: string; cols: number; rows: number }) => {
    ipcLog.debug('resize-session', id, `${cols}x${rows}`);
    sessionManager.resizeSession(id, cols, rows);
  });

  ipcMain.handle('sdk-send-message', async (_e, id: string, prompt: string) => {
    ipcLog.info('sdk-send-message', id, prompt.substring(0, 80));
    await sdkSessionManager.sendMessage(id, prompt);
  });

  ipcMain.handle('sdk-cancel-query', async (_e, id: string) => {
    ipcLog.info('sdk-cancel-query', id);
    sdkSessionManager.cancelQuery(id);
  });

  ipcMain.handle('sdk-get-messages', async (_e, id: string) => {
    return sdkSessionManager.getMessages(id);
  });

  ipcMain.handle('select-directory', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory']
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    ipcLog.info('Directory selected:', result.filePaths[0]);
    return result.filePaths[0];
  });

  ipcMain.handle('get-log-path', async () => {
    return getLogPath();
  });

  createWindow();

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
