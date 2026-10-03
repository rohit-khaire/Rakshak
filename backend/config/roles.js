/**
 * PROJECT RAKSHAK — ROLE HIERARCHY
 * ---------------------------------
 * Mirrors Chapter 3 of the Master Documentation.
 *
 *                National Rakshak Administrator (super_admin)
 *                          |
 *              -------------------------
 *              |                       |
 *        State Control Room      System Administrator
 *              |
 *        District Control Room
 *              |
 *        Police Station Admin
 *              |
 *     -----------------------------
 *     |           |               |
 *   Family     NGO Admin       Citizen
 *                  |
 *            NGO Volunteer
 *
 * ROLE_LEVEL is used for simple "is this role senior enough" checks
 * (higher number = more authority over case data). It intentionally
 * does NOT imply NGO/Family/Citizen outrank each other — those three
 * are peers who each only see what they're entitled to; see
 * middleware/authorize.js for the real permission logic.
 */

const ROLES = Object.freeze({
  SUPER_ADMIN: 'super_admin', // National Rakshak Administrator
  SYSTEM_ADMIN: 'system_admin', // Technical administrator
  STATE_CONTROL: 'state_control', // State Control Room
  DISTRICT_CONTROL: 'district_control', // District Control Room
  POLICE_ADMIN: 'police_admin', // Police Station Admin (creates/verifies cases)
  NGO_ADMIN: 'ngo_admin',
  NGO_VOLUNTEER: 'ngo_volunteer',
  FAMILY: 'family',
  CITIZEN: 'citizen',
});

// Authority level purely for "administrative reach" comparisons
// (used e.g. to decide who can escalate/reassign a case).
const ROLE_LEVEL = Object.freeze({
  [ROLES.SUPER_ADMIN]: 100,
  [ROLES.SYSTEM_ADMIN]: 90,
  [ROLES.STATE_CONTROL]: 80,
  [ROLES.DISTRICT_CONTROL]: 70,
  [ROLES.POLICE_ADMIN]: 60,
  [ROLES.NGO_ADMIN]: 30,
  [ROLES.NGO_VOLUNTEER]: 20,
  [ROLES.FAMILY]: 10,
  [ROLES.CITIZEN]: 10,
});

// Roles allowed to officially create a case (case creation is always
// FIR-anchored and performed by an authenticated official — see
// WORKFLOW-004 in ART_D). Family can only create an "Emergency Report"
// (pre-FIR, restricted visibility) — see WORKFLOW-003.
const CAN_CREATE_VERIFIED_CASE = [ROLES.POLICE_ADMIN, ROLES.DISTRICT_CONTROL, ROLES.STATE_CONTROL, ROLES.SUPER_ADMIN];
const CAN_CREATE_EMERGENCY_REPORT = [ROLES.FAMILY];
const CAN_VERIFY_SIGHTING = [ROLES.POLICE_ADMIN, ROLES.DISTRICT_CONTROL, ROLES.STATE_CONTROL, ROLES.SUPER_ADMIN];
const CAN_SUBMIT_SIGHTING = [ROLES.CITIZEN, ROLES.NGO_VOLUNTEER, ROLES.NGO_ADMIN, ROLES.FAMILY];

// Operational roles: can verify sightings, change case status, edit case
// details, view/restore version history. Deliberately EXCLUDES
// System Admin — that role manages the platform (users, audit logs,
// uptime), not live investigations. This was a permissions overreach
// in the first pass and is now corrected.
const OPERATIONAL_ROLES = [ROLES.POLICE_ADMIN, ROLES.DISTRICT_CONTROL, ROLES.STATE_CONTROL, ROLES.SUPER_ADMIN];

// Platform-wide dashboard/stats visibility — broader than OPERATIONAL_ROLES
// because System Admin should still be able to *view* aggregate numbers,
// just not act on individual cases.
const ADMIN_ROLES = [
  ROLES.SUPER_ADMIN,
  ROLES.SYSTEM_ADMIN,
  ROLES.STATE_CONTROL,
  ROLES.DISTRICT_CONTROL,
  ROLES.POLICE_ADMIN,
];

// Who can create/manage OTHER user accounts. NGO Admin is included but
// scoped in the controller to only their own volunteers — they cannot
// see or manage the wider user base.
const CAN_MANAGE_USERS = [ROLES.SUPER_ADMIN, ROLES.SYSTEM_ADMIN, ROLES.STATE_CONTROL, ROLES.DISTRICT_CONTROL, ROLES.NGO_ADMIN];

// Platform-management-only actions (user approval/suspension across the
// whole system, audit log access). NGO Admin is excluded here even
// though it's in CAN_MANAGE_USERS above, since NGO Admin's user
// management is scoped to their own org only.
const PLATFORM_ADMIN_ROLES = [ROLES.SUPER_ADMIN, ROLES.SYSTEM_ADMIN, ROLES.STATE_CONTROL, ROLES.DISTRICT_CONTROL];

module.exports = {
  ROLES,
  ROLE_LEVEL,
  CAN_CREATE_VERIFIED_CASE,
  CAN_CREATE_EMERGENCY_REPORT,
  CAN_VERIFY_SIGHTING,
  CAN_SUBMIT_SIGHTING,
  CAN_MANAGE_USERS,
  PLATFORM_ADMIN_ROLES,
  OPERATIONAL_ROLES,
  ADMIN_ROLES,
};
