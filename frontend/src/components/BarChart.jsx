import React from 'react';

/**
 * Minimal dependency-free bar chart. Good enough for a status-count /
 * trend visualization without pulling in a charting library. Swap for
 * recharts later if you want richer interactivity.
 */
export default function BarChart({ data, labelKey = 'label', valueKey = 'value', color = 'var(--accent)', height = 160 }) {
  const max = Math.max(1, ...data.map((d) => d[valueKey]));
  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 10, height, padding: '10px 0' }}>
      {data.map((d) => (
        <div key={d[labelKey]} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'flex-end', height: '100%' }}>
          <span className="muted" style={{ fontSize: 12, marginBottom: 4 }}>{d[valueKey]}</span>
          <div style={{
            width: '100%', maxWidth: 42,
            height: `${Math.max(4, (d[valueKey] / max) * (height - 40))}px`,
            background: color, borderRadius: '3px 3px 0 0',
          }} />
          <span className="muted" style={{ fontSize: 11, marginTop: 6, textAlign: 'center' }}>{d[labelKey]}</span>
        </div>
      ))}
    </div>
  );
}
