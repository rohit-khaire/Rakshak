const asyncHandler = require('express-async-handler');
const Case = require('../models/Case');
const CaseVersion = require('../models/CaseVersion');
const User = require('../models/User');
const { ROLES, CAN_CREATE_VERIFIED_CASE } = require('../config/roles');
const { logAction } = require('../utils/audit');
const { notifyUser } = require('../utils/notify');
const { notifyStationOrDistrictFallback } = require('../utils/stationNotify');
const { notifyDistrictSuperiors } = require('../utils/oversight');
const { involveNearbyNgos } = require('../utils/ngoInvolvement');
const { suggestPriority } = require('../utils/priority');
const { validateAge, validateHeightInches, validateLastSeenAt } = require('../utils/validators');
const { findNearestStation } = require('../utils/findNearestStation');
const { resolveUserArea } = require('../utils/resolveArea');
const { asSafeString } = require('../utils/sanitize');
const { canViewCase, jurisdictionCaseFilter, PUBLIC_STATUSES, OFFICIAL_ROLES } = require('../utils/caseVisibility');
const { idsEqual } = require('../utils/ids');
const { findPossibleDuplicates } = require('../utils/duplicateDetection');

const EMERGENCY_REPORT_COOLDOWN_DAYS = 30;

const toGeo = (lat, lng) => ({ type: 'Point', coordinates: [Number(lng), Number(lat)] });

// Fields an official may edit after creation. Deliberately excludes
// system fields (status, timeline, createdBy, verifiedBy, etc) — those
// have their own dedicated, audited endpoints.
const EDITABLE_FIELDS = [
  'fullName', 'age', 'height', 'appearanceDescription', 'photoUrl',
  'lastSeenAt', 'familyContact', 'courtRestricted',
];

const snapshotCase = (caseDoc) => {
  const obj = caseDoc.toObject();
  // Keep the snapshot focused on editable + identifying fields, not the
  // whole document (timeline/versions would otherwise nest infinitely).
  const { _id, fullName, age, height, appearanceDescription, photoUrl, lastSeenLocation, lastSeenAt, firNumber, familyContact, status, courtRestricted, priority, priorityReason } = obj;
  return { _id, fullName, age, height, appearanceDescription, photoUrl, lastSeenLocation, lastSeenAt, firNumber, familyContact, status, courtRestricted, priority, priorityReason };
};

// @route POST /api/cases/check-duplicates
// Pre-flight check the frontend runs just before either case-creation
// endpoint below — a heads-up, never a hard block: whoever's filing
// always decides for themselves whether it's genuinely a new case.
// See utils/duplicateDetection.js for the scoring itself and the
// reasoning behind its thresholds.
const checkDuplicates = asyncHandler(async (req, res) => {
  const { fullName, age, lat, lng, lastSeenAt } = req.body;
  if (!fullName?.trim()) {
    res.status(400);
    throw new Error('Full name is required to check for duplicates');
  }

  const draft = {
    fullName,
    age: age !== undefined && age !== '' ? Number(age) : undefined,
    lastSeenAt,
    geo: (lat !== undefined && lat !== '' && lng !== undefined && lng !== '') ? [Number(lng), Number(lat)] : undefined,
  };

  // Only ACTIVE cases are worth flagging — one already found or closed
  // isn't a reason to hesitate before filing a new report. Restricted
  // cases are excluded outright: this endpoint is reachable by Family
  // accounts too, so it must never surface a restricted case's details
  // to someone who couldn't otherwise see it.
  const candidates = await Case.find({
    status: { $in: ['emergency_pending', 'verified', 'under_search'] },
    courtRestricted: { $ne: true },
  }).select('fullName age lastSeenAt lastSeenLocation status');

  const matches = findPossibleDuplicates(draft, candidates);

  res.json({
    success: true,
    possibleDuplicates: matches.map((m) => ({
      caseId: m.candidate._id,
      fullName: m.candidate.fullName,
      age: m.candidate.age,
      status: m.candidate.status,
      lastSeenAt: m.candidate.lastSeenAt,
      lastSeenAddress: m.candidate.lastSeenLocation?.address,
      score: Math.round(m.score * 100),
      reasons: m.reasons,
    })),
  });
});

