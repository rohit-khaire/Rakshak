const asyncHandler = require('express-async-handler');
const Notification = require('../models/Notification');

// @route GET /api/notifications
const listMyNotifications = asyncHandler(async (req, res) => {
  const notifications = await Notification.find({ userId: req.user._id })
    .sort({ createdAt: -1 })
    .limit(100);
  const unreadCount = await Notification.countDocuments({ userId: req.user._id, read: false });
  res.json({ success: true, count: notifications.length, unreadCount, notifications });
});

// @route PATCH /api/notifications/:id/read
const markRead = asyncHandler(async (req, res) => {
  const notification = await Notification.findOne({ _id: req.params.id, userId: req.user._id });
  if (!notification) { res.status(404); throw new Error('Notification not found'); }
  notification.read = true;
  await notification.save();
  res.json({ success: true, notification });
});

// @route PATCH /api/notifications/read-all
const markAllRead = asyncHandler(async (req, res) => {
  await Notification.updateMany({ userId: req.user._id, read: false }, { $set: { read: true } });
  res.json({ success: true });
});

module.exports = { listMyNotifications, markRead, markAllRead };
