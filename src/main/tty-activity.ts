import { AgentProvider, SessionActivity } from '../core/constants';

const BUFFER_TAIL_BYTES = 16384;
const SUBAGENT_DECAY_MS = 60_000;
const WAITING_LATCH_MS = 21_600_000;
const RECENTLY_ACTIVE_MS = 1500;
const ANSI_PATTERN = /\x1b\[[0-9;?<>!]*[a-zA-Z~]|\x1b\][^\x07]*\x07|\x1b[()][0-9A-Z]/g;

// Per-provider pattern set. Detection is heuristic scraping of each CLI's TUI
// output, so the markers differ per provider. All patterns are tested against
// the *whitespace-stripped* buffer/chunk (e.g. "esc to interrupt" →
// "esctointerrupt"), matching how `ingest` compacts input.
interface ActivityMatchers {
  // Human-in-the-loop prompts (permission / y-n / approval menus). Any match
  // latches WaitingForUser until the user acts or `thinking` resumes.
  readonly waiting: readonly RegExp[];
  // The "model is generating" spinner. Capture group 1, when present, is used
  // as the activity detail (e.g. "thinking"). A match also clears a pending
  // waiting latch — it means work resumed past the prompt.
  readonly thinking: RegExp | null;
  // The "output is streaming, press X to stop" hint. Lower priority than
  // `thinking`; never clears the waiting latch (some CLIs, e.g. Kiro, keep
  // showing it *while* the approval menu is up).
  readonly streaming: RegExp | null;
  // Subagent/Task launch marker, scanned globally to count concurrent forks.
  readonly subagent: RegExp | null;
}

const CLAUDE_MATCHERS: ActivityMatchers = {
  waiting: [/❯[123]\./, /\(y\/n\)/i, /\[y\/n\]/i],
  thinking: /[✻✶✷✸✹✢✳✽*·∗◆◇]([A-Z][a-z]+ing)/i,
  streaming: /esctointerrupt/i,
  subagent: /[⏺·●]Task\(/g,
};

// Kiro CLI (`kiro-cli chat`) TUI markers:
//   working  → "⠙ Thinking... (esc to cancel)" + a "Kiro is working" footer
//   approval → "shell requires approval" / "Trust, always allow in this session"
// The tool spinner and "esc to cancel" hint stay on screen *during* the
// approval menu, so `streaming` must not clear the waiting latch — only
// `thinking` (real generation resuming) or user input does.
const KIRO_MATCHERS: ActivityMatchers = {
  waiting: [/requiresapproval/i, /Trust,alwaysallow/i],
  thinking: /(Thinking)\.\.\./i,
  streaming: /esctocancel/i,
  subagent: null,
};

const MATCHERS_BY_PROVIDER: Partial<Record<AgentProvider, ActivityMatchers>> = {
  [AgentProvider.Claude]: CLAUDE_MATCHERS,
  [AgentProvider.Kiro]: KIRO_MATCHERS,
};

export interface TtyActivitySnapshot {
  activity: SessionActivity;
  detail?: string;
  subagentCount: number;
  // Epoch ms of the most recent PTY output — used as the session's "last
  // active" time for the staleness indicator in the header.
  lastDataAt: number;
}

interface TtyActivityState {
  matchers: ActivityMatchers | null;
  buffer: string;
  lastDataAt: number;
  subagentEvents: number[];
  waitingDetectedAt: number | null;
}

// Codex (and any provider without a matcher set) gets no scraping — its state
// stays Idle, which is the pre-existing behavior.
export function createTtyState(provider: AgentProvider): TtyActivityState {
  return {
    matchers: MATCHERS_BY_PROVIDER[provider] ?? null,
    buffer: '',
    lastDataAt: 0,
    subagentEvents: [],
    waitingDetectedAt: null,
  };
}

export function ingest(state: TtyActivityState, chunk: string, now: number): void {
  state.lastDataAt = now;
  const matchers = state.matchers;
  if (!matchers) return;
  const stripped = chunk.replace(ANSI_PATTERN, '');
  state.buffer = (state.buffer + stripped).slice(-BUFFER_TAIL_BYTES);
  const compact = stripped.replace(/\s+/g, '');
  if (chunkContainsWaiting(matchers, compact)) {
    state.waitingDetectedAt = now;
  } else if (state.waitingDetectedAt && matchers.thinking?.test(compact)) {
    // Generation resumed past the prompt — drop the latch.
    state.waitingDetectedAt = null;
  }
  if (matchers.subagent) {
    matchers.subagent.lastIndex = 0;
    while (matchers.subagent.exec(compact) !== null) {
      state.subagentEvents.push(now);
    }
  }
}

export function clearWaiting(state: TtyActivityState): void {
  state.waitingDetectedAt = null;
}

export function snapshot(state: TtyActivityState, now: number): TtyActivitySnapshot {
  state.subagentEvents = state.subagentEvents.filter((t) => now - t < SUBAGENT_DECAY_MS);
  const subagentCount = state.subagentEvents.length;
  const matchers = state.matchers;
  const idleMs = now - state.lastDataAt;

  if (state.waitingDetectedAt && now - state.waitingDetectedAt < WAITING_LATCH_MS) {
    return { activity: SessionActivity.WaitingForUser, subagentCount, lastDataAt: state.lastDataAt };
  }
  if (state.waitingDetectedAt) state.waitingDetectedAt = null;

  if (!matchers) {
    return { activity: SessionActivity.Idle, subagentCount, lastDataAt: state.lastDataAt };
  }

  const compact = state.buffer.replace(/\s+/g, '');
  const thinking = matchers.thinking?.exec(compact) ?? null;
  const streaming = matchers.streaming?.test(compact) ?? false;
  const recentlyActive = idleMs < RECENTLY_ACTIVE_MS;

  if (thinking && recentlyActive) {
    const detail = thinking[1]?.toLowerCase();
    return { activity: SessionActivity.Thinking, detail, subagentCount, lastDataAt: state.lastDataAt };
  }

  if (recentlyActive && streaming) {
    return { activity: SessionActivity.Streaming, subagentCount, lastDataAt: state.lastDataAt };
  }

  return { activity: SessionActivity.Idle, subagentCount, lastDataAt: state.lastDataAt };
}

function chunkContainsWaiting(matchers: ActivityMatchers, compact: string): boolean {
  return matchers.waiting.some((p) => p.test(compact));
}
