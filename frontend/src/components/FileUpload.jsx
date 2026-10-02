import React, { useState } from 'react';
import api from '../api/client';

/**
 * Uploads selected files immediately on change and reports back the
 * resulting public URL(s) via onUploaded. Keeps the parent form simple —
 * it just receives ready-to-use URLs, same shape as if the user had
 * pasted a link in a text field.
 */
export default function FileUpload({ label = 'Attach file(s)', multiple = false, onUploaded }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [uploadedNames, setUploadedNames] = useState([]);

  const handleChange = async (e) => {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;
    setError(''); setBusy(true);
    try {
      const formData = new FormData();
      files.forEach((f) => formData.append('files', f));
      const { data } = await api.post('/uploads', formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      setUploadedNames(data.files.map((f) => f.originalName));
      onUploaded(multiple ? data.files.map((f) => f.url) : data.files[0].url);
    } catch (err) {
      setError(err.response?.data?.message || 'Upload failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <label>{label}</label>
      <input type="file" multiple={multiple} accept="image/*,application/pdf" onChange={handleChange} disabled={busy} />
      {busy && <p className="muted">Uploading…</p>}
      {error && <p className="error-text">{error}</p>}
      {uploadedNames.length > 0 && !busy && (
        <p className="muted" style={{ color: 'var(--success)' }}>Uploaded: {uploadedNames.join(', ')}</p>
      )}
    </div>
  );
}
