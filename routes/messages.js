// routes/messages.js — Fellow <-> Admin messaging
const express = require('express');
const router = express.Router();
const supabase = require('../config/supabase');
const { authMiddleware, adminMiddleware } = require('../middleware/auth');

// ── Fellow: Send message to admin ────────────────────────────────────
router.post('/send', authMiddleware, async (req, res) => {
  try {
    const { subject, message } = req.body;
    if (!message) return res.status(400).json({ error: 'Message is required.' });
    const { data, error } = await supabase.from('messages').insert({
      fellow_id: req.user.id,
      subject: subject || 'General Enquiry',
      message,
      status: 'unread',
      sent_at: new Date()
    }).select().single();
    if (error) throw error;
    res.json({ success: true, message: data });
  } catch(err) {
    res.status(500).json({ error: 'Failed to send message.' });
  }
});

// ── Fellow: Get my messages and replies ──────────────────────────────
router.get('/my', authMiddleware, async (req, res) => {
  try {
    const { data } = await supabase
      .from('messages')
      .select('*, message_replies(*)')
      .eq('fellow_id', req.user.id)
      .order('sent_at', { ascending: false });
    res.json(data || []);
  } catch(err) {
    res.status(500).json({ error: 'Failed.' });
  }
});

// ── Admin: Get all messages ───────────────────────────────────────────
router.get('/admin/all', adminMiddleware, async (req, res) => {
  try {
    const { status } = req.query;
    let query = supabase
      .from('messages')
      .select('*, fellows(full_name, email, profile_photo, fellow_id), message_replies(*)')
      .order('sent_at', { ascending: false });
    if (status) query = query.eq('status', status);
    const { data } = await query;
    res.json(data || []);
  } catch(err) {
    res.status(500).json({ error: 'Failed.' });
  }
});

// ── Admin: Reply to a message ─────────────────────────────────────────
router.post('/admin/:messageId/reply', adminMiddleware, async (req, res) => {
  try {
    const { reply } = req.body;
    if (!reply) return res.status(400).json({ error: 'Reply is required.' });

    const { data: msg } = await supabase
      .from('messages').select('fellow_id').eq('id', req.params.messageId).single();

    const { data, error } = await supabase.from('message_replies').insert({
      message_id: req.params.messageId,
      admin_id: req.admin.id,
      reply,
      replied_at: new Date()
    }).select().single();

    if (error) throw error;

    // Mark original message as replied
    await supabase.from('messages').update({ status: 'replied' }).eq('id', req.params.messageId);

    // Notify fellow
    await supabase.from('notifications').insert({
      fellow_id: msg.fellow_id,
      title: 'Admin replied to your message',
      message: `An admin has replied to your message. Check your inbox.`,
      type: 'info'
    }).catch(() => {});

    res.json({ success: true, reply: data });
  } catch(err) {
    res.status(500).json({ error: 'Failed to send reply.' });
  }
});

// ── Admin: Mark message as read ───────────────────────────────────────
router.patch('/admin/:messageId/read', adminMiddleware, async (req, res) => {
  try {
    await supabase.from('messages').update({ status: 'read' }).eq('id', req.params.messageId);
    res.json({ success: true });
  } catch(err) {
    res.status(500).json({ error: 'Failed.' });
  }
});

module.exports = router;
