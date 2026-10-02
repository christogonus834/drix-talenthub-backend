// routes/exam-extract.js — admin uploads a PDF/Word doc of questions + answers they've already
// written, we extract the raw text and ask the AI to STRUCTURE it into {question, options,
// correct_answer} JSON. The AI never invents questions — it only reformats what's already on
// the page. Admin reviews/edits the result in the UI before anything is saved to the exam.
const express = require('express');
const router = express.Router();
const multer = require('multer');
const { adminMiddleware } = require('../middleware/auth');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 }, // 15MB — plenty for a text-based question doc
  fileFilter: (req, file, cb) => {
    const allowed = [
      'application/pdf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error('Please upload a PDF or Word (.doc/.docx) file.'), false);
  },
});

const MAX_TEXT_CHARS = 20000; // generous for even a large exam; keeps the AI call fast and cheap
const _fetch = globalThis.fetch || require('node-fetch');

async function extractText(file) {
  if (file.mimetype === 'application/pdf') {
    const pdfParse = require('pdf-parse');
    const data = await pdfParse(file.buffer);
    return data.text;
  }
  // .doc and .docx both route through mammoth, which handles the modern .docx XML format;
  // legacy binary .doc has much weaker support, so we tell the admin to re-save as .docx if that fails.
  const mammoth = require('mammoth');
  const result = await mammoth.extractRawText({ buffer: file.buffer });
  return result.value;
}

function extractJsonArray(text) {
  const cleaned = text.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
  const start = cleaned.indexOf('[');
  const end = cleaned.lastIndexOf(']');
  if (start === -1 || end === -1 || end <= start) return null;
  try { return JSON.parse(cleaned.slice(start, end + 1)); } catch (e) { return null; }
}

function buildPrompt(text) {
  return `You will be given raw text extracted from a document of multiple-choice exam questions that a human has ALREADY written, each with 4 answer options and the correct answer already indicated somehow (bolded, marked with an asterisk, written as "Answer: B" / "Correct: C", or listed in a separate answer key at the end of the document).

Your job is ONLY to reformat what is already there into JSON — never invent, rewrite, or add questions that aren't in the text.

Return ONLY a JSON array, nothing else, in exactly this shape:
[
  {"question": "question text without its number", "options": ["option A text", "option B text", "option C text", "option D text"], "correct_answer": "A"}
]

Rules:
- correct_answer must be the LETTER (A, B, C, or D) matching the correct option's position — never the option's text.
- If you genuinely cannot tell which option is correct for a question, set correct_answer to null — never guess.
- If a question has fewer than 4 options, leave the remaining slots as empty strings.
- Extract every question you can find, even if formatting is inconsistent across the document.
- Strip question numbers (e.g. "1.", "Q3)") from the question text itself.

Document text:
"""
${text.slice(0, MAX_TEXT_CHARS)}
"""`;
}

// Minimal, happy-path provider calls — deliberately simpler than routes/ai.js's fellow-chat
// logic (no caching/cooldown/throttle machinery), since this is a low-frequency admin action
// where a clear error and a retry button is perfectly fine. Kept fully separate from ai.js so
// nothing here can ever affect the fellow-facing AI assistant.
async function callGemini(prompt) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return null;
  const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
  const res = await _fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.1, maxOutputTokens: 8192 } }),
  });
  const data = await res.json().catch(() => ({}));
  if (data.error) { console.error('[exam-extract] Gemini error:', data.error.message); return null; }
  return (data.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('');
}

async function callGroq(prompt) {
  const key = process.env.GROQ_API_KEY;
  if (!key) return null;
  const model = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';
  const res = await _fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], temperature: 0.1, max_tokens: 8192 }),
  });
  const data = await res.json().catch(() => ({}));
  if (data.error) { console.error('[exam-extract] Groq error:', data.error.message); return null; }
  return data.choices?.[0]?.message?.content || null;
}

router.post('/', adminMiddleware, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
    if (!process.env.GEMINI_API_KEY && !process.env.GROQ_API_KEY) {
      return res.status(503).json({ error: 'No AI provider is configured on the server (GEMINI_API_KEY or GROQ_API_KEY).' });
    }

    let rawText;
    try {
      rawText = await extractText(req.file);
    } catch (e) {
      console.error('[exam-extract] text extraction failed:', e.message);
      return res.status(400).json({ error: 'Could not read that file. If it\'s a legacy .doc, try re-saving it as .docx or PDF first.' });
    }
    if (!rawText || rawText.trim().length < 20) {
      return res.status(400).json({ error: 'No readable text found in that file — is it a scanned image rather than typed text?' });
    }

    const prompt = buildPrompt(rawText);
    let reply = await callGemini(prompt);
    if (!reply) reply = await callGroq(prompt);
    if (!reply) return res.status(502).json({ error: 'The AI parser is temporarily unavailable. Please try again shortly.' });

    const questions = extractJsonArray(reply);
    if (!Array.isArray(questions) || !questions.length) {
      return res.status(502).json({ error: "Couldn't find any recognizable questions in that document. Double-check the formatting, or enter them manually." });
    }

    // Light validation/cleanup — never trust the AI's output shape blindly.
    const cleaned = questions
      .filter(q => q && typeof q.question === 'string' && q.question.trim())
      .map(q => ({
        question: String(q.question).trim().slice(0, 1000),
        options: Array.from({ length: 4 }, (_, i) => String(q.options?.[i] ?? '').trim().slice(0, 500)),
        correct_answer: ['A', 'B', 'C', 'D'].includes(q.correct_answer) ? q.correct_answer : null,
      }));

    res.json({ success: true, questions: cleaned, truncated: rawText.length > MAX_TEXT_CHARS });
  } catch (err) {
    console.error('Exam extraction error:', err);
    if (err.message?.includes('Please upload a PDF')) return res.status(400).json({ error: err.message });
    res.status(500).json({ error: 'Failed to process that file.' });
  }
});

module.exports = router;
