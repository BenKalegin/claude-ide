import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  AgentProvider,
  TerminalTranscriptMessageType,
} from '../core/constants';
import type {
  TerminalTranscript,
  TerminalTranscriptMessage,
} from '../core/constants';

const TRANSCRIPT_MAX_MESSAGES = 500;
const TRANSCRIPT_MAX_TOOL_INPUT_CHARS = 20_000;
const TRANSCRIPT_MAX_TOOL_RESULT_CHARS = 40_000;
const MS_PER_SECOND = 1000;
const TRANSCRIPT_TRUNCATION_LABEL = '\n\n… output truncated in Rendered view';
const INJECTED_USER_MESSAGE_PATTERN = /^<(?:local-command|command-name|command-message|system-reminder|ide_opened_file|available-deferred-tools)/i;
const KIRO_SESSIONS_DIR = path.join(os.homedir(), '.kiro', 'sessions', 'cli');
const ClaudeContentBlockType = {
  Text: 'text',
  ToolUse: 'tool_use',
  ToolResult: 'tool_result',
  ToolReference: 'tool_reference',
} as const;
const ClaudeToolName = {
  Edit: 'Edit',
} as const;
const KiroEntryKind = {
  Prompt: 'Prompt',
  AssistantMessage: 'AssistantMessage',
  ToolResults: 'ToolResults',
} as const;
const KiroContentKind = {
  Text: 'text',
  Json: 'json',
  ToolUse: 'toolUse',
  ToolResult: 'toolResult',
} as const;
const KiroToolName = {
  Write: 'write',
} as const;
const KiroWriteCommand = {
  StringReplace: 'strReplace',
} as const;
const KiroToolStatus = {
  Error: 'error',
} as const;

interface CachedTranscript {
  mtimeMs: number;
  size: number;
  transcript: TerminalTranscript;
}