// @route POST /api/cases
// Official, FIR-anchored case creation — WORKFLOW-004.
// Restricted to police_admin and above (see CAN_CREATE_VERIFIED_CASE).
const createCase = asyncHandler(async (req, res) => {
  const {
    fullName, age, height, appearanceDescription, photoUrl,
    address, lat, lng, lastSeenAt, firNumber, familyContact, state, district,
  } = req.body;

  if (!firNumber) {
    res.status(400);
    throw new Error('FIR number is required for an official case (see WORKFLOW-004)');
  }

  const ageCheck = validateAge(age);
  if (!ageCheck.ok) { res.status(400); throw new Error(ageCheck.message); }
  const heightCheck = validateHeightInches(height);
  if (!heightCheck.ok) { res.status(400); throw new Error(heightCheck.message); }
  const lastSeenCheck = validateLastSeenAt(lastSeenAt);
  if (!lastSeenCheck.ok) { res.status(400); throw new Error(lastSeenCheck.message); }

  const suggestion = suggestPriority({ age: ageCheck.value, lastSeenAt });

  // Route the case to whichever station is actually nearest the
  // incident location — NOT automatically the creating officer's own
  // station. An explicit state/district typed in the form still wins
  // (the officer may know something the geo-lookup can't), then the
  // nearest real station, then finally the officer's own jurisdiction
  // as a last-resort fallback if nothing else is available.
  const nearestStation = await findNearestStation(lat, lng);
  const ownStationId = req.user.jurisdiction?.policeStationId;
  const routedToOtherStation = nearestStation && String(nearestStation._id) !== String(ownStationId);

  const assignedPoliceStationId = nearestStation?._id || ownStationId;
  const assignedState = state || nearestStation?.state || req.user.jurisdiction?.state;
  const assignedDistrict = district || nearestStation?.district || req.user.jurisdiction?.district;

  const timeline = [
    { label: 'Case Created', actor: req.user._id, note: `FIR ${firNumber} linked` },
    { label: 'Verified', actor: req.user._id, note: 'Verified at creation by official' },
    { label: 'Priority Suggested', note: `${suggestion.priority.toUpperCase()} — ${suggestion.reasons.join('; ')}` },
  ];
  if (routedToOtherStation) {
    timeline.push({
      label: 'Routed by Location',
      note: `Last-seen location is nearest to ${nearestStation.name} (${nearestStation.district}) — case routed there, not to ${req.user.name}'s own station.`,
    });
  }

  const newCase = await Case.create({
    fullName, age: ageCheck.value, height: heightCheck.value, appearanceDescription, photoUrl,
    lastSeenLocation: { address, geo: toGeo(lat, lng) },
    lastSeenAt, firNumber, familyContact,
    status: 'verified',
    priority: suggestion.priority,
    priorityReason: suggestion.reasons.join('; '),
    priorityAutoSuggested: true,
    createdBy: req.user._id,
    verifiedBy: req.user._id,
    policeStationId: assignedPoliceStationId,
    jurisdiction: { state: assignedState, district: assignedDistrict },
    timeline,
  });

  // If this case landed in a DIFFERENT station's jurisdiction than the
  // officer who filed it, that station's admin(s) get notified live —
  // this is the cross-jurisdiction alerting you asked for, now applied
  // at case creation, not just when a sighting comes in later. Falls
  // back to that district's District Control if the station itself
  // has no assigned admin yet, so this can never silently reach nobody.
  if (routedToOtherStation) {
    await notifyStationOrDistrictFallback({
      station: nearestStation,
      message: `A case was filed by ${req.user.name} (${req.user.jurisdiction?.district || 'another district'} station) for a location in your jurisdiction: ${newCase.fullName}.`,
      caseId: newCase._id,
    });
  }

  // Officially-created cases are verified immediately (a real FIR
  // number already exists) — but this never actually told any nearby
  // NGO. involveNearbyNgos was only ever wired into attachFir (the
  // Family-report upgrade path) and sighting creation; a case entered
  // directly here by an officer had no trigger point at all, so it
  // stayed invisible to every NGO until (if ever) a sighting happened
  // to land near it later. This is the fix for that gap.
  await involveNearbyNgos(newCase, newCase.lastSeenLocation.geo, {
    linkedVia: 'case_verified',
    triggerLabel: 'a newly registered, verified case',
  });
  await newCase.save();

  await logAction({ userId: req.user._id, action: 'CASE_CREATED_VERIFIED', targetType: 'Case', targetId: newCase._id, req });

  res.status(201).json({ success: true, case: newCase, routedToOtherStation: routedToOtherStation ? nearestStation.name : null });
});

// @route POST /api/cases/emergency
// Pre-FIR self-report by a Family member — WORKFLOW-003.
// Created with restricted visibility until an official upgrades it
// with an FIR number (PATCH /api/cases/:id/attach-fir).
const createEmergencyReport = asyncHandler(async (req, res) => {
  const { fullName, age, height, appearanceDescription, photoUrl, address, lat, lng, lastSeenAt, familyContact, declarationAccepted } = req.body;

  const ageCheck = validateAge(age);
  if (!ageCheck.ok) { res.status(400); throw new Error(ageCheck.message); }
  const heightCheck = validateHeightInches(height);
  if (!heightCheck.ok) { res.status(400); throw new Error(heightCheck.message); }
  const lastSeenCheck = validateLastSeenAt(lastSeenAt);
  if (!lastSeenCheck.ok) { res.status(400); throw new Error(lastSeenCheck.message); }

  if (!declarationAccepted) {
    res.status(400);
    throw new Error('You must confirm the declaration before submitting an emergency report.');
  }

  // Once-per-30-days limit — the seeded demo family account is exempt
  // (testAccount: true) so grading/demo testing isn't blocked by it.
  // A real family account gets no such exemption.
  if (!req.user.testAccount) {
    const cooldownStart = new Date(Date.now() - EMERGENCY_REPORT_COOLDOWN_DAYS * 24 * 60 * 60 * 1000);
    const recentReport = await Case.findOne({
      createdBy: req.user._id,
      isEmergencyReport: true,
      createdAt: { $gte: cooldownStart },
    }).sort({ createdAt: -1 });

    if (recentReport) {
      const nextEligible = new Date(new Date(recentReport.createdAt).getTime() + EMERGENCY_REPORT_COOLDOWN_DAYS * 24 * 60 * 60 * 1000);
      res.status(429);
      throw new Error(
        `You already submitted an emergency report on ${recentReport.createdAt.toDateString()}. `
        + `You can submit another after ${nextEligible.toDateString()}. `
        + `If this is a new urgent situation, please contact your nearest police station directly.`
      );
    }
  }

  const suggestion = suggestPriority({ age: ageCheck.value, lastSeenAt });

  // Family has no "own station" bias at all, so this matters even more
  // here than in createCase: route straight to whichever real station
  // is nearest the incident, so it's already in the right queue the
  // moment an officer looks for it — not floating with no jurisdiction
  // until someone manually attaches one.
  const nearestStation = await findNearestStation(lat, lng);

  const timeline = [
    { label: 'Emergency Report Created', actor: req.user._id, note: 'Awaiting FIR registration' },
    { label: 'Priority Suggested', note: `${suggestion.priority.toUpperCase()} — ${suggestion.reasons.join('; ')}` },
  ];
  if (nearestStation) {
    timeline.push({ label: 'Routed by Location', note: `Nearest station: ${nearestStation.name} (${nearestStation.district})` });
  }

  const newCase = await Case.create({
    fullName, age: ageCheck.value, height: heightCheck.value, appearanceDescription, photoUrl,
    lastSeenLocation: { address, geo: toGeo(lat, lng) },
    lastSeenAt, familyContact,
    status: 'emergency_pending',
    isEmergencyReport: true,
    priority: suggestion.priority,
    priorityReason: suggestion.reasons.join('; '),
    priorityAutoSuggested: true,
    declarationAccepted: true,
    declarationAcceptedAt: new Date(),
    createdBy: req.user._id,
    policeStationId: nearestStation?._id,
    jurisdiction: nearestStation ? { state: nearestStation.state, district: nearestStation.district } : undefined,
    timeline,
  });

  // Alert that station immediately — this is the "advanced real-time"
  // piece: the right station finds out the moment the family submits,
  // not only once someone happens to browse the unassigned pool. Falls
  // back to District Control if that station has no admin assigned.
  if (nearestStation) {
    await notifyStationOrDistrictFallback({
      station: nearestStation,
      message: `New Emergency Report near your jurisdiction: ${newCase.fullName}. Awaiting FIR registration.`,
      caseId: newCase._id,
    });
  }

  // NGOs previously only learned about a case once an officer verified
  // it (attachFir) or a sighting came in — meaning a freshly-filed
  // Emergency Report was invisible to every NGO until police acted on
  // it, sometimes hours or days later. They now learn the moment it's
  // filed too, worded honestly as "unverified" so a volunteer doesn't
  // treat it as confirmed before police have acted.
  await involveNearbyNgos(newCase, newCase.lastSeenLocation.geo, {
    linkedVia: 'emergency_report',
    triggerLabel: 'an unverified Emergency Report — police verification is still pending',
  });
  await newCase.save();

  await logAction({ userId: req.user._id, action: 'EMERGENCY_REPORT_CREATED', targetType: 'Case', targetId: newCase._id, req });

  res.status(201).json({
    success: true,
    case: newCase,
    advisory: 'Please register an FIR at the nearest police station as soon as possible.',
  });
});

