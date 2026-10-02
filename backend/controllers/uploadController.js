const asyncHandler = require('express-async-handler');
const fs = require('fs/promises');
const { logAction } = require('../utils/audit');
const { contentMatchesDeclaredType } = require('../utils/fileSignature');

// @route POST /api/uploads  (field name: "files", accepts up to 5)
// Returns public URLs the client can attach to a case (photoUrl) or a
// sighting (evidenceUrls). Files are served statically from /uploads.
const uploadFiles = asyncHandler(async (req, res) => {
  if (!req.files || req.files.length === 0) {
    res.status(400);
    throw new Error('No files were uploaded');
  }

  // middleware/upload.js's fileFilter only checked the client-supplied
  // Content-Type header — trivially spoofable. This checks what the
  // file actually is. Reject the whole batch (cleaning up every file
  // already written) rather than silently dropping just the bad one,
  // so the response is never a confusing partial success.
  for (const f of req.files) {
    const ok = await contentMatchesDeclaredType(f.path, f.mimetype);
    if (!ok) {
      await Promise.all(req.files.map((file) => fs.unlink(file.path).catch(() => {})));
      res.status(400);
      throw new Error(`"${f.originalname}" doesn't actually look like a ${f.mimetype} file.`);
    }
  }

  const baseUrl = `${req.protocol}://${req.get('host')}`;
  const files = req.files.map((f) => ({
    url: `${baseUrl}/uploads/${f.filename}`,
    originalName: f.originalname,
    mimeType: f.mimetype,
    sizeBytes: f.size,
  }));

  await logAction({
    userId: req.user._id,
    action: 'FILES_UPLOADED',
    targetType: 'Upload',
    targetId: req.user._id,
    meta: { count: files.length },
    req,
  });

  res.status(201).json({ success: true, files });
});

module.exports = { uploadFiles };
