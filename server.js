// Doc Helper License Server 1.5.0 — server.js
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
// 1.5.0: HÀNG ĐỢI MUSE cho Blueberry Flow v0.2.3 (xem README_SERVER.md):
// bảng muse_tasks + POST /api/flow/muse-tasks, GET /api/flow/muse-tasks/:id,
// GET /api/flow/muse-tasks?status=pending, POST /api/flow/muse-tasks/:id/result.
// Endpoint license cũ (verify/consume) không đổi. CHƯA DEPLOY — chỉ code +
// test local, deploy sau khi user duyệt.
// 1.4.0: TÁCH THEO PRODUCT — thêm Blueberry Flow (xem README_SERVER.md):
// DB thêm product/plan/monthly_quota/used_this_month/month_key + bảng
// flow_usage; endpoint riêng POST /api/flow/verify, POST /api/flow/consume,
// GET /api/latest-flow, GET /api/flow/stats + CRUD admin
// /api/admin/flow/licenses (chỉ product='blueberry-flow'); /api/verify cũ
// giờ chỉ tìm product='doc-helper' nên license Flow không verify được ở
// đó và ngược lại. Endpoint cũ của Doc Helper + Blueberry giữ nguyên.
'use strict';
const crypto = require('node:crypto');
const express = require('express');
const path = require('node:path');
const db = require('./src/db');
const { normalizeKey, isValidKeyFormat, hashKey, makeLicense, normalizeEmail, isValidEmail, makeEmailLicense, isUnlimitedExpiry, daysRemaining, isUnlimitedDevices, UNLIMITED_EXPIRES_AT, FLOW_PLANS, isValidFlowPlan, makeFlowEmailLicense } = require('./src/keys');

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
const VERSION = '1.5.0';

const app = express();
app.use(express.json({ limit: '512kb' })); // 512kb: kết quả Muse trả về có thể dài (prompt + upstream + bài trả lời)
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

