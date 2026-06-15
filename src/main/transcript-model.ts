import { ClaudeModel, SdkMessageType } from '../core/constants';

// The `/model` confirmation as recorded in the transcript, e.g.
//   <local-command-stdout>Set model to \x1b[1mclaude-fable-5[1m]\x1b[22m and saved...</local-command-stdout>
// Observed variants: "Set model to X" (argument form), "... and saved as your
// default for new sessions" (picker Enter), "... for this session [only]"
// (picker S), and "Kept model as X" (picker confirmed the active model — a
// free re-sync signal). The name is wrapped in ANSI bold codes, so strip
// escapes before matching.
const ANSI_PATTERN = /\x1b\[[0-9;?<>!]*[a-zA-Z~]/g;
const SET_MODEL_STDOUT_PATTERN = /(?:Set model to|Kept model as)\s+(.+)/i;

// Full ids ("claude-opus-4-8"), display names ("Opus 4.8 [1m]"), and hybrids
// ("opusplan") all contain the family name, so substring matching is the
// stable way to fold every spelling onto the dropdown aliases.
const MODEL_ALIAS_PATTERNS: ReadonlyArray<readonly [ClaudeModel, RegExp]> = [
  [ClaudeModel.Opus, /opus/i],
  [ClaudeModel.Sonnet, /sonnet/i],
  [ClaudeModel.Haiku, /haiku/i],
  [ClaudeModel.Fable, /fable/i],
];

interface TranscriptLine {
  type?: string;
  isSidechain?: boolean;
  message?: {
    model?: string;
    content?: unknown;
  };
}

export function modelAliasFromName(name: string): ClaudeModel | null {
  for (const [alias, pattern] of MODEL_ALIAS_PATTERNS) {
    if (pattern.test(name)) return alias;
  }
  return null;
}

function textContentOf(line: TranscriptLine): string {
  const raw = line.message?.content;
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw)) {
    return raw
      .filter((b: { type?: string }) => b.type === 'text')
      .map((b: { text?: string }) => b.text ?? '')
      .join(' ');
  }
  return '';
}

function modelAliasFromLine(line: TranscriptLine): ClaudeModel | null {
  // Sidechain (subagent) turns can run a different model than the session.
  if (line.isSidechain) return null;
  // Authoritative: the model that actually produced an assistant message.
  if (line.type === SdkMessageType.Assistant && typeof line.message?.model === 'string') {
    return modelAliasFromName(line.message.model);
  }
  // Immediate: the `/model` confirmation lands as user-side command stdout
  // before any response is generated with the new model.
  if (line.type === SdkMessageType.User) {
    const text = textContentOf(line).replace(ANSI_PATTERN, '');
    const match = SET_MODEL_STDOUT_PATTERN.exec(text);
    if (match) return modelAliasFromName(match[1]);
  }
  return null;
}

// Latest model signal in a batch of transcript lines — later lines win.
// Returns null when the batch carries no recognizable signal.
export function latestModelAliasInLines(lines: string[]): ClaudeModel | null {
  let latest: ClaudeModel | null = null;
  for (const raw of lines) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    let parsed: TranscriptLine;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const alias = modelAliasFromLine(parsed);
    if (alias) latest = alias;
  }
  return latest;
}
