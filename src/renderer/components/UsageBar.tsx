import React, { useEffect } from 'react';
import { useSessionStore } from '../stores/session-store';

const THOUSAND = 1000;
const MILLION = 1_000_000;

function formatTokens(n: number): string {
  if (n >= MILLION) return `${(n / MILLION).toFixed(1)}M`;
  if (n >= THOUSAND) return `${(n / THOUSAND).toFixed(1)}k`;
  return String(n);
}

function formatCost(usd: number): string {
  if (usd >= 1) return `$${usd.toFixed(2)}`;
  return `$${usd.toFixed(4)}`;
}

export function UsageBar(): React.ReactElement | null {
  const summary = useSessionStore((s) => s.usageSummary);
  const setUsageSummary = useSessionStore((s) => s.setUsageSummary);

  useEffect(() => {
    // Load initial summary
    window.api.usage.getSummary().then(setUsageSummary).catch(() => {});
    // Subscribe to live updates
    const unsub = window.api.usage.onUpdate(setUsageSummary);
    return unsub;
  }, [setUsageSummary]);

  if (!summary || summary.totalTokens === 0) return null;

  return (
    <div className="usage-bar">
      <div className="usage-row">
        <span className="usage-label">2h usage</span>
        <span className="usage-value">{formatTokens(summary.totalTokens)} tok</span>
      </div>
      <div className="usage-row">
        <span className="usage-label">rate</span>
        <span className="usage-value">{formatTokens(summary.tokensPerHour)}/hr</span>
      </div>
      <div className="usage-row">
        <span className="usage-label">cost</span>
        <span className="usage-value">{formatCost(summary.costUsd)}</span>
      </div>
    </div>
  );
}
