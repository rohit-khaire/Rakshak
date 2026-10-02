const crypto = require('crypto');
const asyncHandler = require('express-async-handler');
const User = require('../models/User');
const FaceCheck = require('../models/FaceCheck');
const { ROLES } = require('../config/roles');
const { logAction } = require('../utils/audit');
const { notifyUser } = require('../utils/notify');
const { matchDescriptor, isValidDescriptor, framePairDistance } = require('../utils/faceMatch');
const { verifyBlinkPattern, verifyHeadTurnPattern } = require('../utils/liveness');
const { notifyDistrictSuperiors } = require('../utils/oversight');
const { asSafeString } = require('../utils/sanitize');
const { canManageJurisdiction } = require('../utils/userHierarchy');

const CHALLENGE_TTL_MS = 2 * 60 * 1000; // 2 minutes to complete a capture
const VERIFIED_TTL_MS = 2 * 60 * 1000; // then 2 more minutes to actually submit the gated action

// @route POST /api/face/enroll-request
// A Police Admin submits 3 captured angles (left/center/right) —
// images for their District Control to visually confirm, and the
// descriptors face-api.js computed from each, which become the
// enrolled reference once approved. Resets to 'pending' even after a
// prior rejection, so a PSI can simply resubmit.
const enrollRequest = asyncHandler(async (req, res) => {
  if (req.user.role !== ROLES.POLICE_ADMIN) {
    res.status(403);
    throw new Error('Only a Police Admin account enrolls a face for verification');
  }

  const { images, descriptors } = req.body;
  if (!Array.isArray(images) || images.length !== 3) {
    res.status(400);
    throw new Error('Exactly 3 images are required (left, center, right)');
  }
  if (!Array.isArray(descriptors) || descriptors.length !== 3 || !descriptors.every(isValidDescriptor)) {
    res.status(400);
    throw new Error('Exactly 3 valid face descriptors are required — make sure a face was detected in every capture');
  }

  req.user.faceEnrollment = {
    status: 'pending',
    images,
    descriptors,
    submittedAt: new Date(),
    reviewedBy: undefined,
    reviewedAt: undefined,
    rejectionReason: undefined,
  };
  await req.user.save();

  await logAction({ userId: req.user._id, action: 'FACE_ENROLLMENT_SUBMITTED', targetType: 'User', targetId: req.user._id, req });

  // Routed to the DySP covering THIS PSI's own district only — a
  // Palghar PSI's request goes to Palghar's District Control, never
  // to Pune's or Mumbai's. Same jurisdiction pattern as everywhere
  // else in this app (Officer Activity, messaging, etc).
  const superiors = await User.find({
    role: ROLES.DISTRICT_CONTROL, status: 'active',
    'jurisdiction.district': req.user.jurisdiction?.district,
    'jurisdiction.state': req.user.jurisdiction?.state,
  });
  await Promise.all(superiors.map((s) => notifyUser({
    userId: s._id,
    type: 'system',
    message: `${req.user.name} (Police Admin) submitted a face enrollment request — review it in Face Enrollment Requests.`,
  })));

  res.json({ success: true, status: 'pending' });
});

// @route GET /api/face/enrollments?status=pending|approved|rejected
// District Control's review queue — scoped to their own district,
// same as Officer Activity. Defaults to pending (the actionable
// queue) but accepts any status so past decisions are reviewable too,
// not just the current backlog.
const pendingEnrollments = asyncHandler(async (req, res) => {
  const status = asSafeString(req.query.status) || 'pending';
  if (!['pending', 'enrolled', 'rejected'].includes(status)) {
    res.status(400);
    throw new Error("status must be 'pending', 'enrolled', or 'rejected'");
  }

  const officers = await User.find({
    role: ROLES.POLICE_ADMIN,
    'jurisdiction.district': req.user.jurisdiction?.district,
    'jurisdiction.state': req.user.jurisdiction?.state,
    'faceEnrollment.status': status,
  }).select('name phone faceEnrollment.status faceEnrollment.images faceEnrollment.submittedAt faceEnrollment.reviewedAt faceEnrollment.rejectionReason jurisdiction');
  // Deliberately NOT selecting faceEnrollment.descriptors — the DySP
  // reviews the 3 images visually; the reference vectors used for
  // actual matching stay server-side only, same as toSafeObject().

  res.json({ success: true, officers });
});

