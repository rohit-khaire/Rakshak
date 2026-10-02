// Regression tests for scopeFilter (controllers/statsController.js) —
// run with:
//   node controllers/__tests__/statsController.test.js
//
// Guards the fix found in the v16.1 follow-up audit: a filter key set
// to undefined (e.g. a Police Admin account with no policeStationId)
// doesn't narrow a MongoDB query — it's dropped entirely during BSON
// serialization before the query ever reaches the server, so it
// silently becomes "match everything" instead of "match nothing".
// Confirmed directly against the real bson package before this fix
// was trusted (see the README's v16.1 entry); this file guards that
// scopeFilter keeps returning null in that situation rather than an
// empty-but-technically-valid filter object.
//
// Plain Node, no test framework — matches this project's existing
// style. Exits 1 on any failure, 0 if everything passes.
const { ROLES } = require('../../config/roles');
const { scopeFilter } = require('../statsController');

let failures = 0;
function check(label, condition) {
  const pass = !!condition;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}`);
  if (!pass) failures++;
}

const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ---------- THE BUG: a required scope missing on the account must return null, never an empty-but-valid filter ----------
check('Police Admin, NO policeStationId -> null (not a filter that matches every case)', scopeFilter({ role: ROLES.POLICE_ADMIN, jurisdiction: {} }, {}) === null);
check('Police Admin, WITH policeStationId -> real filter', eq(scopeFilter({ role: ROLES.POLICE_ADMIN, jurisdiction: { policeStationId: 'abc123' } }, {}), { policeStationId: 'abc123' }));

// ---------- Same guard on District/State Control, for consistency (already validated as required at account creation, but must not regress if that ever changes) ----------
check('District Control, NO district -> null', scopeFilter({ role: ROLES.DISTRICT_CONTROL, jurisdiction: {} }, {}) === null);
check('District Control, WITH district+state -> real filter', eq(scopeFilter({ role: ROLES.DISTRICT_CONTROL, jurisdiction: { district: 'Palghar', state: 'Maharashtra' } }, {}), { 'jurisdiction.district': 'Palghar', 'jurisdiction.state': 'Maharashtra' }));
check('State Control, NO state -> null', scopeFilter({ role: ROLES.STATE_CONTROL, jurisdiction: {} }, {}) === null);
check('State Control, WITH state -> real filter', eq(scopeFilter({ role: ROLES.STATE_CONTROL, jurisdiction: { state: 'Maharashtra' } }, {}), { 'jurisdiction.state': 'Maharashtra' }));

// ---------- Explicit query params still work (an official narrowing their own already-scoped view) ----------
check('District Control with explicit ?district= overrides their own district', eq(scopeFilter({ role: ROLES.DISTRICT_CONTROL, jurisdiction: { district: 'Palghar', state: 'Maharashtra' } }, { district: 'Thane' }), { 'jurisdiction.district': 'Thane' }));

// ---------- Unrestricted roles: an empty filter here is CORRECT, not a bug — must stay distinguishable from the null case above ----------
check('super_admin with no query params -> empty filter (sees everything, by design)', eq(scopeFilter({ role: ROLES.SUPER_ADMIN, jurisdiction: {} }, {}), {}));

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