// @route PATCH /api/cases/:id/attach-fir
// Official upgrades an emergency report to a verified case once the
// family has registered the FIR — completes WORKFLOW-003.
const attachFir = asyncHandler(async (req, res) => {
  const { firNumber } = req.body;

  const caseDoc = await Case.findById(req.params.id);
  if (!caseDoc) { res.status(404); throw new Error('Case not found'); }

  caseDoc.firNumber = firNumber;
  caseDoc.status = 'verified';
  caseDoc.verifiedBy = req.user._id;
  // If this case never got a station at creation — createEmergencyReport
  // leaves both policeStationId and jurisdiction unset together when
  // findNearestStation found nothing to route to (bad/missing
  // coordinates from the family's submission) — give geo-routing one
  // more real attempt before falling back to anything else. More
  // stations may have been added to the platform since this case was
  // created, so a retry against the SAME stored coordinates isn't
  // pointless even though nothing about the case's own data changed.
  //
  // If that still finds nothing, the station stays unset rather than
  // defaulting to whichever officer happens to attach the FIR — that
  // officer could be reviewing a backlog of unrouted reports from
  // anywhere, with no geographic connection to where the person was
  // actually last seen, so "their own station" isn't a meaningful
  // fallback the way it deliberately is in createCase (an officer
  // taking a report in person, usually locally, is a much better
  // last-resort signal). An unassigned case is already a fully-
  // supported state, not a new one this introduces — canViewCase and
  // listCases' query filter both already treat "no station" as
  // visible to any official who could plausibly claim it — so this
  // surfaces the case broadly and prompts an explicit human
  // reassignment (Reassign Station) instead of silently guessing.
  if (!caseDoc.policeStationId) {
    const [lng, lat] = caseDoc.lastSeenLocation?.geo?.coordinates || [];
    const nearestStation = (lat && lng) ? await findNearestStation(lat, lng) : null;
    if (nearestStation) {
      caseDoc.policeStationId = nearestStation._id;
      caseDoc.jurisdiction = { state: nearestStation.state, district: nearestStation.district };
      caseDoc.timeline.push({ label: 'Routed by Location', note: `Nearest station: ${nearestStation.name} (${nearestStation.district}) — matched on FIR attachment` });
    } else {
      caseDoc.timeline.push({ label: 'Station Unassigned', note: 'No usable location on file — needs manual station assignment (see Reassign Station)' });
    }
  }
  caseDoc.timeline.push({ label: 'Verified', actor: req.user._id, note: `FIR ${firNumber} attached` });

  // Broadcast to nearby NGOs (and their volunteers) the moment the case
  // goes live — not just reactively when a sighting later comes in.
  await involveNearbyNgos(caseDoc, caseDoc.lastSeenLocation.geo, {
    linkedVia: 'manual',
    triggerLabel: 'case verification',
  });

  await caseDoc.save();

  await notifyUser({
    userId: caseDoc.createdBy,
    type: 'case_verified',
    message: `Your report for ${caseDoc.fullName} has been verified and is now live.`,
    caseId: caseDoc._id,
  });
  await logAction({ userId: req.user._id, action: 'CASE_FIR_ATTACHED', targetType: 'Case', targetId: caseDoc._id, req });

  res.json({ success: true, case: caseDoc });
});

