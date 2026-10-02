import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../api/client';
import PhotoMatchCapture from './PhotoMatchCapture.jsx';
import FaceLivenessCapture from './FaceLivenessCapture.jsx';
import HeadTurnLivenessCapture from './HeadTurnLivenessCapture.jsx';

// Shown right after tapping Submit on attachFir / verify-a-sighting,
// BEFORE the actual request goes out. Gets a fresh nonce, captures a
// face check, sends it to the server for identity checking (and, for
// blink/head-turn, independent liveness checking too), and only then
// calls onVerified(nonce) — the parent includes that nonce in the
// real request, which the backend independently checks again. This
// modal failing to appear, or being skipped somehow, doesn't matter:
// the server rejects the action without a valid nonce regardless.
//
// blink is the default — reverted back from head_turn (see the
// README's v17.4 entry for the full back-and-forth). The theoretical
// case for head_turn was real: blink is the fastest human gesture
// there is (100-400ms), right at the edge of what a browser polling
// loop can reliably sample, while a slower gesture is inherently more
// forgiving of that variance. But a real terminal log showed blink
// actually completing and registering real cases repeatedly on this
// exact hardware, once the hot detection loop was also sped up
// (detectLivenessFrameLight's inputSize — see faceApi.js). Real
// evidence of what actually works outweighs a reasonable theory about
// what should. head_turn stays fully available, still fixed, still a
// genuine option — just not the first thing shown anymore.
// photo_match — no gesture at all, single frame, weakest guarantee —
// stays the explicit fallback for whoever's camera still struggles
// with live detection either way: the security note below states its
// trade-off plainly every time it's selected, and every method's
// actual guarantee is named here honestly rather than implied to be
// equal.
// head_turn's theoretical edge over blink (a slower gesture is more
// forgiving of exactly the sampling-rate variance that caused all the
// earlier trouble — see the README's v17.1 entry) is real, but it's a
// theory. A real terminal log showing blink actually completing and
// registering cases repeatedly, on this exact hardware, once properly
// speed-tuned (see detectLivenessFrameLight's inputSize change), is
// evidence — and evidence outweighs theory. Default reverted to blink
// on that basis, not on a whim.
export default function FaceVerifyGate({ onVerified, onCancel }) {
  const [nonce, setNonce] = useState(null);
  const [notEnrolled, setNotEnrolled] = useState(false);
  const [error, setError] = useState('');
  const [locked, setLocked] = useState(false);
  const [checking, setChecking] = useState(false);
  const [captureKey, setCaptureKey] = useState(0); // bump to remount the capture component for a retry
  const [method, setMethod] = useState('blink');

  useEffect(() => {
    api.post('/face/challenge')
      .then(({ data }) => setNonce(data.nonce))
      .catch((err) => {
        if (err.response?.status === 400) setNotEnrolled(true);
        else setError('Could not start face verification — check your connection and try again.');
      });
  }, []);

  const handleCapture = async (framesOrDescriptor) => {
    setChecking(true);
    setError('');
    try {
      const payload = method === 'photo_match'
        ? { nonce, method, descriptor: framesOrDescriptor }
        : { nonce, method, frames: framesOrDescriptor };
      const { data } = await api.post('/face/verify', payload);
      onVerified(data.nonce);
    } catch (err) {
      if (err.response?.data?.locked) {
        // Retrying is pointless here — the account is suspended, and
        // even a fresh /face/challenge call will now fail (see
        // middleware/auth.js) — so this replaces the capture UI
        // entirely rather than offering a "try again" that can't work.
        setLocked(true);
        setError(err.response.data.message);
      } else {
        setError(err.response?.data?.message || 'Face verification failed.');
        setCaptureKey((k) => k + 1); // let them try again with the same nonce
      }
    } finally {
      setChecking(false);
    }
  };

  const switchMethod = (next) => {
    setMethod(next);
    setError('');
    setCaptureKey((k) => k + 1); // a method switch starts a fresh capture attempt
  };

  const securityNote = {
    head_turn: 'Requires an actual live head movement, not just a matching face — a photo alone can\u2019t pass this.',
    blink: 'Requires an actual live blink, not just a matching face — a photo alone can\u2019t pass this, but it\u2019s the fastest gesture to catch and can be finicky on some cameras.',
    photo_match: 'This checks that the camera sees your enrolled face right now — it does not require a live gesture, so a clear photo of you held up to the camera could pass. Repeated failed attempts lock the account automatically.',
  }[method];

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: 16 }}>
      <div className="card" style={{ maxWidth: 420, width: '100%' }}>
        <h3 style={{ marginTop: 0 }}>Face verification required</h3>
        <p className="muted" style={{ fontSize: 13 }}>
          This is a Police Admin action — your face must match your enrolled record before it's
          filed, so a compromised login alone can't be used to lodge or verify a case.
        </p>

        {locked ? (
          <>
            <p className="error-text">{error}</p>
            <button className="btn btn-outline" onClick={onCancel}>Close</button>
          </>
        ) : notEnrolled ? (
          <>
            <p className="error-text">Your face isn't enrolled yet.</p>
            <Link to="/face-enrollment" className="btn btn-primary">Go to Face Enrollment</Link>
            <button className="btn btn-outline" style={{ marginLeft: 8 }} onClick={onCancel}>Cancel</button>
          </>
        ) : error && !nonce ? (
          <>
            <p className="error-text">{error}</p>
            <button className="btn btn-outline" onClick={onCancel}>Close</button>
          </>
        ) : !nonce ? (
          <p className="muted">Starting…</p>
        ) : (
          <>
            {error && <p className="error-text" style={{ fontSize: 13 }}>{error}</p>}
            {checking ? (
              <p className="muted">Checking against your enrolled face…</p>
            ) : (
              <>
                {method === 'head_turn' && <HeadTurnLivenessCapture key={captureKey} onComplete={handleCapture} onCancel={onCancel} />}
                {method === 'blink' && <FaceLivenessCapture key={captureKey} onComplete={handleCapture} onCancel={onCancel} />}
                {method === 'photo_match' && <PhotoMatchCapture key={captureKey} onComplete={handleCapture} onCancel={onCancel} />}

                <p className="muted" style={{ fontSize: 11.5, marginTop: 10, textAlign: 'center' }}>{securityNote}</p>

                <p className="muted" style={{ fontSize: 12.5, marginTop: 6, textAlign: 'center' }}>
                  {method === 'head_turn' && (
                    <>
                      <button type="button" className="link-button" onClick={() => switchMethod('blink')}>Try a blink instead</button>
                      {' · '}
                      <button type="button" className="link-button" onClick={() => switchMethod('photo_match')}>Camera struggling? Use simple photo match</button>
                    </>
                  )}
                  {method === 'blink' && (
                    <>
                      <button type="button" className="link-button" onClick={() => switchMethod('head_turn')}>Try a head turn instead</button>
                      {' · '}
                      <button type="button" className="link-button" onClick={() => switchMethod('photo_match')}>Camera struggling? Use simple photo match</button>
                    </>
                  )}
                  {method === 'photo_match' && (
                    <>Prefer a stronger check? <button type="button" className="link-button" onClick={() => switchMethod('blink')}>Try a live blink</button></>
                  )}
                </p>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
