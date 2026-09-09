// routes/upload.js — File uploads (videos, PDFs, docs) stored as base64 in Supabase
const express = require('express');
const router = express.Router();
const multer = require('multer');
const supabase = require('../config/supabase');
const { adminMiddleware } = require('../middleware/auth');

// Store in memory then upload to Supabase Storage
const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: { fileSize: 200 * 1024 * 1024 }, // 200MB max
  fileFilter: (req, file, cb) => {
    const allowed = [
      'video/mp4', 'video/webm', 'video/ogg', 'video/avi', 'video/mov',
      'application/pdf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.ms-powerpoint',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'image/jpeg', 'image/png', 'image/gif', 'image/webp',
      'audio/mpeg', 'audio/wav', 'audio/ogg',
      'application/zip', 'text/plain'
    ];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error(`File type ${file.mimetype} not allowed.`), false);
  }
});

// ── Admin: Upload lesson file ─────────────────────────────────────────
router.post('/lesson-file', adminMiddleware, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });

    const { lesson_id, track_id } = req.body;
    const ext = req.file.originalname.split('.').pop();
    const filename = `lessons/${track_id || 'general'}/${Date.now()}-${req.file.originalname.replace(/[^a-zA-Z0-9.-]/g, '_')}`;

    // Upload to Supabase Storage
    const { data, error } = await supabase.storage
      .from('drix-content')
      .upload(filename, req.file.buffer, {
        contentType: req.file.mimetype,
        upsert: false
      });

    if (error) {
      // If bucket doesn't exist, return base64 fallback
      console.error('Storage error:', error.message);
      const base64 = req.file.buffer.toString('base64');
      const dataUrl = `data:${req.file.mimetype};base64,${base64}`;
      return res.json({
        success: true,
        url: dataUrl,
        filename: req.file.originalname,
        type: req.file.mimetype,
        size: req.file.size,
        storage: 'inline'
      });
    }

    // Get public URL
    const { data: { publicUrl } } = supabase.storage
      .from('drix-content')
      .getPublicUrl(filename);

    // Update lesson if lesson_id provided
    if (lesson_id) {
      await supabase.from('lessons').update({
        content_url: publicUrl,
        type: req.file.mimetype.startsWith('video/') ? 'video'
            : req.file.mimetype === 'application/pdf' ? 'pdf' : 'document'
      }).eq('id', lesson_id);
    }

    res.json({
      success: true,
      url: publicUrl,
      filename: req.file.originalname,
      type: req.file.mimetype,
      size: req.file.size,
      storage: 'supabase'
    });
  } catch(err) {
    console.error('Upload error:', err);
    res.status(500).json({ error: err.message || 'Upload failed.' });
  }
});

// ── Admin: Upload profile/logo image ──────────────────────────────────
router.post('/image', adminMiddleware, upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No image uploaded.' });
    const filename = `images/${Date.now()}-${req.file.originalname.replace(/[^a-zA-Z0-9.-]/g, '_')}`;

    const { error } = await supabase.storage
      .from('drix-content')
      .upload(filename, req.file.buffer, { contentType: req.file.mimetype });

    if (error) {
      const base64 = `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`;
      return res.json({ success: true, url: base64 });
    }

    const { data: { publicUrl } } = supabase.storage.from('drix-content').getPublicUrl(filename);
    res.json({ success: true, url: publicUrl });
  } catch(err) {
    res.status(500).json({ error: 'Upload failed.' });
  }
});

module.exports = router;
