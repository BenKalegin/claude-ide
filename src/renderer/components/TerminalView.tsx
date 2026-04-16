import React, { useEffect, useRef } from 'react';
import { Terminal } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';
import 'xterm/css/xterm.css';

interface Props {
  sessionId: string | null;
}

interface CachedTerminal {
  terminal: Terminal;
  fitAddon: FitAddon;
  element: HTMLDivElement;
}

const terminalCache = new Map<string, CachedTerminal>();

// Buffer data for terminals not yet created
const pendingData = new Map<string, string[]>();

// Global data listener
let globalUnsub: (() => void) | null = null;
function ensureGlobalListener(): void {
  if (globalUnsub) return;
  globalUnsub = window.api.sessions.onData(({ id, data }) => {
    const cached = terminalCache.get(id);
    if (cached) {
      cached.terminal.write(data);
    } else {
      // Buffer until terminal is created
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
    scrollOnOutput: false,
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

  terminal.onData((data) => {
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
    if (!container || !sessionId) return;

    // Remove all children (previous terminal elements)
    while (container.firstChild) {
      container.removeChild(container.firstChild);
    }

    const cached = getOrCreateTerminal(sessionId);
    container.appendChild(cached.element);

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
      // Don't remove element — just leave it; next effect will swap it
    };
  }, [sessionId]);

  if (!sessionId) {
    return (
      <div className="terminal-placeholder">
        <div className="placeholder-text">
          <span className="placeholder-icon">&#9654;</span>
          <span>Select a project to open a Claude session</span>
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
}
