const asyncHandler = require('express-async-handler');
const Case = require('../models/Case');
const Sighting = require('../models/Sighting');
const { ROLES } = require('../config/roles');
const { asSafeString } = require('../utils/sanitize');

// Builds a Mongo filter that scopes results to the requester's
// jurisdiction, mirroring the control-room hierarchy: State Control
// sees its whole state, District Control sees only its district,
// Police Station Admin sees only cases tied to their station. Anything
// above State Control (system/super admin) sees everything, unless
// they explicitly pass ?state=/&district= query params.
//
// Returns null if the requester's role requires a specific scope that
// isn't actually set on their account. This matters more than it
// might look: a filter key with an undefined value doesn't narrow a
// MongoDB query — it's dropped entirely during BSON serialization
// before the query ever reaches the server (confirmed directly
// against the real bson package this project uses, not assumed —
// {policeStationId: undefined} serializes to {}), so it would
// silently become "match every case in the whole database" rather
// than "match none." Every caller below checks for null and returns
// an explicitly empty response instead of ever letting that happen.
// Police Admin is the one case this could actually occur for today
// (a pre-v14.1 account not yet repaired — see the README); State/
// District Control already have their state/district validated as
// required at account-creation time, so this is here for consistency
// and to not depend on that staying true, not because either is
// currently reachable without one.
const scopeFilter = (user, query) => {
  const filter = {};
  const state = asSafeString(query.state);
  const district = asSafeString(query.district);
  if (state) filter['jurisdiction.state'] = state;
  if (district) filter['jurisdiction.district'] = district;

  if (user.role === ROLES.STATE_CONTROL && !state) {
    if (!user.jurisdiction?.state) return null;
    filter['jurisdiction.state'] = user.jurisdiction.state;
  }
  if (user.role === ROLES.DISTRICT_CONTROL && !district) {
    if (!user.jurisdiction?.district || !user.jurisdiction?.state) return null;
    filter['jurisdiction.district'] = user.jurisdiction.district;
    filter['jurisdiction.state'] = user.jurisdiction.state;
  }
  if (user.role === ROLES.POLICE_ADMIN) {
    if (!user.jurisdiction?.policeStationId) return null;
    filter.policeStationId = user.jurisdiction.policeStationId;
  }
  return filter;
};

const EMPTY_OVERVIEW = {
  success: true,
  scope: {},
  totals: { cases: 0, newLast30Days: 0, resolutionRate: 0 },
  casesByStatus: { emergency_pending: 0, verified: 0, under_search: 0, found: 0, closed: 0 },
  sightingsByStatus: { pending: 0, verified: 0, rejected: 0 },
};

// @route GET /api/stats/overview
const overview = asyncHandler(async (req, res) => {
  const filter = scopeFilter(req.user, req.query);
  if (filter === null) { res.json(EMPTY_OVERVIEW); return; }

  const [byStatus, totalCases, last30dCases, sightingStats] = await Promise.all([
    Case.aggregate([{ $match: filter }, { $group: { _id: '$status', count: { $sum: 1 } } }]),
    Case.countDocuments(filter),
    Case.countDocuments({ ...filter, createdAt: { $gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) } }),
    Sighting.aggregate([
      { $lookup: { from: 'cases', localField: 'caseId', foreignField: '_id', as: 'case' } },
      { $unwind: '$case' },
      { $match: Object.keys(filter).reduce((acc, k) => ({ ...acc, [`case.${k}`]: filter[k] }), {}) },
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]),
  ]);

  const statusCounts = byStatus.reduce((acc, s) => ({ ...acc, [s._id]: s.count }), {});
  const sightingCounts = sightingStats.reduce((acc, s) => ({ ...acc, [s._id]: s.count }), {});
  const resolvedCount = (statusCounts.found || 0) + (statusCounts.closed || 0);

  res.json({
    success: true,
    scope: filter,
    totals: {
      cases: totalCases,
      newLast30Days: last30dCases,
      resolutionRate: totalCases ? Math.round((resolvedCount / totalCases) * 100) : 0,
    },
    casesByStatus: {
      emergency_pending: statusCounts.emergency_pending || 0,
      verified: statusCounts.verified || 0,
      under_search: statusCounts.under_search || 0,
      found: statusCounts.found || 0,
      closed: statusCounts.closed || 0,
    },
    sightingsByStatus: {
      pending: sightingCounts.pending || 0,
      verified: sightingCounts.verified || 0,
      rejected: sightingCounts.rejected || 0,
    },
  });
});

// @route GET /api/stats/timeseries?days=30
// Cases created per day — for a simple trend chart.
const timeseries = asyncHandler(async (req, res) => {
  const days = Math.min(Number(req.query.days) || 30, 180);
  const filter = scopeFilter(req.user, req.query);
  if (filter === null) { res.json({ success: true, days, series: [] }); return; }
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const rows = await Case.aggregate([
    { $match: { ...filter, createdAt: { $gte: since } } },
    { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } }, count: { $sum: 1 } } },
    { $sort: { _id: 1 } },
  ]);

  res.json({ success: true, days, series: rows.map((r) => ({ date: r._id, count: r.count })) });
});

// @route GET /api/stats/by-region
// State Control compares districts within their state; District Control
// compares police stations within their district (this is the piece
// that actually gives District Control a distinct, useful home view
// instead of the same state-wide numbers as their senior).
// System/National Admin compare states.
const byRegion = asyncHandler(async (req, res) => {
  const filter = scopeFilter(req.user, req.query);
  if (filter === null) {
    const groupedBy = req.user.role === ROLES.DISTRICT_CONTROL ? 'station' : req.user.role === ROLES.STATE_CONTROL ? 'district' : 'state';
    res.json({ success: true, groupedBy, regions: [] });
    return;
  }

  if (req.user.role === ROLES.DISTRICT_CONTROL) {
    const rows = await Case.aggregate([
      { $match: filter },
      { $group: { _id: '$policeStationId', total: { $sum: 1 }, found: { $sum: { $cond: [{ $eq: ['$status', 'found'] }, 1, 0] } } } },
      { $lookup: { from: 'policestations', localField: '_id', foreignField: '_id', as: 'station' } },
      { $unwind: { path: '$station', preserveNullAndEmptyArrays: true } },
      { $sort: { total: -1 } },
    ]);
    return res.json({
      success: true,
      groupedBy: 'station',
      regions: rows.map((r) => ({ region: r.station?.name || 'Unassigned station', total: r.total, found: r.found })),
    });
  }

  const groupField = req.user.role === ROLES.STATE_CONTROL ? '$jurisdiction.district' : '$jurisdiction.state';
  const rows = await Case.aggregate([
    { $match: filter },
    { $group: { _id: groupField, total: { $sum: 1 }, found: { $sum: { $cond: [{ $eq: ['$status', 'found'] }, 1, 0] } } } },
    { $sort: { total: -1 } },
  ]);

  res.json({
    success: true,
    groupedBy: req.user.role === ROLES.STATE_CONTROL ? 'district' : 'state',
    regions: rows.map((r) => ({ region: r._id || 'Unspecified', total: r.total, found: r.found })),
  });
});

module.exports = { overview, timeseries, byRegion, scopeFilter };
