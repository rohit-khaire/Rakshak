const asyncHandler = require('express-async-handler');
const User = require('../models/User');
const Case = require('../models/Case');
const Message = require('../models/Message');
const { ROLES } = require('../config/roles');
const { notifyUser } = require('../utils/notify');
const { logAction } = require('../utils/audit');
const { canViewCase, OFFICIAL_ROLES } = require('../utils/caseVisibility');

const sameDistrict = (a, b) => a?.jurisdiction?.district === b?.jurisdiction?.district && a?.jurisdiction?.state === b?.jurisdiction?.state;

// "The officer handling this case" — whoever attached the FIR (most
// direct point of contact) if it's been verified, otherwise any active
// Police Admin at the station it's currently assigned to. Returns null
// if neither exists yet (an unassigned Emergency Report has nobody to
// message yet — resolveArea/findNearestStation just hasn't matched a
// real admin, the same "no station provisioned" edge case
// utils/stationNotify.js already handles for notifications).
const resolveCaseOfficer = async (caseDoc) => {
  if (caseDoc.verifiedBy) {
    const officer = await User.findById(caseDoc.verifiedBy).select('name phone role status');
    if (officer && officer.status === 'active') return officer;
  }
  if (caseDoc.policeStationId) {
    const officer = await User.findOne({
      role: ROLES.POLICE_ADMIN, 'jurisdiction.policeStationId': caseDoc.policeStationId, status: 'active',
    }).select('name phone role');
    if (officer) return officer;
  }
  return null;
};

// @route POST /api/messages
// District Control can message any Police Admin in their own district
// at any time — they can always initiate. A Police Admin can only
// message their District Control back — never initiate — and only
// once that District Control has messaged OR called (see logCall
// below) them at least once. Real chain-of-command protocol: a junior
// officer doesn't cold-contact their superior, but has a genuine way
// to respond once reached out to.
const sendMessage = asyncHandler(async (req, res) => {
  const { to, message } = req.body;
  if (!to || !message?.trim()) { res.status(400); throw new Error('Recipient and message text are required'); }

  const recipient = await User.findById(to);
  if (!recipient) { res.status(404); throw new Error('Recipient not found'); }

  if (req.user.role === ROLES.DISTRICT_CONTROL) {
    if (recipient.role !== ROLES.POLICE_ADMIN || !sameDistrict(req.user, recipient)) {
      res.status(403);
      throw new Error('You can only message Police Admins within your own district');
    }
  } else if (req.user.role === ROLES.POLICE_ADMIN) {
    if (recipient.role !== ROLES.DISTRICT_CONTROL || !sameDistrict(req.user, recipient)) {
      res.status(403);
      throw new Error('You can only message your own District Control');
    }
    // Any prior entry FROM the DySP TO this PSI counts — a text
    // message or a logged call both satisfy "they reached out first".
    const dcInitiated = await Message.exists({ from: recipient._id, to: req.user._id });
    if (!dcInitiated) {
      res.status(403);
      throw new Error('You can only reply once your District Control has messaged or called you first \u2014 they haven\u2019t yet.');
    }
  } else {
    res.status(403);
    throw new Error('Messaging is only available between District Control and their Police Admins');
  }

  const msg = await Message.create({ from: req.user._id, to: recipient._id, type: 'text', message: message.trim() });

  await notifyUser({
    userId: recipient._id,
    type: 'system',
    message: `New message from ${req.user.name} (${req.user.role.replace('_', ' ')}) \u2014 check Messages to reply.`,
  });
  await logAction({ userId: req.user._id, action: 'MESSAGE_SENT', targetType: 'User', targetId: recipient._id, req });

  res.status(201).json({ success: true, messageDoc: msg });
});

// @route POST /api/messages/log-call
// A tel: link opens the phone's native dialer — the app has no way to
// know if the call actually connected, and pretending otherwise would
// be dishonest. What it CAN honestly record is that District Control
// tapped Call with intent to reach this officer, at this timestamp.
// That record lives in the same thread as text messages and counts
// exactly the same toward unlocking the Police Admin's reply above.
const logCall = asyncHandler(async (req, res) => {
  const { to } = req.body;
  const recipient = await User.findById(to);
  if (!recipient) { res.status(404); throw new Error('User not found'); }

  if (req.user.role === ROLES.DISTRICT_CONTROL) {
    if (recipient.role !== ROLES.POLICE_ADMIN || !sameDistrict(req.user, recipient)) {
      res.status(403);
      throw new Error('You can only call Police Admins within your own district');
    }
  } else {
    res.status(403);
    throw new Error('Not authorized to log a call to this user');
  }

  const msg = await Message.create({ from: req.user._id, to: recipient._id, type: 'call_logged', message: `${req.user.name} called via phone.` });
  await notifyUser({ userId: recipient._id, type: 'system', message: `${req.user.name} (district control) called you.` });
  await logAction({ userId: req.user._id, action: 'CALL_LOGGED', targetType: 'User', targetId: recipient._id, req });

  res.json({ success: true, messageDoc: msg });
});