// @route POST /api/face/enrollment/:userId/approve
const approveEnrollment = asyncHandler(async (req, res) => {
  const officer = await User.findById(req.params.userId);
  if (!officer || officer.role !== ROLES.POLICE_ADMIN) { res.status(404); throw new Error('Police Admin not found'); }
  if (officer.jurisdiction?.district !== req.user.jurisdiction?.district) {
    res.status(403);
    throw new Error('You can only approve enrollments for your own district');
  }
  if (officer.faceEnrollment?.status !== 'pending') {
    res.status(400);
    throw new Error('This officer has no pending enrollment request');
  }

  officer.faceEnrollment.status = 'enrolled';
  officer.faceEnrollment.reviewedBy = req.user._id;
  officer.faceEnrollment.reviewedAt = new Date();
  officer.faceEnrollment.rejectionReason = undefined;
  await officer.save();

  await logAction({ userId: req.user._id, action: 'FACE_ENROLLMENT_APPROVED', targetType: 'User', targetId: officer._id, req });
  await notifyUser({ userId: officer._id, type: 'system', message: `Your face enrollment was approved by ${req.user.name}. Face verification is now required to verify cases and sightings.` });

  res.json({ success: true });
});

// @route POST /api/face/enrollment/:userId/reject
const rejectEnrollment = asyncHandler(async (req, res) => {
  const { reason } = req.body;
  const officer = await User.findById(req.params.userId);
  if (!officer || officer.role !== ROLES.POLICE_ADMIN) { res.status(404); throw new Error('Police Admin not found'); }
  if (officer.jurisdiction?.district !== req.user.jurisdiction?.district) {
    res.status(403);
    throw new Error('You can only review enrollments for your own district');
  }

  officer.faceEnrollment.status = 'rejected';
  officer.faceEnrollment.reviewedBy = req.user._id;
  officer.faceEnrollment.reviewedAt = new Date();
  officer.faceEnrollment.rejectionReason = reason || 'Not specified';
  await officer.save();

  await logAction({ userId: req.user._id, action: 'FACE_ENROLLMENT_REJECTED', targetType: 'User', targetId: officer._id, req, meta: { reason } });
  await notifyUser({ userId: officer._id, type: 'system', message: `Your face enrollment was rejected by ${req.user.name}${reason ? `: ${reason}` : ''}. Please resubmit.` });

  res.json({ success: true });
});

// @route POST /api/face/challenge
// Step 1 of verification — issues a short-lived nonce right before
// capture starts. See models/FaceCheck.js for why this exists.
const issueChallenge = asyncHandler(async (req, res) => {
  if (req.user.faceEnrollment?.status !== 'enrolled') {
    res.status(400);
    throw new Error('Your face is not enrolled yet — complete Face Enrollment first.');
  }
  const nonce = crypto.randomBytes(24).toString('hex');
  await FaceCheck.create({ userId: req.user._id, nonce, stage: 'pending', expiresAt: new Date(Date.now() + CHALLENGE_TTL_MS) });
  res.json({ success: true, nonce, expiresInSeconds: CHALLENGE_TTL_MS / 1000 });
});

const LOCK_AFTER_FAILED_ATTEMPTS = 3;

// Pure — given the failure count going into this attempt, returns
// what it becomes and whether that crosses the lock threshold.
// Extracted specifically so the arithmetic itself is directly
// testable (see controllers/__tests__/faceController.test.js)
// without needing a database.
const nextFailedAttempts = (current) => {
  const count = (current || 0) + 1;
  return { count, locked: count >= LOCK_AFTER_FAILED_ATTEMPTS };
};

