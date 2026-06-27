import React, { useEffect, useMemo, useState } from 'react';
import {
  PermissionDecision,
  PermissionRequestKind,
} from '../../core/constants';
import type { SdkPermissionRequestPayload, SdkPermissionResponsePayload } from '../../core/constants';

// Sentinel label for the synthetic "type my own answer" option appended to
// every AskUserQuestion. Not a real option label, so it can't collide.
const CUSTOM_OPTION = '__custom__';

// Per-question selection state. `labels` holds chosen predefined options
// (a set so multiSelect works); `custom` is the free-text answer when the
// user picks the custom option.
interface QuestionSelection {
  labels: string[];
  customActive: boolean;
  custom: string;
}

function emptySelection(): QuestionSelection {
  return { labels: [], customActive: false, custom: '' };
}

function PermissionBody({
  req,
  onRespond,
}: {
  req: SdkPermissionRequestPayload;
  onRespond: (r: SdkPermissionResponsePayload) => void;
}): React.ReactElement {
  const [decision, setDecision] = useState<PermissionDecision>(PermissionDecision.AllowOnce);
  const [feedback, setFeedback] = useState('');

  const submit = () => {
    onRespond({
      requestId: req.requestId,
      kind: PermissionRequestKind.Permission,
      decision,
      message: decision === PermissionDecision.Deny ? feedback : undefined,
    });
  };

  const choices: Array<{ value: PermissionDecision; label: string }> = [
    { value: PermissionDecision.AllowOnce, label: 'Allow once' },
    { value: PermissionDecision.AllowSession, label: 'Allow for the rest of this session' },
    { value: PermissionDecision.Deny, label: 'Deny' },
  ];

  return (
    <div className="perm-body">
      <div className="perm-tool">
        <span className="perm-tool-name">{req.toolName}</span>
        {req.summary && <pre className="perm-tool-summary">{req.summary}</pre>}
      </div>
      <div className="perm-options">
        {choices.map((c) => (
          <label key={c.value} className="perm-radio">
            <input
              type="radio"
              name={`perm-${req.requestId}`}
              checked={decision === c.value}
              onChange={() => setDecision(c.value)}
            />
            <span>{c.label}</span>
          </label>
        ))}
      </div>
      {decision === PermissionDecision.Deny && (
        <textarea
          className="perm-feedback"
          value={feedback}
          onChange={(e) => setFeedback(e.target.value)}
          placeholder="Optional: tell Claude what to do instead…"
          rows={2}
          autoFocus
        />
      )}
      <div className="perm-actions">
        <button className="perm-btn perm-btn-primary" onClick={submit}>Submit</button>
      </div>
    </div>
  );
}

