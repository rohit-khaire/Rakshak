import React, { useRef, useState } from 'react';
import { preloadFaceApi, detectLivenessFrameLight, detectFaceDescriptor } from '../utils/faceApi.js';
import { nextHeadTurnState, YAW_TRIGGER_RATIO, YAW_RECOVER_RATIO } from '../utils/livenessState.js';
import { useNonOverlappingPoll, snapshotVideoFrame } from '../hooks/useNonOverlappingPoll.js';

// Mirrors FaceLivenessCapture.jsx closely — same camera/polling/
// snapshot/finalize mechanics (see that file and useNonOverlappingPoll
// for the reasoning), swapping blink-EAR tracking for yaw tracking.
// Offered as an alternative on the same verification screen for
// anyone who finds blink detection unreliable for their camera/face/
// lighting — see FaceVerifyGate.jsx for the method picker. Unlike the
// blink thresholds (tuned across real usage over several rounds — see
// backend/utils/liveness.js), the yaw thresholds here are a first
// pass with no real-camera data behind them; worth tuning once
// there's real usage to check them against (see livenessState.js).

const POLL_MS = 100;
const TIMEOUT_MS = 10000;

const STAGE_COPY = {
  watching: 'Look straight at the camera, then turn your head to either side and back',
  detected: 'Turn detected — confirming…',
  finalizing: 'Confirming…',
  done: 'Captured!',
  timeout: 'Didn\u2019t catch a clear head turn in time',
};

const freshTracking = () => ({ tracking: { stage: 'watching', baseline: null }, baselineFrame: null, triggerFrame: null });

export default function HeadTurnLivenessCapture({ onComplete, onCancel }) {
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
        setFinalizeError('Something interrupted the capture — please try again.');
        setStage('timeout');
        return;
      }
      frames.push({ jawOutline: k.reading.jawOutline, nose: k.reading.nose, descriptor: result.descriptor });
    }
    setStage('done');
    onComplete(frames);
  };

  const onFrame = (frame, video) => {
    const prevTrackingStage = trackRef.current.tracking.stage;
    const next = nextHeadTurnState(trackRef.current.tracking, frame.yawRatio);
    trackRef.current.tracking = next;

    if (next.stage === 'watching') {
      setProgress(0);
      // A centered baseline is only really established once it's
      // non-null — before that, snapshotting would just be saving an
      // off-center opening frame, which is a weaker frame to submit
      // for identity matching than waiting one more tick for a
      // properly centered one.
      if (next.event === 'new_baseline' && next.baseline !== null) {
        trackRef.current.baselineFrame = { canvas: snapshotVideoFrame(video), reading: frame };
      }
      return;
    }

    if (next.stage === 'detected') {
      // During confirming, progress must represent "how close to
      // recovered" — filling as the reading approaches the recovery
      // threshold, not as it moves further from center. Using the
      // same "distance from baseline" framing as the watching phase
      // here was backwards: it grew while still turned away and
      // shrank while correctly returning to center, meaning the bar
      // visually rewarded staying turned — the one thing the
      // confirming phase is waiting for the person to stop doing.
      // Scaled so 0 = right at the original trigger distance (still
      // fully turned), 1 = right at the recovery threshold.
      const dev = Math.abs(frame.yawRatio - next.baseline);
      const range = YAW_TRIGGER_RATIO - YAW_RECOVER_RATIO;
      setProgress(Math.max(0, Math.min(1, 1 - (dev - YAW_RECOVER_RATIO) / range)));
      if (prevTrackingStage !== 'detected') {
        trackRef.current.triggerFrame = { canvas: snapshotVideoFrame(video), reading: frame };
        setStage('detected');
        // Same reasoning as FaceLivenessCapture.jsx: confirming (the
        // turn back to center) gets its own fresh window instead of
        // eating into whatever was left of the original 10s.
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
            A live head turn is required — a saved photo can't do this.
          </p>

          {stage === 'timeout' && (
            <div style={{ marginTop: 12 }}>
              <p className="error-text" style={{ fontSize: 13 }}>
                {finalizeError || (
                  // trackRef.current.tracking.stage is frozen at
                  // whatever it was the moment the timeout fired —
                  // polling stops as soon as `stage` leaves 'watching'/
                  // 'detected', so nothing can change it after this.
                  // Without this check, someone who genuinely turned
                  // (saw "Turn detected — confirming…" onscreen) but
                  // then didn't turn back to center in time saw "No
                  // clear head turn detected" — flatly contradicting
                  // what they'd just watched happen a moment earlier.
                  trackRef.current.tracking.stage === 'detected'
                    ? 'We saw the turn, but didn\u2019t see you return to center in time. Turn back further, or hold the centered position a moment longer.'
                    : 'No clear head turn detected. Make sure your face is well lit and centered to start.'
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
