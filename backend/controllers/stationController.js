const asyncHandler = require('express-async-handler');
const PoliceStation = require('../models/PoliceStation');
const User = require('../models/User');
const { ROLES } = require('../config/roles');
const { asSafeString } = require('../utils/sanitize');

// @route GET /api/stations
// District Control gets stations in their own district by default;
// State/System/Super Admin can pass ?district= or see all.
const listStations = asyncHandler(async (req, res) => {
  const district = asSafeString(req.query.district);
  const state = asSafeString(req.query.state);
  const filter = {};

  if (req.user.role === ROLES.DISTRICT_CONTROL && !district) {
    filter.district = req.user.jurisdiction?.district;
  } else if (district) {
    filter.district = district;
  }
  if (state) filter.state = state;

  const stations = await PoliceStation.find(filter).sort({ name: 1 });
  res.json({ success: true, count: stations.length, stations });
});

// @route GET /api/stations/officers
// The "who's on duty and how do I reach them" directory — District
// Control's own district by default (State/System/Super can pass
// ?district= or see everything). Each station lists its assigned
// Police Admin(s) with phone + on-duty status, so a call/message
// action always goes to a specific real officer, never a broadcast.
const listOfficers = asyncHandler(async (req, res) => {
  const district = asSafeString(req.query.district);
  const state = asSafeString(req.query.state);
  const filter = {};

  if (req.user.role === ROLES.DISTRICT_CONTROL && !district) {
    filter.district = req.user.jurisdiction?.district;
  } else if (district) {
    filter.district = district;
  }
  if (state) filter.state = state;

  const stations = await PoliceStation.find(filter).sort({ name: 1 });

  const withOfficers = await Promise.all(stations.map(async (station) => {
    const officers = await User.find({
      role: ROLES.POLICE_ADMIN,
      'jurisdiction.policeStationId': station._id,
      status: 'active',
    }).select('name phone email onDuty lastLoginAt faceEnrollment.status');
    return { _id: station._id, name: station.name, district: station.district, state: station.state, officers };
  }));

  res.json({ success: true, stations: withOfficers });
});

module.exports = { listStations, listOfficers };