const transcriptCache = new Map<string, CachedTranscript>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function parseTimestamp(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function parseUnixTimestamp(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return value * MS_PER_SECOND;
}

function truncateToolResult(value: string): string {
  if (value.length <= TRANSCRIPT_MAX_TOOL_RESULT_CHARS) return value;
  return `${value.slice(0, TRANSCRIPT_MAX_TOOL_RESULT_CHARS)}${TRANSCRIPT_TRUNCATION_LABEL}`;
}

function truncateToolInput(value: string): string {
  if (value.length <= TRANSCRIPT_MAX_TOOL_INPUT_CHARS) return value;
  return `${value.slice(0, TRANSCRIPT_MAX_TOOL_INPUT_CHARS)}${TRANSCRIPT_TRUNCATION_LABEL}`;
}

function stringifyValue(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function textFromContent(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  const parts: string[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    if (item.type === ClaudeContentBlockType.Text && typeof item.text === 'string') {
      parts.push(item.text);
    } else if (item.type === ClaudeContentBlockType.ToolReference && typeof item.tool_name === 'string') {
      parts.push(`Selected tool: ${item.tool_name}`);
    }
  }
  return parts.join('\n');
}

function toolDiff(name: string, input: Record<string, unknown>): string | undefined {
  const isClaudeEdit = name === ClaudeToolName.Edit;
  const isKiroReplace = name === KiroToolName.Write && input.command === KiroWriteCommand.StringReplace;
  if (!isClaudeEdit && !isKiroReplace) return undefined;
  const oldText = asString(isClaudeEdit ? input.old_string : input.oldStr);
  const newText = asString(isClaudeEdit ? input.new_string : input.newStr);
  if (oldText === undefined || newText === undefined) return undefined;
  const filePath = asString(isClaudeEdit ? input.file_path : input.path) ?? 'file';
  const removed = oldText.split('\n').map((line) => `-${line}`);
  const added = newText.split('\n').map((line) => `+${line}`);
  return [`--- ${filePath}`, `+++ ${filePath}`, ...removed, ...added].join('\n');
}

function appendTextMessage(
  messages: TerminalTranscriptMessage[],
  type: typeof TerminalTranscriptMessageType.User | typeof TerminalTranscriptMessageType.Assistant,
  content: string,
  id: string,
  timestamp?: number,
): void {
  const text = content.trim();
  if (!text) return;
  const previous = messages[messages.length - 1];
  if (previous?.type === type) {
    previous.content = `${previous.content}\n\n${text}`;
    previous.timestamp = timestamp ?? previous.timestamp;
    return;
  }
  messages.push({ id, type, content: text, timestamp });
}

function parseClaudeTranscript(data: string): TerminalTranscriptMessage[] {
  const messages: TerminalTranscriptMessage[] = [];
  const toolMessages = new Map<string, TerminalTranscriptMessage>();
  const lines = data.split('\n');

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex].trim();
    if (!line) continue;

    let entry: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!isRecord(parsed) || parsed.isSidechain === true) continue;
      entry = parsed;
    } catch {
      continue;
    }

    const message = isRecord(entry.message) ? entry.message : null;
    if (!message) continue;
    const timestamp = parseTimestamp(entry.timestamp);
    const entryId = asString(entry.uuid) ?? `line-${lineIndex}`;

    if (entry.type === TerminalTranscriptMessageType.Assistant) {
      const content = message.content;
      if (typeof content === 'string') {
        appendTextMessage(messages, TerminalTranscriptMessageType.Assistant, content, entryId, timestamp);
        continue;
      }
      if (!Array.isArray(content)) continue;
      for (let blockIndex = 0; blockIndex < content.length; blockIndex++) {
        const block = content[blockIndex];
        if (!isRecord(block)) continue;
        if (block.type === ClaudeContentBlockType.Text && typeof block.text === 'string') {
          appendTextMessage(
            messages,
            TerminalTranscriptMessageType.Assistant,
            block.text,
            `${entryId}-${blockIndex}`,
            timestamp,
          );
          continue;
        }
        if (block.type !== ClaudeContentBlockType.ToolUse || typeof block.name !== 'string') continue;
        const input = isRecord(block.input) ? block.input : {};
        const toolId = asString(block.id) ?? `${entryId}-${blockIndex}`;
        const toolMessage: TerminalTranscriptMessage = {
          id: toolId,
          type: TerminalTranscriptMessageType.Tool,
          content: '',
          timestamp,
          toolName: block.name,
          toolInput: truncateToolInput(stringifyValue(input)),
          toolDiff: toolDiff(block.name, input),
        };
        messages.push(toolMessage);
        toolMessages.set(toolId, toolMessage);
      }
      continue;
    }

    if (entry.type !== TerminalTranscriptMessageType.User) continue;
    const content = message.content;
    if (typeof content === 'string') {
      const text = content.trim();
      if (entry.isMeta !== true && text && !INJECTED_USER_MESSAGE_PATTERN.test(text)) {
        appendTextMessage(messages, TerminalTranscriptMessageType.User, text, entryId, timestamp);
      }
      continue;
    }
    if (!Array.isArray(content)) continue;
    for (let blockIndex = 0; blockIndex < content.length; blockIndex++) {
      const block = content[blockIndex];
      if (!isRecord(block)) continue;
      if (block.type === ClaudeContentBlockType.Text && typeof block.text === 'string') {
        appendTextMessage(
          messages,
          TerminalTranscriptMessageType.User,
          block.text,
          `${entryId}-${blockIndex}`,
          timestamp,
        );
        continue;
      }
      if (block.type !== ClaudeContentBlockType.ToolResult) continue;
      const toolUseId = asString(block.tool_use_id);
      const result = truncateToolResult(textFromContent(block.content));
      if (!result) continue;
      const existing = toolUseId ? toolMessages.get(toolUseId) : undefined;
      if (existing) {
        existing.toolResult = result;
        existing.isError = block.is_error === true;
      } else {
        messages.push({
          id: `${entryId}-${blockIndex}`,
          type: TerminalTranscriptMessageType.Tool,
          content: '',
          timestamp,
          toolName: 'Tool result',
          toolResult: result,
          isError: block.is_error === true,
        });
      }
    }
  }

  return messages.slice(-TRANSCRIPT_MAX_MESSAGES);
}

function textFromKiroResultContent(value: unknown): string {
  if (!Array.isArray(value)) return stringifyValue(value);
  const parts: string[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    if (item.kind === KiroContentKind.Text && typeof item.data === 'string') {
      parts.push(item.data);
    } else if (item.kind === KiroContentKind.Json) {
      parts.push(stringifyValue(item.data));
    }
  }
  return parts.join('\n');
}

function kiroEntryTimestamp(data: Record<string, unknown>): number | undefined {
  const meta = isRecord(data.meta) ? data.meta : null;
  return parseUnixTimestamp(meta?.timestamp);
}