// @route GET /api/cases
// Public feed shows only verified+ cases with restricted field set.
// Officials' default view auto-scopes to their own jurisdiction — this
// is what actually differentiates the roles day-to-day: a Police Admin
// sees their station's queue, District Control sees their district,
// State Control sees their state, System/National Admin see everything.
// Pass ?scope=all, or explicit ?state=/&district=, to override.
//
// IMPORTANT: a case that hasn't been assigned a jurisdiction yet (e.g.
// a Family's Emergency Report, which is pre-FIR and has no station/
// district/state attached) must still be visible to officials who
// could plausibly claim it — otherwise it's invisible to everyone
// except Super/System Admin, which defeats the point of an emergency
// report reaching an officer quickly. So the scope is "my jurisdiction
// OR unassigned", not just "my jurisdiction".
const listCases = asyncHandler(async (req, res) => {
  const status = asSafeString(req.query.status);
  const state = asSafeString(req.query.state);
  const district = asSafeString(req.query.district);
  const isOfficial = OFFICIAL_ROLES.includes(req.user?.role);

  const filter = {};

  if (isOfficial) {
    if (status) filter.status = status; // already a confirmed string, see asSafeString above

    if (!state && !district && req.query.scope !== 'all') {
      Object.assign(filter, jurisdictionCaseFilter(req.user));
      // system_admin / super_admin fall through with no default scope
      // (jurisdictionCaseFilter returns {} for them, same as before).
    }
  } else {
    // Non-officials never see restricted/emergency cases, but their chosen
    // status filter is still respected as long as it's within the public set.
    filter.courtRestricted = { $ne: true };
    filter.status = status && PUBLIC_STATUSES.includes(status) ? status : { $in: PUBLIC_STATUSES };

    // THE MISSING PIECE: officials auto-scope to their own jurisdiction
    // above, but neither Citizen/Family NOR NGO accounts were ever
    // scoped to anything — every verified case nationwide came back
    // regardless of where the person actually lives, or where an NGO's
    // service area actually is. resolveUserArea answers "what's this
    // account's area" the same way for every role (Citizen/Family via
    // homeLocation, NGO via a geo lookup on their service area — see
    // utils/resolveArea.js), so this now applies uniformly instead of
    // only covering the two roles that happened to have a stored
    // district already. An explicit ?district=/?state=/?scope=all
    // still wins — smart default, not a cage.
    if (!state && !district && req.query.scope !== 'all') {
      const myArea = await resolveUserArea(req.user);
      if (myArea.district) {
        filter['jurisdiction.district'] = myArea.district;
        if (myArea.state) filter['jurisdiction.state'] = myArea.state;
      }
    }
  }

  // Explicit query params always win over jurisdiction defaults above.
  if (state) filter['jurisdiction.state'] = state;
  if (district) filter['jurisdiction.district'] = district;

  // Free-text search (Citizen portal's Search page, and useful for
  // officials too) — matches full name or appearance description.
  // Regex characters in the search term are escaped so a crafted
  // query can't build an expensive pattern (ReDoS), on top of
  // asSafeString already ruling out a non-string (object) value.
  const q = asSafeString(req.query.q);
  if (q) {
    const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const searchOr = [
      { fullName: { $regex: escaped, $options: 'i' } },
      { appearanceDescription: { $regex: escaped, $options: 'i' } },
    ];
    // filter.$or may already be doing jurisdiction-scoping work above —
    // a second top-level $or would silently overwrite it, so combine
    // via $and instead of just assigning over it.
    if (filter.$or) {
      filter.$and = [{ $or: filter.$or }, { $or: searchOr }];
      delete filter.$or;
    } else {
      filter.$or = searchOr;
    }
  }

  const cases = await Case.find(filter).sort({ createdAt: -1 }).limit(200);
  res.json({ success: true, count: cases.length, cases, scopedTo: isOfficial ? filter : undefined });
});

// @route GET /api/cases/nearby?lat=&lng=&radiusKm=
// Powers the public map + "nearby citizen alert" feature.
const nearbyCases = asyncHandler(async (req, res) => {
  const lat = Number(req.query.lat);
  const lng = Number(req.query.lng);
  const radiusKm = Number(req.query.radiusKm) || 10;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    res.status(400);
    throw new Error('lat and lng must be valid numbers');
  }

  const cases = await Case.find({
    status: { $in: ['verified', 'under_search'] },
    courtRestricted: { $ne: true },
    'lastSeenLocation.geo': {
      $near: {
        $geometry: { type: 'Point', coordinates: [lng, lat] },
        $maxDistance: radiusKm * 1000,
      },
    },
  }).limit(100);

  res.json({ success: true, count: cases.length, cases });
});

// @route GET /api/cases/:id
const getCase = asyncHandler(async (req, res) => {
  const caseDoc = await Case.findById(req.params.id)
    .populate('createdBy', 'name role')
    .populate('verifiedBy', 'name role')
    .populate('timeline.actor', 'name role')
    .populate('involvedNgos.ngoAdmin', 'name email phone')
    .populate('assignedVolunteers.volunteer', 'name phone')
    .populate('assignedVolunteers.assignedBy', 'name')
    .populate('policeStationId', 'name district state');
  if (!caseDoc) { res.status(404); throw new Error('Case not found'); }

  // Previously missing entirely — any authenticated account could
  // view any case by ID. See utils/caseVisibility.js for the exact
  // rule, which mirrors what listCases already enforces via its query
  // filter so the two can't drift apart.
  if (!canViewCase(req.user, caseDoc)) { res.status(404); throw new Error('Case not found'); }

  res.json({ success: true, case: caseDoc });
});

// @route PATCH /api/cases/:id/status
// Official-only status transition (under_search / found / closed).
const CLOSURE_REASONS = ['false_report', 'duplicate_case', 'withdrawn_by_family', 'resolved_other_means', 'other'];

// Roles allowed to close a case that was NEVER marked Found — this is
// deliberately NOT available to Police Station Admin. A single station
// officer being able to unilaterally close an unresolved missing-person
// case, with no finding and no oversight, is a real accountability gap
// — the exact kind of thing that lets a case get quietly buried. Only
// District Control and above can do this, and only with a mandatory,
// specific reason on record.
const CAN_CLOSE_WITHOUT_FINDING = [ROLES.DISTRICT_CONTROL, ROLES.STATE_CONTROL, ROLES.SUPER_ADMIN];

