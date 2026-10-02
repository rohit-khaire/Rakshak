import React, { useState } from 'react';

/**
 * Runs OCR entirely in the browser (Tesseract.js, WASM) on an uploaded
 * FIR photo/scan, then extracts fields from the recognized text.
 *
 * Two things matter a lot for OCR accuracy, and both are handled here:
 *  1. Image preprocessing (grayscale + contrast + upscale) before
 *     handing it to Tesseract — this alone fixes the majority of
 *     real-world "photo of a document" accuracy problems (uneven
 *     lighting, low contrast, small text).
 *  2. Line-based label matching instead of one big regex — this is
 *     far more forgiving of OCR noise, because a garbled word on one
 *     line doesn't break extraction on every other line.
 *
 * What preprocessing CANNOT fix: decorative/stylized fonts, or an
 * image where the text itself was never rendered as plain readable
 * characters (e.g. a graphic/illustration rather than typed text). No
 * OCR engine — free or paid — reads those reliably. If you test with a
 * stylized "designed" document and get poor results, that's the input,
 * not the pipeline; try a plain typed or clearly scanned document.
 */

const LABEL_ALIASES = {
  fullName: ['name of the missing person', 'name of missing person', 'victim name', 'complainant name', 'name'],
  age: ['age'],
  firNumber: ['fir no', 'fir number', 'f.i.r no', 'f.i.r. no', 'fir'],
  address: ['last seen location', 'last seen address', 'last known address', 'address'],
  contact: ['contact number', 'contact no', 'mobile no', 'mobile', 'phone', 'contact'],
};

// Draws the image onto a canvas at 2x scale, converts to grayscale,
// and applies a simple contrast boost — a lightweight version of the
// preprocessing real OCR pipelines do before recognition.
const preprocessImage = (file) => new Promise((resolve, reject) => {
  const img = new Image();
  const reader = new FileReader();
  reader.onload = () => { img.src = reader.result; };
  reader.onerror = reject;

  img.onload = () => {
    const scale = 2;
    const canvas = document.createElement('canvas');
    canvas.width = img.width * scale;
    canvas.height = img.height * scale;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const data = imageData.data;
    const contrast = 40; // -255..255
    const factor = (259 * (contrast + 255)) / (255 * (259 - contrast));

    for (let i = 0; i < data.length; i += 4) {
      const gray = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      const adjusted = factor * (gray - 128) + 128;
      const clamped = Math.max(0, Math.min(255, adjusted));
      data[i] = data[i + 1] = data[i + 2] = clamped;
    }
    ctx.putImageData(imageData, 0, 0);
    canvas.toBlob((blob) => resolve(blob), 'image/png');
  };
  img.onerror = reject;
  reader.readAsDataURL(file);
});

const extractFields = (text) => {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const result = {};

  for (const line of lines) {
    const lower = line.toLowerCase();
    for (const [field, aliases] of Object.entries(LABEL_ALIASES)) {
      if (result[field]) continue;
      for (const alias of aliases) {
        const idx = lower.indexOf(alias);
        if (idx === -1) continue;
        const rest = line.slice(idx + alias.length).replace(/^[\s:>\-–.]+/, '').trim();
        if (rest.length > 0 && rest.length < 150) {
          result[field] = rest;
        }
        break;
      }
    }
  }
  return result;
};

export default function OcrFirUpload({ onExtract }) {
  const [status, setStatus] = useState('idle'); // idle | preprocessing | processing | done | error
  const [progress, setProgress] = useState(0);
  const [rawText, setRawText] = useState('');
  const [extracted, setExtracted] = useState(null);
  const [error, setError] = useState('');

  const handleFile = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setStatus('preprocessing');
    setProgress(0);
    setError('');
    setRawText('');
    setExtracted(null);

    try {
      const processedBlob = await preprocessImage(file);
      setStatus('processing');

      const Tesseract = await import('tesseract.js');
      const { data } = await Tesseract.recognize(processedBlob, 'eng', {
        logger: (m) => {
          if (m.status === 'recognizing text') setProgress(Math.round(m.progress * 100));
        },
      });

      setRawText(data.text);
      const fields = extractFields(data.text);
      setExtracted(fields);
      setStatus('done');

      if (Object.keys(fields).length > 0) {
        onExtract(fields);
      }
    } catch (err) {
      console.error(err);
      setError('OCR failed to process this image — try a clearer photo or scan, or enter details manually.');
      setStatus('error');
    }
  };

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <h4 style={{ marginTop: 0 }}>Scan FIR document (optional)</h4>
      <p className="muted" style={{ marginTop: 0 }}>
        Upload a photo or scan of the FIR. Works best on plain typed or clearly scanned text — not on
        stylized/decorative documents. We'll try to auto-fill the fields below; please double-check
        everything before submitting.
      </p>
      <input type="file" accept="image/*" onChange={handleFile} disabled={status === 'preprocessing' || status === 'processing'} />

      {status === 'preprocessing' && <p className="muted" style={{ marginTop: 8 }}>Preparing image…</p>}
      {status === 'processing' && <p className="muted" style={{ marginTop: 8 }}>Reading document… {progress}%</p>}
      {error && <p className="error-text">{error}</p>}

      {status === 'done' && (
        <div style={{ marginTop: 10 }}>
          {extracted && Object.keys(extracted).length > 0 ? (
            <>
              <p style={{ color: 'var(--success)', margin: '0 0 6px' }}>
                Auto-filled {Object.keys(extracted).length} field{Object.keys(extracted).length > 1 ? 's' : ''} below — review before submitting.
              </p>
              <ul className="muted" style={{ margin: 0, paddingLeft: 18, fontSize: 13 }}>
                {Object.entries(extracted).map(([k, v]) => <li key={k}>{k}: {v}</li>)}
              </ul>
            </>
          ) : (
            <p className="muted">
              Couldn't confidently extract structured fields from this scan. This usually means the
              image is low-contrast, blurry, or uses a decorative font — please fill the form manually.
            </p>
          )}
          <details style={{ marginTop: 8 }}>
            <summary className="muted" style={{ cursor: 'pointer', fontSize: 12 }}>View raw OCR text</summary>
            <pre style={{ fontSize: 11, whiteSpace: 'pre-wrap', color: 'var(--text-muted)', marginTop: 6 }}>{rawText}</pre>
          </details>
        </div>
      )}
    </div>
  );
}
