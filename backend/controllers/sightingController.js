const asyncHandler = require('express-async-handler');
const Sighting = require('../models/Sighting');
const Case = require('../models/Case');
const User = require('../models/User');
const PoliceStation = require('../models/PoliceStation');
const { ROLES } = require('../config/roles');
const { jurisdictionCaseFilter } = require('../utils/caseVisibility');
const { logAction } = require('../utils/audit');
const { notifyUser, notifyMany } = require('../utils/notify');
const { notifyStationOrDistrictFallback } = require('../utils/stationNotify');
const { involveNearbyNgos } = require('../utils/ngoInvolvement');
const { asSafeString } = require('../utils/sanitize');
const { canViewCase } = require('../utils/caseVisibility');

const toGeo = (lat, lng) => ({ type: 'Point', coordinates: [Number(lng), Number(lat)] });

// Finds the police station nearest the sighting (within 50km) and, if
// it differs from the case's original station, notifies that station's
// admin too — this is the "case opened in Pune, sighting near Mumbai,
// Mumbai police gets alerted" workflow.
const notifyNearestStation = async (caseDoc, sightingGeo) => {
  const [lng, lat] = sightingGeo.coordinates;
  const nearestStations = await PoliceStation.find({
    geo: { $near: { $geometry: { type: 'Point', coordinates: [lng, lat] }, $maxDistance: 50 * 1000 } },
  }).limit(1);

  const nearestStation = nearestStations[0];
  if (!nearestStation) return;
  if (caseDoc.policeStationId && String(nearestStation._id) === String(caseDoc.policeStationId)) return; // same station, already notified via verifiedBy

  await notifyStationOrDistrictFallback({
    station: nearestStation,
    message: `A sighting near ${nearestStation.name} (${nearestStation.district}) was reported for a case opened in another jurisdiction: ${caseDoc.fullName}.`,
    caseId: caseDoc._id,
  });
};

// @route POST /api/sightings
const createSighting = asyncHandler(async (req, res) => {
  const { caseId, description, address, lat, lng, seenAt, evidenceUrls } = req.body;

  const caseDoc = await Case.findById(caseId);
  if (!caseDoc) { res.status(404); throw new Error('Case not found'); }
  if (!['verified', 'under_search'].includes(caseDoc.status)) {
    res.status(400);
    throw new Error('Sightings can only be submitted for verified, active cases');
  }

  const sightingGeo = toGeo(lat, lng);

  const sighting = await Sighting.create({
    caseId,
    reportedBy: req.user._id,
    description,
    location: { address, geo: sightingGeo },
    seenAt,
    evidenceUrls: evidenceUrls || [],
  });

  caseDoc.timeline.push({ label: 'Sighting Reported', actor: req.user._id, note: `Near ${address} — pending verification` });

  // Pull in nearby NGOs and alert the nearest police jurisdiction before
  // saving, so both land in the same timeline write.
  await involveNearbyNgos(caseDoc, sightingGeo);
  await caseDoc.save();
  await notifyNearestStation(caseDoc, sightingGeo);

  await notifyUser({
    userId: caseDoc.verifiedBy || caseDoc.createdBy,
    type: 'new_sighting',
    message: `New sighting reported for ${caseDoc.fullName}, pending your verification.`,
    caseId: caseDoc._id,
  });
  await logAction({ userId: req.user._id, action: 'SIGHTING_CREATED', targetType: 'Sighting', targetId: sighting._id, req });

  res.status(201).json({ success: true, sighting });
});

// @route GET /api/sightings?caseId=
const listSightings = asyncHandler(async (req, res) => {
  const caseId = asSafeString(req.query.caseId);
  const status = asSafeString(req.query.status);
  if (!caseId) { res.status(400); throw new Error('caseId is required'); }

  // Same access rule as getCase — previously this endpoint had no
  // authorization at all, so sightings (which can include a
  // reporter's contact details) for ANY case, including a
  // courtRestricted one, were readable by anyone logged in who knew
  // or guessed the caseId.
  const caseDoc = await Case.findById(caseId);
  if (!caseDoc || !canViewCase(req.user, caseDoc)) { res.status(404); throw new Error('Case not found'); }

  const filter = { caseId };
  if (status) filter.status = status;

  const sightings = await Sighting.find(filter).populate('reportedBy', 'name role').sort({ createdAt: -1 });
  res.json({ success: true, count: sightings.length, sightings });
});