function parseKiroTranscript(data: string): TerminalTranscriptMessage[] {
  const messages: TerminalTranscriptMessage[] = [];
  const toolMessages = new Map<string, TerminalTranscriptMessage>();
  const lines = data.split('\n');

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex].trim();
    if (!line) continue;
    let entry: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!isRecord(parsed)) continue;
      entry = parsed;
    } catch {
      continue;
    }

    const entryData = isRecord(entry.data) ? entry.data : null;
    if (!entryData || !Array.isArray(entryData.content)) continue;
    const entryId = asString(entryData.message_id) ?? `line-${lineIndex}`;
    const timestamp = kiroEntryTimestamp(entryData);

    if (entry.kind === KiroEntryKind.Prompt) {
      for (let blockIndex = 0; blockIndex < entryData.content.length; blockIndex++) {
        const block = entryData.content[blockIndex];
        if (!isRecord(block) || block.kind !== KiroContentKind.Text || typeof block.data !== 'string') continue;
        appendTextMessage(
          messages,
          TerminalTranscriptMessageType.User,
          block.data,
          `${entryId}-${blockIndex}`,
          timestamp,
        );
      }
      continue;
    }

    if (entry.kind === KiroEntryKind.AssistantMessage) {
      for (let blockIndex = 0; blockIndex < entryData.content.length; blockIndex++) {
        const block = entryData.content[blockIndex];
        if (!isRecord(block)) continue;
        if (block.kind === KiroContentKind.Text && typeof block.data === 'string') {
          appendTextMessage(
            messages,
            TerminalTranscriptMessageType.Assistant,
            block.data,
            `${entryId}-${blockIndex}`,
            timestamp,
          );
          continue;
        }
        if (block.kind !== KiroContentKind.ToolUse || !isRecord(block.data)) continue;
        const toolData = block.data;
        const toolName = asString(toolData.name) ?? 'Tool';
        const toolId = asString(toolData.toolUseId) ?? `${entryId}-${blockIndex}`;
        const input = isRecord(toolData.input) ? toolData.input : {};
        const toolMessage: TerminalTranscriptMessage = {
          id: toolId,
          type: TerminalTranscriptMessageType.Tool,
          content: '',
          timestamp,
          toolName,
          toolInput: truncateToolInput(stringifyValue(input)),
          toolDiff: toolDiff(toolName, input),
        };
        messages.push(toolMessage);
        toolMessages.set(toolId, toolMessage);
      }
      continue;
    }

    if (entry.kind !== KiroEntryKind.ToolResults) continue;
    for (let blockIndex = 0; blockIndex < entryData.content.length; blockIndex++) {
      const block = entryData.content[blockIndex];
      if (!isRecord(block) || block.kind !== KiroContentKind.ToolResult || !isRecord(block.data)) continue;
      const resultData = block.data;
      const toolUseId = asString(resultData.toolUseId);
      const result = truncateToolResult(textFromKiroResultContent(resultData.content));
      if (!result) continue;
      const existing = toolUseId ? toolMessages.get(toolUseId) : undefined;
      if (existing) {
        existing.toolResult = result;
        existing.isError = resultData.status === KiroToolStatus.Error;
      } else {
        messages.push({
          id: `${entryId}-${blockIndex}`,
          type: TerminalTranscriptMessageType.Tool,
          content: '',
          timestamp,
          toolName: 'Tool result',
          toolResult: result,
          isError: resultData.status === KiroToolStatus.Error,
        });
      }
    }
  }

  return messages.slice(-TRANSCRIPT_MAX_MESSAGES);
}

export function unsupportedTerminalTranscript(
  provider: AgentProvider,
  reason: string,
): TerminalTranscript {
  return {
    supported: false,
    provider,
    messages: [],
    updatedAt: 0,
    unavailableReason: reason,
  };
}

function readTerminalTranscriptFile(
  filePath: string,
  provider: AgentProvider,
  parse: (data: string) => TerminalTranscriptMessage[],
): TerminalTranscript {
  let stats: fs.Stats;
  try {
    stats = fs.statSync(filePath);
  } catch {
    return {
      supported: true,
      provider,
      messages: [],
      updatedAt: 0,
    };
  }

  const cached = transcriptCache.get(filePath);
  if (cached && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size) {
    return cached.transcript;
  }

  let data: string;
  try {
    data = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return {
      supported: true,
      provider,
      messages: [],
      updatedAt: stats.mtimeMs,
    };
  }

  const transcript: TerminalTranscript = {
    supported: true,
    provider,
    messages: parse(data),
    updatedAt: stats.mtimeMs,
  };
  transcriptCache.set(filePath, { mtimeMs: stats.mtimeMs, size: stats.size, transcript });
  return transcript;
}

export function readClaudeTerminalTranscript(filePath: string): TerminalTranscript {
  return readTerminalTranscriptFile(filePath, AgentProvider.Claude, parseClaudeTranscript);
}

export function readKiroTerminalTranscript(providerSessionId: string): TerminalTranscript {
  const filePath = path.join(KIRO_SESSIONS_DIR, `${providerSessionId}.jsonl`);
  return readTerminalTranscriptFile(filePath, AgentProvider.Kiro, parseKiroTranscript);
}
