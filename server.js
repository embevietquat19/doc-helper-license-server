// Doc Helper License Server 1.2.0 — server.js
// Express + SQLite (node:sqlite). Chạy: npm install && npm start.
// Deploy: Hostinger Business, Web App Node.js 24, Application root là thư
// mục gốc repo (xem README_DEPLOY.md).
// 1.1.0: license gắn EMAIL khách thay vì key rời — verify nhận {email}
// hoặc {key}; tạo license nhận email (trùng email đang còn thì 409).
// 1.2.0: license KHÔNG GIỚI HẠN (days = 0 → không hết hạn, maxDevices = 0
// → không giới hạn thiết bị); /api/verify trả thêm hạn mức còn lại
// (daysRemaining, deviceCount, maxDevices, unlimitedTime, unlimitedDevices).
'use strict';
const crypto = require('node:crypto');
const express = require('express');
const path = require('node:path');
const db = require('./src/db');
const { normalizeKey, isValidKeyFormat, hashKey, makeLicense, normalizeEmail, isValidEmail, makeEmailLicense, isUnlimitedExpiry, daysRemaining, isUnlimitedDevices } = require('./src/keys');

const PORT = process.env.PORT || 3001;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const IS_PROD = process.env.NODE_ENV === 'production';
const VERSION = '1.2.0';

const app = express();
app.use(express.json({ limit: '64kb' }));
app.disable('x-powered-by');
// Hostinger chạy app sau 1 reverse proxy: tin proxy để req.ip là IP thật
// của khách (không có dòng này, mọi request đều mang IP của proxy và
// rate-limit /api/verify sẽ đếm chung 1 giỏ cho tất cả mọi người).
app.set('trust proxy', 1);

// ---------- Phiên quản trị (token ngẫu nhiên trong cookie httpOnly) ----------
const adminTokens = new Map(); // token -> expiresAt (ms)
function issueAdminToken(res) {
  const token = crypto.randomBytes(32).toString('hex');
  adminTokens.set(token, Date.now() + 12 * 60 * 60 * 1000);
  res.cookie('admin_token', token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: IS_PROD,
    maxAge: 12 * 60 * 60 * 1000,
    path: '/'
  });
  return token;
}
function isAdmin(req) {
  const token = req.cookies?.admin_token || req.headers['x-admin-token'];
  if (!token) return false;
  const exp = adminTokens.get(token);
  if (!exp) return false;
  if (exp < Date.now()) { adminTokens.delete(token); return false; }
  return true;
}
// Cookie parser tối giản (không thêm dependency)
app.use((req, res, next) => {
  req.cookies = {};
  const raw = req.headers.cookie;
  if (raw) {
    for (const part of raw.split(';')) {
      const i = part.indexOf('=');
      if (i > 0) req.cookies[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    }
  }
  next();
});

// Chống CSRF cơ bản cho API đổi dữ liệu: Origin (nếu có) phải cùng host.
function sameOrigin(req, res, next) {
  const origin = req.headers.origin;
  if (origin) {
    try {
      const o = new URL(origin);
      const h = (req.headers.host || '').split(':')[0];
      if (o.hostname !== h && o.hostname !== 'localhost') {
        return res.status(403).json({ ok: false, error: 'forbidden_origin' });
      }
    } catch { return res.status(403).json({ ok: false, error: 'bad_origin' }); }
  }
  next();
}

// ---------- Rate-limit cho /api/verify: 60 lần / 10 phút / IP ----------
const verifyHits = new Map(); // ip -> [timestamps]
function verifyRateLimit(req, res, next) {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const windowMs = 10 * 60 * 1000;
  const list = (verifyHits.get(ip) || []).filter((t) => now - t < windowMs);
  if (list.length >= 60) {
    return res.status(429).json({ ok: false, error: 'rate_limited', retryAfterSeconds: 600 });
  }
  list.push(now);
  verifyHits.set(ip, list);
  next();
}

// ---------- Trang trạng thái + trang quản trị ----------
app.get('/', (req, res) => {
  res.json({ ok: true, service: 'doc-helper-license', version: VERSION });
});
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});
app.use('/admin-static', express.static(path.join(__dirname, 'public')));

// ---------- API công khai: extension gọi để kiểm tra key/email ----------
// Body: { key, deviceId } hoặc { email, deviceId } — email được ưu tiên
// nếu gửi cả hai. Email chuẩn hoá thường trước khi tra cứu.
app.post('/api/verify', verifyRateLimit, (req, res) => {
  const rawKey = typeof req.body?.key === 'string' ? req.body.key : '';
  const rawEmail = typeof req.body?.email === 'string' ? req.body.email : '';
  const deviceId = typeof req.body?.deviceId === 'string'
    ? req.body.deviceId.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 128)
    : '';
  if (!deviceId) {
    return res.json({ ok: true, valid: false, reason: 'invalid' });
  }
  let lic = null;
  let type = null;
  if (isValidEmail(rawEmail)) {
    lic = db.findLicenseByEmail(normalizeEmail(rawEmail));
    type = 'email';
  } else if (isValidKeyFormat(rawKey)) {
    const key = normalizeKey(rawKey);
    lic = db.findLicenseByHash(hashKey(key));
    type = 'key';
  }
  if (!lic) return res.json({ ok: true, valid: false, reason: 'invalid' });
  if (lic.revoked) {
    return res.json({ ok: true, valid: false, reason: 'revoked', expiresAt: lic.expiresAt, type });
  }
  if (lic.expiresAt <= Date.now()) {
    return res.json({ ok: true, valid: false, reason: 'expired', expiresAt: lic.expiresAt, type });
  }
  const touch = db.touchDeviceByLicenseId(lic.id, deviceId);
  if (!touch.ok && touch.reason === 'device_limit') {
    return res.json({
      ok: true, valid: false, reason: 'device_limit', type,
      expiresAt: lic.expiresAt, deviceCount: touch.deviceCount, maxDevices: lic.maxDevices
    });
  }
  // Hạn mức còn lại: daysRemaining null = không giới hạn thời gian;
  // maxDevices 0 = không giới hạn thiết bị. expiresAt trả null khi không
  // giới hạn (bên trong DB lưu mốc 31/12/9999).
  const unlimitedTime = isUnlimitedExpiry(lic.expiresAt);
  const unlimitedDevices = isUnlimitedDevices(lic.maxDevices);
  return res.json({
    ok: true, valid: true, type,
    expiresAt: unlimitedTime ? null : lic.expiresAt,
    expiresAtISO: unlimitedTime ? null : new Date(lic.expiresAt).toISOString(),
    daysRemaining: daysRemaining(lic.expiresAt),
    unlimitedTime,
    unlimitedDevices,
    deviceCount: touch.deviceCount, maxDevices: lic.maxDevices
  });
});