// @route PATCH /api/cases/:id/status
const updateStatus = asyncHandler(async (req, res) => {
  const { status, note, closureReason } = req.body;
  const allowed = ['under_search', 'found', 'closed'];
  if (!allowed.includes(status)) { res.status(400); throw new Error(`Status must be one of: ${allowed.join(', ')}`); }

  const caseDoc = await Case.findById(req.params.id);
  if (!caseDoc) { res.status(404); throw new Error('Case not found'); }

  if (status === 'under_search' && caseDoc.status !== 'verified') {
    res.status(400);
    throw new Error(`Cannot move to "Under Search" from "${caseDoc.status}"`);
  }

  if (status === 'found' && !['verified', 'under_search'].includes(caseDoc.status)) {
    res.status(400);
    throw new Error(`Cannot mark Found from "${caseDoc.status}"`);
  }

  if (status === 'closed') {
    if (caseDoc.status === 'found') {
      // Normal resolution closure — any operational role, since the
      // person has actually been found. No special gate needed here.
    } else if (caseDoc.status === 'emergency_pending') {
      // Rejecting an unverified claim — this is exactly the first-line
      // triage a Police Admin is supposed to do, so no District Control
      // gate here (unlike closing an already-verified case below).
      // Still requires a specific reason, permanently on record.
      if (!closureReason || !CLOSURE_REASONS.includes(closureReason)) {
        res.status(400);
        throw new Error(`A specific closureReason is required to reject an emergency report. Must be one of: ${CLOSURE_REASONS.join(', ')}`);
      }
      if (closureReason === 'other' && !note) {
        res.status(400);
        throw new Error('Please provide a note explaining the rejection reason.');
      }
    } else if (['verified', 'under_search'].includes(caseDoc.status)) {
      // Closing WITHOUT ever finding the person — the sensitive path.
      if (!CAN_CLOSE_WITHOUT_FINDING.includes(req.user.role)) {
        res.status(403);
        throw new Error(
          'Closing a case that was never marked "Found" requires District Control authority or above. '
          + 'A Police Station Admin can mark a case Found and close it, or escalate to their District Control for any other closure.'
        );
      }
      if (!closureReason || !CLOSURE_REASONS.includes(closureReason)) {
        res.status(400);
        throw new Error(`A specific closureReason is required to close an unresolved case. Must be one of: ${CLOSURE_REASONS.join(', ')}`);
      }
      if (closureReason === 'other' && !note) {
        res.status(400);
        throw new Error('Please provide a note explaining the closure reason.');
      }
    } else {
      res.status(400);
      throw new Error(`Cannot close a case from "${caseDoc.status}"`);
    }
  }

  const previousStatus = caseDoc.status;
  caseDoc.status = status;

  if (status === 'closed' && previousStatus === 'emergency_pending') {
    caseDoc.timeline.push({
      label: 'Emergency Report Rejected',
      actor: req.user._id,
      note: `Reason: ${closureReason}${note ? ` — ${note}` : ''}`,
    });
  } else if (status === 'closed' && previousStatus !== 'found') {
    caseDoc.timeline.push({
      label: 'Closed Without Resolution',
      actor: req.user._id,
      note: `Reason: ${closureReason}${note ? ` — ${note}` : ''}`,
    });
  } else {
    caseDoc.timeline.push({ label: status === 'found' ? 'Recovered' : status === 'closed' ? 'Closed' : 'Under Search', actor: req.user._id, note });
  }

  // Optional, explicit action — never automatic. An officer rejecting a
  // false emergency report can additionally suspend the account that
  // filed it. Deliberately narrow: only reachable via this exact
  // combination, so a routine "duplicate" or "withdrawn" rejection
  // never accidentally locks someone out.
  let suspendedReporter = false;
  if (status === 'closed' && previousStatus === 'emergency_pending' && closureReason === 'false_report' && req.body.suspendReporter) {
    const reporter = await User.findById(caseDoc.createdBy);
    if (reporter && !reporter.testAccount) {
      reporter.status = 'suspended';
      await reporter.save();
      suspendedReporter = true;
      caseDoc.timeline.push({ label: 'Reporter Account Suspended', actor: req.user._id, note: `${reporter.name}'s account suspended for a false report` });
      await logAction({ userId: req.user._id, action: 'USER_SUSPENDED_FALSE_REPORT', targetType: 'User', targetId: reporter._id, req, meta: { caseId: caseDoc._id } });
    }
  }

  await caseDoc.save();

  await notifyUser({
    userId: caseDoc.createdBy,
    type: 'status_update',
    message: `Case status for ${caseDoc.fullName} updated to "${status}".`,
    caseId: caseDoc._id,
  });
  await logAction({
    userId: req.user._id, action: `CASE_STATUS_${status.toUpperCase()}`, targetType: 'Case', targetId: caseDoc._id, req,
    meta: status === 'closed' && previousStatus !== 'found' ? { closureReason, unresolvedClosure: true } : undefined,
  });

  // Surfaces to the officer's District Control superior — see
  // notifyDistrictSuperiors in utils/oversight.js. This is the
  // continuous-surveillance piece: every status change a Police Admin
  // makes is visible to their direct superior, not just closures.
  if (req.user.role === ROLES.POLICE_ADMIN) {
    const isUnresolvedClosure = status === 'closed' && previousStatus !== 'found' && previousStatus !== 'emergency_pending';
    await notifyDistrictSuperiors({
      officer: req.user,
      message: `${req.user.name} updated case "${caseDoc.fullName}" to "${status}"${isUnresolvedClosure ? ' (WITHOUT a Found resolution)' : ''}${suspendedReporter ? ' — reporter account suspended for a false report' : ''}.`,
      caseId: caseDoc._id,
    });
  }

  res.json({ success: true, case: caseDoc, suspendedReporter });
});

