import React, { useRef, useState } from 'react';
import { preloadFaceApi, detectLivenessFrameLight, detectFaceDescriptor } from '../utils/faceApi.js';
import { nextBlinkState } from '../utils/livenessState.js';
import { useNonOverlappingPoll, snapshotVideoFrame } from '../hooks/useNonOverlappingPoll.js';

const POLL_MS = 100;
const TIMEOUT_MS = 10000;

const STAGE_COPY = {
  watching: 'Look at the camera, then blink naturally',
  detected: 'Blink detected — confirming…',
  finalizing: 'Confirming…',
  done: 'Captured!',
  timeout: 'Didn\u2019t catch a clear blink in time',
};

const freshTracking = () => ({ tracking: { stage: 'watching', baseline: 0 }, baselineFrame: null, triggerFrame: null });

export default function FaceLivenessCapture({ onComplete, onCancel }) {
  const [stage, setStage] = useState('watching');
  const [progress, setProgress] = useState(0);
  const [finalizeError, setFinalizeError] = useState('');
  const trackRef = useRef(freshTracking());

  const finalize = async (finalCanvas, finalReading, poll) => {
    poll.stop();
    setStage('finalizing');
    setFinalizeError('');

    const kept = [trackRef.current.baselineFrame, trackRef.current.triggerFrame, { canvas: finalCanvas, reading: finalReading }];
    const frames = [];
    for (const k of kept) {
      // eslint-disable-next-line no-await-in-loop
      const result = await detectFaceDescriptor(k.canvas);
      if (!result.ok) {
        // Extremely rare — a face was tracked continuously through the
        // whole live loop, so a saved snapshot from that same window
        // failing to redetect it is almost always a one-off camera
        // hiccup, not a real problem. Let them retry rather than
        // surfacing face-api's raw reason, which wouldn't mean much
        // in this context.
        setFinalizeError('Something interrupted the capture — please try again.');
        setStage('timeout');
        return;
      }
      frames.push({ leftEye: k.reading.leftEye, rightEye: k.reading.rightEye, descriptor: result.descriptor });
    }
    setStage('done');
    onComplete(frames);
  };

  const onFrame = (frame, video) => {
    const prevTrackingStage = trackRef.current.tracking.stage;
    const next = nextBlinkState(trackRef.current.tracking, frame.ear);
    trackRef.current.tracking = next;

    if (next.stage === 'watching') {
      setProgress(next.baseline > 0 ? frame.ear / next.baseline : 0);
      if (next.event === 'new_baseline') {
        trackRef.current.baselineFrame = { canvas: snapshotVideoFrame(video), reading: frame };
      }
      return;
    }

    if (next.stage === 'detected') {
      setProgress(next.baseline > 0 ? frame.ear / next.baseline : 0);
      if (prevTrackingStage !== 'detected') {
        trackRef.current.triggerFrame = { canvas: snapshotVideoFrame(video), reading: frame };
        setStage('detected');
        // Confirming (waiting for eyes to reopen) gets its own fresh
        // window rather than eating into whatever was left of the
        // original 10s — someone who took a while just to settle in
        // and start blinking shouldn't have less time to finish than
        // someone who blinked immediately.
        poll.resetTimeout();
      }
      if (next.event === 'recovered') {
        finalize(snapshotVideoFrame(video), frame, poll);
      }
    }
  };

  const restart = () => {
    trackRef.current = freshTracking();
    setStage('watching');
    setProgress(0);
    setFinalizeError('');
    poll.resetTimeout();
  };

  const poll = useNonOverlappingPoll({
    detect: detectLivenessFrameLight,
    onFrame,
    active: stage === 'watching' || stage === 'detected',
    pollMs: POLL_MS,
    timeoutMs: TIMEOUT_MS,
    onTimeout: () => setStage((s) => (s === 'done' ? s : 'timeout')),
  });

  React.useEffect(() => { preloadFaceApi(); }, []);

  const ringColor = stage === 'detected' ? 'var(--accent)' : stage === 'watching' ? 'var(--success)' : 'var(--border)';

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
            {stage === 'watching' && <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--success)', display: 'inline-block', animation: 'pulse 1.4s ease-in-out infinite' }} />}
            {stage === 'detected' && <span style={{ fontSize: 15 }}>✨</span>}
            {stage === 'done' && <span style={{ fontSize: 15 }}>✅</span>}
            <p style={{ fontWeight: 600, margin: 0 }}>{STAGE_COPY[stage]}</p>
          </div>

          <div style={{
            position: 'relative', width: 260, maxWidth: '100%', margin: '0 auto',
            borderRadius: '50% / 40%', overflow: 'hidden', border: `3px solid ${ringColor}`,
            transition: 'border-color 0.25s ease', boxShadow: stage === 'detected' ? '0 0 0 6px rgba(255,193,7,0.15)' : 'none',
          }}>
            <video ref={poll.videoRef} autoPlay playsInline muted style={{ width: '100%', display: 'block', transform: 'scaleX(-1)', background: '#000' }} />
          </div>

          <div style={{ width: 200, height: 4, background: 'var(--border)', borderRadius: 2, margin: '14px auto 4px', overflow: 'hidden' }}>
            <div style={{
              height: '100%', width: `${Math.max(4, Math.min(100, progress * 100))}%`,
              background: stage === 'detected' ? 'var(--accent)' : 'var(--success)',
              transition: 'width 0.1s linear, background 0.2s ease',
            }} />
          </div>
          <p className="muted" style={{ fontSize: 11.5, marginTop: 2 }}>
            A live blink is required — a saved photo can't do this.
          </p>

          {stage === 'timeout' && (
            <div style={{ marginTop: 12 }}>
              <p className="error-text" style={{ fontSize: 13 }}>
                {finalizeError || (
                  // Same reasoning as HeadTurnLivenessCapture.jsx: without
                  // this, someone who genuinely blinked (saw "Blink
                  // detected — confirming…" onscreen) but then didn't
                  // reopen their eyes enough to register as recovered in
                  // time saw "No clear blink detected" — contradicting
                  // what had just happened on the same screen.
                  trackRef.current.tracking.stage === 'detected'
                    ? 'We saw the blink, but didn\u2019t see your eyes reopen in time. Open your eyes fully and hold still a moment.'
                    : 'No clear blink detected. Make sure your face is well lit and centered.'
                )}
              </p>
              <button className="btn btn-primary" onClick={restart}>Try again</button>
            </div>
          )}
          <div style={{ marginTop: 14 }}>
            <button className="btn btn-outline" onClick={onCancel} disabled={!poll.ready}>Cancel</button>
          </div>
        </>
      )}
      <style>{`@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }`}</style>
    </div>
  );
}