// ---------- Rate-limit cho /api/flow/consume ----------
// Consume gọi theo từng task (1 batch có thể là hàng chục task trong vài
// phút) nên giới hạn nới hơn verify: 300 lần / 10 phút / chứng chỉ
// (đủ cho gói Pro 300/tháng chạy dồn 1 batch), 600 lần / 10 phút / IP.
const FLOW_CONSUME_RATE_LIMIT_MAX = Number(process.env.FLOW_CONSUME_RATE_LIMIT_MAX) || 300;
const FLOW_CONSUME_RATE_LIMIT_WINDOW_MS = Number(process.env.FLOW_CONSUME_RATE_LIMIT_WINDOW_MS) || 10 * 60 * 1000;
const flowConsumeCredHits = new Map();
const flowConsumeIpHits = new Map();
function flowConsumeRateLimit(req, res, next) {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const windowMs = FLOW_CONSUME_RATE_LIMIT_WINDOW_MS;
  const rawEmail = typeof req.body?.email === 'string' ? req.body.email : '';
  const rawKey = typeof req.body?.key === 'string' ? req.body.key : '';
  let credKey = 'anon:' + ip;
  if (isValidEmail(rawEmail)) credKey = 'email:' + normalizeEmail(rawEmail);
  else if (isValidKeyFormat(rawKey)) credKey = 'key:' + hashKey(normalizeKey(rawKey));
  const credList = (flowConsumeCredHits.get(credKey) || []).filter((t) => now - t < windowMs);
  if (credList.length >= FLOW_CONSUME_RATE_LIMIT_MAX) {
    return res.status(429).json({ ok: false, error: 'rate_limited', retryAfterSeconds: Math.ceil(windowMs / 1000) });
  }
  credList.push(now);
  flowConsumeCredHits.set(credKey, credList);
  const list = (flowConsumeIpHits.get(ip) || []).filter((t) => now - t < windowMs);
  if (list.length >= 600) {
    return res.status(429).json({ ok: false, error: 'rate_limited', retryAfterSeconds: 600 });
  }
  list.push(now);
  flowConsumeIpHits.set(ip, list);
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
// 1.4.0: bản Blueberry Flow mới nhất (file latest-flow.json ở cùng thư
// mục; ZIP bản mới nằm trong thư mục downloads/, phục vụ tại
// /downloads/<file>.zip). Cách phát hành giống Blueberry: tăng version
// trong manifest → đóng ZIP → copy ZIP vào downloads/ → sửa
// latest-flow.json → redeploy server.
let LATEST_FLOW = null;
try {
  const rawFlow = require('node:fs').readFileSync(path.join(__dirname, 'latest-flow.json'), 'utf8');
  const parsedFlow = JSON.parse(rawFlow);
  if (parsedFlow && typeof parsedFlow.version === 'string' && typeof parsedFlow.url === 'string') {
    LATEST_FLOW = { version: parsedFlow.version, url: parsedFlow.url, notes: typeof parsedFlow.notes === 'string' ? parsedFlow.notes : '' };
  }
} catch (e) { LATEST_FLOW = null; }
app.get('/api/latest-flow', (req, res) => {
  if (!LATEST_FLOW) return res.status(404).json({ ok: false, error: 'no_update_info' });
  res.json({ ok: true, ...LATEST_FLOW });
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
  // 1.4.0: /api/verify chỉ phục vụ Doc Helper — tìm đúng product.
  if (isValidEmail(rawEmail)) {
    lic = db.findLicenseByEmail(normalizeEmail(rawEmail), 'doc-helper');
    type = 'email';
  } else if (isValidKeyFormat(rawKey)) {
    const key = normalizeKey(rawKey);
    lic = db.findLicenseByHash(hashKey(key), 'doc-helper');
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

// ---------- API công khai: Blueberry Flow (1.4.0) ----------
// TÌM LICENSE FLOW THEO EMAIL HOẶC KEY — CHỈ product='blueberry-flow'.
// License Doc Helper (cùng email) KHÔNG verify được ở đây và ngược lại.
// Body: { key, deviceId } hoặc { email, deviceId } — email ưu tiên.
// Trả: { ok, valid, reason?, plan, expiresAt, daysRemaining,
//        monthlyQuota (null = VIP không giới hạn), usedThisMonth,
//        remaining (null = không giới hạn), monthKey }
function findFlowLicense(req) {
  const rawKey = typeof req.body?.key === 'string' ? req.body.key : '';
  const rawEmail = typeof req.body?.email === 'string' ? req.body.email : '';
  if (isValidEmail(rawEmail)) return { lic: db.findLicenseByEmail(normalizeEmail(rawEmail), 'blueberry-flow'), type: 'email' };
  if (isValidKeyFormat(rawKey)) return { lic: db.findLicenseByHash(hashKey(normalizeKey(rawKey)), 'blueberry-flow'), type: 'key' };
  return { lic: null, type: null };
}
function flowLicensePayload(lic, type) {
  const quota = lic.monthlyQuota; // null = VIP không giới hạn
  const remaining = quota === null ? null : Math.max(0, quota - lic.usedThisMonth);
  return {
    ok: true, valid: true, type,
    plan: lic.plan || 'free',
    expiresAt: isUnlimitedExpiry(lic.expiresAt) ? null : lic.expiresAt,
    expiresAtISO: isUnlimitedExpiry(lic.expiresAt) ? null : new Date(lic.expiresAt).toISOString(),
    daysRemaining: daysRemaining(lic.expiresAt),
    unlimitedTime: isUnlimitedExpiry(lic.expiresAt),
    monthlyQuota: quota,
    usedThisMonth: lic.usedThisMonth,
    remaining,
    monthKey: lic.monthKey
  };
}
function cleanDeviceId(req) {
  const d = typeof req.body?.deviceId === 'string' ? req.body.deviceId : '';
  return d.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 128);
}

app.post('/api/flow/verify', verifyRateLimit, (req, res) => {
  const { lic, type } = findFlowLicense(req);
  if (!lic) return res.json({ ok: true, valid: false, reason: 'invalid' });
  if (lic.revoked) return res.json({ ok: true, valid: false, reason: 'revoked', expiresAt: lic.expiresAt, plan: lic.plan });
  if (lic.expiresAt <= Date.now()) return res.json({ ok: true, valid: false, reason: 'expired', expiresAt: lic.expiresAt, plan: lic.plan });
  const deviceId = cleanDeviceId(req);
  if (deviceId) db.touchDeviceByLicenseId(lic.id, deviceId);
  const quota = lic.monthlyQuota;
  if (quota !== null && lic.usedThisMonth >= quota) {
    return res.json({ ok: true, valid: false, reason: 'quota_exceeded', plan: lic.plan, monthlyQuota: quota, usedThisMonth: lic.usedThisMonth, remaining: 0, monthKey: lic.monthKey });
  }
  return res.json(flowLicensePayload(lic, type));
});

// Trừ quota: body { key|email, deviceId, units (1 text/ảnh, 5 video),
// kind ('text'|'image'|'video') }. Trừ xong mới tính tiền — extension
// gọi SAU MỖI TASK HOÀN THÀNH, không gọi trước khi chạy.
app.post('/api/flow/consume', flowConsumeRateLimit, (req, res) => {
  const { lic } = findFlowLicense(req);
  if (!lic) return res.json({ ok: true, valid: false, reason: 'invalid' });
  const units = Number(req.body?.units);
  if (!Number.isFinite(units) || units < 1 || units > 5) {
    return res.status(400).json({ ok: false, error: 'bad_units' });
  }
  const kind = typeof req.body?.kind === 'string' ? req.body.kind.slice(0, 20) : '';
  const deviceId = cleanDeviceId(req);
  const result = db.consumeFlowQuota(lic.id, Math.floor(units), deviceId, kind);
  if (!result.ok) {
    return res.json({ ok: true, valid: false, reason: result.reason, plan: lic.plan, monthlyQuota: lic.monthlyQuota, usedThisMonth: result.license ? result.license.usedThisMonth : lic.usedThisMonth, remaining: result.remaining !== undefined ? result.remaining : null, monthKey: lic.monthKey });
  }
  return res.json({ ok: true, valid: true, plan: result.license.plan, monthlyQuota: result.license.monthlyQuota, usedThisMonth: result.license.usedThisMonth, remaining: result.remaining, monthKey: result.license.monthKey });
});

// ---------- Hàng đợi Muse (1.5.0, Blueberry Flow v0.2.3) ----------
// Luồng đồng bộ: extension giao việc -> POST /api/flow/muse-tasks (pending)
// -> Muse phía chat poll GET /api/flow/muse-tasks?status=pending, làm xong
// -> POST /api/flow/muse-tasks/:id/result -> extension poll GET /:id thấy
// done và lấy resultText về làm kết quả task, chuyền downstream như node
// thường. Extension poll mỗi 10s, hết 10 phút chưa có kết quả thì tự
// chuyển sang fallback paste-back (không chờ server nữa).
// LƯU Ý BẢO MẬT: queue này không có auth riêng (theo thiết kế v0.2.3) —
// id là chuỗi ngẫu nhiên không đoán được, chỉ dùng cho tài khoản của user.
// Không dùng để nhận việc từ người lạ; sau khi deploy cần theo dõi bảng
// muse_tasks trên /admin.
function museTaskId() {
  return 'mt_' + Date.now().toString(36) + crypto.randomBytes(8).toString('hex');
}
function cleanMuseStr(v, max) {
  return typeof v === 'string' ? v.slice(0, max) : '';
}
app.post('/api/flow/muse-tasks', (req, res) => {
  const taskId = cleanMuseStr(req.body?.taskId, 128);
  const prompt = cleanMuseStr(req.body?.prompt, 20000);
  if (!taskId || !prompt.trim()) {
    return res.status(400).json({ ok: false, error: 'bad_task', detail: 'taskId và prompt (không rỗng) là bắt buộc' });
  }
  // Idempotency: giao lại cùng taskId khi còn pending -> trả bản cũ.
  const existing = db.findPendingMuseTaskByTaskId(taskId);
  if (existing) return res.json({ ok: true, ...existing, deduped: true });
  const task = db.createMuseTask({
    id: museTaskId(),
    taskId,
    workflowId: cleanMuseStr(req.body?.workflowId, 128),
    email: cleanMuseStr(req.body?.email, 200),
    deviceId: cleanDeviceId(req),
    prompt,
    upstreamText: cleanMuseStr(req.body?.upstreamText, 20000),
  });
  res.json({ ok: true, ...task });
});
app.get('/api/flow/muse-tasks/:id', (req, res) => {
  const task = db.getMuseTask(String(req.params.id || '').slice(0, 128));
  if (!task) return res.status(404).json({ ok: false, error: 'not_found' });
  res.json({ ok: true, ...task });
});
app.get('/api/flow/muse-tasks', (req, res) => {
  const status = typeof req.query.status === 'string' ? req.query.status.slice(0, 20) : '';
  if (status && status !== 'pending' && status !== 'done' && status !== 'failed') {
    return res.status(400).json({ ok: false, error: 'bad_status' });
  }
  const limit = req.query.limit ? Number(req.query.limit) : 100;
  res.json({ ok: true, tasks: db.listMuseTasks(status || null, limit), counts: db.countMuseTasksByStatus() });
});
app.post('/api/flow/muse-tasks/:id/result', (req, res) => {
  const id = String(req.params.id || '').slice(0, 128);
  const resultText = typeof req.body?.resultText === 'string' ? req.body.resultText
    : (typeof req.body?.result === 'string' ? req.body.result : '');
  if (!resultText.trim()) {
    return res.status(400).json({ ok: false, error: 'bad_result', detail: 'resultText (không rỗng) là bắt buộc' });
  }
  const r = db.completeMuseTask(id, resultText.slice(0, 200000));
  if (!r.ok && r.reason === 'not_found') return res.status(404).json({ ok: false, error: 'not_found' });
  if (!r.ok && r.reason === 'already_done') return res.status(409).json({ ok: false, error: 'already_done', task: r.task });
  res.json({ ok: true, ...r.task });
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
  const product = typeof req.query.product === 'string' && req.query.product ? req.query.product : undefined;
  res.json({ ok: true, stats: db.stats(product) });
});

app.get('/api/admin/licenses', requireAdmin, (req, res) => {
  const product = typeof req.query.product === 'string' && req.query.product ? req.query.product : undefined;
  res.json({ ok: true, licenses: db.listLicenses(product) });
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

// ---------- API quản trị: Blueberry Flow (1.4.0) ----------
// Tất cả endpoint dưới đây CHỈ chạm product='blueberry-flow'.
// Tạo license Flow: body { email (bắt buộc), plan ('free'|'pro'|'vip',
// mặc định 'free'), days (mặc định 30, 0 = không hết hạn),
// monthlyQuota (ghi đè gói — vd Pro tặng 500), note, zalo }.
// Email đã có license Flow thì 409 (email_exists) — cùng email vẫn có thể
// có license Doc Helper riêng, không ảnh hưởng.
app.get('/api/flow/stats', requireAdmin, (req, res) => {
  res.json({ ok: true, stats: db.flowStats() });
});

app.get('/api/admin/flow/licenses', requireAdmin, (req, res) => {
  const plan = typeof req.query.plan === 'string' && req.query.plan ? req.query.plan : undefined;
  let list = db.listLicenses('blueberry-flow');
  if (plan) list = list.filter((l) => l.plan === plan);
  res.json({ ok: true, licenses: list });
});

app.post('/api/admin/flow/licenses', requireAdmin, sameOrigin, (req, res) => {
  const rawEmail = typeof req.body?.email === 'string' ? req.body.email : '';
  if (!isValidEmail(rawEmail)) return res.status(400).json({ ok: false, error: 'bad_email' });
  const email = normalizeEmail(rawEmail);
  const plan = typeof req.body?.plan === 'string' ? req.body.plan.toLowerCase() : 'free';
  if (!isValidFlowPlan(plan)) return res.status(400).json({ ok: false, error: 'bad_plan' });
  const days = Number(req.body?.days);
  const optsDays = Number.isFinite(days) && days >= 0 && days <= 3650 ? Math.floor(days) : 30;
  const zalo = sanitizeZalo(req.body?.zalo);
  if (zalo === null) return res.status(400).json({ ok: false, error: 'bad_zalo' });
  const note = typeof req.body?.note === 'string' ? req.body.note.slice(0, 200) : '';
  let quota = null;
  if (req.body?.monthlyQuota !== undefined && req.body?.monthlyQuota !== null && req.body?.monthlyQuota !== '') {
    const q = Number(req.body.monthlyQuota);
    if (!Number.isFinite(q) || q < 0 || q > 100000) return res.status(400).json({ ok: false, error: 'bad_quota' });
    quota = Math.floor(q);
  }
  const existing = db.findLicenseByEmail(email, 'blueberry-flow');
  if (existing) return res.status(409).json({ ok: false, error: 'email_exists', license: existing });
  const lic = makeFlowEmailLicense({ days: optsDays, note, maxDevices: 0, email, plan, monthlyQuota: quota });
  const saved = db.createLicense({
    keyHash: lic.keyHash, prefix: lic.prefix, note: lic.note,
    expiresAt: lic.expiresAt, maxDevices: lic.maxDevices, email: lic.email, zalo,
    product: 'blueberry-flow', plan: lic.plan, monthlyQuota: lic.monthlyQuota
  });
  res.json({ ok: true, email: saved.email, license: saved });
});

app.patch('/api/admin/flow/licenses/:id', requireAdmin, sameOrigin, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ ok: false, error: 'bad_id' });
  const lic = db.findFlowLicenseById(id);
  if (!lic) return res.status(404).json({ ok: false, error: 'not_found' });
  const patch = {};
  if (req.body?.zalo !== undefined) {
    const z = sanitizeZalo(req.body.zalo);
    if (z === null) return res.status(400).json({ ok: false, error: 'bad_zalo' });
    patch.zalo = z;
  }
  if (typeof req.body?.note === 'string') patch.note = req.body.note.slice(0, 200);
  if (typeof req.body?.plan === 'string') {
    if (!isValidFlowPlan(req.body.plan.toLowerCase())) return res.status(400).json({ ok: false, error: 'bad_plan' });
    patch.plan = req.body.plan.toLowerCase();
  }
  if (req.body?.monthlyQuota !== undefined) {
    if (req.body.monthlyQuota === null || req.body.monthlyQuota === '') patch.monthlyQuota = null;
    else {
      const q = Number(req.body.monthlyQuota);
      if (!Number.isFinite(q) || q < 0 || q > 100000) return res.status(400).json({ ok: false, error: 'bad_quota' });
      patch.monthlyQuota = Math.floor(q);
    }
  }
  if (req.body?.usedThisMonth !== undefined) {
    const u = Number(req.body.usedThisMonth);
    if (!Number.isFinite(u) || u < 0 || u > 100000) return res.status(400).json({ ok: false, error: 'bad_used' });
    patch.usedThisMonth = Math.floor(u);
  }
  if (req.body?.unlimitedTime === true) {
    patch.expiresAt = UNLIMITED_EXPIRES_AT;
  } else if (typeof req.body?.expiresAtISO === 'string' && req.body.expiresAtISO) {
    const ms = Date.parse(req.body.expiresAtISO + 'T23:59:59.999+07:00');
    if (!Number.isFinite(ms)) return res.status(400).json({ ok: false, error: 'bad_expiry' });
    patch.expiresAt = ms;
  } else if (req.body?.days !== undefined) {
    const d = Number(req.body.days);
    if (!Number.isFinite(d) || d < 0 || d > 3650) return res.status(400).json({ ok: false, error: 'bad_days' });
    patch.expiresAt = d === 0 ? UNLIMITED_EXPIRES_AT : Date.now() + Math.floor(d) * 24 * 60 * 60 * 1000;
  }
  const updated = db.updateLicense(id, patch);
  res.json({ ok: true, license: updated });
});

app.post('/api/admin/flow/licenses/:id/revoke', requireAdmin, sameOrigin, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ ok: false, error: 'bad_id' });
  if (!db.findFlowLicenseById(id)) return res.status(404).json({ ok: false, error: 'not_found' });
  res.json({ ok: db.revokeLicense(id, true) });
});

app.post('/api/admin/flow/licenses/:id/restore', requireAdmin, sameOrigin, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ ok: false, error: 'bad_id' });
  if (!db.findFlowLicenseById(id)) return res.status(404).json({ ok: false, error: 'not_found' });
  res.json({ ok: db.revokeLicense(id, false) });
});

app.delete('/api/admin/flow/licenses/:id', requireAdmin, sameOrigin, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ ok: false, error: 'bad_id' });
  if (!db.findFlowLicenseById(id)) return res.status(404).json({ ok: false, error: 'not_found' });
  res.json({ ok: db.deleteLicense(id) });
});

app.get('/api/admin/flow/usage', requireAdmin, (req, res) => {
  const licenseId = req.query.licenseId ? Number(req.query.licenseId) : null;
  const limit = req.query.limit ? Number(req.query.limit) : 100;
  res.json({ ok: true, usage: db.listFlowUsage(Number.isFinite(licenseId) ? licenseId : null, limit) });
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
