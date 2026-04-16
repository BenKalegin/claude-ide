import React, { useEffect, useRef, useState, memo } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useSessionStore } from '../stores/session-store';
import { SdkMessageType, SessionStatus, SessionActivity, ClaudeModel } from '../../core/constants';

const CMD_PREFIX = '/';

interface Props {
  sessionId: string;
}

const THOUSAND = 1000;
const MILLION = 1_000_000;

function fmtTokens(n: number): string {
  if (n >= MILLION) return `${(n / MILLION).toFixed(1)}M`;
  if (n >= THOUSAND) return `${(n / THOUSAND).toFixed(1)}k`;
  return String(n);
}

function fmtCost(usd: number): string {
  return usd >= 1 ? `$${usd.toFixed(2)}` : `$${usd.toFixed(4)}`;
}

const ChatMessage = memo(function ChatMessage({ msg }: { msg: SdkMessage }) {
  if (msg.type === SdkMessageType.User) {
    return (
      <div className="chat-row chat-row-user">
        <div className="chat-bubble-user">{msg.content}</div>
      </div>
    );
  }
  if (msg.type === SdkMessageType.System) {
    return (
      <div className="chat-row chat-row-notice">
        <pre className="chat-notice">{msg.content}</pre>
      </div>
    );
  }
  if (msg.type === SdkMessageType.ToolUse) {
    return (
      <div className="chat-row chat-row-tool">
        <span className="chat-tool-label">{msg.toolName}</span>
      </div>
    );
  }
  if (msg.type === SdkMessageType.ToolResult) {
    return null;
  }
  return (
    <div className="chat-row chat-row-assistant">
      <div className="md"><Markdown remarkPlugins={[remarkGfm]}>{msg.content}</Markdown></div>
    </div>
  );
});

/** Emit a local system message visible in the chat. */
function emitLocal(sessionId: string, content: string): void {
  useSessionStore.getState().addSdkMessage(sessionId, {
    type: SdkMessageType.System,
    content,
    timestamp: Date.now(),
  });
}

/** Handle slash commands client-side. Returns true if the input was a command. */
function handleSlashCommand(sessionId: string, text: string): boolean {
  const parts = text.split(/\s+/);
  const cmd = parts[0].toLowerCase();
  const arg = parts.slice(1).join(' ').trim();

  switch (cmd) {
    case '/help': {
      emitLocal(sessionId, [
        'Available commands:',
        '  /usage   — show token usage & cost',
        '  /cost    — show session cost',
        '  /model   — show or change model (sonnet, opus, haiku)',
        '  /clear   — clear chat display',
        '  /help    — this message',
      ].join('\n'));
      return true;
    }
    case '/usage': {
      window.api.usage.getSummary().then((s) => {
        emitLocal(sessionId, [
          `Tokens (2h): ${fmtTokens(s.totalTokens)} (in: ${fmtTokens(s.inputTokens)}, out: ${fmtTokens(s.outputTokens)})`,
          `Rate: ${fmtTokens(s.tokensPerHour)}/hr`,
          `Cost (2h): ${fmtCost(s.costUsd)}`,
        ].join('\n'));
      });
      return true;
    }
    case '/cost': {
      const session = useSessionStore.getState().sessions.get(sessionId);
      emitLocal(sessionId, `Session cost: ${fmtCost(session?.totalCost || 0)}`);
      return true;
    }
    case '/model': {
      const session = useSessionStore.getState().sessions.get(sessionId);
      if (!arg) {
        emitLocal(sessionId, `Current model: ${session?.model || 'unknown'}\nAvailable: sonnet, opus, haiku`);
        return true;
      }
      const models: Record<string, string> = {
        sonnet: ClaudeModel.Sonnet,
        opus: ClaudeModel.Opus,
        haiku: ClaudeModel.Haiku,
      };
      const model = models[arg.toLowerCase()];
      if (!model) {
        emitLocal(sessionId, `Unknown model "${arg}". Available: sonnet, opus, haiku`);
        return true;
      }
      window.api.sessions.setModel(sessionId, model).then(() => {
        useSessionStore.getState().updateSession(sessionId, { model });
        emitLocal(sessionId, `Model set to: ${arg.toLowerCase()}`);
      });
      return true;
    }
    case '/clear': {
      useSessionStore.getState().setSdkMessages(sessionId, []);
      return true;
    }
    default:
      return false;
  }
}

function ChatInput({ sessionId }: { sessionId: string }) {
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const session = useSessionStore((s) => s.sessions.get(sessionId));
  const isThinking = session?.status === SessionStatus.Thinking;

  const handleSend = async () => {
    const prompt = input.trim();
    if (!prompt || sending) return;

    if (prompt.startsWith(CMD_PREFIX) && handleSlashCommand(sessionId, prompt)) {
      setInput('');
      return;
    }

    setInput('');
    setSending(true);
    try {
      await window.api.sdk.sendMessage(sessionId, prompt);
    } finally {
      setSending(false);
    }
  };

  const handleInterrupt = async () => {
    const wasInterrupted = await window.api.sdk.interruptQuery(sessionId);
    if (!wasInterrupted) {
      setSending(false);
    }
  };

  const handleCancel = () => {
    window.api.sdk.cancelQuery(sessionId);
    setSending(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape' && isThinking) {
      e.preventDefault();
      handleInterrupt();
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
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
              <button className="chat-btn-stop" onClick={handleInterrupt} title="Interrupt (Esc)">
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
  );
}

export function SdkView({ sessionId }: Props): React.ReactElement {
  const messages = useSessionStore((s) => s.sdkMessages.get(sessionId)) || [];
  const session = useSessionStore((s) => s.sessions.get(sessionId));
  const scrollRef = useRef<HTMLDivElement>(null);

  // Global Escape handler — works even when textarea isn't focused
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        const s = useSessionStore.getState().sessions.get(sessionId);
        if (s?.status === SessionStatus.Thinking) {
          e.preventDefault();
          window.api.sdk.interruptQuery(sessionId);
        }
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [sessionId]);

  useEffect(() => {
    const existing = useSessionStore.getState().sdkMessages.get(sessionId);
    if (!existing || existing.length === 0) {
      window.api.sdk.getMessages(sessionId).then((msgs) => {
        if (msgs.length > 0) {
          useSessionStore.getState().setSdkMessages(sessionId, msgs);
        }
      });
    }
  }, [sessionId]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  const isThinking = session?.status === SessionStatus.Thinking;
  const visible = messages.filter((msg) =>
    msg.type !== SdkMessageType.System || !msg.content.startsWith('Session initialized:')
  );

  return (
    <div className="chat-view">
      <div className="chat-messages" ref={scrollRef}>
        {visible.length === 0 && (
          <div className="chat-empty">Send a message to start a Claude session</div>
        )}
        {visible.map((msg, i) => (
          <ChatMessage key={i} msg={msg} />
        ))}
        {isThinking && (
          <div className="chat-row chat-row-assistant">
            <div className="chat-thinking">
              <span className="chat-dot" />
              <span className="chat-dot" />
              <span className="chat-dot" />
              <span className="chat-thinking-label">
                {session?.activity === SessionActivity.UsingTool
                  ? session.activityDetail || 'Using tool'
                  : session?.activity === SessionActivity.Streaming
                    ? 'Writing'
                    : 'Thinking'}
              </span>
            </div>
          </div>
        )}
      </div>
      <ChatInput sessionId={sessionId} />
    </div>
  );
}