// @route POST /api/face/verify
// Step 2. Two things can be checked, both server-side, neither
// trusted from the client:
//   1. Liveness (method: 'blink' | 'head_turn' only) — do the 3
//      submitted frames show a genuine open -> closed/turned -> open
//      sequence? (utils/liveness.js, recomputed from raw landmark
//      coordinates, never a client-asserted boolean)
//   2. Identity — does the relevant frame's descriptor match this
//      user's enrolled reference? (utils/faceMatch.js)
//
// method: 'photo_match' skips step 1 entirely — a single live-camera
// capture, matched directly, no gesture required. This exists because
// blink/head-turn liveness turned out to be genuinely unreliable on
// some hardware (slow/inconsistent face-api.js inference on a 100ms
// polling loop — see the README's v16-v16.2 history for the full
// story of what was tried), and a feature that mostly doesn't
// complete isn't actually providing the security property it's meant
// to. photo_match trades away liveness (a printed or displayed photo
// of the enrolled officer CAN pass this — that's a real, deliberate,
// documented trade-off, not an oversight) for something that actually
// works: a live camera frame (not a file upload) matched against the
// enrolled descriptor, same matching logic already proven for the
// other two methods. It is offered as the default precisely because
// a verification step people can actually complete is worth more than
// a stronger one that mostly times out.
//
// Only if the relevant check(s) pass does the nonce become a
// short-lived "verified" proof that attachFir / sighting-verify will
// require and consume.
const verifyFace = asyncHandler(async (req, res) => {
  const { nonce, method } = req.body;
  if (!nonce) {
    res.status(400);
    throw new Error('nonce is required');
  }
  if (method && !['blink', 'head_turn', 'photo_match'].includes(method)) {
    res.status(400);
    throw new Error('Unknown verification method.');
  }

  const check = await FaceCheck.findOne({ userId: req.user._id, nonce, stage: 'pending', expiresAt: { $gt: new Date() } });
  if (!check) {
    res.status(400);
    throw new Error('This verification attempt has expired — request a new challenge and try again.');
  }

  // The descriptor actually being matched — where it comes from
  // depends entirely on the method, but from here on every method is
  // treated identically.
  let candidateDescriptor;
  let staticnessDistance = null; // observational only — see faceMatch.js's framePairDistance

  if (method === 'photo_match') {
    const { descriptor } = req.body;
    if (!isValidDescriptor(descriptor)) {
      res.status(400);
      throw new Error('A valid face capture is required.');
    }
    candidateDescriptor = descriptor;
  } else {
    // Defaults to blink for backward compatibility with any caller
    // that predates method being sent at all — every such capture was
    // always a blink sequence.
    const { frames } = req.body;
    if (!Array.isArray(frames)) {
      res.status(400);
      throw new Error('A 3-frame capture is required for this method.');
    }
    const liveness = method === 'head_turn' ? verifyHeadTurnPattern(frames) : verifyBlinkPattern(frames);
    if (!liveness.ok) {
      await logAction({ userId: req.user._id, action: 'FACE_VERIFY_LIVENESS_FAILED', targetType: 'User', targetId: req.user._id, req, meta: { reason: liveness.reason } });
      // Nonce stays 'pending' — bad lighting or a mistimed gesture is
      // a real, common false negative, not grounds to force a whole
      // new challenge on every retry. Also deliberately NOT counted
      // toward the lockout below — that's reserved for a live face
      // that doesn't match the enrolled one, a materially different
      // and more serious signal than "the gesture wasn't caught."
      res.status(401).json({ success: false, message: `Liveness check failed \u2014 ${liveness.reason} Please try again and blink naturally.` });
      return;
    }
    candidateDescriptor = frames[liveness.bestOpenFrameIndex]?.descriptor;
    staticnessDistance = framePairDistance(frames[0], frames[2]);
  }

  const result = matchDescriptor(candidateDescriptor, req.user.faceEnrollment?.descriptors);

  await logAction({
    userId: req.user._id, action: result.match ? 'FACE_VERIFY_PASSED' : 'FACE_VERIFY_FAILED',
    targetType: 'User', targetId: req.user._id, req,
    meta: { distance: result.distance, method: method || 'blink', staticnessDistance },
  });

  if (!result.match) {
    // A liveness hiccup is common and benign (handled above, doesn't
    // reach here). A live face that doesn't match the enrolled
    // officer is a materially different signal: it means someone who
    // isn't that officer is holding valid login credentials and
    // attempting a sensitive action right now — exactly the scenario
    // this whole feature exists to catch. Every failure notifies
    // District Control immediately, same as before; repeated failures
    // additionally lock the account outright rather than just hoping
    // someone reads the notification in time.
    const { count, locked: justLocked } = nextFailedAttempts(req.user.faceEnrollment.failedMatchAttempts);
    req.user.faceEnrollment.failedMatchAttempts = count;
    if (justLocked) {
      req.user.status = 'suspended';
      // Already fully enforced everywhere an account's status is
      // checked (middleware/auth.js, authController.js login) — this
      // alone is what actually blocks every next request instantly,
      // not anything in this file.
    }
    await req.user.save();

    await notifyDistrictSuperiors({
      officer: req.user,
      message: justLocked
        ? `Face verification failed repeatedly for ${req.user.name} (Police Admin) \u2014 their account has been AUTOMATICALLY LOCKED after ${LOCK_AFTER_FAILED_ATTEMPTS} consecutive non-matching attempts. This strongly suggests the account's credentials are being used by someone else. Immediate review required before reactivating.`
        : `Face verification FAILED for ${req.user.name} (Police Admin) \u2014 a live face was presented but did not match their enrolled face. This may indicate the account's credentials are being used by someone else. Review immediately.`,
    });

    if (justLocked) {
      await logAction({ userId: req.user._id, action: 'ACCOUNT_AUTO_LOCKED', targetType: 'User', targetId: req.user._id, req, meta: { reason: 'repeated_face_mismatch' } });
      res.status(401).json({ success: false, locked: true, message: 'Your account has been locked after repeated failed verification attempts. Contact your District Control office to reactivate it.' });
      return;
    }
    res.status(401).json({
      success: false,
      message: method === 'photo_match'
        ? 'That face didn\u2019t match your enrolled record \u2014 try again with better lighting, facing the camera directly.'
        : 'Liveness confirmed, but the face didn\u2019t match \u2014 try again with better lighting, facing the camera directly.',
    });
    return;
  }

  req.user.faceEnrollment.failedMatchAttempts = 0;
  await req.user.save();

  check.stage = 'verified';
  check.expiresAt = new Date(Date.now() + VERIFIED_TTL_MS); // extend briefly so the gated action has time to submit
  await check.save();

  res.json({ success: true, nonce });
});

