// Doc Helper License Server 1.3.2 — server.js
// Express + SQLite (node:sqlite). Chạy: npm install && npm start.
// Deploy: Hostinger Business, Web App Node.js 24, Application root là thư
// mục gốc repo (xem README_DEPLOY.md).
// 1.1.0: license gắn EMAIL khách thay vì key rời — verify nhận {email}
// hoặc {key}; tạo license nhận email (trùng email đang còn thì 409).
// 1.2.0: license KHÔNG GIỚI HẠN (days = 0 → không hết hạn, maxDevices = 0
// → không giới hạn thiết bị); /api/verify trả thêm hạn mức còn lại
// (daysRemaining, deviceCount, maxDevices, unlimitedTime, unlimitedDevices).
// 1.3.0: sửa được thông tin khách (PATCH /api/admin/licenses/:id — số
// Zalo, ghi chú, hạn dùng, số thiết bị tối đa; lúc tạo cũng nhập được số
// Zalo); đăng nhập quản trị có rate-limit (mặc định 10 lần / 10 phút / IP)
// để mật khẩu yếu khó bị dò.
'use strict';
const crypto = require('node:crypto');
const express = require('express');
const path = require('node:path');
const db = require('./src/db');
const { normalizeKey, isValidKeyFormat, hashKey, makeLicense, normalizeEmail, isValidEmail, makeEmailLicense, isUnlimitedExpiry, daysRemaining, isUnlimitedDevices, UNLIMITED_EXPIRES_AT } = require('./src/keys');

const PORT = process.env.PORT || 3001;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const IS_PROD = process.env.NODE_ENV === 'production';
// 1.3.2: endpoint báo bản extension mới nhất (GET /api/latest-extension)
// — popup đọc file latest.json (bản mới + link tải GitHub Releases) để hiện
// banner "Đã có bản mới" cho khách đang dùng bản cũ. File đọc 1 lần lúc
// khởi động; đổi bản mới thì sửa latest.json rồi redeploy (hoặc restart).
// 1.3.3: thêm endpoint cho Blueberry ADS Block (GET /api/latest-blueberry,
// file latest-blueberry.json) + phục vụ file ZIP tại /downloads/ để
// popup của Blueberry tải bản mới. Cách phát hành bản Blueberry mới:
// tăng version trong manifest → đóng ZIP → copy ZIP vào thư mục
// downloads/ → sửa latest-blueberry.json → redeploy server.
const VERSION = '1.3.3';

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

// ---------- Rate-limit cho /api/admin/login: 10 lần / 10 phút / IP ----------
// Đăng nhập quản trị trước đây không có giới hạn — mật khẩu yếu có thể bị
// dò. Giới hạn chỉnh được qua biến môi trường (để test đặt nhỏ lại).
const LOGIN_RATE_LIMIT_MAX = Number(process.env.LOGIN_RATE_LIMIT_MAX) || 10;
const LOGIN_RATE_LIMIT_WINDOW_MS = Number(process.env.LOGIN_RATE_LIMIT_WINDOW_MS) || 10 * 60 * 1000;
const loginHits = new Map(); // ip -> [timestamps]
function loginRateLimit(req, res, next) {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const list = (loginHits.get(ip) || []).filter((t) => now - t < LOGIN_RATE_LIMIT_WINDOW_MS);
  if (list.length >= LOGIN_RATE_LIMIT_MAX) {
    return res.status(429).json({ ok: false, error: 'rate_limited', retryAfterSeconds: Math.ceil(LOGIN_RATE_LIMIT_WINDOW_MS / 1000) });
  }
  list.push(now);
  loginHits.set(ip, list);
  next();
}

