import React, { useEffect, useRef, useState } from 'react';
import Markdown from 'react-markdown';
import { useSessionStore } from '../stores/session-store';

interface Props {
  sessionId: string;
}

export function SdkView({ sessionId }: Props): React.ReactElement {
  const messages = useSessionStore((s) => s.sdkMessages.get(sessionId)) || [];
  const session = useSessionStore((s) => s.sessions.get(sessionId));
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    window.api.sdk.getMessages(sessionId).then((msgs) => {
      if (msgs.length > 0) {
        useSessionStore.getState().setSdkMessages(sessionId, msgs);
      }
    });
  }, [sessionId]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  const handleSend = async () => {
    const prompt = input.trim();
    if (!prompt || sending) return;
    setInput('');
    setSending(true);
    try {
      await window.api.sdk.sendMessage(sessionId, prompt);
    } finally {
      setSending(false);
    }
  };

  const handleCancel = () => {
    window.api.sdk.cancelQuery(sessionId);
    setSending(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const isThinking = session?.status === 'thinking';

  return (
    <div className="sdk-view">
      <div className="sdk-messages" ref={scrollRef}>
        {messages.length === 0 && (
          <div className="sdk-empty">
            Send a message to start a Claude session
          </div>
        )}
        {messages.filter((msg) => msg.type !== 'system').map((msg, i) => (
          <div key={i} className={`sdk-message sdk-message-${msg.type}`}>
            <div className="sdk-message-header">
              <span className="sdk-message-type">{formatType(msg.type)}</span>
              {msg.toolName && <span className="sdk-tool-name">{msg.toolName}</span>}
              {msg.cost && (
                <span className="sdk-cost">${msg.cost.totalUsd.toFixed(4)}</span>
              )}
              <span className="sdk-timestamp">{formatTime(msg.timestamp)}</span>
            </div>
            <div className="sdk-message-content">
              {msg.type === 'tool_use' && msg.toolInput ? (
                <pre className="sdk-tool-input">{JSON.stringify(msg.toolInput, null, 2)}</pre>
              ) : msg.type === 'assistant' || msg.type === 'result' ? (
                <div className="md"><Markdown>{msg.content}</Markdown></div>
              ) : (
                <pre>{msg.content}</pre>
              )}
            </div>
          </div>
        ))}
        {isThinking && (
          <div className="sdk-message sdk-message-thinking">
            <div className="sdk-thinking-indicator">
              <span className="sdk-dot" />
              <span className="sdk-dot" />
              <span className="sdk-dot" />
            </div>
          </div>
        )}
      </div>
      <div className="sdk-input-area">
        {session?.totalCost != null && session.totalCost > 0 && (
          <div className="sdk-session-cost">Session cost: ${session.totalCost.toFixed(4)}</div>
        )}
        <div className="sdk-input-row">
          <textarea
            className="sdk-input"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Send a message to Claude..."
            rows={2}
            disabled={sending}
          />
          {isThinking ? (
            <button className="sdk-btn sdk-btn-cancel" onClick={handleCancel}>Cancel</button>
          ) : (
            <button className="sdk-btn sdk-btn-send" onClick={handleSend} disabled={!input.trim() || sending}>
              Send
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function formatType(type: string): string {
  switch (type) {
    case 'assistant': return 'Claude';
    case 'user': return 'You';
    case 'system': return 'System';
    case 'result': return 'Result';
    case 'tool_use': return 'Tool';
    case 'tool_result': return 'Output';
    default: return type;
  }
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
