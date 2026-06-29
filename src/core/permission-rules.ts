// Permission policy for SDK (node) sessions.
//
// SDK sessions run headless, so claude-ide's own `canUseTool` callback is the
// only gate on tool use — there's no TTY claude to print its own prompt. This
// module holds the *policy* (which calls auto-run vs. prompt) as a declarative,
// ordered rule table; the session manager holds the *mechanism* (popping the
// dialog and awaiting the answer). Adding an inclusion or exclusion is a one-
// line table edit, not a new branch in the callback.

import { BASH_TOOL, PERMISSION_AUTO_ALLOW_TOOLS } from './constants';

// What a matched rule decides. First match wins (see `evaluatePermission`), so
// a Prompt rule placed *above* a broad Allow rule acts as an exclusion: it
// carves a hole out of the wider inclusion below it.
export const PermissionEffect = {
  Allow: 'allow', // auto-approve, no popup
  Prompt: 'prompt', // force the permission popup
} as const;
export type PermissionEffect = (typeof PermissionEffect)[keyof typeof PermissionEffect];

// Everything a rule needs to judge a single tool call.
export interface PermissionRuleContext {
  toolName: string;
  // The Bash command text when `toolName` is Bash; undefined otherwise.
  command?: string;
  // Tools the user chose "Allow for session" on — dynamic, per session.
  sessionAllowedTools: ReadonlySet<string>;
}

export interface PermissionRule {
  readonly name: string;
  readonly effect: PermissionEffect;
  matches(ctx: PermissionRuleContext): boolean;
}

// --- git command classification --------------------------------------------

// Read-only git subcommands we trust enough to skip the prompt for. These only
// read repo state — they never mutate it — so prompting for them is pure
// friction. Writes (commit, push, checkout, …) are absent, so they still
// prompt, matching this project's git-averse posture.
export const READ_ONLY_GIT_SUBCOMMANDS = ['log', 'status', 'diff'] as const;

// Shell metacharacters that could chain or redirect a second command onto an
// otherwise-safe one (e.g. `git log; rm -rf`). Their presence disqualifies
// auto-allow — the allow-list only covers a bare, single git invocation.
const SHELL_CONTROL_CHARS = /[;&|`$><(){}\n]/;

// True only when `command` is a standalone, read-only git invocation. Errs
// strict: anything it can't prove safe returns false, and the user is prompted.
export function isReadOnlyGitCommand(command: string): boolean {
  const trimmed = command.trim();
  if (SHELL_CONTROL_CHARS.test(trimmed)) return false;
  const match = /^git\s+([a-z][a-z-]*)/.exec(trimmed);
  return match !== null && (READ_ONLY_GIT_SUBCOMMANDS as readonly string[]).includes(match[1]);
}

// --- the rule table ---------------------------------------------------------

// Evaluated top to bottom; the first matching rule decides. Order matters:
// place narrow exclusions (Prompt) above the broad inclusions (Allow) they
// carve into.
export const PERMISSION_RULES: readonly PermissionRule[] = [
  {
    name: 'session-allowlist',
    effect: PermissionEffect.Allow,
    matches: (ctx) => ctx.sessionAllowedTools.has(ctx.toolName),
  },
  {
    name: 'read-only-tools',
    effect: PermissionEffect.Allow,
    matches: (ctx) => (PERMISSION_AUTO_ALLOW_TOOLS as readonly string[]).includes(ctx.toolName),
  },
  {
    name: 'read-only-git',
    effect: PermissionEffect.Allow,
    matches: (ctx) =>
      ctx.toolName === BASH_TOOL && ctx.command !== undefined && isReadOnlyGitCommand(ctx.command),
  },
];

// The effect of the first matching rule, or Prompt when none match.
export function evaluatePermission(ctx: PermissionRuleContext): PermissionEffect {
  for (const rule of PERMISSION_RULES) {
    if (rule.matches(ctx)) return rule.effect;
  }
  return PermissionEffect.Prompt;
}