// @route PATCH /api/cases/:id/priority
// An officer reviews (and can override) the auto-suggested priority.
// The original auto-suggestion reasoning stays visible in the timeline
// even after an override, so there's always a record of what the
// system recommended vs. what a human decided.
const setPriority = asyncHandler(async (req, res) => {
  const { priority, reason } = req.body;
  const allowed = ['critical', 'high', 'medium', 'low'];
  if (!allowed.includes(priority)) { res.status(400); throw new Error(`Priority must be one of: ${allowed.join(', ')}`); }

  const caseDoc = await Case.findById(req.params.id);
  if (!caseDoc) { res.status(404); throw new Error('Case not found'); }

  const previousPriority = caseDoc.priority;
  caseDoc.priority = priority;
  caseDoc.priorityReason = reason || `Manually set by ${req.user.name}`;
  caseDoc.priorityAutoSuggested = false;
  caseDoc.timeline.push({
    label: 'Priority Updated',
    actor: req.user._id,
    note: `${previousPriority.toUpperCase()} → ${priority.toUpperCase()}${reason ? ` — ${reason}` : ''}`,
  });
  await caseDoc.save();

  await logAction({
    userId: req.user._id, action: 'CASE_PRIORITY_UPDATED', targetType: 'Case', targetId: caseDoc._id, req,
    meta: { from: previousPriority, to: priority },
  });

  res.json({ success: true, case: caseDoc });
});

// @route PATCH /api/cases/:id
// Edits case detail fields. Snapshots the pre-edit state to CaseVersion
// first, so every edit is reviewable and reversible.
const updateCase = asyncHandler(async (req, res) => {
  const caseDoc = await Case.findById(req.params.id);
  if (!caseDoc) { res.status(404); throw new Error('Case not found'); }

  const { changeReason, address, lat, lng, ...rest } = req.body;

  if (rest.age !== undefined) {
    const ageCheck = validateAge(rest.age);
    if (!ageCheck.ok) { res.status(400); throw new Error(ageCheck.message); }
    rest.age = ageCheck.value;
  }
  if (rest.height !== undefined) {
    const heightCheck = validateHeightInches(rest.height);
    if (!heightCheck.ok) { res.status(400); throw new Error(heightCheck.message); }
    rest.height = heightCheck.value;
  }
  if (rest.lastSeenAt !== undefined) {
    const lastSeenCheck = validateLastSeenAt(rest.lastSeenAt);
    if (!lastSeenCheck.ok) { res.status(400); throw new Error(lastSeenCheck.message); }
  }

  await CaseVersion.create({
    caseId: caseDoc._id,
    snapshot: snapshotCase(caseDoc),
    changedBy: req.user._id,
    changeReason: changeReason || 'Edited case details',
  });

  EDITABLE_FIELDS.forEach((field) => {
    if (rest[field] !== undefined) caseDoc[field] = rest[field];
  });
  if (address || lat || lng) {
    caseDoc.lastSeenLocation = {
      address: address ?? caseDoc.lastSeenLocation.address,
      geo: (lat && lng) ? toGeo(lat, lng) : caseDoc.lastSeenLocation.geo,
    };
  }

  caseDoc.timeline.push({ label: 'Details Edited', actor: req.user._id, note: changeReason || 'Case details updated' });
  await caseDoc.save();

  await logAction({ userId: req.user._id, action: 'CASE_UPDATED', targetType: 'Case', targetId: caseDoc._id, req });

  res.json({ success: true, case: caseDoc });
});

// @route GET /api/cases/:id/versions
const listVersions = asyncHandler(async (req, res) => {
  const versions = await CaseVersion.find({ caseId: req.params.id })
    .populate('changedBy', 'name role')
    .sort({ createdAt: -1 });
  res.json({ success: true, count: versions.length, versions });
});

// @route POST /api/cases/:id/versions/:versionId/restore
// Restores editable fields from a prior snapshot. The current state is
// itself snapshotted first, so a restore can always be undone too.
const restoreVersion = asyncHandler(async (req, res) => {
  const caseDoc = await Case.findById(req.params.id);
  if (!caseDoc) { res.status(404); throw new Error('Case not found'); }

  const version = await CaseVersion.findOne({ _id: req.params.versionId, caseId: caseDoc._id });
  if (!version) { res.status(404); throw new Error('Version not found for this case'); }

  await CaseVersion.create({
    caseId: caseDoc._id,
    snapshot: snapshotCase(caseDoc),
    changedBy: req.user._id,
    changeReason: `Pre-restore snapshot (restoring to version ${version._id})`,
  });

  const s = version.snapshot;
  ['fullName', 'age', 'height', 'appearanceDescription', 'photoUrl', 'lastSeenLocation', 'lastSeenAt', 'familyContact', 'courtRestricted']
    .forEach((field) => { if (s[field] !== undefined) caseDoc[field] = s[field]; });

  caseDoc.timeline.push({ label: 'Restored', actor: req.user._id, note: `Restored to version from ${new Date(version.createdAt).toLocaleString()}` });
  await caseDoc.save();

  await logAction({ userId: req.user._id, action: 'CASE_RESTORED', targetType: 'Case', targetId: caseDoc._id, req, meta: { versionId: version._id } });

  res.json({ success: true, case: caseDoc });
});