// ---------- Rate-limit cho /api/verify: theo từng email/key + theo IP ----------
// Trước đây chỉ giới hạn theo IP (60 lần / 10 phút / IP), nhưng sau CDN của
// Hostinger IP thật bị che nên giới hạn này không chặn được gì (đợt kiểm tra
// ~780 lượt gọi vẫn lọt hết). Giờ siết theo từng "chứng chỉ" — email hoặc
// key — vì đó mới là thứ kẻ dò key/email nhắm tới: mỗi email/key chỉ được
// 30 lần kiểm tra / 10 phút (người dùng thật chỉ kiểm tra vài lần/ngày,
// popup còn cache 1 giờ nên 30 là thừa). Giới hạn theo IP vẫn giữ làm lớp
// chặn thô phía sau (60/10 phút). Cả 2 đều chỉnh được qua biến môi trường
// (để test đặt nhỏ lại).
const VERIFY_RATE_LIMIT_MAX = Number(process.env.VERIFY_RATE_LIMIT_MAX) || 30;
const VERIFY_RATE_LIMIT_WINDOW_MS = Number(process.env.VERIFY_RATE_LIMIT_WINDOW_MS) || 10 * 60 * 1000;
const verifyHits = new Map(); // ip -> [timestamps]
const verifyCredHits = new Map(); // 'email:x' | 'key:<hash>' | 'anon:<ip>' -> [timestamps]
function verifyRateLimit(req, res, next) {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const windowMs = VERIFY_RATE_LIMIT_WINDOW_MS;
  // Khóa theo chứng chỉ: email chuẩn hoá, hoặc băm SHA-256 của key (không
  // lưu key thô trong bộ nhớ), hoặc IP nếu không có cả hai.
  const rawEmail = typeof req.body?.email === 'string' ? req.body.email : '';
  const rawKey = typeof req.body?.key === 'string' ? req.body.key : '';
  let credKey = 'anon:' + ip;
  if (isValidEmail(rawEmail)) credKey = 'email:' + normalizeEmail(rawEmail);
  else if (isValidKeyFormat(rawKey)) credKey = 'key:' + hashKey(normalizeKey(rawKey));
  const credList = (verifyCredHits.get(credKey) || []).filter((t) => now - t < windowMs);
  if (credList.length >= VERIFY_RATE_LIMIT_MAX) {
    return res.status(429).json({ ok: false, error: 'rate_limited', retryAfterSeconds: Math.ceil(windowMs / 1000) });
  }
  credList.push(now);
  verifyCredHits.set(credKey, credList);
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
// Bản extension mới nhất cho popup báo update (file latest.json ở gốc repo).
// Không cần đăng nhập; extension gọi khi mở popup (cache 6 giờ phía client).
let LATEST_EXTENSION = null;
try {
  const raw = require('node:fs').readFileSync(path.join(__dirname, 'latest.json'), 'utf8');
  const parsed = JSON.parse(raw);
  if (parsed && typeof parsed.version === 'string' && typeof parsed.url === 'string') {
    LATEST_EXTENSION = { version: parsed.version, url: parsed.url, notes: typeof parsed.notes === 'string' ? parsed.notes : '' };
  }
} catch (e) { LATEST_EXTENSION = null; }
app.get('/api/latest-extension', (req, res) => {
  if (!LATEST_EXTENSION) return res.status(404).json({ ok: false, error: 'no_update_info' });
  res.json({ ok: true, ...LATEST_EXTENSION });
});
// Bản Blueberry ADS Block mới nhất cho popup của Blueberry báo update
// (file latest-blueberry.json ở cùng thư mục; ZIP bản mới nằm trong
// thư mục downloads/ và được phục vụ tại /downloads/<file>.zip).
let LATEST_BLUEBERRY = null;
try {
  const rawBb = require('node:fs').readFileSync(path.join(__dirname, 'latest-blueberry.json'), 'utf8');
  const parsedBb = JSON.parse(rawBb);
  if (parsedBb && typeof parsedBb.version === 'string' && typeof parsedBb.url === 'string') {
    LATEST_BLUEBERRY = { version: parsedBb.version, url: parsedBb.url, notes: typeof parsedBb.notes === 'string' ? parsedBb.notes : '' };
  }
} catch (e) { LATEST_BLUEBERRY = null; }
app.get('/api/latest-blueberry', (req, res) => {
  if (!LATEST_BLUEBERRY) return res.status(404).json({ ok: false, error: 'no_update_info' });
  res.json({ ok: true, ...LATEST_BLUEBERRY });
});
app.use('/downloads', express.static(path.join(__dirname, 'downloads')));
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

app.post('/api/admin/login', loginRateLimit, sameOrigin, (req, res) => {
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
  const zalo = sanitizeZalo(req.body?.zalo);
  if (zalo === null) {
    return res.status(400).json({ ok: false, error: 'bad_zalo' });
  }
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
      expiresAt: lic.expiresAt, maxDevices: lic.maxDevices, email: lic.email, zalo
    });
    return res.json({ ok: true, email: lic.email, license: saved });
  }
  const lic = makeLicense(opts);
  const saved = db.createLicense({
    keyHash: lic.keyHash, prefix: lic.prefix, note: lic.note,
    expiresAt: lic.expiresAt, maxDevices: lic.maxDevices, zalo
  });
  // Key gốc chỉ trả về 1 lần duy nhất lúc tạo — lưu lại ngay, không xem lại được.
  res.json({ ok: true, key: lic.key, license: saved });
});

