const asyncHandler = require('express-async-handler');
const User = require('../models/User');
const PoliceStation = require('../models/PoliceStation');
const { ROLE_LEVEL, ROLES } = require('../config/roles');
const { logAction } = require('../utils/audit');
const { notifyUser } = require('../utils/notify');
const { resolveUserArea } = require('../utils/resolveArea');
const { asSafeString } = require('../utils/sanitize');
const { canManageJurisdiction, manageableUsersFilter } = require('../utils/userHierarchy');

// @route POST /api/users
// A senior admin creates an official account. Enforces you can only
// create roles below your own authority level. Special case: an
// NGO Admin creating a Volunteer automatically ties that volunteer to
// their own organization — they cannot create accounts for any other
// role or org.
const createOfficialUser = asyncHandler(async (req, res) => {
  const { name, email, phone, password, role } = req.body;
  let { jurisdiction, ngo } = req.body;

  if (req.user.role === ROLES.NGO_ADMIN) {
    if (role !== ROLES.NGO_VOLUNTEER) {
      res.status(403);
      throw new Error('NGO Admins may only create Volunteer accounts under their own organization');
    }
    ngo = {
      organizationName: req.user.ngo?.organizationName,
      registrationId: req.user.ngo?.registrationId,
      supervisorId: req.user._id,
    };
  } else {
    const requesterLevel = ROLE_LEVEL[req.user.role] ?? 0;
    const targetLevel = ROLE_LEVEL[role] ?? 0;
    if (targetLevel >= requesterLevel) {
      res.status(403);
      throw new Error('You cannot create an account with equal or higher authority than your own');
    }

    // Previously the frontend just sent whatever state/district text
    // the creator typed — meaning a District Control could place a
    // new Police Admin in a different district entirely, or leave it
    // blank. Jurisdiction-bearing roles are now forced into the
    // creator's own territory instead of trusting client input for
    // it; only Super Admin / System Admin (platform bootstrap) can
    // set an arbitrary one.
    if (req.user.role === ROLES.STATE_CONTROL) {
      jurisdiction = { ...jurisdiction, state: req.user.jurisdiction?.state };
    } else if (req.user.role === ROLES.DISTRICT_CONTROL) {
      jurisdiction = { ...jurisdiction, state: req.user.jurisdiction?.state, district: req.user.jurisdiction?.district };
    }
    // Jurisdiction-bearing roles are useless without a real
    // jurisdiction — an empty district here is exactly what makes a
    // Police Admin's face-enrollment request (or any cross-jurisdiction
    // notification) match zero District Control accounts: the query
    // is 'jurisdiction.district': '<real value>', and '' never equals
    // that. Reject the creation outright instead of silently producing
    // an official nobody's hierarchy can ever find.
    const needsDistrict = [ROLES.POLICE_ADMIN, ROLES.DISTRICT_CONTROL].includes(role);
    const needsState = needsDistrict || role === ROLES.STATE_CONTROL;
    if (needsState && !jurisdiction?.state?.trim()) {
      res.status(400);
      throw new Error(`A ${role.replace('_', ' ')} account requires a state.`);
    }
    if (needsDistrict && !jurisdiction?.district?.trim()) {
      res.status(400);
      throw new Error(`A ${role.replace('_', ' ')} account requires a district.`);
    }

    // A Police Admin's jurisdiction.policeStationId is exactly what
    // canViewCase matches a case's own policeStationId against (see
    // utils/caseVisibility.js) — this was previously accepted
    // unvalidated (or not sent at all — the Admin Users form never
    // collected it), so this endpoint would happily create an
    // account that could never see a single case routed to a
    // station. Seeded demo accounts aren't affected: seed.js writes
    // to the User model directly, bypassing this controller.
    if (role === ROLES.POLICE_ADMIN) {
      if (!jurisdiction?.policeStationId) {
        res.status(400);
        throw new Error('A police admin account requires a police station.');
      }
      const station = await PoliceStation.findById(jurisdiction.policeStationId).catch(() => null);
      if (!station || station.district !== jurisdiction.district) {
        res.status(400);
        throw new Error('That police station was not found in the selected district.');
      }
    }
  }

  const exists = await User.findOne({ email: email.toLowerCase() });
  if (exists) { res.status(400); throw new Error('An account with this email already exists'); }

  const user = await User.create({ name, email, phone, password, role, jurisdiction, ngo, status: 'active' });

  await logAction({ userId: req.user._id, action: 'OFFICIAL_USER_CREATED', targetType: 'User', targetId: user._id, req, meta: { role } });

  res.status(201).json({ success: true, user: user.toSafeObject() });
});

