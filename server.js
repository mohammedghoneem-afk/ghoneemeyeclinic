'use strict';
/**
 * Clinic website server — zero dependencies (Node 18+).
 * Public site + booking API + staff dashboard API.
 * Patients book a DAY at a branch (entry is first come, first served; no specific time).
 * WhatsApp API sending is optional and OFF by default (config.json → whatsapp.enabled).
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = __dirname;

// ---------- .env loader (no dependency) ----------
try {
  const envFile = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
  for (const line of envFile.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch (_) { /* no .env is fine */ }

const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const env = process.env;
const PORT = Number(env.PORT) || 3000;
const BASE_URL = (env.BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const ADMIN_PASSWORD = env.ADMIN_PASSWORD || '';
const WA_TOKEN = env.WA_TOKEN || '';
const WA_PHONE_ID = env.WA_PHONE_ID || '';
const WA_ENABLED = cfg.whatsapp.enabled === true;           // master switch (off = no automatic WhatsApp at all)
const WA_LIVE = WA_ENABLED && Boolean(WA_TOKEN && WA_PHONE_ID); // enabled + keys present = real sending
const TRUST_PROXY = env.TRUST_PROXY === '1';
const DATA_DIR = path.join(ROOT, 'data');
const DB_FILE = path.join(DATA_DIR, 'appointments.json');
const OUTBOX_LOG = path.join(DATA_DIR, 'outbox.log');
fs.mkdirSync(DATA_DIR, { recursive: true });

// ---------- storage ----------
let db = { appointments: [] };
try { db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch (_) { /* fresh */ }
function save() {
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_FILE);
}

// ---------- time helpers (clinic timezone) ----------
const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
function nowLocal() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: cfg.timezone, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
  }).formatToParts(new Date());
  const p = Object.fromEntries(parts.map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}
