import React, { useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

const LANGUAGE_CLASS_PREFIX = 'language-';
const COPY_RESET_MS = 1600;

interface Props {
  content: string;
  className?: string;
}

interface CodeChildProps {
  className?: string;
  children?: React.ReactNode;
}

function languageFromClassName(className?: string): string {
  if (!className?.startsWith(LANGUAGE_CLASS_PREFIX)) return '';
  return className.slice(LANGUAGE_CLASS_PREFIX.length);
}

function CopyButton({ text }: { text: string }): React.ReactElement {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), COPY_RESET_MS);
    } catch {
      // Clipboard permission can be unavailable in hardened Electron builds.
    }
  };

  return (
    <button type="button" className="md-copy-button" onClick={copy}>
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}

export function DiffContent({ content }: { content: string }): React.ReactElement {
  return (
    <code className="md-diff-code">
      {content.split('\n').map((line, index) => {
        const kind = line.startsWith('+') && !line.startsWith('+++')
          ? 'add'
          : line.startsWith('-') && !line.startsWith('---')
            ? 'remove'
            : line.startsWith('@@')
              ? 'hunk'
              : 'context';
        return (
          <span key={`${index}-${line}`} className={`md-diff-line md-diff-${kind}`}>
            {line || ' '}
          </span>
        );
      })}
    </code>
  );
}

function MarkdownPre({ children }: React.HTMLAttributes<HTMLPreElement>): React.ReactElement {
  const child = React.Children.toArray(children)[0];
  if (!React.isValidElement<CodeChildProps>(child)) {
    return <pre>{children}</pre>;
  }
  const text = String(child.props.children ?? '').replace(/\n$/, '');
  const language = languageFromClassName(child.props.className);
  const label = language || 'text';

  return (
    <div className="md-code-block">
      <div className="md-code-header">
        <span>{label}</span>
        <CopyButton text={text} />
      </div>
      <pre>{language === 'diff' ? <DiffContent content={text} /> : child}</pre>
    </div>
  );
}

function MarkdownTable(props: React.TableHTMLAttributes<HTMLTableElement>): React.ReactElement {
  return (
    <div className="md-table-scroll">
      <table {...props} />
    </div>
  );
}

export function MarkdownContent({ content, className = '' }: Props): React.ReactElement {
  return (
    <div className={`md ${className}`.trim()}>
      <Markdown
        remarkPlugins={[remarkGfm]}
        components={{
          pre: MarkdownPre,
          table: MarkdownTable,
          a: ({ children, ...props }) => (
            <a {...props} target="_blank" rel="noreferrer">{children}</a>
          ),
        }}
      >
        {content}
      </Markdown>
    </div>
  );
}