// @route GET /api/messages/thread/:userId
// Every message (and logged call) between the current user and
// :userId, oldest first — either party can call this for their own
// shared thread.
const getThread = asyncHandler(async (req, res) => {
  const other = await User.findById(req.params.userId);
  if (!other) { res.status(404); throw new Error('User not found'); }

  const isValidPair = (
    (req.user.role === ROLES.DISTRICT_CONTROL && other.role === ROLES.POLICE_ADMIN && sameDistrict(req.user, other))
    || (req.user.role === ROLES.POLICE_ADMIN && other.role === ROLES.DISTRICT_CONTROL && sameDistrict(req.user, other))
  );
  if (!isValidPair) { res.status(403); throw new Error('No conversation available with this user'); }

  const messages = await Message.find({
    $or: [{ from: req.user._id, to: other._id }, { from: other._id, to: req.user._id }],
  }).sort({ createdAt: 1 });

  const canReply = req.user.role === ROLES.DISTRICT_CONTROL || messages.some((m) => String(m.from) === String(other._id));

  res.json({ success: true, messages, canReply, otherUser: { _id: other._id, name: other.name } });
});

// @route GET /api/messages/my-district-control
// Lets a Police Admin find who their own District Control is, so the
// frontend doesn't have to guess — resolved by matching jurisdiction.
const myDistrictControl = asyncHandler(async (req, res) => {
  if (req.user.role !== ROLES.POLICE_ADMIN) {
    res.status(403);
    throw new Error('This endpoint is only for Police Admin accounts');
  }
  const dc = await User.findOne({
    role: ROLES.DISTRICT_CONTROL,
    'jurisdiction.state': req.user.jurisdiction?.state,
    'jurisdiction.district': req.user.jurisdiction?.district,
    status: 'active',
  }).select('name');

  res.json({ success: true, districtControl: dc ? { _id: dc._id, name: dc.name } : null });
});

// @route POST /api/messages/case/:caseId
// Family portal's "Contact Officer" — a case-scoped conversation
// between whoever reported the case and whoever's handling it.
// Unlike DySP<->PSI messaging, BOTH directions can always initiate:
// there's no chain-of-command protocol reason for a family member
// anxious about their missing relative to wait for the officer to
// reach out first, and no reason an officer with an update should
// wait either.
const sendCaseMessage = asyncHandler(async (req, res) => {
  const { message } = req.body;
  if (!message?.trim()) { res.status(400); throw new Error('Message text is required'); }

  const caseDoc = await Case.findById(req.params.caseId);
  if (!caseDoc) { res.status(404); throw new Error('Case not found'); }

  const isReporter = String(caseDoc.createdBy) === String(req.user._id);
  let recipientId;

  if (isReporter) {
    const officer = await resolveCaseOfficer(caseDoc);
    if (!officer) { res.status(400); throw new Error('No officer is assigned to this case yet \u2014 check back once it\u2019s been routed to a station.'); }
    recipientId = officer._id;
  } else if (OFFICIAL_ROLES.includes(req.user.role) && canViewCase(req.user, caseDoc)) {
    recipientId = caseDoc.createdBy;
  } else {
    res.status(403);
    throw new Error('You are not authorized to message about this case.');
  }

  const msg = await Message.create({ from: req.user._id, to: recipientId, type: 'text', message: message.trim(), caseId: caseDoc._id });
  await notifyUser({
    userId: recipientId, type: 'system',
    message: `New message about ${caseDoc.fullName} from ${req.user.name} \u2014 check the case to reply.`,
    caseId: caseDoc._id,
  });
  await logAction({ userId: req.user._id, action: 'CASE_MESSAGE_SENT', targetType: 'Case', targetId: caseDoc._id, req });

  res.status(201).json({ success: true, messageDoc: msg });
});

// @route GET /api/messages/case/:caseId/thread
const getCaseThread = asyncHandler(async (req, res) => {
  const caseDoc = await Case.findById(req.params.caseId);
  if (!caseDoc) { res.status(404); throw new Error('Case not found'); }

  const isReporter = String(caseDoc.createdBy) === String(req.user._id);
  const isOfficial = OFFICIAL_ROLES.includes(req.user.role) && canViewCase(req.user, caseDoc);
  if (!isReporter && !isOfficial) { res.status(403); throw new Error('You are not authorized to view messages about this case.'); }

  const messages = await Message.find({ caseId: caseDoc._id }).sort({ createdAt: 1 }).populate('from', 'name role');
  const officer = isReporter ? await resolveCaseOfficer(caseDoc) : null;

  res.json({
    success: true,
    messages,
    officer: officer ? { _id: officer._id, name: officer.name, phone: officer.phone } : null,
  });
});

module.exports = { sendMessage, logCall, getThread, myDistrictControl, sendCaseMessage, getCaseThread };
