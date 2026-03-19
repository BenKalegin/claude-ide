import React, { useEffect, useRef, useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
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
  const visible = messages.filter((msg) =>
    msg.type !== 'system' || msg.content.startsWith('Note:')
  );

  return (
    <div className="chat-view">
      <div className="chat-messages" ref={scrollRef}>
        {visible.length === 0 && (
          <div className="chat-empty">Send a message to start a Claude session</div>
        )}
        {visible.map((msg, i) => {
          if (msg.type === 'user') {
            return (
              <div key={i} className="chat-row chat-row-user">
                <div className="chat-bubble-user">{msg.content}</div>
              </div>
            );
          }
          if (msg.type === 'system') {
            return (
              <div key={i} className="chat-row chat-row-notice">
                <span className="chat-notice">{msg.content}</span>
              </div>
            );
          }
          if (msg.type === 'tool_use') {
            return (
              <div key={i} className="chat-row chat-row-tool">
                <span className="chat-tool-label">{msg.toolName}</span>
              </div>
            );
          }
          if (msg.type === 'tool_result') {
            return null;
          }
          // assistant or result
          return (
            <div key={i} className="chat-row chat-row-assistant">
              <div className="md"><Markdown remarkPlugins={[remarkGfm]}>{msg.content}</Markdown></div>
            </div>
          );
        })}
        {isThinking && (
          <div className="chat-row chat-row-assistant">
            <div className="chat-thinking">
              <span className="chat-dot" />
              <span className="chat-dot" />
              <span className="chat-dot" />
            </div>
          </div>
        )}
      </div>
      <div className="chat-input-area">
        <div className="chat-input-box">
          <textarea
            className="chat-input"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Reply..."
            rows={1}
            disabled={sending}
          />
          <div className="chat-input-footer">
            <button className="chat-input-add" title="Add context">+</button>
            <div className="chat-input-right">
              {session?.totalCost != null && session.totalCost > 0 && (
                <span className="chat-cost">${session.totalCost.toFixed(4)}</span>
              )}
              {isThinking ? (
                <button className="chat-btn-stop" onClick={handleCancel} title="Stop">
                  <svg width="14" height="14" viewBox="0 0 14 14"><rect x="2" y="2" width="10" height="10" rx="2" fill="currentColor"/></svg>
                </button>
              ) : (
                <button
                  className="chat-btn-submit"
                  onClick={handleSend}
                  disabled={!input.trim() || sending}
                  title="Send"
                >
                  <svg width="16" height="16" viewBox="0 0 16 16"><path d="M3 13V3l11 5-11 5z" fill="currentColor"/></svg>
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
