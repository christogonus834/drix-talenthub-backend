// services/email.js — Brevo transactional email.
// Rules: every call is fire-and-forget safe (never throws), everything is logged to email_log,
// activity emails respect fellows.email_notifications, account emails always send.

const jwt = require('jsonwebtoken');
const supabase = require('../config/supabase');
const { esc, frontendUrl, backendUrl } = require('./util');

const BREVO_URL = 'https://api.brevo.com/v3/smtp/email';
const _fetch = globalThis.fetch || require('node-fetch');
const DAILY_LIMIT = parseInt(process.env.BREVO_DAILY_LIMIT || '300', 10);

const ACCOUNT_TYPES = new Set(['application_received', 'welcome', 'rejected', 'certificate_ready']);

// ─── LOW LEVEL ───────────────────────────────────────────────────────
async function logEmail(row) {
  try { await supabase.from('email_log').insert(row); } catch (e) { /* logging must never break sending */ }
}

async function sendEmail({ to, toName, subject, html, type = 'other', fellowId = null, headers = null }) {
  if (!process.env.BREVO_API_KEY || !process.env.BREVO_SENDER_EMAIL) return { skipped: true }; // not configured
  if (!to) return { skipped: true };
  try {
    const payload = {
      sender: { email: process.env.BREVO_SENDER_EMAIL, name: process.env.BREVO_SENDER_NAME || 'Drix Tech Talent' },
      to: [{ email: to, name: toName || to }],
      subject,
      htmlContent: html,
    };
    if (headers) payload.headers = headers;

    const resp = await _fetch(BREVO_URL, {
      method: 'POST',
      headers: { 'api-key': process.env.BREVO_API_KEY, 'Content-Type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!resp.ok) {
      const errText = (await resp.text().catch(() => '')).slice(0, 500);
      console.error(`[EMAIL] Brevo ${resp.status} for ${type}:`, errText);
      await logEmail({ recipient_email: to, fellow_id: fellowId, email_type: type, subject, status: 'failed', error: `${resp.status} ${errText}` });
      return { ok: false };
    }
    await logEmail({ recipient_email: to, fellow_id: fellowId, email_type: type, subject, status: 'sent' });
    return { ok: true };
  } catch (err) {
    console.error('[EMAIL] Failed:', err.message); // never throw
    await logEmail({ recipient_email: to, fellow_id: fellowId, email_type: type, subject, status: 'failed', error: err.message });
    return { ok: false };
  }
}

// ─── UNSUBSCRIBE TOKENS ──────────────────────────────────────────────
function signUnsubToken(fellowId) {
  return jwt.sign({ sub: fellowId, purpose: 'unsubscribe' }, process.env.JWT_SECRET);
}
function verifyUnsubToken(token) {
  try {
    const d = jwt.verify(token, process.env.JWT_SECRET);
    return d.purpose === 'unsubscribe' ? d.sub : null;
  } catch (e) { return null; }
}
function unsubscribeUrl(fellowId) {
  return `${backendUrl()}/api/fellows/unsubscribe?token=${encodeURIComponent(signUnsubToken(fellowId))}`;
}

// ─── LAYOUT ──────────────────────────────────────────────────────────
function layout({ heading, bodyHtml, cta, unsubUrl }) {
  const fe = frontendUrl();
  const button = cta && cta.url
    ? `<p style="margin:28px 0 8px;"><a href="${esc(cta.url)}" style="background:#7C6EF7;color:#ffffff;text-decoration:none;padding:12px 26px;border-radius:8px;font-weight:600;font-size:14px;display:inline-block;">${esc(cta.label)}</a></p>`
    : '';
  const footer = unsubUrl
    ? `You are receiving this because you are a fellow on the Drix Tech Talent Programme.<br/><a href="${esc(unsubUrl)}" style="color:#7C6EF7;">Unsubscribe from activity emails</a>${fe ? ` · <a href="${esc(fe)}/dashboard" style="color:#7C6EF7;">Open dashboard</a>` : ''}`
    : `You are receiving this account email from the Drix Tech Talent Programme.`;
  return `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f4f5fb;font-family:Arial,Helvetica,sans-serif;">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f4f5fb;padding:24px 12px;"><tr><td align="center">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px;background:#ffffff;border-radius:12px;overflow:hidden;">
<tr><td style="background:#0f1020;padding:18px 28px;color:#ffffff;font-weight:800;letter-spacing:0.04em;font-size:15px;">DRIX <span style="color:#7C6EF7;">Tech Talent</span></td></tr>
<tr><td style="padding:28px;color:#1c1d2e;font-size:14px;line-height:1.7;">
<h2 style="margin:0 0 14px;font-size:20px;color:#0f1020;">${esc(heading)}</h2>
${bodyHtml}
${button}
</td></tr>
<tr><td style="padding:16px 28px;background:#fafaff;color:#8a8ca5;font-size:11px;line-height:1.6;">${footer}</td></tr>
</table></td></tr></table></body></html>`;
}

const p = t => `<p style="margin:0 0 12px;">${t}</p>`;
const nl2br = s => esc(s).replace(/\r?\n/g, '<br/>');
const dash = path => (frontendUrl() ? `${frontendUrl()}${path}` : '');
const fmtDate = d => d ? new Date(d).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Africa/Lagos' }) + ' (WAT)' : '';

// ─── TEMPLATES (return { subject, html }) ────────────────────────────
const templates = {
  application_received: (f) => ({
    subject: 'Application received',
    html: layout({
      heading: 'Application received',
      bodyHtml: p(`Hi ${esc(f.full_name)},`) + p('Thank you for applying to the Drix Tech Talent Programme. Your application is now under review and we will email you as soon as a decision is made.'),
    }),
  }),
  welcome: (f) => ({
    subject: 'Welcome to Drix Tech Talent',
    html: layout({
      heading: 'Welcome to Drix Tech Talent 🎉',
      bodyHtml: p(`Hi ${esc(f.full_name)},`) + p('Your application has been approved. You can now sign in to your dashboard, start your first module and join the community.'),
      cta: { label: 'Go to my dashboard', url: dash('/dashboard') },
    }),
  }),
  rejected: (f) => ({
    subject: 'Update on your application',
    html: layout({
      heading: 'Update on your application',
      bodyHtml: p(`Hi ${esc(f.full_name)},`) + p('Thank you for your interest in the Drix Tech Talent Programme. Unfortunately we are unable to offer you a place at this time. If you have questions, reply through the contact page on our website.'),
    }),
  }),
  certificate_ready: (f, d = {}) => ({
    subject: 'Your certificate is ready',
    html: layout({
      heading: 'Your certificate is ready 🎓',
      bodyHtml: p(`Congratulations ${esc(f.full_name)}!`) + p(`Your certificate${d.certId ? ` (ID: <strong>${esc(d.certId)}</strong>)` : ''} has been approved and issued. You can view and download it from your certificates page.`),
      cta: { label: 'View my certificate', url: dash('/dashboard/certificates') },
    }),
  }),
  module_unlocked: (f, d) => ({
    subject: `New module unlocked: ${d.title}`,
    html: layout({
      heading: 'A new module is open',
      bodyHtml: p(`Hi ${esc(f.full_name)},`) + p(`<strong>${esc(d.title)}</strong> is now unlocked and ready for you.`)
        + (d.deadline ? p(`Deadline: <strong>${esc(fmtDate(d.deadline))}</strong>`) : ''),
      cta: { label: 'Start the module', url: dash('/dashboard/courses') },
      unsubUrl: d.unsubUrl,
    }),
  }),
  assignment_graded: (f, d) => ({
    subject: 'Your assignment has been reviewed',
    html: layout({
      heading: d.approved ? 'Assignment approved ✅' : 'Revision needed on your assignment',
      bodyHtml: p(`Hi ${esc(f.full_name)},`)
        + p(`Your submission for <strong>${esc(d.assignmentTitle)}</strong> has been reviewed.`)
        + (d.grade !== null && d.grade !== undefined ? p(`Score: <strong>${esc(d.grade)} / ${esc(d.maxScore)}</strong>`) : '')
        + p(`Result: <strong>${d.approved ? 'Approved' : 'Needs revision'}</strong>`)
        + (d.feedback ? `<div style="background:#f4f5fb;border-left:3px solid #7C6EF7;padding:12px 14px;border-radius:6px;margin:10px 0;">${nl2br(d.feedback)}</div>` : ''),
      cta: { label: 'View feedback', url: dash('/dashboard') },
      unsubUrl: d.unsubUrl,
    }),
  }),
  announcement: (f, d) => ({
    subject: d.title,
    html: layout({
      heading: d.title,
      bodyHtml: p(`Hi ${esc(f.full_name)},`) + p(nl2br(d.content || '')),
      cta: { label: 'Open dashboard', url: dash('/dashboard') },
      unsubUrl: d.unsubUrl,
    }),
  }),
  message_reply: (f, d) => ({
    subject: d.fromMentor ? 'You have a reply from your mentor' : 'You have a reply from the Drix Tech Talent team',
    html: layout({
      heading: 'You have a new reply',
      bodyHtml: p(`Hi ${esc(f.full_name)},`) + p('You have a reply to your message:')
        + `<div style="background:#f4f5fb;border-left:3px solid #7C6EF7;padding:12px 14px;border-radius:6px;margin:10px 0;">${nl2br(d.reply)}</div>`,
      cta: { label: 'Open my inbox', url: dash('/dashboard/messages') },
      unsubUrl: d.unsubUrl,
    }),
  }),
};

// ─── HIGH LEVEL SENDERS ──────────────────────────────────────────────
// One fellow. Account emails always send; activity emails respect email_notifications.
async function sendToFellow(type, fellow, data = {}) {
  try {
    if (!fellow?.email) return { skipped: true };
    const isAccount = ACCOUNT_TYPES.has(type);
    if (!isAccount && fellow.email_notifications === false) return { skipped: true, reason: 'opted_out' };

    const d = { ...data };
    let headers = null;
    if (!isAccount) {
      d.unsubUrl = unsubscribeUrl(fellow.id);
      headers = { 'List-Unsubscribe': `<${d.unsubUrl}>` };
    }
    const { subject, html } = templates[type](fellow, d);
    return await sendEmail({ to: fellow.email, toName: fellow.full_name, subject, html, type, fellowId: fellow.id, headers });
  } catch (err) {
    console.error('[EMAIL] sendToFellow failed:', err.message);
    return { ok: false };
  }
}

async function emailsSentToday() {
  const start = new Date(); start.setUTCHours(0, 0, 0, 0);
  const { count } = await supabase.from('email_log').select('id', { count: 'exact', head: true })
    .eq('status', 'sent').gte('sent_at', start.toISOString());
  return count || 0;
}

// Many fellows. Logs the count first, respects the daily budget, sends in small parallel chunks.
async function sendBulk(type, fellows, data = {}) {
  const result = { type, recipients: fellows.length, attempted: 0, sent: 0, failed: 0, skipped_over_limit: 0 };
  try {
    if (!process.env.BREVO_API_KEY) { console.log(`[EMAIL] bulk ${type}: Brevo not configured, ${fellows.length} recipients skipped`); return result; }

    const used = await emailsSentToday();
    const budget = ACCOUNT_TYPES.has(type) ? Infinity : Math.max(0, DAILY_LIMIT - used); // account emails are never throttled by us
    console.log(`[EMAIL] bulk ${type}: ${fellows.length} recipients, ${used}/${DAILY_LIMIT} used today, budget ${budget}`);

    const toSend = fellows.slice(0, budget);
    result.skipped_over_limit = fellows.length - toSend.length;
    if (result.skipped_over_limit > 0) console.warn(`[EMAIL] bulk ${type}: ${result.skipped_over_limit} recipients NOT emailed (daily limit)`);

    const CHUNK = 10;
    for (let i = 0; i < toSend.length; i += CHUNK) {
      const chunk = toSend.slice(i, i + CHUNK);
      const res = await Promise.all(chunk.map(f => sendToFellow(type, f, data)));
      res.forEach(r => { result.attempted++; if (r?.ok) result.sent++; else if (!r?.skipped) result.failed++; });
      if (i + CHUNK < toSend.length) await new Promise(r => setTimeout(r, 300));
    }
  } catch (err) {
    console.error('[EMAIL] sendBulk failed:', err.message);
  }
  console.log(`[EMAIL] bulk ${type} done:`, JSON.stringify(result));
  return result;
}

// Email to a non-fellow (public contact-form reply)
async function sendPlain({ to, toName, subject, heading, text, type = 'contact_reply' }) {
  return sendEmail({ to, toName, subject, type, html: layout({ heading, bodyHtml: p(nl2br(text)) }) });
}

module.exports = {
  sendEmail, sendToFellow, sendBulk, sendPlain, emailsSentToday,
  verifyUnsubToken, unsubscribeUrl, templates, DAILY_LIMIT, ACCOUNT_TYPES,
};
