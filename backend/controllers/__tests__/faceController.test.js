// Regression tests for nextFailedAttempts (controllers/faceController.js)
// — the lockout arithmetic for photo_match / blink / head_turn face
// verification. Run with:
//   node controllers/__tests__/faceController.test.js
//
// Small and simple by design, but this is the exact decision that
// determines whether a real officer's account gets automatically
// suspended — worth a permanent, direct test rather than trusting a
// one-time manual trace.
const { nextFailedAttempts } = require('../faceController');

let failures = 0;
function check(label, condition) {
  const pass = !!condition;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}`);
  if (!pass) failures++;
}

check('1st failure: count=1, not locked', JSON.stringify(nextFailedAttempts(0)) === JSON.stringify({ count: 1, locked: false }));
check('2nd failure: count=2, not locked', JSON.stringify(nextFailedAttempts(1)) === JSON.stringify({ count: 2, locked: false }));
check('3rd failure: count=3, LOCKED (matches LOCK_AFTER_FAILED_ATTEMPTS=3)', JSON.stringify(nextFailedAttempts(2)) === JSON.stringify({ count: 3, locked: true }));
check('a 4th failure somehow reached: still reports locked, never un-locks', JSON.stringify(nextFailedAttempts(3)) === JSON.stringify({ count: 4, locked: true }));
check('undefined/never-set starting count treated as 0, not NaN or a crash', JSON.stringify(nextFailedAttempts(undefined)) === JSON.stringify({ count: 1, locked: false }));
check('null starting count also treated as 0', JSON.stringify(nextFailedAttempts(null)) === JSON.stringify({ count: 1, locked: false }));

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
