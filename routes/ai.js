// routes/ai.js — Gemini proxy. The API key lives only here, in Render's environment
// variables. It is never sent to (or visible in) the browser.
//
// Why fellows hit "temporarily unavailable" after a few questions:
// one shared free-tier key = a small per-minute / per-day quota PER MODEL, shared by every fellow.
// This route now (1) rotates to another model when one is out of quota, (2) remembers which
// models are cooling down so it doesn't waste calls, (3) retries brief overloads, (4) caches
// repeated questions, and (5) throttles each fellow so one person can't drain the shared quota.
const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../middleware/auth');

// Each model has its own free quota, so more models = more capacity.
// Override the whole list on Render with GEMINI_MODELS="modelA,modelB" (first is tried first).
const MODELS = [...new Set(
  (process.env.GEMINI_MODELS ||
    [process.env.GEMINI_MODEL, 'gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.0-flash', 'gemini-2.0-flash-lite', 'gemini-flash-latest']
      .filter(Boolean).join(','))
    .split(',').map(m => m.trim()).filter(Boolean)
)];

const sleep = ms => new Promise(r => setTimeout(r, ms));
const cooldown = new Map();          // model -> timestamp (ms) until which it is skipped

function coolDown(model, err) {
  let secs = 60;
  const info = (err?.details || []).find(d => String(d['@type'] || '').includes('RetryInfo'));
  const m = info && /(\d+(\.\d+)?)s/.exec(String(info.retryDelay || ''));
  if (m) secs = Math.min(300, Math.max(5, Math.ceil(parseFloat(m[1]))));
  cooldown.set(model, Date.now() + secs * 1000);
}

async function askGemini(key, prompt, fetchFn = fetch) {
  let quota = false;
  for (const model of MODELS) {
    if ((cooldown.get(model) || 0) > Date.now()) { quota = true; continue; }   // still cooling down

    let data = null, code = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await fetchFn(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            // generous: some Gemini models spend part of this on internal "thinking"
            generationConfig: { temperature: 0.7, maxOutputTokens: 2048 }
          })
        }
      );
      data = await response.json().catch(() => ({}));
      if (!data.error) return { data, model };

      code = data.error.code;
      console.error(`[AI] Gemini error (model ${model}): ${code} ${data.error.status || ''} — ${data.error.message}`);
      if ((code === 503 || code === 500) && attempt === 0) { await sleep(1200); continue; }   // brief overload: retry once
      break;
    }

    if (code === 429) { coolDown(model, data.error); quota = true; continue; }          // out of quota → next model
    if (code === 404 || code === 503 || code === 500) continue;                         // retired / overloaded → next model
    return { error: { fatal: true, code } };                                            // 400/401/403: key or setup problem
  }
  return { error: { quota, code: quota ? 429 : 503 } };
}

// ── per-fellow throttle (protects the shared quota) ───────────────────
const LIMIT = 8, WINDOW_MS = 60 * 1000;
const hits = new Map();
function throttled(fellowId) {
  const now = Date.now();
  const arr = (hits.get(fellowId) || []).filter(t => now - t < WINDOW_MS);
  if (arr.length >= LIMIT) { hits.set(fellowId, arr); return Math.ceil((WINDOW_MS - (now - arr[0])) / 1000); }
  arr.push(now); hits.set(fellowId, arr);
  if (hits.size > 5000) for (const [k, v] of hits) if (!v.some(t => now - t < WINDOW_MS)) hits.delete(k);
  return 0;
}

// ── tiny answer cache (same lesson + same question → same answer, no quota used) ──
const cache = new Map();
const CACHE_MS = 15 * 60 * 1000;
const cacheKey = (context, message) => `${context}||${message}`.toLowerCase().replace(/\s+/g, ' ').trim();
function cacheGet(k) { const h = cache.get(k); if (h && h.exp > Date.now()) return h.reply; cache.delete(k); return null; }
function cacheSet(k, reply) {
  if (cache.size >= 300) cache.delete(cache.keys().next().value);
  cache.set(k, { reply, exp: Date.now() + CACHE_MS });
}

router.post('/chat', authMiddleware, async (req, res) => {
  try {
    const message = String(req.body?.message || '').trim().slice(0, 2000);
    const context = String(req.body?.context || 'General').slice(0, 500);
    if (!message) return res.status(400).json({ error: 'Message is required.' });

    const key = process.env.GEMINI_API_KEY;
    if (!key) return res.json({ success: false, not_configured: true });

    const k = cacheKey(context, message);
    const cached = cacheGet(k);
    if (cached) return res.json({ success: true, reply: cached, cached: true });

    const wait = throttled(req.user.id);
    if (wait) return res.status(429).json({ error: `You're asking quickly — please wait ${wait} seconds and try again.` });

    const prompt = `You are a helpful AI learning assistant for the Drix Tech Talent Programme, a Nigerian tech training fellowship. Help students understand their coursework, answer tech questions, and guide their learning. Be concise, practical and encouraging. Keep answers short and clear.\n\nLesson context: ${context}\n\nStudent question: ${message}`;

    const result = await askGemini(key, prompt);
    if (result.error) {
      if (result.error.quota) {
        return res.status(429).json({ error: 'The AI assistant is very busy right now. Please try again in a minute.' });
      }
      return res.status(502).json({ error: 'AI assistant is temporarily unavailable.' });
    }

    const cand = result.data.candidates?.[0];
    const reply = (cand?.content?.parts || []).map(p => p.text || '').join('').trim();
    if (!reply) {
      console.error('[AI] Empty reply. finishReason:', cand?.finishReason, 'blocked:', result.data.promptFeedback?.blockReason);
      return res.json({ success: true, reply: 'I could not answer that one. Try rephrasing your question.' });
    }

    cacheSet(k, reply);
    res.json({ success: true, reply, model: result.model });
  } catch (err) {
    console.error('AI chat error:', err);
    res.status(500).json({ error: 'AI assistant is temporarily unavailable.' });
  }
});

module.exports = router;
module.exports._test = { askGemini, throttled, cooldown, MODELS, LIMIT };