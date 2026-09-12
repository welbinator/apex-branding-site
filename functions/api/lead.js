// Cloudflare Pages Function: POST /api/lead
// Handles the "$49/mo website" funnel form. Reuses the proven apexbranding.design
// pipeline: validation, honeypot, heuristic spam scoring, rate limit, parameterized
// D1 insert into the shared `submissions` table (form_name = 'website-offer-49'),
// then fire-and-forget Command Center push for genuine leads.
//
// Binding (see wrangler.jsonc):  DB -> D1 `apex-contact-submissions`
// Optional secrets: TURNSTILE_SECRET, PUSH_NOTIFY_SECRET, CC_NOTIFY_URL

const LIMITS = { first_name: 100, last_name: 100, email: 254, phone: 40, website: 300, message: 5000 };
const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_WINDOW_MIN = 10;
const MAX_BODY_BYTES = 16 * 1024;
const FORM_NAME = 'website-offer-49';

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });

const isEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
const clean = (v, max) => (typeof v !== 'string' ? '' : v.trim().slice(0, max));

const SPAM_KEYWORDS = [
  'viagra', 'cialis', 'casino', 'porn', 'crypto pump', 'forex',
  'bitcoin doubler', 'seo services', 'guest post', 'backlink',
  'loan offer', 'weight loss', 'buy followers',
];
function scoreSpam({ message, first_name, last_name, email }) {
  const reasons = [];
  const body = `${message}`.toLowerCase();
  const nameBlob = `${first_name} ${last_name}`.toLowerCase();
  const linkCount = (body.match(/https?:\/\/|www\.|\[url|<a\s/gi) || []).length;
  if (linkCount >= 3) reasons.push(`links:${linkCount}`);
  const hitKw = SPAM_KEYWORDS.filter((k) => body.includes(k));
  if (hitKw.length) reasons.push(`kw:${hitKw.slice(0, 3).join('/')}`);
  if (/\[url=|\[link=|<a\s+href/i.test(message)) reasons.push('markup');
  if (/[\u0400-\u04FF\u4E00-\u9FFF]/.test(nameBlob)) reasons.push('nonlatin-name');
  if (email && nameBlob.replace(/\s/g, '') === email.toLowerCase()) reasons.push('name=email');
  return { spam: reasons.length > 0, reason: reasons.join(',') };
}

async function hmacHex(secret, msg) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function notifyCommandCenter(env, lead) {
  const url = env.CC_NOTIFY_URL || 'https://cc.crweb.design/api/push/notify';
  const secret = env.PUSH_NOTIFY_SECRET;
  if (!secret) return;
  try {
    const ts = Math.floor(Date.now() / 1000);
    const body = JSON.stringify({
      name: `${lead.first_name} ${lead.last_name}`.trim(),
      email: lead.email,
      site: 'jameswelbes.com',
      message: `[$49/mo website lead] ${lead.business ? 'Business: ' + lead.business + '. ' : ''}${lead.message || ''}`.trim(),
      ts,
    });
    const sig = await hmacHex(secret, `v0:${ts}:${body}`);
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CC-Signature': `t=${ts},v0=${sig}` },
      body,
    });
  } catch (_) { /* CC down — lead already safe in D1 */ }
}

async function verifyTurnstile(token, secret, ip) {
  if (!secret) return { ok: true, reason: 'no-secret-configured' }; // no key set → skip (honeypot still guards)
  if (!token) return { ok: false, reason: 'no-token' };
  const form = new FormData();
  form.append('secret', secret);
  form.append('response', token);
  if (ip) form.append('remoteip', ip);
  const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: form });
  const data = await res.json().catch(() => ({ success: false }));
  return { ok: !!data.success, reason: (data['error-codes'] || []).join(',') };
}

async function rateLimited(db, ip) {
  if (!ip) return false;
  try {
    const sinceIso = new Date(Date.now() - RATE_LIMIT_WINDOW_MIN * 60_000)
      .toISOString().replace('T', ' ').slice(0, 19);
    const row = await db
      .prepare('SELECT COUNT(*) AS c FROM submissions WHERE ip_address = ? AND created_at >= ?')
      .bind(ip, sinceIso).first();
    return row && row.c >= RATE_LIMIT_MAX;
  } catch (_) { return false; }
}

export async function onRequestPost({ request, env, waitUntil }) {
  if (!env.DB) return json({ ok: false, error: 'Form storage is not configured yet.' }, 500);

  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) return json({ ok: false, error: 'Payload too large.' }, 413);

  let body;
  try { body = JSON.parse(raw); } catch (_) { return json({ ok: false, error: 'Invalid request.' }, 400); }

  const honeypotTripped = !!clean(body.website_hp, 200);
  const ip = request.headers.get('CF-Connecting-IP') || '';

  if (!honeypotTripped) {
    const ts = await verifyTurnstile(body.turnstile_token, env.TURNSTILE_SECRET, ip);
    if (!ts.ok) return json({ ok: false, error: 'Verification failed. Please try again.' }, 403);
  }

  const first_name = clean(body.first_name, LIMITS.first_name);
  const last_name = clean(body.last_name, LIMITS.last_name);
  const email = clean(body.email, LIMITS.email);
  const phone = clean(body.phone, LIMITS.phone);
  const business = clean(body.business, LIMITS.website);
  const message = clean(body.message, LIMITS.message);

  const errors = [];
  if (!first_name) errors.push('Your name is required.');
  if (!email || !isEmail(email)) errors.push('A valid email is required.');
  if (errors.length && !honeypotTripped) return json({ ok: false, error: errors.join(' ') }, 422);

  if (!honeypotTripped && (await rateLimited(env.DB, ip)))
    return json({ ok: false, error: 'Too many submissions. Please try again later.' }, 429);

  let is_spam = 0, spam_reason = null;
  if (honeypotTripped) { is_spam = 1; spam_reason = 'honeypot'; }
  else {
    const s = scoreSpam({ message, first_name, last_name, email });
    if (s.spam) { is_spam = 1; spam_reason = s.reason; }
  }

  // The `website` column stores the prospect's business name here (funnel context);
  // `message` carries any note. form_name segregates these from agency contact leads.
  try {
    await env.DB.prepare(
      `INSERT INTO submissions
        (first_name, last_name, email, phone, website, interests, outsourcing,
         budget, message, follow_up_ok, ip_address, user_agent,
         form_name, is_spam, spam_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      first_name, last_name, email, phone, business,
      JSON.stringify([]), '', '$49/mo', message, 1, ip,
      (request.headers.get('User-Agent') || '').slice(0, 500),
      FORM_NAME, is_spam, spam_reason
    ).run();
  } catch (_) {
    return json({ ok: false, error: 'Something went wrong. Please try again.' }, 500);
  }

  if (!is_spam) {
    const p = notifyCommandCenter(env, { first_name, last_name, email, message, business });
    if (waitUntil) waitUntil(p); else await p.catch(() => {});
  }

  return json({ ok: true });
}
