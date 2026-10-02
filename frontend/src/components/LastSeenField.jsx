import React from 'react';

// Converts a Date to the value format <input type="datetime-local">
// expects (local time, no timezone suffix).
const toLocalInputValue = (date) => {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

const QUICK_OPTIONS = [
  { label: 'Just now', getDate: () => new Date() },
  { label: '1 hour ago', getDate: () => new Date(Date.now() - 60 * 60 * 1000) },
  { label: '3 hours ago', getDate: () => new Date(Date.now() - 3 * 60 * 60 * 1000) },
  { label: 'This morning', getDate: () => { const d = new Date(); d.setHours(8, 0, 0, 0); return d; } },
  { label: 'Yesterday', getDate: () => { const d = new Date(); d.setDate(d.getDate() - 1); d.setHours(18, 0, 0, 0); return d; } },
];

/**
 * A last-seen date/time field with one-tap relative options — filing
 * an FIR from memory is usually "a few hours ago" or "yesterday
 * evening," not a precise clock time, so picking that directly is
 * both faster and more honest than fiddling with a plain digit-by-
 * digit native picker. The underlying native input is still there
 * for exact entry when needed, and both max out at "now" — the
 * backend rejects a future date either way, but there's no reason to
 * let the UI offer something that will just bounce.
 */
export default function LastSeenField({ value, onChange, required = true }) {
  const nowValue = toLocalInputValue(new Date());

  const applyQuickOption = (getDate) => {
    onChange(toLocalInputValue(getDate()));
  };

  return (
    <div>
      <label>Last seen date/time</label>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
        {QUICK_OPTIONS.map((opt) => (
          <button
            key={opt.label}
            type="button"
            className="btn btn-outline"
            style={{ padding: '5px 10px', fontSize: 12.5 }}
            onClick={() => applyQuickOption(opt.getDate)}
          >
            {opt.label}
          </button>
        ))}
      </div>
      <input
        required={required}
        type="datetime-local"
        max={nowValue}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      <p className="muted" style={{ fontSize: 11.5, marginTop: 4 }}>Can't be in the future.</p>
    </div>
  );
}
