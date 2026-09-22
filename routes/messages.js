// routes/messages.js — Fellow <-> Admin messaging
const express = require('express');
const router = express.Router();
const supabase = require('../config/supabase');
const { authMiddleware, adminMiddleware } = require('../middleware/auth');
const { safe, cleanText } = require('../services/util');
const { resolveRecipients } = require('../services/recipients');
const { sendToFellow, sendPlain } = require('../services/email');

// ── Fellow: Send message to admin ────────────────────────────────────
router.post('/send', authMiddleware, async (req, res) => {
  try {
    const subject = cleanText(req.body?.subject, 200);
    const message = String(req.body?.message || '').trim().slice(0, 5000);
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
    const reply = String(req.body?.reply || '').trim().slice(0, 5000);
    if (!reply) return res.status(400).json({ error: 'Reply is required.' });

    const { data: msg } = await supabase
      .from('messages').select('fellow_id, subject, message').eq('id', req.params.messageId).single();
    if (!msg) return res.status(404).json({ error: 'Message not found.' });

    const { data, error } = await supabase.from('message_replies').insert({
      message_id: req.params.messageId,
      admin_id: req.admin.id,
      reply,
      replied_at: new Date()
    }).select().single();

    if (error) throw error;

    await supabase.from('messages').update({ status: 'replied' }).eq('id', req.params.messageId);

    if (msg.fellow_id) {
      await safe(supabase.from('notifications').insert({
        fellow_id: msg.fellow_id,
        title: 'Admin replied to your message',
        message: 'An admin has replied to your message. Check your inbox.',
        type: 'info'
      }), 'notif');

      // email the one fellow — through the recipient resolver (activity email → respects opt-out)
      (async () => {
        const [fellow] = await resolveRecipients({ actorId: req.admin.id, actorType: 'admin', fellowIds: [msg.fellow_id], respectPrefs: true });
        if (fellow) await sendToFellow('message_reply', fellow, { reply, fromMentor: false });
      })().catch(e => console.error('[reply email]', e.message));
    } else {
      // public contact-form message: the sender's address is stored inside the message text
      const m = /^Email:\s*(\S+@\S+)/m.exec(msg.message || '');
      if (m) {
        sendPlain({
          to: m[1], subject: `Re: ${String(msg.subject || 'Your enquiry').replace(/^\[Contact Form\]\s*/, '').split(' — from ')[0]}`,
          heading: 'A reply from Drix Tech Talent', text: reply,
        }).catch(() => {});
      }
    }

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

// ── PUBLIC: Contact form (no auth needed) ────────────────────────────
router.post('/contact', async (req, res) => {
  try {
    const name = cleanText(req.body?.name, 120);
    const email = String(req.body?.email || '').trim().slice(0, 200);
    const subject = cleanText(req.body?.subject, 150);
    const message = String(req.body?.message || '').trim().slice(0, 5000);
    if (!name || !email || !message) return res.status(400).json({ error: 'Name, email and message are required.' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Please enter a valid email address.' });

    await supabase.from('messages').insert({
      fellow_id: null,
      subject: `[Contact Form] ${subject || 'General Enquiry'} — from ${name} <${email}>`,
      message: `From: ${name}\nEmail: ${email}\n\n${message}`,
      status: 'unread',
      sent_at: new Date()
    });

    res.json({ success: true });
  } catch(err) {
    res.status(500).json({ error: 'Failed to send message.' });
  }
});

module.exports = router;
