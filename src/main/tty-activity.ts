import { SessionActivity } from '../core/constants';

const BUFFER_TAIL_BYTES = 16384;
const SUBAGENT_DECAY_MS = 60_000;
const WAITING_LATCH_MS = 21_600_000;
const ANSI_PATTERN = /\x1b\[[0-9;?<>!]*[a-zA-Z~]|\x1b\][^\x07]*\x07|\x1b[()][0-9A-Z]/g;

const WAITING_PATTERNS_NOSPACE: RegExp[] = [
  /❯[123]\./,
  /\(y\/n\)/i,
  /\[y\/n\]/i,
];
const SPINNER_PATTERN = /[✻✶✷✸✹✢✳✽*·∗◆◇]([A-Z][a-z]+ing)/i;
const ESC_INTERRUPT_PATTERN = /esctointerrupt/i;
const SUBAGENT_LAUNCH_PATTERN = /[⏺·●]Task\(/g;

export interface TtyActivitySnapshot {
  activity: SessionActivity;
  detail?: string;
  subagentCount: number;
}

interface TtyActivityState {
  buffer: string;
  lastDataAt: number;
  subagentEvents: number[];
  waitingDetectedAt: number | null;
}

export function createTtyState(): TtyActivityState {
  return { buffer: '', lastDataAt: 0, subagentEvents: [], waitingDetectedAt: null };
}

export function ingest(state: TtyActivityState, chunk: string, now: number): void {
  state.lastDataAt = now;
  const stripped = chunk.replace(ANSI_PATTERN, '');
  state.buffer = (state.buffer + stripped).slice(-BUFFER_TAIL_BYTES);
  const compact = stripped.replace(/\s+/g, '');
  if (chunkContainsWaiting(compact)) {
    state.waitingDetectedAt = now;
  } else if (state.waitingDetectedAt && SPINNER_PATTERN.test(compact)) {
    state.waitingDetectedAt = null;
  }
  SUBAGENT_LAUNCH_PATTERN.lastIndex = 0;
  while (SUBAGENT_LAUNCH_PATTERN.exec(compact) !== null) {
    state.subagentEvents.push(now);
  }
}

export function clearWaiting(state: TtyActivityState): void {
  state.waitingDetectedAt = null;
}

export function snapshot(state: TtyActivityState, now: number): TtyActivitySnapshot {
  state.subagentEvents = state.subagentEvents.filter((t) => now - t < SUBAGENT_DECAY_MS);
  const subagentCount = state.subagentEvents.length;
  const idleMs = now - state.lastDataAt;

  if (state.waitingDetectedAt && now - state.waitingDetectedAt < WAITING_LATCH_MS) {
    return { activity: SessionActivity.WaitingForUser, subagentCount };
  }
  if (state.waitingDetectedAt) state.waitingDetectedAt = null;

  const compact = state.buffer.replace(/\s+/g, '');
  const spinner = SPINNER_PATTERN.exec(compact);
  const escInterrupt = ESC_INTERRUPT_PATTERN.test(compact);
  const recentlyActive = idleMs < 1500;

  if (spinner && recentlyActive) {
    return { activity: SessionActivity.Thinking, detail: spinner[1].toLowerCase(), subagentCount };
  }

  if (recentlyActive && escInterrupt) {
    return { activity: SessionActivity.Streaming, subagentCount };
  }

  return { activity: SessionActivity.Idle, subagentCount };
}

function chunkContainsWaiting(compact: string): boolean {
  return WAITING_PATTERNS_NOSPACE.some((p) => p.test(compact));
}
