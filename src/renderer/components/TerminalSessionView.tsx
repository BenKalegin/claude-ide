import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  AgentProvider,
  SessionActivity,
  TerminalTranscriptMessageType,
} from '../../core/constants';
import type {
  TerminalTranscript,
  TerminalTranscriptMessage,
} from '../../core/constants';
import { useSessionStore } from '../stores/session-store';
import { DiffContent, MarkdownContent } from './MarkdownContent';
import { TerminalView } from './TerminalView';

const TerminalOutputMode = {
  Rendered: 'rendered',
  Terminal: 'terminal',
} as const;
type TerminalOutputMode = (typeof TerminalOutputMode)[keyof typeof TerminalOutputMode];

const TRANSCRIPT_POLL_MS = 1000;
const TRANSCRIPT_SCROLL_THRESHOLD_PX = 72;
const OUTPUT_MODE_STORAGE_PREFIX = 'claude-ide:terminal-output-mode';
const TRANSCRIPT_API_RESTART_MESSAGE = 'The app bridge is out of date. Restart Claude IDE to enable Rendered view.';

interface Props {
  sessionId: string;
  provider: AgentProvider;
}

function storageKey(sessionId: string): string {
  return `${OUTPUT_MODE_STORAGE_PREFIX}:${sessionId}`;
}

function defaultMode(provider: AgentProvider): TerminalOutputMode {
  return provider === AgentProvider.Claude
    ? TerminalOutputMode.Rendered
    : TerminalOutputMode.Terminal;
}

function loadMode(sessionId: string, provider: AgentProvider): TerminalOutputMode {
  try {
    const stored = window.localStorage.getItem(storageKey(sessionId));
    if (stored === TerminalOutputMode.Rendered || stored === TerminalOutputMode.Terminal) return stored;
  } catch {
    // localStorage is optional; fall back to the provider's safest view.
  }
  return defaultMode(provider);
}

function saveMode(sessionId: string, mode: TerminalOutputMode): void {
  try {
    window.localStorage.setItem(storageKey(sessionId), mode);
  } catch {
    // localStorage is optional; the view still works for this mount.
  }
}

function providerLabel(provider: AgentProvider): string {
  switch (provider) {
    case AgentProvider.Codex:
      return 'Codex';
    case AgentProvider.Kiro:
      return 'Kiro';
    case AgentProvider.Claude:
    default:
      return 'Claude';
  }
}

function ToolMessage({ message }: { message: TerminalTranscriptMessage }): React.ReactElement {
  const hasDetails = Boolean(message.toolInput || message.toolResult || message.toolDiff);
  return (
    <details className={`transcript-tool${message.isError ? ' transcript-tool-error' : ''}`}>
      <summary>
        <span className="transcript-tool-icon" aria-hidden="true">›</span>
        <span>{message.toolName || 'Tool'}</span>
        {message.isError && <span className="transcript-tool-error-label">failed</span>}
      </summary>
      {hasDetails && (
        <div className="transcript-tool-details">
          {message.toolDiff && (
            <div className="transcript-tool-diff">
              <div className="transcript-tool-section-label">Changes</div>
              <pre><DiffContent content={message.toolDiff} /></pre>
            </div>
          )}
          {message.toolInput && !message.toolDiff && (
            <div>
              <div className="transcript-tool-section-label">Input</div>
              <pre>{message.toolInput}</pre>
            </div>
          )}
          {message.toolResult && (
            <div>
              <div className="transcript-tool-section-label">Output</div>
              <pre>{message.toolResult}</pre>
            </div>
          )}
        </div>
      )}
    </details>
  );
}

function TranscriptMessage({ message }: { message: TerminalTranscriptMessage }): React.ReactElement {
  if (message.type === TerminalTranscriptMessageType.Tool) {
    return <ToolMessage message={message} />;
  }
  if (message.type === TerminalTranscriptMessageType.User) {
    return (
      <div className="transcript-row transcript-row-user">
        <div className="transcript-user-message">{message.content}</div>
      </div>
    );
  }
  return (
    <div className="transcript-row transcript-row-assistant">
      <MarkdownContent content={message.content} />
    </div>
  );
}

