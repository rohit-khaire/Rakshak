import React, { useRef, useState } from 'react';
import { detectLivenessFrameLight, detectFaceDescriptor } from '../utils/faceApi.js';
import { useNonOverlappingPoll, snapshotVideoFrame } from '../hooks/useNonOverlappingPoll.js';

const POLL_MS = 150; // just live "we see a face" feedback, not time-sensitive — no need for 100ms here

// Deliberately the simplest possible capture: live camera preview,
// a running "face detected" indicator, and a manual Capture button —
// no automatic trigger, no gesture, no multi-stage timing state
// machine at all. That's the whole point of this component existing
// alongside FaceLivenessCapture/HeadTurnLivenessCapture: those failed
// specifically because of timing-sensitive logic (a fast human gesture
// against a polling loop on unpredictable hardware — see the README's
// v16-v16.2 history). Putting the capture MOMENT in the person's own
// hands removes that whole class of failure outright, at the cost of
// the liveness guarantee those components were trying to provide — a
// deliberate, documented trade-off (see FaceVerifyGate.jsx and the
// README), not an oversight.
export default function PhotoMatchCapture({ onComplete, onCancel }) {
  const [faceDetected, setFaceDetected] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [error, setError] = useState('');

  const onFrame = (frame) => {
    setFaceDetected(!!frame);
  };

  const poll = useNonOverlappingPoll({
    detect: async (video) => {
      const frame = await detectLivenessFrameLight(video);
      return frame || null;
    },
    onFrame,
    active: !capturing,
    pollMs: POLL_MS,
    timeoutMs: 60000, // generous — nothing here is racing a fast gesture, no reason to rush someone lining up their camera
    onTimeout: () => {}, // no forced timeout state for this one — waiting is free when there's no gesture to catch in time
  });

  const capture = async () => {
    if (!poll.videoRef.current) return;
    setCapturing(true);
    setError('');
    try {
      const canvas = snapshotVideoFrame(poll.videoRef.current);
      const result = await detectFaceDescriptor(canvas);
      if (!result.ok) {
        setError('Could not get a clear reading of your face — make sure you\u2019re centered and well lit, then try again.');
        setCapturing(false);
        return;
      }
      poll.stop();
      onComplete(result.descriptor);
    } catch (err) {
      setError('Something went wrong capturing that — please try again.');
      setCapturing(false);
    }
  };

  return (
    <div style={{ padding: 20, background: 'var(--surface-raised)', borderRadius: 12, textAlign: 'center' }}>
      {poll.cameraError ? (
        <>
          <p className="error-text">{poll.cameraError}</p>
          <button className="btn btn-outline" onClick={onCancel}>Cancel</button>
        </>
      ) : (
        <>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, marginBottom: 10 }}>
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: faceDetected ? 'var(--success)' : 'var(--border)', display: 'inline-block' }} />
            <p style={{ fontWeight: 600, margin: 0 }}>{faceDetected ? 'Face detected — ready to capture' : 'Center your face in the frame'}</p>
          </div>

          <div style={{
            position: 'relative', width: 260, maxWidth: '100%', margin: '0 auto',
            borderRadius: '50% / 40%', overflow: 'hidden', border: `3px solid ${faceDetected ? 'var(--success)' : 'var(--border)'}`,
            transition: 'border-color 0.2s ease',
          }}>
            <video ref={poll.videoRef} autoPlay playsInline muted style={{ width: '100%', display: 'block', transform: 'scaleX(-1)', background: '#000' }} />
          </div>

          <p className="muted" style={{ fontSize: 11.5, marginTop: 10 }}>
            This is matched against your enrolled face. It does not check for a live gesture — a
            still, well-lit, direct shot works best.
          </p>

          {error && <p className="error-text" style={{ fontSize: 13 }}>{error}</p>}

          <div style={{ marginTop: 14, display: 'flex', gap: 8, justifyContent: 'center' }}>
            <button className="btn btn-outline" onClick={onCancel} disabled={capturing}>Cancel</button>
            <button className="btn btn-primary" onClick={capture} disabled={!faceDetected || capturing}>
              {capturing ? 'Checking…' : 'Capture'}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