// ---------- API quản trị ----------
function requireAdmin(req, res, next) {
  if (!isAdmin(req)) return res.status(401).json({ ok: false, error: 'unauthorized' });
  next();
}

app.post('/api/admin/login', sameOrigin, (req, res) => {
  if (!ADMIN_PASSWORD) {
    return res.status(500).json({ ok: false, error: 'admin_password_not_configured' });
  }
  const pw = typeof req.body?.password === 'string' ? req.body.password : '';
  const a = Buffer.from(pw);
  const b = Buffer.from(ADMIN_PASSWORD);
  const match = a.length === b.length && crypto.timingSafeEqual(a, b);
  if (!match) return res.status(401).json({ ok: false, error: 'wrong_password' });
  issueAdminToken(res);
  res.json({ ok: true });
});

app.post('/api/admin/logout', requireAdmin, (req, res) => {
  const token = req.cookies?.admin_token;
  if (token) adminTokens.delete(token);
  res.clearCookie('admin_token', { path: '/' });
  res.json({ ok: true });
});

app.get('/api/admin/stats', requireAdmin, (req, res) => {
  res.json({ ok: true, stats: db.stats() });
});

app.get('/api/admin/licenses', requireAdmin, (req, res) => {
  res.json({ ok: true, licenses: db.listLicenses() });
});

app.post('/api/admin/licenses', requireAdmin, sameOrigin, (req, res) => {
  const days = Number(req.body?.days);
  const maxDevices = Number(req.body?.maxDevices);
  const note = typeof req.body?.note === 'string' ? req.body.note.slice(0, 200) : '';
  const rawEmail = typeof req.body?.email === 'string' ? req.body.email : '';
  const opts = {
    days: Number.isFinite(days) && days >= 0 && days <= 3650 ? Math.floor(days) : 30,
    maxDevices: Number.isFinite(maxDevices) && maxDevices >= 0 && maxDevices <= 20 ? Math.floor(maxDevices) : 2,
    note
  };
  // days = 0 → không giới hạn thời gian; maxDevices = 0 → không giới hạn
  // thiết bị.
  // Tạo theo email: khách không nhận key — chỉ kích hoạt email đó.
  // Email đã có license thì báo 409 kèm bản hiện có (xóa bản cũ rồi tạo
  // lại, hoặc khóa/mở lại bản cũ).
  if (rawEmail) {
    if (!isValidEmail(rawEmail)) {
      return res.status(400).json({ ok: false, error: 'bad_email' });
    }
    const email = normalizeEmail(rawEmail);
    const existing = db.findLicenseByEmail(email);
    if (existing) {
      return res.status(409).json({ ok: false, error: 'email_exists', license: existing });
    }
    const lic = makeEmailLicense({ ...opts, email });
    const saved = db.createLicense({
      keyHash: lic.keyHash, prefix: lic.prefix, note: lic.note,
      expiresAt: lic.expiresAt, maxDevices: lic.maxDevices, email: lic.email
    });
    return res.json({ ok: true, email: lic.email, license: saved });
  }
  const lic = makeLicense(opts);
  const saved = db.createLicense({
    keyHash: lic.keyHash, prefix: lic.prefix, note: lic.note,
    expiresAt: lic.expiresAt, maxDevices: lic.maxDevices
  });
  // Key gốc chỉ trả về 1 lần duy nhất lúc tạo — lưu lại ngay, không xem lại được.
  res.json({ ok: true, key: lic.key, license: saved });
});

app.post('/api/admin/licenses/:id/revoke', requireAdmin, sameOrigin, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ ok: false, error: 'bad_id' });
  const ok = db.revokeLicense(id, true);
  res.json({ ok });
});

app.post('/api/admin/licenses/:id/restore', requireAdmin, sameOrigin, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ ok: false, error: 'bad_id' });
  const ok = db.revokeLicense(id, false);
  res.json({ ok });
});

app.delete('/api/admin/licenses/:id', requireAdmin, sameOrigin, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ ok: false, error: 'bad_id' });
  const ok = db.deleteLicense(id);
  res.json({ ok });
});

app.listen(PORT, () => {
  console.log(`[license-server] listening on :${PORT} (db: ${db.DB_PATH})`);
  if (!ADMIN_PASSWORD) {
    console.log('[license-server] WARNING: ADMIN_PASSWORD chưa đặt — /admin chưa đăng nhập được. Đặt biến môi trường ADMIN_PASSWORD.');
  }
});
