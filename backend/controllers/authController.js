const asyncHandler = require('express-async-handler');
const User = require('../models/User');
const generateToken = require('../utils/generateToken');
const { ROLES } = require('../config/roles');
const { logAction } = require('../utils/audit');
const { findNearestStation } = require('../utils/findNearestStation');
const { notifyUser } = require('../utils/notify');

// @route POST /api/auth/register
// Public self-registration is only for Citizen / Family. Official roles
// (police_admin, district_control, etc.) are created by a senior admin
// via POST /api/users (see userController) and start pending_approval.
const register = asyncHandler(async (req, res) => {
  const { name, email, phone, password, role, lat, lng, locality } = req.body;

  const publicRoles = [ROLES.CITIZEN, ROLES.FAMILY];
  const finalRole = publicRoles.includes(role) ? role : ROLES.CITIZEN;

  const exists = await User.findOne({ email: email.toLowerCase() });
  if (exists) {
    res.status(400);
    throw new Error('An account with this email already exists');
  }

  // Resolves "which area does this account belong to" the same way a
  // case's location determines its station — via real geo-distance to
  // the nearest known police jurisdiction, not a free-text field.
  // locality (e.g. "Virar") is the one piece that ISN'T re-derived
  // server-side — it's whatever the frontend already resolved, either
  // the exact name someone picked from the district/locality selector,
  // or a reverse-geocoded label for a raw GPS point. Trusted as
  // display text only; it never drives any jurisdiction logic, which
  // still runs entirely on the geo-derived district/state above.
  let homeLocation;
  if (lat && lng) {
    const nearestStation = await findNearestStation(lat, lng);
    homeLocation = {
      geo: { type: 'Point', coordinates: [Number(lng), Number(lat)] },
      state: nearestStation?.state,
      district: nearestStation?.district,
      locality: typeof locality === 'string' ? locality.slice(0, 120) : undefined,
    };
  }

  const user = await User.create({ name, email, phone, password, role: finalRole, homeLocation });

  await logAction({ userId: user._id, action: 'USER_REGISTERED', targetType: 'User', targetId: user._id, req });

  res.status(201).json({
    success: true,
    user: user.toSafeObject(),
    token: generateToken(user._id),
  });
});

// @route POST /api/auth/login
const login = asyncHandler(async (req, res) => {
  const { email, password } = req.body;

  const user = await User.findOne({ email: email?.toLowerCase() }).select('+password');
  if (!user || !(await user.comparePassword(password))) {
    res.status(401);
    throw new Error('Invalid email or password');
  }
  if (user.status === 'suspended') {
    res.status(403);
    throw new Error('Account suspended — contact an administrator');
  }

  user.lastLoginAt = new Date();

  // One-time nudge — the Dashboard banner and the sidebar badge stay
  // visible on every page for as long as enrollment is incomplete, so
  // this doesn't need to repeat on every login; it just makes sure the
  // very first login after this feature existed actually surfaces it.
  if (user.role === ROLES.POLICE_ADMIN && user.faceEnrollment?.status === 'not_enrolled' && !user.faceEnrollment?.reminderSentAt) {
    user.faceEnrollment.reminderSentAt = new Date();
    await notifyUser({
      userId: user._id,
      type: 'system',
      message: 'Your face recognition enrollment is pending \u2014 visit your District Control office, or complete it online under Face Enrollment.',
    });
  }

  await user.save();

  res.json({
    success: true,
    user: user.toSafeObject(),
    token: generateToken(user._id),
  });
});

// @route GET /api/auth/me
const getMe = asyncHandler(async (req, res) => {
  res.json({ success: true, user: req.user.toSafeObject() });
});

module.exports = { register, login, getMe };