// @route PATCH /api/sightings/:id/verify
const verifySighting = asyncHandler(async (req, res) => {
  const { decision, reviewNote } = req.body; // decision: 'verified' | 'rejected'
  if (!['verified', 'rejected'].includes(decision)) {
    res.status(400);
    throw new Error("decision must be 'verified' or 'rejected'");
  }

  const sighting = await Sighting.findById(req.params.id);
  if (!sighting) { res.status(404); throw new Error('Sighting not found'); }

  sighting.status = decision;
  sighting.verifiedBy = req.user._id;
  sighting.reviewNote = reviewNote;
  await sighting.save();

  const caseDoc = await Case.findById(sighting.caseId);

  if (decision === 'verified') {
    if (caseDoc && caseDoc.status === 'verified') {
      caseDoc.status = 'under_search';
      caseDoc.timeline.push({ label: 'Search Narrowed', actor: req.user._id, note: 'First verified sighting received' });
    } else if (caseDoc) {
      caseDoc.timeline.push({ label: 'Sighting Verified', actor: req.user._id, note: reviewNote || `Near ${sighting.location?.address || 'reported location'}` });
    }
  } else {
    // This branch was previously missing entirely — a rejected sighting
    // never touched the case timeline, so it stayed showing "pending
    // verification" forever even after being reviewed and rejected.
    if (caseDoc) {
      caseDoc.timeline.push({ label: 'Sighting Rejected', actor: req.user._id, note: reviewNote || `Near ${sighting.location?.address || 'reported location'} — reviewed and rejected` });
    }
  }
  if (caseDoc) await caseDoc.save();

  await notifyUser({
    userId: sighting.reportedBy,
    type: 'sighting_verified',
    message: `Your sighting report was ${decision} by an official.`,
    caseId: sighting.caseId,
  });
  await logAction({ userId: req.user._id, action: `SIGHTING_${decision.toUpperCase()}`, targetType: 'Sighting', targetId: sighting._id, req });

  res.json({ success: true, sighting });
});

// @route GET /api/sightings/mine
// Every sighting the current user has personally reported, across all
// cases — the Citizen portal's "My Reports" page. Distinct from
// listSightings (which requires a caseId and is scoped to that one
// case) — this is "everything I've contributed," not "everything
// about this case."
const listMySightings = asyncHandler(async (req, res) => {
  const sightings = await Sighting.find({ reportedBy: req.user._id })
    .sort({ createdAt: -1 })
    .populate('caseId', 'fullName status photoUrl');
  res.json({ success: true, count: sightings.length, sightings });
});

// @route GET /api/sightings/pending-review
// A queue of sightings awaiting verification, scoped to the
// requester's own jurisdiction — station for Police Admin, district
// for District Control, state for State Control, everything for
// system/super admin. Distinct from listSightings (needs a specific
// caseId) and listMySightings (a citizen's own submissions) — this is
// "what's waiting on ME, across every case my jurisdiction covers,"
// which nothing before this endpoint could answer in one call. Reuses
// jurisdictionCaseFilter (utils/caseVisibility.js) — the exact same
// scoping rule listCases itself uses — so "my jurisdiction" can't mean
// something subtly different here than it does anywhere else in the
// app.
const listPendingReview = asyncHandler(async (req, res) => {
  const caseFilter = { status: { $in: ['verified', 'under_search'] }, ...jurisdictionCaseFilter(req.user) };
  const caseIds = await Case.find(caseFilter).distinct('_id');
  const sightings = await Sighting.find({ caseId: { $in: caseIds }, status: 'pending' })
    .sort({ createdAt: -1 })
    .limit(100)
    .populate('reportedBy', 'name role')
    .populate('caseId', 'fullName age photoUrl lastSeenLocation policeStationId');
  res.json({ success: true, count: sightings.length, sightings });
});

module.exports = { createSighting, listSightings, verifySighting, listMySightings, listPendingReview };