// @route GET /api/users?role=&status=
// NGO Admins are scoped to only their own volunteers. Every other
// CAN_MANAGE_USERS role is scoped by canManageJurisdiction/
// manageableUsersFilter — this used to return literally every user on
// the platform for State/District Control, with no restriction at all.
const listUsers = asyncHandler(async (req, res) => {
  const role = asSafeString(req.query.role);
  const status = asSafeString(req.query.status);
  let filter;

  if (req.user.role === ROLES.NGO_ADMIN) {
    filter = { role: ROLES.NGO_VOLUNTEER, 'ngo.supervisorId': req.user._id };
  } else {
    filter = manageableUsersFilter(req.user);
  }
  if (status) filter.status = status;

  let users = await User.find(filter).sort({ createdAt: -1 });
  // Narrowed in application code rather than merged into the Mongo
  // filter above — that filter is the actual security boundary (e.g.
  // State Control's role:{$in:[...]}), and a query param should only
  // ever narrow it further, never have a chance to replace it.
  if (role) users = users.filter((u) => u.role === role);

  res.json({ success: true, count: users.length, users: users.map((u) => u.toSafeObject()) });
});

// @route PATCH /api/users/:id/approve
const approveUser = asyncHandler(async (req, res) => {
  const user = await User.findById(req.params.id);
  if (!user) { res.status(404); throw new Error('User not found'); }

  if (req.user.role === ROLES.NGO_ADMIN) {
    if (String(user.ngo?.supervisorId) !== String(req.user._id)) {
      res.status(403);
      throw new Error('You can only manage volunteers within your own organization');
    }
  } else if (!canManageJurisdiction(req.user, user.role, user.jurisdiction)) {
    res.status(403);
    throw new Error('You don\u2019t have authority over this account \u2014 it\u2019s outside your jurisdiction, or at or above your own level.');
  }

  user.status = 'active';
  await user.save();
  await logAction({ userId: req.user._id, action: 'USER_APPROVED', targetType: 'User', targetId: user._id, req });
  res.json({ success: true, user: user.toSafeObject() });
});

// @route PATCH /api/users/:id/suspend
const suspendUser = asyncHandler(async (req, res) => {
  const user = await User.findById(req.params.id);
  if (!user) { res.status(404); throw new Error('User not found'); }

  if (req.user.role === ROLES.NGO_ADMIN) {
    if (String(user.ngo?.supervisorId) !== String(req.user._id)) {
      res.status(403);
      throw new Error('You can only manage volunteers within your own organization');
    }
  } else if (!canManageJurisdiction(req.user, user.role, user.jurisdiction)) {
    res.status(403);
    throw new Error('You don\u2019t have authority over this account \u2014 it\u2019s outside your jurisdiction, or at or above your own level.');
  }

  user.status = 'suspended';
  await user.save();
  await logAction({ userId: req.user._id, action: 'USER_SUSPENDED', targetType: 'User', targetId: user._id, req });
  res.json({ success: true, user: user.toSafeObject() });
});

// @route PATCH /api/users/me/duty-status
// Self-toggle — a Police Admin marks themselves on/off duty, so their
// District Control's officer directory reflects who's actually
// reachable right now, not just who's assigned to a station on paper.
const toggleDuty = asyncHandler(async (req, res) => {
  if (req.user.role !== ROLES.POLICE_ADMIN) {
    res.status(403);
    throw new Error('Duty status only applies to Police Station Admin accounts');
  }
  req.user.onDuty = req.body.onDuty !== undefined ? !!req.body.onDuty : !req.user.onDuty;
  await req.user.save();
  res.json({ success: true, onDuty: req.user.onDuty });
});

// @route GET /api/users/my-area
// "What area is this account associated with" — the same question,
// answered the same way, for every single role. Previously this had
// no single answer: Citizen/Family had homeLocation, officials had
// jurisdiction, NGO accounts had neither. Powers a consistent
// "📍 Your area: …" line on the home screen regardless of who's
// logged in, and backs NGO default-scoping in caseController.listCases.
const myArea = asyncHandler(async (req, res) => {
  const area = await resolveUserArea(req.user);
  res.json({ success: true, ...area });
});

module.exports = { createOfficialUser, listUsers, approveUser, suspendUser, toggleDuty, myArea };
