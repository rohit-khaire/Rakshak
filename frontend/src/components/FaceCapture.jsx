import React, { useEffect, useRef, useState } from 'react';
import { preloadFaceApi, detectFaceDescriptor } from '../utils/faceApi.js';

// Walks through one or more capture prompts (e.g. "Look straight
// ahead", then "Turn slightly left") using the live camera, running
// real face detection on each shot before accepting it. Calls
// onComplete with one { descriptor, imageDataUrl } per prompt, in
// order, once every prompt has a good capture.
//
// Used for BOTH enrollment (3 prompts) and step-up verification
// (1 prompt) — same component, same real detection either way.
export default function FaceCapture({ prompts, onComplete, onCancel }) {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const streamRef = useRef(null);
  const [ready, setReady] = useState(false);
  const [cameraError, setCameraError] = useState('');
  const [busy, setBusy] = useState(false);
  const [captureError, setCaptureError] = useState('');
  const [results, setResults] = useState([]);

  useEffect(() => {
    preloadFaceApi();
    let cancelled = false;
    navigator.mediaDevices?.getUserMedia({ video: { facingMode: 'user' } })
      .then((stream) => {
        if (cancelled) { stream.getTracks().forEach((t) => t.stop()); return; }
        streamRef.current = stream;
        if (videoRef.current) videoRef.current.srcObject = stream;
        setReady(true);
      })
      .catch(() => setCameraError('Could not access your camera — check your browser\u2019s permission for this site and try again.'));

    return () => {
      cancelled = true;
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  const capture = async () => {
    setBusy(true);
    setCaptureError('');
    try {
      const video = videoRef.current;
      const canvas = canvasRef.current;
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      canvas.getContext('2d').drawImage(video, 0, 0);

      const detection = await detectFaceDescriptor(canvas);
      if (!detection.ok) {
        setCaptureError(detection.reason);
        return;
      }

      const imageDataUrl = canvas.toDataURL('image/jpeg', 0.85);
      const next = [...results, { descriptor: detection.descriptor, imageDataUrl }];
      setResults(next);

      if (next.length >= prompts.length) {
        streamRef.current?.getTracks().forEach((t) => t.stop());
        onComplete(next);
      }
    } catch {
      setCaptureError('Something went wrong reading the camera frame — try again.');
    } finally {
      setBusy(false);
    }
  };

  const currentPrompt = prompts[results.length];

  return (
    <div style={{ padding: 20, background: 'var(--surface-raised)', borderRadius: 12, textAlign: 'center' }}>
      {cameraError ? (
        <>
          <p className="error-text">{cameraError}</p>
          <button className="btn btn-outline" onClick={onCancel}>Cancel</button>
        </>
      ) : (
        <>
          {prompts.length > 1 && (
            <div style={{ display: 'flex', justifyContent: 'center', gap: 6, marginBottom: 10 }}>
              {prompts.map((_, i) => (
                <span key={i} style={{
                  width: 8, height: 8, borderRadius: '50%',
                  background: i < results.length ? 'var(--success)' : i === results.length ? 'var(--accent)' : 'var(--border)',
                  transition: 'background 0.2s ease',
                }} />
              ))}
            </div>
          )}
          <p style={{ fontWeight: 600, margin: '0 0 4px' }}>{currentPrompt}</p>
          <p className="muted" style={{ fontSize: 12, marginTop: 0, marginBottom: 12 }}>
            {prompts.length > 1 ? `Shot ${results.length + 1} of ${prompts.length}` : 'A fresh live capture is required — a saved photo won\u2019t pass detection.'}
          </p>
          <div style={{
            position: 'relative', width: 260, maxWidth: '100%', margin: '0 auto',
            borderRadius: '50% / 40%', overflow: 'hidden', border: '3px solid var(--success)',
          }}>
            <video ref={videoRef} autoPlay playsInline muted style={{ width: '100%', display: 'block', transform: 'scaleX(-1)', background: '#000' }} />
          </div>
          <canvas ref={canvasRef} style={{ display: 'none' }} />
          {captureError && <p className="error-text" style={{ marginTop: 10, fontSize: 13 }}>{captureError}</p>}
          <div style={{ display: 'flex', gap: 8, justifyContent: 'center', marginTop: 16 }}>
            <button className="btn btn-outline" onClick={onCancel} disabled={busy}>Cancel</button>
            <button className="btn btn-primary" onClick={capture} disabled={!ready || busy}>
              {busy ? 'Checking…' : !ready ? 'Starting camera…' : 'Capture'}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
