const asyncHandler = require('express-async-handler');

// @route GET /api/geo/reverse?lat=&lng=
// Resolves raw coordinates to a human-readable place name via
// OpenStreetMap's free Nominatim service — no API key required, and
// it pairs naturally with the Leaflet/OSM map this app already uses.
// This is the "smart element that tells you the raw location behind
// a lat/lng" piece: every screen that captures coordinates can now
// show what they actually resolve to, instead of a bare decimal pair
// nobody can sanity-check at a glance.
//
// Runs server-side rather than being called directly from the
// browser — Nominatim's usage policy wants a real User-Agent and
// modest, non-parallel request volume, both easier to honor here
// than in client JS, and it avoids a CORS round-trip too.
const reverseGeocode = asyncHandler(async (req, res) => {
  const { lat, lng } = req.query;
  if (!lat || !lng) { res.status(400); throw new Error('lat and lng are required'); }

  const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lng)}&zoom=14&addressdetails=1`;

  try {
    const response = await fetch(url, {
      headers: {
        // Nominatim rejects/blocks requests with no identifying UA.
        'User-Agent': 'RakshakMissingPersonsApp/1.0 (student final-year project)',
        'Accept-Language': 'en',
      },
    });
    if (!response.ok) throw new Error(`Nominatim responded ${response.status}`);
    const data = await response.json();

    const a = data.address || {};
    // A short, human-scannable label — Nominatim's own display_name
    // is often a long, noisy full address (postcode, country, etc.)
    // that's more than this needs. De-duplicated in case two levels
    // resolve to the same name (e.g. town === city_district).
    const parts = [
      a.suburb || a.neighbourhood || a.village || a.town,
      a.city_district || a.town || a.city,
      a.county || a.state_district,
      a.state,
    ].filter(Boolean);
    const label = [...new Set(parts)].slice(0, 3).join(', ') || data.display_name || null;

    res.json({
      success: true,
      label,
      district: a.county || a.state_district || null,
      state: a.state || null,
    });
  } catch (err) {
    // Never block a form on this — it's a helpful confirmation, not a
    // required field. Degrade quietly instead of a 500.
    res.json({ success: false, label: null, error: 'Could not resolve this location right now.' });
  }
});

module.exports = { reverseGeocode };