function QuestionBody({
  req,
  onRespond,
}: {
  req: SdkPermissionRequestPayload;
  onRespond: (r: SdkPermissionResponsePayload) => void;
}): React.ReactElement {
  const questions = req.questions ?? [];
  const [activeTab, setActiveTab] = useState(0);
  const [selections, setSelections] = useState<QuestionSelection[]>(
    () => questions.map(emptySelection)
  );

  const updateSelection = (idx: number, next: QuestionSelection) => {
    setSelections((prev) => prev.map((s, i) => (i === idx ? next : s)));
  };

  const toggleOption = (idx: number, label: string, multiSelect: boolean) => {
    const cur = selections[idx];
    if (label === CUSTOM_OPTION) {
      updateSelection(idx, multiSelect
        ? { ...cur, customActive: !cur.customActive }
        : { labels: [], customActive: true, custom: cur.custom });
      return;
    }
    if (multiSelect) {
      const has = cur.labels.includes(label);
      updateSelection(idx, {
        ...cur,
        labels: has ? cur.labels.filter((l) => l !== label) : [...cur.labels, label],
      });
    } else {
      updateSelection(idx, { labels: [label], customActive: false, custom: cur.custom });
    }
  };

  // A question is answered once it has at least one predefined choice or
  // non-empty custom text.
  const isAnswered = (s: QuestionSelection): boolean =>
    s.labels.length > 0 || (s.customActive && s.custom.trim().length > 0);

  const allAnswered = useMemo(
    () => questions.length > 0 && selections.every(isAnswered),
    [questions, selections]
  );

  const submit = () => {
    const answers: Record<string, string> = {};
    questions.forEach((q, i) => {
      const s = selections[i];
      const parts = [...s.labels];
      if (s.customActive && s.custom.trim()) parts.push(s.custom.trim());
      answers[q.question] = parts.join(', ');
    });
    onRespond({ requestId: req.requestId, kind: PermissionRequestKind.Question, answers });
  };

  const q = questions[activeTab];
  if (!q) return <div className="perm-body" />;
  const sel = selections[activeTab];

  return (
    <div className="perm-body">
      {questions.length > 1 && (
        <div className="perm-tabs">
          {questions.map((qq, i) => (
            <button
              key={i}
              className={`perm-tab ${i === activeTab ? 'perm-tab-active' : ''} ${isAnswered(selections[i]) ? 'perm-tab-done' : ''}`}
              onClick={() => setActiveTab(i)}
            >
              {qq.header || `Q${i + 1}`}
            </button>
          ))}
        </div>
      )}
      <div className="perm-question">{q.question}</div>
      <div className="perm-options">
        {q.options.map((opt) => {
          const checked = sel.labels.includes(opt.label);
          return (
            <label key={opt.label} className="perm-radio">
              <input
                type={q.multiSelect ? 'checkbox' : 'radio'}
                name={`q-${req.requestId}-${activeTab}`}
                checked={checked}
                onChange={() => toggleOption(activeTab, opt.label, !!q.multiSelect)}
              />
              <span>
                <span className="perm-opt-label">{opt.label}</span>
                {opt.description && <span className="perm-opt-desc">{opt.description}</span>}
              </span>
            </label>
          );
        })}
        <label className="perm-radio">
          <input
            type={q.multiSelect ? 'checkbox' : 'radio'}
            name={`q-${req.requestId}-${activeTab}`}
            checked={sel.customActive}
            onChange={() => toggleOption(activeTab, CUSTOM_OPTION, !!q.multiSelect)}
          />
          <span className="perm-opt-label">Custom…</span>
        </label>
        {sel.customActive && (
          <textarea
            className="perm-feedback"
            value={sel.custom}
            onChange={(e) => updateSelection(activeTab, { ...sel, custom: e.target.value })}
            placeholder="Type your own answer…"
            rows={2}
            autoFocus
          />
        )}
      </div>
      <div className="perm-actions">
        <button
          className="perm-btn perm-btn-primary"
          onClick={submit}
          disabled={!allAnswered}
        >Submit</button>
      </div>
    </div>
  );
}

export function SdkPermissionDialog(): React.ReactElement | null {
  const [queue, setQueue] = useState<SdkPermissionRequestPayload[]>([]);

  useEffect(() => {
    const unsub = window.api.sdk.onPermissionRequest((payload) => {
      setQueue((prev) => [...prev, payload]);
    });
    return unsub;
  }, []);

  const current = queue[0];

  const respond = (response: SdkPermissionResponsePayload) => {
    window.api.sdk.respondPermission(response);
    setQueue((prev) => prev.slice(1));
  };

  if (!current) return null;

  const isQuestion = current.kind === PermissionRequestKind.Question;

  return (
    <div className="perm-overlay">
      <div className="perm-dialog">
        <div className="perm-header">
          {isQuestion ? 'Claude has a question' : 'Permission required'}
        </div>
        {isQuestion ? (
          <QuestionBody key={current.requestId} req={current} onRespond={respond} />
        ) : (
          <PermissionBody key={current.requestId} req={current} onRespond={respond} />
        )}
      </div>
    </div>
  );
}
