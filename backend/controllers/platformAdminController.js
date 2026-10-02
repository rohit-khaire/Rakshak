const asyncHandler = require('express-async-handler');
const AuditLog = require('../models/AuditLog');
const User = require('../models/User');
const { ROLES } = require('../config/roles');

// @route GET /api/admin/audit-logs?limit=100
const listAuditLogs = asyncHandler(async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  const logs = await AuditLog.find({})
    .populate('userId', 'name role')
    .sort({ createdAt: -1 })
    .limit(limit);
  res.json({ success: true, count: logs.length, logs });
});

// @route GET /api/admin/platform-stats
// System/National Admin's home view: platform health, not case data.
const platformStats = asyncHandler(async (req, res) => {
  const [usersByRole, usersByStatus, totalAuditEvents] = await Promise.all([
    User.aggregate([{ $group: { _id: '$role', count: { $sum: 1 } } }]),
    User.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]),
    AuditLog.countDocuments({}),
  ]);

  res.json({
    success: true,
    usersByRole: usersByRole.reduce((acc, r) => ({ ...acc, [r._id]: r.count }), {}),
    usersByStatus: usersByStatus.reduce((acc, s) => ({ ...acc, [s._id]: s.count }), {}),
    totalAuditEvents,
  });
});

// @route GET /api/admin/district-activity
// District Control's "who did what" feed — recent case actions taken
// by Police Admins within their OWN district only. This is the "see
// PSI Shinde registered new FIR" view: each entry names the officer
// and the action, so Call/Message can target that specific person
// directly from the same list.
const districtActivity = asyncHandler(async (req, res) => {
  if (req.user.role !== ROLES.DISTRICT_CONTROL) {
    res.status(403);
    throw new Error('This endpoint is scoped to District Control');
  }

  const officersInDistrict = await User.find({
    role: ROLES.POLICE_ADMIN,
    'jurisdiction.district': req.user.jurisdiction?.district,
    'jurisdiction.state': req.user.jurisdiction?.state,
  }).select('_id');

  const officerIds = officersInDistrict.map((o) => o._id);
  const limit = Math.min(Number(req.query.limit) || 50, 200);

  const logs = await AuditLog.find({ userId: { $in: officerIds } })
    .populate('userId', 'name phone email onDuty')
    .sort({ createdAt: -1 })
    .limit(limit);

  res.json({ success: true, count: logs.length, logs });
});

module.exports = { listAuditLogs, platformStats, districtActivity };


