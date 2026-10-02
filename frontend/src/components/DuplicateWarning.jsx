import React from 'react';
import { Link } from 'react-router-dom';

// Shared between CreateCase (police) and EmergencyReport (family) —
// both run the same POST /cases/check-duplicates pre-flight check
// before actually creating a case, so this renders the result
// identically in both places rather than two copies that can drift
// (the same reasoning DocumentsPanel/PhotosPanel/AdditionalInfoPanel
// were split out for).
//
// This is a heads-up, never a hard stop: the person filing always
// gets a clear "continue anyway" path, because a false positive here
// (two different people who happen to share a name and area) must
// never be able to block a genuine report.
export default function DuplicateWarning({ matches, onContinue, onCancel, busy }) {
  return (
    <div className="card" style={{ borderColor: 'var(--accent)', marginBottom: 16 }}>
      <h3 style={{ marginTop: 0 }}>⚠️ This might already be reported</h3>
      <p className="muted">
        {matches.length === 1
          ? 'We found an existing case that looks similar:'
          : `We found ${matches.length} existing cases that look similar:`}
      </p>
      {matches.map((m) => (
        <div key={m.caseId} className="card" style={{ background: 'var(--surface-raised)', marginBottom: 8 }}>
          <strong>{m.fullName}</strong>{m.age != null ? `, ${m.age} yrs` : ''}
          {' — '}<span className="muted">{m.status.replace(/_/g, ' ')}</span>
          {m.lastSeenAddress && <div className="muted" style={{ fontSize: 12.5 }}>Last seen: {m.lastSeenAddress}</div>}
          <div className="muted" style={{ fontSize: 12 }}>{m.reasons.join(' · ')}</div>
          <Link to={`/cases/${m.caseId}`} target="_blank" rel="noopener noreferrer" style={{ fontSize: 12.5 }}>View this case →</Link>
        </div>
      ))}
      <p className="muted" style={{ fontSize: 12.5 }}>
        If one of these is the same person, please view it instead — a duplicate report splits
        information across two cases and slows the investigation down. If you're sure this is a
        different case, you can continue.
      </p>
      <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
        <button type="button" className="btn btn-outline" onClick={onCancel} disabled={busy}>Go back</button>
        <button type="button" className="btn btn-primary" onClick={onContinue} disabled={busy}>
          {busy ? 'Submitting…' : "This is a different case — continue"}
        </button>
      </div>
    </div>
  );
}
