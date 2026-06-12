import React, { useEffect, useRef } from 'react';
import { Terminal } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';
import 'xterm/css/xterm.css';
import { TtyKeySequence } from '../../core/constants';

interface Props {
  sessionId: string | null;
}

interface CachedTerminal {
  terminal: Terminal;
  fitAddon: FitAddon;
  element: HTMLDivElement;
}

// Per-session undo/redo stack for the in-CLI prompt editor.
// A chunk = one batch of input the user typed or pasted; on Cmd+Z we send
// one backspace per character in the most recent chunk.
interface InputTracker {
  undoStack: string[];
  redoStack: string[];
}

const terminalCache = new Map<string, CachedTerminal>();
const inputTrackers = new Map<string, InputTracker>();

// Buffer data for terminals not yet created
const pendingData = new Map<string, string[]>();

function getTracker(sessionId: string): InputTracker {
  let tracker = inputTrackers.get(sessionId);
  if (!tracker) {
    tracker = { undoStack: [], redoStack: [] };
    inputTrackers.set(sessionId, tracker);
  }
  return tracker;
}

function isPlainInput(data: string): boolean {
  // Escape sequences (arrows, function keys) start with ESC.
  if (data.charCodeAt(0) === 0x1b) return false;
  // Single control bytes (Ctrl+*, Backspace, etc.) — not user-typed text.
  if (data.length === 1 && data.charCodeAt(0) < 0x20 && data !== '\t') return false;
  if (data === TtyKeySequence.Backspace) return false;
  return true;
}

function recordInput(sessionId: string, data: string): void {
  const tracker = getTracker(sessionId);
  // Enter submits the prompt — the CLI clears its buffer, so we clear ours too.
  if (data.includes('\r') || data.includes('\n')) {
    tracker.undoStack.length = 0;
    tracker.redoStack.length = 0;
    return;
  }
  if (!isPlainInput(data)) {
    // Backspace invalidates the redo history (user is editing forward again).
    if (data === TtyKeySequence.Backspace) tracker.redoStack.length = 0;
    return;
  }
  tracker.undoStack.push(data);
  tracker.redoStack.length = 0;
}

function undoLastChunk(sessionId: string): void {
  const tracker = getTracker(sessionId);
  const chunk = tracker.undoStack.pop();
  if (!chunk) return;
  tracker.redoStack.push(chunk);
  window.api.sessions.write(sessionId, TtyKeySequence.Backspace.repeat(chunk.length));
}

function redoLastChunk(sessionId: string): void {
  const tracker = getTracker(sessionId);
  const chunk = tracker.redoStack.pop();
  if (!chunk) return;
  tracker.undoStack.push(chunk);
  window.api.sessions.write(sessionId, chunk);
}

function handleEditingShortcut(sessionId: string, event: KeyboardEvent): boolean {
  if (event.type !== 'keydown') return true;
  const { metaKey: cmd, altKey: alt, shiftKey: shift, key } = event;
  if (!cmd && !alt) return true;

  let sequence: string | null = null;
  let handled = true;

  if (cmd && !alt && key === 'z') {
    if (shift) redoLastChunk(sessionId);
    else undoLastChunk(sessionId);
  } else if (cmd && key === 'Backspace') {
    sequence = TtyKeySequence.KillLine;
  } else if (cmd && key === 'ArrowLeft') {
    sequence = TtyKeySequence.LineStart;
  } else if (cmd && key === 'ArrowRight') {
    sequence = TtyKeySequence.LineEnd;
  } else if (alt && key === 'Backspace') {
    sequence = TtyKeySequence.KillWord;
  } else if (alt && key === 'ArrowLeft') {
    sequence = TtyKeySequence.WordBack;
  } else if (alt && key === 'ArrowRight') {
    sequence = TtyKeySequence.WordForward;
  } else {
    handled = false;
  }

  if (sequence !== null) {
    window.api.sessions.write(sessionId, sequence);
    // Cmd+Backspace wipes the prompt — drop the stacks so undo doesn't try
    // to backspace into already-cleared input.
    if (sequence === TtyKeySequence.KillLine) {
      const tracker = getTracker(sessionId);
      tracker.undoStack.length = 0;
      tracker.redoStack.length = 0;
    }
  }

  if (handled) {
    event.preventDefault();
    return false;
  }
  return true;
}

