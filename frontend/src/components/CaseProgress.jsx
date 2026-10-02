import React from 'react';

// Both "pending" states map to the same visual step (index 0) — from
// the family's perspective, an emergency report and a freshly-filed
// case are the same stage: "we told someone, it's not confirmed yet."
// pending_verification is kept here even though no current code path
// creates a case with that status (it's a legacy value in the schema
// enum) — a defensive fallback in case older data still has it.
const STEP_INDEX = {
  emergency_pending: 0,
  pending_verification: 0,
  verified: 1,
  under_search: 2,
  found: 3,
};

const DISPLAY_STEPS = [
  { label: 'Reported' },
  { label: 'Verified' },
  { label: 'Under Search' },
  { label: 'Found' },
];

export default function CaseProgress({ status, compact = false }) {
  if (status === 'closed') {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: compact ? 11 : 12, color: 'var(--text-muted)' }}>
        <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--text-muted)', display: 'inline-block' }} />
        Case closed
      </div>
    );
  }

  const currentIndex = STEP_INDEX[status] ?? 0;

  return (
    <div style={{ display: 'flex', alignItems: 'center', width: '100%' }}>
      {DISPLAY_STEPS.map((step, i) => {
        const isDone = i < currentIndex;
        const isCurrent = i === currentIndex;
        const color = isDone ? 'var(--success)' : isCurrent ? 'var(--accent)' : 'var(--border)';
        return (
          <React.Fragment key={step.label}>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', minWidth: compact ? 0 : 60 }}>
              <span
                style={{
                  width: compact ? 8 : 12, height: compact ? 8 : 12, borderRadius: '50%',
                  background: isDone || isCurrent ? color : 'transparent',
                  border: `2px solid ${color}`,
                  boxShadow: isCurrent ? `0 0 0 4px ${color}22` : 'none',
                  transition: 'all 0.2s',
                }}
              />
              {!compact && (
                <span style={{ fontSize: 10, marginTop: 4, color, whiteSpace: 'nowrap', fontWeight: isCurrent ? 700 : 400 }}>
                  {step.label}
                </span>
              )}
            </div>
            {i < DISPLAY_STEPS.length - 1 && (
              <div style={{ flex: 1, height: 2, background: i < currentIndex ? 'var(--success)' : 'var(--border)', transition: 'all 0.2s' }} />
            )}
          </React.Fragment>
        );
      })}
    </div>
  );
}