// @route POST /api/cases/:id/assign-volunteer
// NGO Admin assigns one of their OWN volunteers to a case their NGO is
// already involved in (linked via a nearby sighting, or manually).
const assignVolunteer = asyncHandler(async (req, res) => {
  const { volunteerId, note } = req.body;
  const caseDoc = await Case.findById(req.params.id);
  if (!caseDoc) { res.status(404); throw new Error('Case not found'); }

  const isInvolved = caseDoc.involvedNgos.some((n) => String(n.ngoAdmin) === String(req.user._id));
  if (!isInvolved) {
    res.status(403);
    throw new Error('Your NGO is not linked to this case yet — it must first be involved via a nearby sighting or manual link');
  }

  const volunteer = await User.findById(volunteerId);
  if (!volunteer || volunteer.role !== ROLES.NGO_VOLUNTEER || String(volunteer.ngo?.supervisorId) !== String(req.user._id)) {
    res.status(400);
    throw new Error('That volunteer is not part of your organization');
  }

  const alreadyAssigned = caseDoc.assignedVolunteers.some((a) => String(a.volunteer) === String(volunteerId));
  if (alreadyAssigned) { res.status(400); throw new Error('This volunteer is already assigned to this case'); }

  caseDoc.assignedVolunteers.push({ volunteer: volunteerId, assignedBy: req.user._id, note });
  caseDoc.timeline.push({ label: 'Volunteer Assigned', actor: req.user._id, note: `${volunteer.name} assigned by ${req.user.ngo?.organizationName || req.user.name}` });
  await caseDoc.save();

  await notifyUser({
    userId: volunteerId,
    type: 'system',
    message: `You've been assigned to assist with case: ${caseDoc.fullName}.`,
    caseId: caseDoc._id,
  });
  await logAction({ userId: req.user._id, action: 'VOLUNTEER_ASSIGNED', targetType: 'Case', targetId: caseDoc._id, req, meta: { volunteerId } });

  res.json({ success: true, case: caseDoc });
});

// @route POST /api/cases/:id/field-update
// An assigned volunteer (or the NGO Admin who manages them) logs a
// field update — distinct from a citizen "sighting": this is a status
// note from someone actively working the case on the ground.
const fieldUpdate = asyncHandler(async (req, res) => {
  const { note } = req.body;
  if (!note) { res.status(400); throw new Error('note is required'); }

  const caseDoc = await Case.findById(req.params.id);
  if (!caseDoc) { res.status(404); throw new Error('Case not found'); }

  const isAssignedVolunteer = caseDoc.assignedVolunteers.some((a) => String(a.volunteer) === String(req.user._id));
  const isInvolvedNgoAdmin = caseDoc.involvedNgos.some((n) => String(n.ngoAdmin) === String(req.user._id));
  if (!isAssignedVolunteer && !isInvolvedNgoAdmin) {
    res.status(403);
    throw new Error('Only a volunteer assigned to this case, or its involved NGO Admin, can post a field update');
  }

  caseDoc.timeline.push({ label: 'Field Update', actor: req.user._id, note });
  await caseDoc.save();

  await logAction({ userId: req.user._id, action: 'FIELD_UPDATE_POSTED', targetType: 'Case', targetId: caseDoc._id, req });

  res.json({ success: true, case: caseDoc });
});

// @route GET /api/cases/assigned-to-me
// Powers the Volunteer's "My Assignments" queue and the NGO Admin's
// "Cases I'm involved in" view.
const listAssignedToMe = asyncHandler(async (req, res) => {
  let filter;
  if (req.user.role === ROLES.NGO_VOLUNTEER) {
    filter = { 'assignedVolunteers.volunteer': req.user._id };
  } else if (req.user.role === ROLES.NGO_ADMIN) {
    filter = { 'involvedNgos.ngoAdmin': req.user._id };
  } else {
    res.status(403);
    throw new Error('This endpoint is only for NGO Volunteers and NGO Admins');
  }

  const cases = await Case.find(filter).sort({ createdAt: -1 });
  res.json({ success: true, count: cases.length, cases });
});

// @route GET /api/cases/mine
// "My Cases" — meaning differs sensibly by role:
//   - Family / Citizen: cases THEY reported (any status, unrestricted
//     by the public-visibility filter — this is the fix for "I
//     submitted an emergency report and then couldn't find it again").
//   - Operational roles: cases THEY personally verified (verifiedBy),
//     so a Police Admin can see their own track record separate from
//     their station's full queue.
// Also returns Family-specific emergency-report eligibility, so the
// UI can show "you can report again on <date>" without a failed
// submission attempt.
const listMine = asyncHandler(async (req, res) => {
  let cases;
  let emergencyReportEligibility = null;

  if ([ROLES.FAMILY, ROLES.CITIZEN].includes(req.user.role)) {
    cases = await Case.find({ createdBy: req.user._id }).sort({ createdAt: -1 });

    if (req.user.role === ROLES.FAMILY) {
      if (req.user.testAccount) {
        emergencyReportEligibility = { canSubmit: true, testAccount: true };
      } else {
        const cooldownStart = new Date(Date.now() - EMERGENCY_REPORT_COOLDOWN_DAYS * 24 * 60 * 60 * 1000);
        const recentReport = await Case.findOne({
          createdBy: req.user._id, isEmergencyReport: true, createdAt: { $gte: cooldownStart },
        }).sort({ createdAt: -1 });

        if (recentReport) {
          const nextEligible = new Date(new Date(recentReport.createdAt).getTime() + EMERGENCY_REPORT_COOLDOWN_DAYS * 24 * 60 * 60 * 1000);
          emergencyReportEligibility = { canSubmit: false, nextEligibleAt: nextEligible, lastSubmittedAt: recentReport.createdAt };
        } else {
          emergencyReportEligibility = { canSubmit: true };
        }
      }
    }
  } else {
    // Operational roles: cases they personally verified.
    cases = await Case.find({ verifiedBy: req.user._id }).sort({ createdAt: -1 });
  }

  res.json({ success: true, count: cases.length, cases, emergencyReportEligibility });
});

