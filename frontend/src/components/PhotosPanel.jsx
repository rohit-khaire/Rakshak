import React, { useState } from 'react';
import api from '../api/client';
import FileUpload from './FileUpload.jsx';

export default function PhotosPanel({ caseId, photoUrl, photos, onChanged, canAdd = true }) {
  const [caption, setCaption] = useState('');
  const [error, setError] = useState('');

  const attach = async (url) => {
    setError('');
    try {
      await api.post(`/cases/${caseId}/photos`, { url, caption: caption.trim() || undefined });
      setCaption('');
      onChanged();
    } catch (err) {
      setError(err.response?.data?.message || 'Could not attach that photo.');
    }
  };

  const allPhotos = [
    ...(photoUrl ? [{ url: photoUrl, primary: true }] : []),
    ...(photos || []),
  ];

  return (
    <div>
      {allPhotos.length === 0 ? (
        <p className="muted">No photos yet.</p>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))', gap: 10, marginBottom: canAdd ? 16 : 0 }}>
          {allPhotos.map((p, i) => (
            <div key={i}>
              <img src={p.url} alt="" style={{ width: '100%', aspectRatio: '1', objectFit: 'cover', borderRadius: 8 }} />
              {p.primary && <p className="muted" style={{ fontSize: 10.5, margin: '2px 0 0' }}>Primary photo</p>}
            </div>
          ))}
        </div>
      )}
      {canAdd && (
        <div className="card">
          <label style={{ fontSize: 12 }}>Caption (optional)</label>
          <input value={caption} onChange={(e) => setCaption(e.target.value)} style={{ marginBottom: 8 }} />
          <FileUpload label="Add a photo" onUploaded={attach} />
          {error && <p className="error-text">{error}</p>}
        </div>
      )}
    </div>
  );
}