function RenderedTerminalView({
  sessionId,
  provider,
  openTerminal,
}: Props & { openTerminal: () => void }): React.ReactElement {
  const session = useSessionStore((state) => state.sessions.get(sessionId));
  const [transcript, setTranscript] = useState<TerminalTranscript | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const followsOutputRef = useRef(true);
  const refreshInFlightRef = useRef(false);

  const refresh = useCallback(async () => {
    if (refreshInFlightRef.current) return;
    refreshInFlightRef.current = true;
    try {
      if (typeof window.api.sessions.getTranscript !== 'function') {
        throw new Error(TRANSCRIPT_API_RESTART_MESSAGE);
      }
      const next = await window.api.sessions.getTranscript(sessionId);
      setTranscript((current) => {
        if (
          current && next &&
          current.supported === next.supported &&
          current.updatedAt === next.updatedAt &&
          current.messages.length === next.messages.length
        ) {
          return current;
        }
        return next;
      });
      setLoadError(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('Failed to load terminal transcript:', error);
      setLoadError(message);
    } finally {
      refreshInFlightRef.current = false;
    }
  }, [sessionId]);

  useEffect(() => {
    window.api.sessions.setActive(sessionId);
    void refresh();
    const timer = provider !== AgentProvider.Codex
      ? window.setInterval(() => void refresh(), TRANSCRIPT_POLL_MS)
      : null;
    return () => {
      if (timer !== null) window.clearInterval(timer);
      window.api.sessions.setActive(null);
    };
  }, [provider, refresh, sessionId]);

  useEffect(() => {
    if (!followsOutputRef.current || !scrollRef.current) return;
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [transcript]);

  const handleScroll = () => {
    const element = scrollRef.current;
    if (!element) return;
    const distanceFromBottom = element.scrollHeight - element.scrollTop - element.clientHeight;
    followsOutputRef.current = distanceFromBottom <= TRANSCRIPT_SCROLL_THRESHOLD_PX;
  };

  if (loadError !== null) {
    return (
      <div className="transcript-state">
        <strong>Rendered transcript could not be loaded.</strong>
        <p>{loadError}</p>
        <button type="button" onClick={() => void refresh()}>Try again</button>
      </div>
    );
  }

  if (transcript && !transcript.supported) {
    return (
      <div className="transcript-state">
        <span className="transcript-state-eyebrow">{providerLabel(provider)} terminal</span>
        <strong>Rendered view is not available for this provider yet.</strong>
        <p>{transcript.unavailableReason}</p>
        <button type="button" onClick={openTerminal}>Open Terminal</button>
      </div>
    );
  }

  return (
    <div className="transcript-view">
      {session?.activity === SessionActivity.WaitingForUser && (
        <div className="transcript-needs-input">
          <span>This session needs terminal input.</span>
          <button type="button" onClick={openTerminal}>Open Terminal</button>
        </div>
      )}
      <div className="transcript-messages" ref={scrollRef} onScroll={handleScroll}>
        {!transcript && <div className="transcript-loading">Loading rendered transcript…</div>}
        {transcript && transcript.messages.length === 0 && (
          <div className="transcript-empty">
            <strong>No rendered messages yet</strong>
            <span>The conversation will appear here after the first Claude response.</span>
          </div>
        )}
        {transcript?.messages.map((message) => (
          <TranscriptMessage key={message.id} message={message} />
        ))}
      </div>
    </div>
  );
}

export function TerminalSessionView({ sessionId, provider }: Props): React.ReactElement {
  const [mode, setMode] = useState<TerminalOutputMode>(() => loadMode(sessionId, provider));

  const selectMode = (next: TerminalOutputMode) => {
    setMode(next);
    saveMode(sessionId, next);
  };

  return (
    <div className="terminal-session-view">
      <div className="terminal-output-bar">
        <div className="terminal-output-toggle" role="group" aria-label="Terminal output view">
          <button
            type="button"
            className={mode === TerminalOutputMode.Rendered ? 'active' : ''}
            aria-pressed={mode === TerminalOutputMode.Rendered}
            onClick={() => selectMode(TerminalOutputMode.Rendered)}
          >
            Rendered
          </button>
          <button
            type="button"
            className={mode === TerminalOutputMode.Terminal ? 'active' : ''}
            aria-pressed={mode === TerminalOutputMode.Terminal}
            onClick={() => selectMode(TerminalOutputMode.Terminal)}
          >
            Terminal
          </button>
        </div>
        <span className="terminal-output-hint">
          {mode === TerminalOutputMode.Rendered ? 'Formatted transcript' : 'Interactive PTY'}
        </span>
      </div>
      <div className="terminal-output-content">
        {mode === TerminalOutputMode.Rendered ? (
          <RenderedTerminalView
            sessionId={sessionId}
            provider={provider}
            openTerminal={() => selectMode(TerminalOutputMode.Terminal)}
          />
        ) : (
          <TerminalView sessionId={sessionId} provider={provider} />
        )}
      </div>
    </div>
  );
}
