// Drives the Claude CLI's interactive `/model` picker over the PTY so a
// dropdown change switches ONLY the current session. The picker is the sole
// path to a session-scoped switch: its `s` key sets the highlighted model
// "for this session only", whereas digit keys, Enter, and the `/model <name>`
// argument form all persist the choice as the global default in settings.json.

// Key bytes the picker's input handler understands. The picker does NOT enable
// application-cursor-key mode (DECCKM), so normal-mode CSI arrows are correct.
export const ModelPickerKey = {
  Open: '/model',
  Down: '\x1b[B',
  Up: '\x1b[A',
  Escape: '\x1b',
  SessionOnly: 's',
} as const;
export type ModelPickerKey = (typeof ModelPickerKey)[keyof typeof ModelPickerKey];

// Row labels the picker renders. The dropdown aliases (sonnet/opus/haiku/fable)
// match these case-insensitively; "Default" maps to whatever the global default
// resolves to and is never a direct dropdown target.
const PICKER_FAMILIES = ['Default', 'Sonnet', 'Opus', 'Haiku', 'Fable'] as const;

// ANSI strip — the picker positions columns with cursor-movement escapes rather
// than literal spaces, so after stripping, label and description run together
// ("OpusOpus4.8..."). That's why family matching keys off the known word list
// above instead of a greedy word capture.
const ANSI_PATTERN = /\x1b\[[0-9;?<>!]*[a-zA-Z~]|\x1b\][^\x07]*\x07|\x1b[()][0-9A-Z]/g;
// A fully-rendered picker ends with this footer (whitespace removed).
const PICKER_READY_MARKER = 'tousethissessiononly';
const FAMILY_ALT = PICKER_FAMILIES.join('|');
const PICKER_ROW_PATTERN = new RegExp(`^(\\s*❯?\\s*)(\\d+)\\.\\s*(${FAMILY_ALT})\\s*(\\([^)]*\\))?`, 'i');

export interface PickerRow {
  row: number;
  family: string;
  variant: string;
  disabled: boolean;
}

export interface PickerState {
  rows: PickerRow[];
  highlight: number | null;
}

/** True once the picker has finished drawing (its footer is present). */
export function isPickerReady(rawBuffer: string): boolean {
  return rawBuffer.replace(ANSI_PATTERN, '').replace(/\s+/g, '').includes(PICKER_READY_MARKER);
}

// Parse the rendered picker into rows + the currently-highlighted row. Reads
// the clean initial full render (parse once, before any navigation), so each
// model occupies one line after collapsing the carriage returns claude emits.
export function parseModelPicker(rawBuffer: string): PickerState {
  const text = rawBuffer.replace(ANSI_PATTERN, '').replace(/\r/g, '\n');
  const rows: PickerRow[] = [];
  let highlight: number | null = null;
  const seen = new Set<number>();
  for (const line of text.split('\n')) {
    const m = line.match(PICKER_ROW_PATTERN);
    if (!m) continue;
    const row = Number(m[2]);
    const variant = (m[4] || '').toLowerCase();
    // A redraw can reprint a row; keep the first parse but always let a later
    // line update which row carries the ❯ cursor.
    if (!seen.has(row)) {
      seen.add(row);
      rows.push({ row, family: m[3].toLowerCase(), variant, disabled: variant.includes('disabled') });
    }
    if (m[1].includes('❯')) highlight = row;
  }
  rows.sort((a, b) => a.row - b.row);
  return { rows, highlight };
}

export interface PickerNavigation {
  reachable: boolean;
  reason?: string;
  // Signed step count from the highlighted row to the target: positive → Down.
  delta: number;
}

// Decide how to reach `targetFamily` from the current highlight. Prefers the
// plain family row over a "(…)" variant (e.g. "Sonnet" not "Sonnet (1M)"), and
// refuses disabled rows.
export function planPickerNavigation(state: PickerState, targetFamily: string): PickerNavigation {
  if (state.highlight === null) return { reachable: false, reason: 'no highlighted row', delta: 0 };
  const family = targetFamily.toLowerCase();
  const target =
    state.rows.find((r) => r.family === family && !r.variant) ||
    state.rows.find((r) => r.family === family);
  if (!target) return { reachable: false, reason: `"${targetFamily}" not in picker`, delta: 0 };
  if (target.disabled) return { reachable: false, reason: `"${targetFamily}" is disabled`, delta: 0 };
  return { reachable: true, delta: target.row - state.highlight };
}
