import React, { useState } from 'react';
import api from '../api/client';
import FileUpload from './FileUpload.jsx';

// Shared between MyMissingPerson (Family) and CaseDetail (officials) —
// documents a family adds (ID proof, dental records, etc.) need to be
// visible to whoever's actually investigating, not just to the family
// who uploaded them.
export default function DocumentsPanel({ caseId, documents, onChanged, canAdd = true }) {
  const [docName, setDocName] = useState('');
  const [error, setError] = useState('');

  const attach = async (url) => {
    if (!docName.trim()) { setError('Give the document a name first, then attach the file.'); return; }
    setError('');
    try {
      await api.post(`/cases/${caseId}/documents`, { url, name: docName.trim() });
      setDocName('');
      onChanged();
    } catch (err) {
      setError(err.response?.data?.message || 'Could not attach that document.');
    }
  };

  return (
    <div>
      {(documents || []).length === 0 ? (
        <p className="muted">No documents yet.</p>
      ) : (
        <div className="grid" style={{ gap: 8, marginBottom: canAdd ? 16 : 0 }}>
          {documents.map((d, i) => (
            <a key={i} href={d.url} target="_blank" rel="noreferrer" className="card" style={{ display: 'block', fontSize: 13.5, textDecoration: 'none', color: 'inherit' }}>
              📄 {d.name}
              <span className="muted" style={{ fontSize: 11.5, display: 'block' }}>{new Date(d.uploadedAt).toLocaleString()}</span>
            </a>
          ))}
        </div>
      )}
      {canAdd && (
        <div className="card">
          <label style={{ fontSize: 12 }}>Document name</label>
          <input value={docName} onChange={(e) => setDocName(e.target.value)} placeholder="e.g. Aadhaar copy, dental records…" style={{ marginBottom: 8 }} />
          <FileUpload label="Attach file" onUploaded={attach} />
          {error && <p className="error-text">{error}</p>}
        </div>
      )}
    </div>
  );
}
