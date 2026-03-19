import log from 'electron-log/main';
import * as path from 'path';
import * as os from 'os';

const LOG_DIR = path.join(os.homedir(), '.claude-ide', 'logs');

log.transports.file.resolvePathFn = () => path.join(LOG_DIR, 'main.log');
log.transports.file.maxSize = 5 * 1024 * 1024; // 5MB
log.transports.file.format = '{y}-{m}-{d} {h}:{i}:{s}.{ms} [{level}] [{processType}] {text}';
log.transports.console.format = '{h}:{i}:{s}.{ms} [{level}] {text}';

log.transports.file.archiveLogFn = (oldLog) => {
  const info = path.parse(oldLog.path);
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  return path.join(info.dir, `${info.name}-${ts}${info.ext}`);
};

export function createLogger(scope: string) {
  return log.scope(scope);
}

export function getLogPath(): string {
  return path.join(LOG_DIR, 'main.log');
}

export default log;
