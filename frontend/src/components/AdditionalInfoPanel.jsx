import React, { useState } from 'react';
import api from '../api/client';

export default function AdditionalInfoPanel({ caseId, additionalInfo, onChanged, canAdd = true }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e) => {
    e.preventDefault();
    if (!text.trim()) return;
    setBusy(true);
    setError('');
    try {
      await api.post(`/cases/${caseId}/additional-info`, { text: text.trim() });
      setText('');
      onChanged();
    } catch (err) {
      setError(err.response?.data?.message || 'Could not add that.');
    } finally {
      setBusy(false);
    }
  };

  const entries = (additionalInfo || []).slice().reverse();
  return (
    <div>
      {canAdd && (
        <form onSubmit={submit} className="card" style={{ marginBottom: 16 }}>
          <label style={{ fontSize: 12 }}>Add something worth knowing — a habit, a mark, a place they might go</label>
          <textarea rows={3} value={text} onChange={(e) => setText(e.target.value)} style={{ width: '100%', marginBottom: 8 }} />
          <button className="btn btn-primary" disabled={busy}>{busy ? 'Adding…' : 'Add'}</button>
          {error && <p className="error-text">{error}</p>}
        </form>
      )}
      {entries.length === 0 ? (
        <p className="muted">Nothing added yet.</p>
      ) : (
        <div className="grid" style={{ gap: 8 }}>
          {entries.map((e, i) => (
            <div className="card" key={i}>
              <p style={{ margin: '0 0 4px', fontSize: 13.5 }}>{e.text}</p>
              <p className="muted" style={{ margin: 0, fontSize: 11.5 }}>{new Date(e.addedAt).toLocaleString()}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
