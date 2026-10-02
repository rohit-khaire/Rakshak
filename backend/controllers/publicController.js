const asyncHandler = require('express-async-handler');
const PoliceStation = require('../models/PoliceStation');

// @route GET /api/public/locations
// Unauthenticated on purpose — needed at registration time, before a
// token exists. Returns every known district and its stations (each
// station doubles as a real locality, e.g. "Vasai", "Bandra"),
// derived live from the actual seeded PoliceStation data rather than
// a hand-maintained frontend file — so it can't drift out of sync the
// way a static list would the moment a station is added, renamed, or
// re-seeded. The frontend's own curated locality list (which also
// includes non-station places like Virar, Boisar, Dahanu — real
// localities without their own station in this demo) is merged with
// this on top, so neither source has to be the only one.
const listLocations = asyncHandler(async (req, res) => {
  const stations = await PoliceStation.find({}).select('name state district geo').sort({ state: 1, district: 1, name: 1 });

  const byDistrict = {};
  for (const s of stations) {
    const key = `${s.state}|${s.district}`;
    if (!byDistrict[key]) byDistrict[key] = { state: s.state, district: s.district, localities: [] };
    byDistrict[key].localities.push({
      name: s.name.replace(/ Police Station$| Town Police Station$/, ''),
      lat: s.geo.coordinates[1],
      lng: s.geo.coordinates[0],
    });
  }

  res.json({ success: true, districts: Object.values(byDistrict) });
});

module.exports = { listLocations };
