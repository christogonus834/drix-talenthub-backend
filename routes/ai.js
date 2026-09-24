// routes/ai.js — Gemini proxy, with a Groq fallback when Gemini is fully exhausted or down.
// Keys live only here, in Render's environment variables. Never sent to (or visible in) the browser.
//
// Why fellows hit "temporarily unavailable" after a few questions:
// one shared free-tier key = a small per-minute / per-day quota PER MODEL, shared by every fellow.
// This route (1) rotates across Gemini models when one is out of quota, (2) remembers which
// models are cooling down so it doesn't waste calls, (3) retries brief overloads, (4) caches
// repeated questions, (5) throttles each fellow so one person can't drain the shared quota, and
// (6) falls back to Groq (a separate, free, no-card-required provider) if every Gemini model is
// exhausted or unreachable — so fellows keep getting answers instead of an error.
const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../middleware/auth');

// Each model has its own free quota, so more models = more capacity.
// Override the whole list on Render with GEMINI_MODELS="modelA,modelB" (first is tried first).
// gemini-2.5-* and gemini-2.0-* returned 404 "no longer available to new users" in production
// logs on 24 Sep 2026 — Google has moved new API keys onto the Gemini 3 line. Update this list
// (or override with GEMINI_MODELS on Render) if Google retires these too.
const MODELS = [...new Set(
  (process.env.GEMINI_MODELS ||
    [process.env.GEMINI_MODEL, 'gemini-flash-latest', 'gemini-3.5-flash', 'gemini-3.1-flash-lite', 'gemini-3-flash-preview']
      .filter(Boolean).join(','))
    .split(',').map(m => m.trim()).filter(Boolean)
)];

// Groq fallback — free tier, no credit card, OpenAI-compatible endpoint. Only used when every
// Gemini model above is out of quota or unreachable. Groq's catalog varies by account (some
// models are gated), so — same as Gemini above — this tries a short list and skips any that
// come back "does not exist / no access" instead of betting everything on one hardcoded name.
// Override the whole list with GROQ_MODELS on Render (first one wins), or GROQ_MODEL for a single one.
const GROQ_MODELS = [...new Set(
  (process.env.GROQ_MODELS ||
    [process.env.GROQ_MODEL, 'llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'llama-3.1-70b-versatile', 'gemma2-9b-it']
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
      if (!data.error) return { data, model, provider: 'gemini' };

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

// Groq cools down the same way Gemini models do, so repeated exhausted-everything requests
// don't hammer it either. Tries each model in GROQ_MODELS in turn; a 404 (model doesn't exist /
// no access on this account) or 429 (out of quota) moves to the next one instead of giving up.
async function askGroq(key, prompt, fetchFn = fetch) {
  let quota = false;
  for (const model of GROQ_MODELS) {
    if ((cooldown.get('groq:' + model) || 0) > Date.now()) { quota = true; continue; }
    try {
      const response = await fetchFn('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.7, max_tokens: 1024,
        })
      });
      const data = await response.json().catch(() => ({}));
      if (!data.error && data.choices?.[0]?.message?.content) {
        return { data: { text: data.choices[0].message.content }, model, provider: 'groq' };
      }
      const code = response.status;
      console.error(`[AI] Groq error (model ${model}): ${code} — ${data.error?.message || 'unknown'}`);
      if (code === 429) { cooldown.set('groq:' + model, Date.now() + 60 * 1000); quota = true; continue; }
      if (code === 404) continue;                                    // this account can't use this model — try the next
      return { error: { quota: false, code } };                      // a real failure (bad key, etc.) — stop
    } catch (e) {
      console.error('[AI] Groq request failed:', e.message);
      return { error: { quota: false, code: 503 } };
    }
  }
  return { error: { quota, code: quota ? 429 : 404 } };
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

    const geminiKey = process.env.GEMINI_API_KEY;
    const groqKey = process.env.GROQ_API_KEY;
    if (!geminiKey && !groqKey) return res.json({ success: false, not_configured: true });

    const k = cacheKey(context, message);
    const cached = cacheGet(k);
    if (cached) return res.json({ success: true, reply: cached, cached: true });

    const wait = throttled(req.user.id);
    if (wait) return res.status(429).json({ error: `You're asking quickly — please wait ${wait} seconds and try again.` });

    const prompt = `You are a helpful AI learning assistant for the Drix Tech Talent Programme, a Nigerian tech training fellowship. Help students understand their coursework, answer tech questions, and guide their learning. Be concise, practical and encouraging. Keep answers short and clear.\n\nLesson context: ${context}\n\nStudent question: ${message}`;

    let result = { error: { quota: false, code: 503 } };
    if (geminiKey) result = await askGemini(geminiKey, prompt);
    // Fall back to Groq if Gemini isn't configured, or every Gemini model is out of quota/down.
    if (result.error && groqKey) result = await askGroq(groqKey, prompt);

    if (result.error) {
      if (result.error.quota) {
        return res.status(429).json({ error: 'The AI assistant is very busy right now. Please try again in a minute.' });
      }
      return res.status(502).json({ error: 'AI assistant is temporarily unavailable.' });
    }

    let reply;
    if (result.provider === 'groq') {
      reply = (result.data.text || '').trim();
    } else {
      const cand = result.data.candidates?.[0];
      reply = (cand?.content?.parts || []).map(p => p.text || '').join('').trim();
      if (!reply) console.error('[AI] Empty reply. finishReason:', cand?.finishReason, 'blocked:', result.data.promptFeedback?.blockReason);
    }
    if (!reply) return res.json({ success: true, reply: 'I could not answer that one. Try rephrasing your question.' });

    cacheSet(k, reply);
    res.json({ success: true, reply, model: result.model, provider: result.provider });
  } catch (err) {
    console.error('AI chat error:', err);
    res.status(500).json({ error: 'AI assistant is temporarily unavailable.' });
  }
});

module.exports = router;
module.exports._test = { askGemini, askGroq, throttled, cooldown, MODELS, GROQ_MODELS, LIMIT };