// Số Zalo: chỉ nhận chuỗi số (cho phép + ở đầu, 9–15 số), rỗng = không có.
// Trả số đã chuẩn hoá, hoặc null khi sai định dạng.
function sanitizeZalo(v) {
  if (v === undefined || v === null || v === '') return '';
  if (typeof v !== 'string') return null;
  const z = v.trim().replace(/[\s.]/g, '');
  if (!/^\+?\d{9,15}$/.test(z)) return null;
  return z;
}

// Sửa thông tin khách: PATCH /api/admin/licenses/:id
// Body (chỉ gửi trường muốn đổi): { zalo, note, maxDevices,
// expiresAtISO ('YYYY-MM-DD' — hết hạn cuối ngày đó, giờ VN),
// unlimitedTime (true → không giới hạn), days (số ngày kể từ hôm nay,
// 0 → không giới hạn) }.
app.patch('/api/admin/licenses/:id', requireAdmin, sameOrigin, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ ok: false, error: 'bad_id' });
  const patch = {};
  if (req.body?.zalo !== undefined) {
    const z = sanitizeZalo(req.body.zalo);
    if (z === null) return res.status(400).json({ ok: false, error: 'bad_zalo' });
    patch.zalo = z;
  }
  if (typeof req.body?.note === 'string') patch.note = req.body.note.slice(0, 200);
  if (req.body?.maxDevices !== undefined) {
    const md = Number(req.body.maxDevices);
    if (!Number.isFinite(md) || md < 0 || md > 20) {
      return res.status(400).json({ ok: false, error: 'bad_max_devices' });
    }
    patch.maxDevices = Math.floor(md);
  }
  if (req.body?.unlimitedTime === true) {
    patch.expiresAt = UNLIMITED_EXPIRES_AT;
  } else if (typeof req.body?.expiresAtISO === 'string' && req.body.expiresAtISO) {
    const ms = Date.parse(req.body.expiresAtISO + 'T23:59:59.999+07:00');
    if (!Number.isFinite(ms)) return res.status(400).json({ ok: false, error: 'bad_expiry' });
    patch.expiresAt = ms;
  } else if (req.body?.days !== undefined) {
    const d = Number(req.body.days);
    if (!Number.isFinite(d) || d < 0 || d > 3650) {
      return res.status(400).json({ ok: false, error: 'bad_days' });
    }
    patch.expiresAt = d === 0 ? UNLIMITED_EXPIRES_AT : Date.now() + Math.floor(d) * 24 * 60 * 60 * 1000;
  }
  const updated = db.updateLicense(id, patch);
  if (!updated) return res.status(404).json({ ok: false, error: 'not_found' });
  res.json({ ok: true, license: updated });
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

// Chỉ lắng nghe khi chạy trực tiếp (node server.js). Khi được require
// (test HTTP) thì chỉ export app, không tự mở cổng.
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`[license-server] listening on :${PORT} (db: ${db.DB_PATH})`);
    if (!ADMIN_PASSWORD) {
      console.log('[license-server] WARNING: ADMIN_PASSWORD chưa đặt — /admin chưa đăng nhập được. Đặt biến môi trường ADMIN_PASSWORD.');
    }
  });
}

module.exports = app;