function toMin(date, time) { // naive minutes, same zone on both sides of any comparison
  const [y, m, d] = date.split('-').map(Number);
  const [h, mi] = time.split(':').map(Number);
  return Date.UTC(y, m - 1, d, h, mi) / 60000;
}
const nowMin = () => { const n = nowLocal(); return toMin(n.date, n.time); };
const validDate = s => /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s + 'T00:00:00Z'));
function addDays(date, n) {
  const d = new Date(date + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// ---------- branches & sessions ----------
const branchOf = id => cfg.branches.find(b => b.id === id);
function sessionFor(branch, date) { // the clinic's opening window that day (no individual times)
  const key = DAY_KEYS[new Date(date + 'T00:00:00Z').getUTCDay()];
  const r = branch.workingHours[key] || [];
  return r.length ? { start: r[0][0], end: r[r.length - 1][1] } : null;
}
function bookableDays(branchId) {
  const branch = branchOf(branchId);
  if (!branch) return [];
  const now = nowLocal(), cap = cfg.maxBookingsPerSession || 0, out = [];
  for (let i = 0; i <= cfg.maxAdvanceDays; i++) {
    const date = addDays(now.date, i), s = sessionFor(branch, date);
    if (!s) continue;
    if (i === 0 && now.time >= s.end) continue; // today's session is over
    const booked = db.appointments.filter(a => a.branch === branchId && a.date === date &&
      (a.status === 'booked' || a.status === 'attended')).length;
    out.push({ date, start: s.start, end: s.end, full: cap > 0 && booked >= cap });
  }
  return out;
}

// ---------- phone ----------
function normalizePhone(raw) {
  let d = String(raw || '').replace(/[٠-٩]/g, c => c.charCodeAt(0) - 0x660) // Arabic digits
    .replace(/[^\d+]/g, '');
  if (d.startsWith('+')) d = d.slice(1);
  else if (d.startsWith('00')) d = d.slice(2);
  else if (d.startsWith('0')) d = cfg.defaultCountryCode + d.slice(1);
  d = d.replace(/\D/g, '');
  return d.length >= 8 && d.length <= 15 ? d : null;
}

// ---------- WhatsApp messages (used for prefilled staff links, and for the API when enabled) ----------
const clinicName = lang => cfg.clinic.name[lang] || cfg.clinic.name.en;
const fmtDate = (date, lang) => new Intl.DateTimeFormat(lang === 'ar' ? 'ar-EG' : 'en-GB',
  { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }).format(new Date(date + 'T00:00:00Z'));
const fmtTime = (time, lang) => {
  const [h, m] = time.split(':').map(Number);
  return new Intl.DateTimeFormat(lang === 'ar' ? 'ar-EG' : 'en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' })
    .format(new Date(Date.UTC(2000, 0, 1, h, m)));
};
const rebookUrl = a => `${BASE_URL}/?r=${a.token}#book`;

function buildMessage(kind, a) {
  const lang = a.lang === 'ar' ? 'ar' : 'en';
  const name = a.name.split(' ')[0];
  const br = branchOf(a.branch) || cfg.branches[0];
  const d = fmtDate(a.date, lang);
  const w = `${fmtTime(a.sessionStart, lang)} – ${fmtTime(a.sessionEnd, lang)}`;
  const c = `${clinicName(lang)} - ${br.name[lang]}`;
  const url = rebookUrl(a);
  const text = {
    confirmation: {
      ar: `مرحباً ${name} 👋\nتم تسجيل حجزك في ${c}:\n📅 ${d}\n🕐 فترة الكشف: ${w}\nالدخول للدكتور بنظام الأسبقية (من يصل أولاً يدخل أولاً)، دون موعد محدد.\n📍 ${br.address.ar}\n${br.mapUrl}`,
      en: `Hello ${name} 👋\nYour booking at ${c} is registered:\n📅 ${d}\n🕐 Clinic hours: ${w}\nEntry to the doctor is first come, first served; there is no specific appointment time.\n📍 ${br.address.en}\n${br.mapUrl}`
    },
    reminder: {
      ar: `تذكير: حجزك في ${c} ${d}، فترة الكشف ${w}. الدخول بنظام الأسبقية. إذا لم تستطع الحضور رد علينا لنلغي الحجز.`,
      en: `Reminder: you're booked at ${c} on ${d}, clinic hours ${w}. Entry is first come, first served. If you can't make it, reply and we'll cancel your booking.`
    },
    missed: {
      ar: `مرحباً ${name}، لاحظنا أنك لم تتمكن من الحضور يوم ${d} في ${c}. نأمل أن تكون بخير 🙏\nيمكنك حجز يوم جديد بسهولة من هنا:\n${url}`,
      en: `Hello ${name}, we noticed you couldn't make it on ${d} at ${c}. We hope you're well 🙏\nYou can easily book a new day here:\n${url}`
    }
  }[kind][lang];
  const params = { confirmation: [name, d, c, w], reminder: [name, d, c, w], missed: [name, d, c, url] }[kind];
  return { lang, text, params, template: cfg.whatsapp.templates[kind][lang] };
}

async function sendWhatsApp(a, kind) {
  if (!WA_ENABLED) return null; // automatic WhatsApp is switched off
  const m = buildMessage(kind, a);
  const entry = { kind, at: new Date().toISOString(), to: a.phone };
  if (!WA_LIVE) { // enabled but no keys yet: dry-run
    entry.status = 'dry-run';
    fs.appendFileSync(OUTBOX_LOG, `[${entry.at}] DRY-RUN ${kind} -> +${a.phone}\n${m.text}\n\n`);
    (a.messages ||= []).push(entry); save();
    return entry;
  }
  const body = cfg.whatsapp.useTemplates
    ? { messaging_product: 'whatsapp', to: a.phone, type: 'template', template: {
        name: m.template, language: { code: m.lang },
        components: [{ type: 'body', parameters: m.params.map(p => ({ type: 'text', text: String(p) })) }] } }
    : { messaging_product: 'whatsapp', to: a.phone, type: 'text', text: { body: m.text, preview_url: true } };
  try {
    const r = await fetch(`https://graph.facebook.com/${cfg.whatsapp.apiVersion}/${WA_PHONE_ID}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${WA_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const j = await r.json().catch(() => ({}));
    if (r.ok) { entry.status = 'sent'; entry.waId = j.messages?.[0]?.id; }
    else { entry.status = 'failed'; entry.error = j.error?.message || `HTTP ${r.status}`; }
  } catch (e) { entry.status = 'failed'; entry.error = e.message; }
  (a.messages ||= []).push(entry); save();
  if (entry.status === 'failed') console.error(`[whatsapp] ${kind} to +${a.phone} failed: ${entry.error}`);
  return entry;
}

// ---------- scheduler: reminders + flagging missed bookings ----------
let ticking = false;
async function tick() {
  if (ticking) return; ticking = true;
  try {
    const now = nowMin(), au = cfg.automation;
    for (const a of db.appointments) {
      const start = toMin(a.date, a.sessionStart), end = toMin(a.date, a.sessionEnd);
      if (a.status === 'booked') {
        const until = start - now;
        if (WA_ENABLED && !a.reminderAt && until > 0 && until <= au.reminderHoursBefore * 60) {
          // Booked inside the reminder window? The confirmation already covers it — skip the reminder.
          const leadAtBooking = until + (Date.now() - new Date(a.createdAt).getTime()) / 60000;
          if (leadAtBooking <= au.reminderHoursBefore * 60) { a.reminderAt = 'skipped'; save(); }
          else { a.reminderAt = new Date().toISOString(); save(); await sendWhatsApp(a, 'reminder'); }
        }
        // After the clinic session ends (+grace), anyone not marked "attended" is flagged as missed.
        if (au.autoMarkMissed && now >= end + au.missedGraceMinutes) {
          a.status = 'missed'; a.missedAt = new Date().toISOString(); save();
          await recontact(a);
        }
      } else if (WA_ENABLED && a.status === 'missed' && a.recontactCount === 1 && a.lastRecontactAt) {
        const due = new Date(a.lastRecontactAt).getTime() + au.followUpAfterDays * 86400000;
        if (Date.now() >= due) {
          if (hasLaterBooking(a)) { a.recovered = true; save(); }
          else await recontact(a);
        }
      }
      if (a.status === 'missed' && !a.recovered && hasLaterBooking(a)) { a.recovered = true; save(); }
    }
  } catch (e) { console.error('[scheduler]', e); }
  ticking = false;
}
function hasLaterBooking(a) {
  return db.appointments.some(b => b.id !== a.id && b.phone === a.phone &&
    (b.status === 'booked' || b.status === 'attended') && b.date > a.date);
}
async function recontact(a) { // automatic WhatsApp only; with the API off, staff use the prefilled link instead
  if (!WA_ENABLED) return null;
  a.recontactCount = (a.recontactCount || 0) + 1;
  a.lastRecontactAt = new Date().toISOString();
  save();
  return sendWhatsApp(a, 'missed');
}
setInterval(tick, 60 * 1000);
setTimeout(tick, 3000);

// ---------- http helpers ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon', '.webp': 'image/webp', '.gif': 'image/gif', '.mp4': 'video/mp4', '.webm': 'video/webm' };
function send(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0, chunks = [];
    req.on('data', c => { size += c.length; if (size > 20000) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}
const hits = new Map();
function rateLimited(key, max, windowMs) {
  const now = Date.now();
  const arr = (hits.get(key) || []).filter(t => now - t < windowMs);
  if (arr.length >= max) { hits.set(key, arr); return true; }
  arr.push(now); hits.set(key, arr); return false;
}
setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (!v.some(t => now - t < 3600000)) hits.delete(k); }, 600000);
const clientIp = req => (TRUST_PROXY && req.headers['x-forwarded-for']?.split(',')[0].trim()) || req.socket.remoteAddress || '?';
function adminAuth(req, res) {
  if (!ADMIN_PASSWORD) { send(res, 503, { error: 'ADMIN_PASSWORD is not set on the server.' }); return false; }
  const ip = clientIp(req);
  const given = Buffer.from(String(req.headers['x-admin-password'] || ''));
  const real = Buffer.from(ADMIN_PASSWORD);
  const ok = given.length === real.length && crypto.timingSafeEqual(given, real);
  if (!ok) {
    if (rateLimited('adminfail:' + ip, 10, 15 * 60000)) { send(res, 429, { error: 'Too many attempts. Try later.' }); return false; }
    send(res, 401, { error: 'Wrong password' }); return false;
  }
  return true;
}
function publicAppt(a) {
  const m = buildMessage('missed', a);
  return { ...a, recontactLink: `https://wa.me/${a.phone}?text=${encodeURIComponent(m.text)}`,
    chatLink: `https://wa.me/${a.phone}` };
}

// ---------- routes ----------
async function api(req, res, url) {
  const p = url.pathname;
  if (req.method === 'GET' && p === '/api/config') {
    return send(res, 200, { clinic: cfg.clinic, branches: cfg.branches, services: cfg.services, media: cfg.media || {},
      maxAdvanceDays: cfg.maxAdvanceDays, today: nowLocal().date });
  }
  if (req.method === 'GET' && p === '/api/days') {
    const branch = url.searchParams.get('branch') || '';
    return send(res, 200, { branch, days: bookableDays(branch) });
  }
  if (req.method === 'GET' && p.startsWith('/api/rebook/')) {
    const a = db.appointments.find(x => x.token === p.split('/').pop());
    return send(res, a ? 200 : 404, a ? { name: a.name, phone: a.phone, lang: a.lang, service: a.service, branch: a.branch } : { error: 'not found' });
  }
  if (req.method === 'POST' && p === '/api/book') {
    if (rateLimited('book:' + clientIp(req), 10, 3600000)) return send(res, 429, { error: 'rate_limited' });
    let b; try { b = await readBody(req); } catch (_) { return send(res, 400, { error: 'bad_request' }); }
    if (b.website) return send(res, 200, { ok: true }); // honeypot: pretend success
    const name = String(b.name || '').trim().replace(/\s+/g, ' ');
    const phone = normalizePhone(b.phone);
    const service = cfg.services.find(s => s.id === b.service);
    const lang = b.lang === 'ar' ? 'ar' : 'en';
    const notes = String(b.notes || '').trim().slice(0, 300);
    const date = String(b.date || '');
    const branch = branchOf(b.branch);
    if (name.length < 2 || name.length > 80) return send(res, 400, { error: 'invalid_name' });
    if (!phone) return send(res, 400, { error: 'invalid_phone' });
    if (!service) return send(res, 400, { error: 'invalid_service' });
    if (!branch) return send(res, 400, { error: 'invalid_branch' });
    if (!validDate(date)) return send(res, 400, { error: 'invalid_day' });
    const day = bookableDays(branch.id).find(d => d.date === date);
    if (!day) return send(res, 409, { error: 'day_unavailable' });
    if (day.full) return send(res, 409, { error: 'day_full' });
    if (db.appointments.some(a => a.phone === phone && a.branch === branch.id && a.date === date && a.status === 'booked'))
      return send(res, 409, { error: 'already_booked' });
    if (db.appointments.filter(a => a.phone === phone && a.status === 'booked').length >= 3)
      return send(res, 429, { error: 'too_many_upcoming' });
    const a = {
      id: crypto.randomUUID(), token: crypto.randomBytes(8).toString('hex'),
      name, phone, service: service.id, branch: branch.id, date, sessionStart: day.start, sessionEnd: day.end,
      notes, lang, status: 'booked', createdAt: new Date().toISOString(), messages: [], recontactCount: 0
    };
    db.appointments.push(a); save();
    sendWhatsApp(a, 'confirmation'); // no-op while WhatsApp API is off
    return send(res, 201, { ok: true, appointment: { date, start: day.start, end: day.end, branch: branch.id, name } });
  }

  // ----- staff -----
  if (p.startsWith('/api/admin/')) {
    if (!adminAuth(req, res)) return;
    if (req.method === 'GET' && p === '/api/admin/appointments') {
      const list = [...db.appointments].sort((x, y) => (x.date + x.createdAt).localeCompare(y.date + y.createdAt)).map(publicAppt);
      return send(res, 200, { appointments: list, today: nowLocal().date, whatsappEnabled: WA_ENABLED,
        whatsappLive: WA_LIVE, services: cfg.services, branches: cfg.branches });
    }
    const m = p.match(/^\/api\/admin\/appointments\/([\w-]+)(\/recontact|\/contacted)?$/);
    if (m && req.method === 'POST') {
      const a = db.appointments.find(x => x.id === m[1]);
      if (!a) return send(res, 404, { error: 'not_found' });
      if (m[2] === '/recontact') {
        if (!WA_ENABLED) return send(res, 400, { error: 'whatsapp_disabled' });
        const e = await recontact(a); return send(res, 200, { ok: true, message: e });
      }
      if (m[2] === '/contacted') { // staff contacted the patient themselves (e.g. via the prefilled WhatsApp link)
        a.recontactCount = (a.recontactCount || 0) + 1; a.lastRecontactAt = new Date().toISOString(); a.contactedBy = 'staff';
        save(); return send(res, 200, { ok: true });
      }
      let b; try { b = await readBody(req); } catch (_) { return send(res, 400, { error: 'bad_request' }); }
      if (!['booked', 'attended', 'missed', 'cancelled'].includes(b.status)) return send(res, 400, { error: 'bad_status' });
      a.status = b.status;
      if (b.status === 'missed' && !a.missedAt) a.missedAt = new Date().toISOString();
      save();
      if (b.status === 'missed' && !a.recontactCount) await recontact(a); // no-op while WhatsApp API is off
      return send(res, 200, { ok: true, appointment: publicAppt(a) });
    }
    return send(res, 404, { error: 'not_found' });
  }
  send(res, 404, { error: 'not_found' });
}

function serveStatic(req, res, url) {
  let p = decodeURIComponent(url.pathname);
  if (p === '/') p = '/index.html';
  if (p === '/admin') p = '/admin.html';
  const file = path.normalize(path.join(ROOT, 'public', p));
  if (!file.startsWith(path.join(ROOT, 'public') + path.sep)) { res.writeHead(403); return res.end(); }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
    const type = MIME[path.extname(file)] || 'application/octet-stream';
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    const cache = /\.(jpe?g|png|webp|gif|mp4|webm)$/.test(file) ? 'public, max-age=86400' : 'no-cache';
    if (range && (range[1] || range[2])) { // video seeking (Safari/iOS need Range support)
      const start = range[1] ? Number(range[1]) : Math.max(0, st.size - Number(range[2]));
      const end = range[1] && range[2] ? Math.min(Number(range[2]), st.size - 1) : st.size - 1;
      if (start > end || start >= st.size) { res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }); return res.end(); }
      res.writeHead(206, { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Range': `bytes ${start}-${end}/${st.size}`,
        'Content-Length': end - start + 1, 'Cache-Control': cache });
      return fs.createReadStream(file, { start, end }).pipe(res);
    }
    res.writeHead(200, { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Length': st.size, 'Cache-Control': cache });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
}

http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  try {
    const url = new URL(req.url, 'http://x');
    if (url.pathname.startsWith('/api/')) await api(req, res, url);
    else if (req.method === 'GET' || req.method === 'HEAD') serveStatic(req, res, url);
    else { res.writeHead(405); res.end(); }
  } catch (e) {
    console.error(e);
    if (!res.headersSent) send(res, 500, { error: 'server_error' });
  }
}).listen(PORT, () => {
  console.log(`Clinic site running at ${BASE_URL}  (admin: ${BASE_URL}/admin)`);
  console.log(`WhatsApp API: ${!WA_ENABLED ? 'OFF (staff use prefilled WhatsApp links)' : WA_LIVE ? 'LIVE (Cloud API)' : 'enabled, DRY-RUN (no keys)'}`);
  if (!ADMIN_PASSWORD) console.warn('WARNING: ADMIN_PASSWORD is not set — the staff dashboard is disabled.');
});
