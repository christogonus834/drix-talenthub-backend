// routes/ai.js — Gemini proxy. The API key lives only here, in Render's
// environment variables. It is never sent to or visible in the browser.
const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../middleware/auth');

// Model can be changed on Render (GEMINI_MODEL) without touching code.
// If a model has been retired (404), the next one in the list is tried automatically.
const MODELS = [
  process.env.GEMINI_MODEL,
  'gemini-2.5-flash',
  'gemini-flash-latest',
  'gemini-2.0-flash',
].filter(Boolean);

async function askGemini(key, prompt) {
  let lastError = null;
  for (const model of MODELS) {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          // generous limit: some Gemini models spend part of it on internal "thinking"
          generationConfig: { temperature: 0.7, maxOutputTokens: 2048 }
        })
      }
    );
    const data = await response.json().catch(() => ({}));

    if (!data.error) return { data, model };

    lastError = { model, status: data.error.code, message: data.error.message };
    console.error(`[AI] Gemini error (model ${model}): ${data.error.code} ${data.error.status || ''} — ${data.error.message}`);

    // Only a missing/retired model is worth retrying with the next one.
    // A bad key, quota or permission error will fail the same way on every model.
    if (data.error.code !== 404) break;
  }
  return { error: lastError };
}

router.post('/chat', authMiddleware, async (req, res) => {
  try {
    const { message, context } = req.body;
    if (!message || !String(message).trim()) {
      return res.status(400).json({ error: 'Message is required.' });
    }

    const key = process.env.GEMINI_API_KEY;
    if (!key) {
      // Graceful, expected state until an admin sets the key on Render
      return res.json({ success: false, not_configured: true });
    }

    const prompt = `You are a helpful AI learning assistant for the Drix Tech Talent Programme, a Nigerian tech training fellowship. Help students understand their coursework, answer tech questions, and guide their learning. Be concise, practical and encouraging. Keep answers short and clear.\n\nLesson context: ${String(context || 'General').slice(0, 500)}\n\nStudent question: ${String(message).slice(0, 2000)}`;

    const result = await askGemini(key, prompt);
    if (result.error) {
      return res.status(502).json({ error: 'AI assistant is temporarily unavailable.' });
    }

    const cand = result.data.candidates?.[0];
    const reply = (cand?.content?.parts || []).map(p => p.text || '').join('').trim();

    if (!reply) {
      console.error('[AI] Empty reply. finishReason:', cand?.finishReason, 'blocked:', result.data.promptFeedback?.blockReason);
      return res.json({ success: true, reply: 'I could not answer that one. Try rephrasing your question.' });
    }

    res.json({ success: true, reply });
  } catch (err) {
    console.error('AI chat error:', err);
    res.status(500).json({ error: 'AI assistant is temporarily unavailable.' });
  }
});

module.exports = router;