// @route PATCH /api/cases/:id/reassign-station
// District Control moves a case to a different station within their
// district — e.g. rebalancing load, or correcting a mis-filed case.
// This is a real District-Control-only action Police Admin can't do.
const reassignStation = asyncHandler(async (req, res) => {
  const { policeStationId, reason } = req.body;
  if (!policeStationId) { res.status(400); throw new Error('policeStationId is required'); }

  const PoliceStation = require('../models/PoliceStation');
  const station = await PoliceStation.findById(policeStationId);
  if (!station) { res.status(404); throw new Error('Police station not found'); }
  if (req.user.jurisdiction?.district && station.district !== req.user.jurisdiction.district) {
    res.status(403);
    throw new Error('You can only reassign cases to stations within your own district');
  }

  const caseDoc = await Case.findById(req.params.id);
  if (!caseDoc) { res.status(404); throw new Error('Case not found'); }

  const previousStationId = caseDoc.policeStationId;
  caseDoc.policeStationId = policeStationId;
  caseDoc.timeline.push({ label: 'Reassigned', actor: req.user._id, note: reason || `Reassigned to ${station.name}` });
  await caseDoc.save();

  await logAction({
    userId: req.user._id, action: 'CASE_REASSIGNED', targetType: 'Case', targetId: caseDoc._id, req,
    meta: { from: previousStationId, to: policeStationId },
  });

  res.json({ success: true, case: caseDoc });
});

// Who can add supplementary material (photos, documents, additional
// info) to a case: the family who reported it, or an official whose
// jurisdiction actually covers this case (same rule as everywhere
// else — canViewCase, not just "any official").
//
// Uses idsEqual() (utils/ids.js) rather than a direct String(a) ===
// String(b) — not because this is currently broken (addPhoto/
// addDocument/addAdditionalInfo all fetch caseDoc via a plain
// Case.findById with no .populate(), so createdBy is always a raw
// ObjectId here today), but because it's the exact same shape as the
// bug that WAS broken in canViewCase (see the README's v16.1 entry):
// a single later .populate('createdBy') added to any of those three
// queries — e.g. to show a name in a response — would silently break
// this the same way, and there'd be no reason to think to check here
// unless someone already knew this history.
const canAddToCase = (user, caseDoc) => {
  const isReporter = idsEqual(caseDoc.createdBy, user._id);
  return isReporter || (OFFICIAL_ROLES.includes(user.role) && canViewCase(user, caseDoc));
};

// @route POST /api/cases/:id/photos
const addPhoto = asyncHandler(async (req, res) => {
  const { url, caption } = req.body;
  if (!url) { res.status(400); throw new Error('An image URL is required'); }

  const caseDoc = await Case.findById(req.params.id);
  if (!caseDoc) { res.status(404); throw new Error('Case not found'); }
  if (!canAddToCase(req.user, caseDoc)) {
    res.status(403);
    throw new Error('Only the reporting family or an officer with jurisdiction can add photos to this case');
  }

  caseDoc.photos.push({ url, caption, uploadedBy: req.user._id });
  caseDoc.timeline.push({ label: 'Photo added', actor: req.user._id });
  await caseDoc.save();

  await logAction({ userId: req.user._id, action: 'CASE_PHOTO_ADDED', targetType: 'Case', targetId: caseDoc._id, req });
  res.json({ success: true, photos: caseDoc.photos });
});

// @route POST /api/cases/:id/documents
const addDocument = asyncHandler(async (req, res) => {
  const { url, name } = req.body;
  if (!url || !name?.trim()) { res.status(400); throw new Error('A document URL and name are required'); }

  const caseDoc = await Case.findById(req.params.id);
  if (!caseDoc) { res.status(404); throw new Error('Case not found'); }
  if (!canAddToCase(req.user, caseDoc)) {
    res.status(403);
    throw new Error('Only the reporting family or an officer with jurisdiction can add documents to this case');
  }

  caseDoc.documents.push({ url, name: name.trim(), uploadedBy: req.user._id });
  caseDoc.timeline.push({ label: 'Document added', actor: req.user._id, note: name.trim() });
  await caseDoc.save();

  await logAction({ userId: req.user._id, action: 'CASE_DOCUMENT_ADDED', targetType: 'Case', targetId: caseDoc._id, req });
  res.json({ success: true, documents: caseDoc.documents });
});

// @route POST /api/cases/:id/additional-info
// Deliberately append-only (no edit/delete) — a distinguishing mark
// remembered later, a habit, a place they might go. Nothing already
// told to police should be silently editable after the fact.
const addAdditionalInfo = asyncHandler(async (req, res) => {
  const { text } = req.body;
  if (!text?.trim()) { res.status(400); throw new Error('Some text is required'); }

  const caseDoc = await Case.findById(req.params.id);
  if (!caseDoc) { res.status(404); throw new Error('Case not found'); }
  if (!canAddToCase(req.user, caseDoc)) {
    res.status(403);
    throw new Error('Only the reporting family or an officer with jurisdiction can add information to this case');
  }

  caseDoc.additionalInfo.push({ text: text.trim(), addedBy: req.user._id });
  caseDoc.timeline.push({ label: 'Additional information added', actor: req.user._id });
  await caseDoc.save();

  await logAction({ userId: req.user._id, action: 'CASE_INFO_ADDED', targetType: 'Case', targetId: caseDoc._id, req });
  res.json({ success: true, additionalInfo: caseDoc.additionalInfo });
});

module.exports = {
  createCase, createEmergencyReport, checkDuplicates, attachFir, listCases, nearbyCases, getCase, updateStatus,
  updateCase, listVersions, restoreVersion, assignVolunteer, fieldUpdate, listAssignedToMe, listMine, reassignStation, setPriority,
  addPhoto, addDocument, addAdditionalInfo, canAddToCase,
};