// Global data listener
let globalUnsub: (() => void) | null = null;
function ensureGlobalListener(): void {
  if (globalUnsub) return;
  globalUnsub = window.api.sessions.onData(({ id, data, reset }) => {
    const cached = terminalCache.get(id);
    if (cached) {
      // `reset` marks a scrollback snapshot from main (sent on focus) — clear
      // the terminal first so refocusing doesn't append a duplicate transcript.
      if (reset) cached.terminal.reset();
      cached.terminal.write(data);
    } else if (reset) {
      // Snapshot for a not-yet-created terminal: it becomes the buffer baseline.
      pendingData.set(id, [data]);
    } else {
      const buf = pendingData.get(id) || [];
      buf.push(data);
      pendingData.set(id, buf);
    }
  });
}

function getOrCreateTerminal(sessionId: string): CachedTerminal {
  const existing = terminalCache.get(sessionId);
  if (existing) return existing;

  const element = document.createElement('div');
  element.style.width = '100%';
  element.style.height = '100%';

  const terminal = new Terminal({
    theme: {
      background: '#252525',
      foreground: '#E8E4E0',
      cursor: '#C47B5C',
      selectionBackground: '#C47B5C33',
      black: '#333333',
      red: '#C96B6B',
      green: '#7DB88A',
      yellow: '#C9A96B',
      blue: '#7BA4C4',
      magenta: '#B07DB8',
      cyan: '#6BB8B8',
      white: '#E8E4E0',
    },
    fontFamily: '"SF Mono", "Fira Code", "JetBrains Mono", monospace',
    fontSize: 13,
    lineHeight: 1.0,
    cursorBlink: false,
    cursorStyle: 'bar',
    cursorInactiveStyle: 'none',
  });

  const fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);
  terminal.open(element);

  // Flush any buffered data
  const buffered = pendingData.get(sessionId);
  if (buffered) {
    for (const chunk of buffered) {
      terminal.write(chunk);
    }
    pendingData.delete(sessionId);
  }

  terminal.attachCustomKeyEventHandler((event) => handleEditingShortcut(sessionId, event));

  terminal.onData((data) => {
    recordInput(sessionId, data);
    window.api.sessions.write(sessionId, data);
  });

  terminal.onResize(({ cols, rows }) => {
    window.api.sessions.resize(sessionId, cols, rows);
  });

  const cached: CachedTerminal = { terminal, fitAddon, element };
  terminalCache.set(sessionId, cached);
  return cached;
}

export function TerminalView({ sessionId }: Props): React.ReactElement {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    ensureGlobalListener();
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !sessionId) {
      // No terminal visible — tell main to stop streaming any session to us.
      window.api.sessions.setActive(null);
      return;
    }

    // Remove all children (previous terminal elements)
    while (container.firstChild) {
      container.removeChild(container.firstChild);
    }

    const cached = getOrCreateTerminal(sessionId);
    container.appendChild(cached.element);

    // Focus this session in main: it stops streaming the previous one and
    // sends a reset snapshot of this session's buffered scrollback.
    window.api.sessions.setActive(sessionId);

    // Fit after layout settles
    requestAnimationFrame(() => cached.fitAddon.fit());
    const timer = setTimeout(() => {
      cached.fitAddon.fit();
      cached.terminal.focus();
    }, 100);

    const resizeObserver = new ResizeObserver(() => {
      requestAnimationFrame(() => cached.fitAddon.fit());
    });
    resizeObserver.observe(container);

    return () => {
      clearTimeout(timer);
      resizeObserver.disconnect();
      // Stop streaming when this view goes away (e.g. switching to an SDK
      // session). On a terminal→terminal switch the next effect re-focuses.
      window.api.sessions.setActive(null);
      // Don't remove element — just leave it; next effect will swap it
    };
  }, [sessionId]);

  if (!sessionId) {
    return (
      <div className="terminal-placeholder">
        <div className="placeholder-text">
          <span className="placeholder-icon">&#9654;</span>
          <span>Select a project to open an agent session</span>
        </div>
      </div>
    );
  }

  return <div ref={containerRef} className="terminal-container" />;
}

export function disposeTerminal(sessionId: string): void {
  const cached = terminalCache.get(sessionId);
  if (cached) {
    cached.terminal.dispose();
    cached.element.remove();
    terminalCache.delete(sessionId);
  }
  pendingData.delete(sessionId);
  inputTrackers.delete(sessionId);
}
