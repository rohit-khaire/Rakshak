import React from 'react';

const PRIORITY_CONFIG = {
  critical: { label: 'Critical', color: 'var(--danger)', bg: 'rgba(228,72,60,0.15)' },
  high: { label: 'High', color: 'var(--accent)', bg: 'rgba(242,160,7,0.15)' },
  medium: { label: 'Medium', color: 'var(--info)', bg: 'rgba(74,144,217,0.15)' },
  low: { label: 'Low', color: 'var(--text-muted)', bg: 'var(--surface-raised)' },
};

// `resolved` covers both closed AND found — once a case isn't actively
// being worked, its historic priority level isn't an urgency signal
// anymore. Showing "CRITICAL" in full red on a case that's been closed
// for weeks is actively misleading to anyone scanning a list for what
// actually needs attention right now.
export default function PriorityBadge({ priority, compact = false, resolved = false }) {
  const cfg = PRIORITY_CONFIG[priority] || PRIORITY_CONFIG.medium;
  const color = resolved ? 'var(--text-muted)' : cfg.color;
  const bg = resolved ? 'var(--surface-raised)' : cfg.bg;

  return (
    <span
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 4,
        fontFamily: 'var(--font-mono)', fontSize: compact ? 10 : 11,
        textTransform: 'uppercase', letterSpacing: '0.04em',
        padding: compact ? '2px 6px' : '3px 9px', borderRadius: 999,
        background: bg, color, border: `1px solid ${color}66`,
        opacity: resolved ? 0.7 : 1,
      }}
      title={resolved ? `Was ${cfg.label} priority while active` : undefined}
    >
      {!resolved && (priority === 'critical' || priority === 'high') && (
        <span style={{ width: 5, height: 5, borderRadius: '50%', background: color, display: 'inline-block' }} />
      )}
      {cfg.label}{resolved && ' (resolved)'}
    </span>
  );
}

export const PRIORITY_COLORS = {
  critical: '#e4483c',
  high: '#f2a007',
  medium: '#4a90d9',
  low: '#8593ad',
};
