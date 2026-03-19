import React, { useEffect, useRef } from 'react';
import { Terminal } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';
import 'xterm/css/xterm.css';

interface Props {
  sessionId: string | null;
}

export function TerminalView({ sessionId }: Props): React.ReactElement {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!containerRef.current || !sessionId) return;

    const terminal = new Terminal({
      theme: {
        background: '#2B2B2B',
        foreground: '#E8E8E8',
        cursor: '#C47B5C',
        selectionBackground: '#C47B5C33',
        black: '#333333',
        red: '#C96B6B',
        green: '#7DB88A',
        yellow: '#C9A96B',
        blue: '#7BA4C4',
        magenta: '#B07DB8',
        cyan: '#6BB8B8',
        white: '#E8E8E8',
      },
      fontFamily: '"SF Mono", "Fira Code", "JetBrains Mono", monospace',
      fontSize: 13,
      lineHeight: 1.4,
      cursorBlink: true
    });

    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(containerRef.current);

    requestAnimationFrame(() => {
      fitAddon.fit();
    });

    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;

    const unsubData = window.api.sessions.onData(({ id, data }) => {
      if (id === sessionId) {
        terminal.write(data);
      }
    });

    terminal.onData((data) => {
      window.api.sessions.write(sessionId, data);
    });

    terminal.onResize(({ cols, rows }) => {
      window.api.sessions.resize(sessionId, cols, rows);
    });

    const resizeObserver = new ResizeObserver(() => {
      requestAnimationFrame(() => {
        fitAddon.fit();
      });
    });
    resizeObserver.observe(containerRef.current);

    cleanupRef.current = () => {
      unsubData();
      resizeObserver.disconnect();
      terminal.dispose();
    };

    return () => {
      cleanupRef.current?.();
      cleanupRef.current = null;
      terminalRef.current = null;
      fitAddonRef.current = null;
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