// @route POST /api/face/enroll-offline/:officerId
// The in-person path: a PSI visits their District Control office, and
// the DySP captures the 3 angles directly on their own device instead
// of the PSI doing it remotely and waiting for review. Since the DySP
// IS physically present confirming this is really that officer, this
// goes straight to 'enrolled' — there's no separate review step
// because the review already happened, in person, which is the whole
// point of the office visit.
const enrollOffline = asyncHandler(async (req, res) => {
  const officer = await User.findById(req.params.officerId);
  if (!officer || officer.role !== ROLES.POLICE_ADMIN) { res.status(404); throw new Error('Police Admin not found'); }
  if (!canManageJurisdiction(req.user, officer.role, officer.jurisdiction)) {
    res.status(403);
    throw new Error('You can only enroll Police Admins within your own district');
  }

  const { images, descriptors } = req.body;
  if (!Array.isArray(images) || images.length !== 3) {
    res.status(400);
    throw new Error('Exactly 3 images are required (left, center, right)');
  }
  if (!Array.isArray(descriptors) || descriptors.length !== 3 || !descriptors.every(isValidDescriptor)) {
    res.status(400);
    throw new Error('Exactly 3 valid face descriptors are required — make sure a face was detected in every capture');
  }

  officer.faceEnrollment = {
    status: 'enrolled',
    images,
    descriptors,
    submittedAt: new Date(),
    reviewedBy: req.user._id,
    reviewedAt: new Date(),
    rejectionReason: undefined,
  };
  await officer.save();

  await logAction({ userId: req.user._id, action: 'FACE_ENROLLMENT_OFFLINE', targetType: 'User', targetId: officer._id, req });
  await notifyUser({
    userId: officer._id,
    type: 'system',
    message: `Your face enrollment was completed in person by ${req.user.name} and is now active. Face verification is required to verify cases and sightings.`,
  });

  res.json({ success: true });
});

module.exports = { enrollRequest, pendingEnrollments, approveEnrollment, rejectEnrollment, issueChallenge, verifyFace, enrollOffline, nextFailedAttempts };
