// routes/ai.js — Gemini proxy. The API key lives only here, in Render's
// environment variables. It is never sent to or visible in the browser.
const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../middleware/auth');

const GEMINI_URL = key =>
  `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${key}`;

router.post('/chat', authMiddleware, async (req, res) => {
  try {
    const { message, context } = req.body;
    if (!message || !message.trim()) {
      return res.status(400).json({ error: 'Message is required.' });
    }

    const key = process.env.GEMINI_API_KEY;
    if (!key) {
      // Graceful, expected state until an admin sets the key on Render
      return res.json({ success: false, not_configured: true });
    }

    const prompt = `You are a helpful AI learning assistant for the Drix Tech Talent Programme, a Nigerian tech training fellowship. Help students understand their coursework, answer tech questions, and guide their learning. Be concise, practical and encouraging. Keep answers short and clear.\n\nLesson context: ${context || 'General'}\n\nStudent question: ${message}`;

    const response = await fetch(GEMINI_URL(key), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.7, maxOutputTokens: 800 }
      })
    });

    const data = await response.json();

    if (data.error) {
      console.error('Gemini error:', data.error);
      return res.status(502).json({ error: 'AI assistant is temporarily unavailable.' });
    }

    const reply = data.candidates?.[0]?.content?.parts?.[0]?.text
      || 'I could not process that. Please try again.';

    res.json({ success: true, reply });
  } catch (err) {
    console.error('AI chat error:', err);
    res.status(500).json({ error: 'AI assistant is temporarily unavailable.' });
  }
});

module.exports = router;
