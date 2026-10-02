import React, { useEffect, useState } from 'react';
import { analyzePhotoQuality } from '../utils/photoQuality.js';

// Shared between CreateCase (police) and EmergencyReport (family) —
// both attach the case's one identification photo through the same
// FileUpload, so this runs identically in both places rather than
// two copies that can drift (same reasoning DuplicateWarning,
// DocumentsPanel/PhotosPanel/AdditionalInfoPanel were split out for).
//
// Purely a nudge: nothing here ever removes the photo or blocks
// submission. A blurry or dark photo of the actual missing person is
// still far more useful than no photo at all, and a family in the
// middle of an emergency report won't always have a better one on
// hand — this only ever suggests a clearer one when one might be
// easy to get, never requires it.
export default function PhotoQualityCheck({ photoUrl }) {
  const [state, setState] = useState('idle'); // idle | checking | done | failed
  const [warnings, setWarnings] = useState([]);

  useEffect(() => {
    if (!photoUrl) { setState('idle'); setWarnings([]); return undefined; }
    let cancelled = false;
    setState('checking');
    analyzePhotoQuality(photoUrl)
      .then((result) => {
        if (cancelled) return;
        setWarnings(result.warnings);
        setState('done');
      })
      .catch(() => {
        // The check itself failing (model load blocked, a CORS
        // hiccup, whatever) is not a statement about the photo —
        // skip the nudge silently rather than show a false warning.
        if (!cancelled) setState('failed');
      });
    return () => { cancelled = true; };
  }, [photoUrl]);

  if (!photoUrl || state === 'idle' || state === 'failed') return null;

  if (state === 'checking') {
    return <p className="muted" style={{ fontSize: 12.5 }}>Checking photo…</p>;
  }

  if (warnings.length === 0) {
    return <p className="muted" style={{ fontSize: 12.5, color: 'var(--success)' }}>✓ Photo looks clear</p>;
  }

  return (
    <div className="card" style={{ background: 'var(--surface-raised)', padding: 10, marginTop: 4 }}>
      {warnings.map((w) => (
        <p key={w.code} className="muted" style={{ fontSize: 12.5, margin: '2px 0' }}>⚠️ {w.message}</p>
      ))}
      <p className="muted" style={{ fontSize: 11.5, marginTop: 4 }}>
        A clearer photo helps sightings get matched faster — but this one is fine to submit as is.
      </p>
    </div>
  );
}
