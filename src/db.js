// Doc Helper License Server 1.5.0 — src/db.js
// (v1.5.0 = 1.4.0 + hàng đợi Muse cho Blueberry Flow v0.2.3 — xem README_SERVER.md)
// Từ 1.5.0: bảng muse_tasks — extension giao việc cho Muse qua server
// (POST /api/flow/muse-tasks), Muse phía chat poll ?status=pending rồi
// trả kết quả về (POST .../result), extension poll GET /:id lấy kết quả.
// Không có auth riêng cho queue này (theo thiết kế v0.2.3): id là chuỗi
// ngẫu nhiên không đoán được; chỉ dùng cho tài khoản của user, theo dõi
// qua bảng admin sau khi deploy.
// SQLite qua node:sqlite (có sẵn từ Node 22+, không cần gói native).
// Lưu key dạng HASH SHA-256 (không lưu key gốc — lộ DB cũng không dùng được
// key). Mỗi key: hạn dùng, trạng thái, số thiết bị tối đa, ghi chú.
// Từ 1.1.0: license có thể gắn EMAIL khách thay vì key rời (cột email;
// license email có prefix 'EMAIL' và key_hash là 1 key ngẫu nhiên đã bỏ
// đi, không ai biết). Bảng devices: 1 dòng / (key, deviceId) — đếm thiết
// bị đã kích hoạt.
// Từ 1.2.0: license KHÔNG GIỚI HẠN — expires_at = 31/12/9999 (mốc
// UNLIMITED_EXPIRES_AT trong keys.js) nghĩa là không hết hạn;
// max_devices = 0 nghĩa là không giới hạn thiết bị (touchDevice luôn OK).
// Từ 1.3.0: license có thêm SỐ ZALO khách (cột zalo) + sửa được thông tin
// khách (updateLicense: zalo, ghi chú, hạn dùng, số thiết bị tối đa).
// Từ 1.4.0: license có thêm PRODUCT ('doc-helper' | 'blueberry' |
// 'blueberry-flow') + PLAN ('free'|'pro'|'vip', chỉ Flow dùng) +
// monthly_quota / used_this_month / month_key (quota tháng của Flow) +
// bảng flow_usage (log từng lần trừ quota). License cũ (tạo trước 1.4.0)
// mặc định product='doc-helper', plan='', quota NULL — hành vi /api/verify
// cũ không đổi: nó chỉ tìm product='doc-helper'.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = path.join(DATA_DIR, 'licenses.db');

const db = new DatabaseSync(DB_PATH);
db.exec(`
  CREATE TABLE IF NOT EXISTS licenses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key_hash TEXT UNIQUE NOT NULL,
    prefix TEXT NOT NULL,
    note TEXT DEFAULT '',
    expires_at INTEGER NOT NULL,
    max_devices INTEGER NOT NULL DEFAULT 2,
    revoked INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    last_used_at INTEGER,
    email TEXT DEFAULT '',
    zalo TEXT DEFAULT '',
    product TEXT NOT NULL DEFAULT 'doc-helper',
    plan TEXT DEFAULT '',
    monthly_quota INTEGER,
    used_this_month INTEGER NOT NULL DEFAULT 0,
    month_key TEXT DEFAULT ''
  );
  CREATE TABLE IF NOT EXISTS devices (
    key_hash TEXT NOT NULL,
    device_id TEXT NOT NULL,
    first_seen_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    PRIMARY KEY (key_hash, device_id)
  );
  CREATE TABLE IF NOT EXISTS flow_usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    license_id INTEGER NOT NULL,
    device_id TEXT DEFAULT '',
    units INTEGER NOT NULL,
    kind TEXT DEFAULT '',
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS muse_tasks (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    workflow_id TEXT DEFAULT '',
    email TEXT DEFAULT '',
    device_id TEXT DEFAULT '',
    prompt TEXT NOT NULL,
    upstream_text TEXT DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending',
    result_text TEXT DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    completed_at INTEGER
  );
`);
// DB cũ (tạo trước 1.1.0) chưa có cột email — thêm vào, đã có thì bỏ qua.
try { db.exec(`ALTER TABLE licenses ADD COLUMN email TEXT DEFAULT ''`); } catch (e) { /* cột đã có */ }
// DB cũ (tạo trước 1.3.0) chưa có cột zalo — thêm vào, đã có thì bỏ qua.
try { db.exec(`ALTER TABLE licenses ADD COLUMN zalo TEXT DEFAULT ''`); } catch (e) { /* cột đã có */ }
// DB cũ (tạo trước 1.4.0) chưa có cột product/plan/quota — thêm vào.
try { db.exec(`ALTER TABLE licenses ADD COLUMN product TEXT NOT NULL DEFAULT 'doc-helper'`); } catch (e) { /* cột đã có */ }
try { db.exec(`ALTER TABLE licenses ADD COLUMN plan TEXT DEFAULT ''`); } catch (e) { /* cột đã có */ }
try { db.exec(`ALTER TABLE licenses ADD COLUMN monthly_quota INTEGER`); } catch (e) { /* cột đã có */ }
try { db.exec(`ALTER TABLE licenses ADD COLUMN used_this_month INTEGER NOT NULL DEFAULT 0`); } catch (e) { /* cột đã có */ }
try { db.exec(`ALTER TABLE licenses ADD COLUMN month_key TEXT DEFAULT ''`); } catch (e) { /* cột đã có */ }
// Index — PHẢI chạy SAU các ALTER ở trên. Trước đây index trên cột
// product chạy trước khi cột được thêm, nên DB cũ (chưa có cột product)
// crash ngay lúc load với "no such column: product" — đó là lỗi làm
// server live 1.4.0 sập vòng lặp 503 ngày 25/11/2026.
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_licenses_expires ON licenses(expires_at);
  CREATE INDEX IF NOT EXISTS idx_licenses_product ON licenses(product);
  CREATE INDEX IF NOT EXISTS idx_licenses_email_product ON licenses(email, product);
  CREATE INDEX IF NOT EXISTS idx_flow_usage_license ON flow_usage(license_id);
  CREATE INDEX IF NOT EXISTS idx_muse_tasks_status ON muse_tasks(status, created_at);
  CREATE INDEX IF NOT EXISTS idx_muse_tasks_task ON muse_tasks(task_id);
`);
// DB cũ chưa có bảng flow_usage — CREATE TABLE IF NOT EXISTS ở trên đã lo.

function museTaskRow(r) {
  if (!r) return null;
  return {
    id: r.id,
    taskId: r.task_id,
    workflowId: r.workflow_id || '',
    email: r.email || '',
    deviceId: r.device_id || '',
    prompt: r.prompt || '',
    upstreamText: r.upstream_text || '',
    status: r.status || 'pending',
    resultText: r.result_text || '',
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    completedAt: r.completed_at || null,
  };
}

function rowToLicense(r) {
  if (!r) return null;
  return {
    id: r.id,
    prefix: r.prefix,
    email: r.email || '',
    zalo: r.zalo || '',
    note: r.note || '',
    expiresAt: r.expires_at,
    expiresAtISO: new Date(r.expires_at).toISOString(),
    maxDevices: r.max_devices,
    revoked: !!r.revoked,
    createdAt: r.created_at,
    lastUsedAt: r.last_used_at || null,
    // 1.4.0 — tách theo tool:
    product: r.product || 'doc-helper',
    plan: r.plan || '',
    monthlyQuota: (r.monthly_quota === null || r.monthly_quota === undefined) ? null : r.monthly_quota,
    usedThisMonth: r.used_this_month || 0,
    monthKey: r.month_key || ''
  };
}

// Tháng hiện tại dạng YYYY-MM (giờ UTC — đủ cho việc reset quota tháng).
function currentMonthKey() {
  const d = new Date();
  return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0');
}
// Nếu license đang ở tháng cũ thì reset used_this_month về 0 (ghi DB luôn).
// Trả về row đã reset (hoặc row gốc nếu đã đúng tháng).
function rollMonthIfNeeded(row) {
  const mk = currentMonthKey();
  if ((row.month_key || '') !== mk) {
    db.prepare('UPDATE licenses SET month_key = ?, used_this_month = 0 WHERE id = ?').run(mk, row.id);
    row.month_key = mk;
    row.used_this_month = 0;
  }
  return row;
}

// Ghi nhận 1 thiết bị dùng license. Trả { ok, deviceCount, reason }:
// - ok=false khi đã đủ số thiết bị tối đa mà deviceId này chưa từng dùng.
// - max_devices = 0 → không giới hạn thiết bị: luôn OK, vẫn đếm để hiển thị.
// Nhận keyHash (từ /api/verify theo key) HOẶC licenseId (từ verify theo
// email — không có key để tính hash từ phía gọi).
function touchDevice(keyHashOrId, deviceId, byId) {
  const now = Date.now();
  const lic = byId
    ? db.prepare('SELECT key_hash, max_devices FROM licenses WHERE id = ?').get(keyHashOrId)
    : db.prepare('SELECT key_hash, max_devices FROM licenses WHERE key_hash = ?').get(keyHashOrId);
  if (!lic) return { ok: false, reason: 'not_found' };
  const keyHash = lic.key_hash;
  const existing = db.prepare(
    'SELECT 1 FROM devices WHERE key_hash = ? AND device_id = ?'
  ).get(keyHash, deviceId);
  if (existing) {
    db.prepare(
      'UPDATE devices SET last_seen_at = ? WHERE key_hash = ? AND device_id = ?'
    ).run(now, keyHash, deviceId);
    db.prepare('UPDATE licenses SET last_used_at = ? WHERE key_hash = ?').run(now, keyHash);
    const n = db.prepare('SELECT COUNT(*) AS n FROM devices WHERE key_hash = ?').get(keyHash).n;
    return { ok: true, deviceCount: n };
  }
  const count = db.prepare('SELECT COUNT(*) AS n FROM devices WHERE key_hash = ?').get(keyHash).n;
  if (lic.max_devices !== 0 && count >= lic.max_devices) return { ok: false, reason: 'device_limit', deviceCount: count };
  db.prepare(
    'INSERT INTO devices (key_hash, device_id, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?)'
  ).run(keyHash, deviceId, now, now);
  db.prepare('UPDATE licenses SET last_used_at = ? WHERE key_hash = ?').run(now, keyHash);
  return { ok: true, deviceCount: count + 1 };
}

module.exports = {
  db,
  DB_PATH,
  createLicense({ keyHash, prefix, note, expiresAt, maxDevices, email, zalo, product, plan, monthlyQuota }) {
    const now = Date.now();
    const prod = product || 'doc-helper';
    const r = db.prepare(
      'INSERT INTO licenses (key_hash, prefix, note, expires_at, max_devices, created_at, email, zalo, product, plan, monthly_quota, used_this_month, month_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)'
    ).run(keyHash, prefix, note || '', expiresAt, maxDevices, now, email || '', zalo || '', prod, plan || '', (monthlyQuota === undefined ? null : monthlyQuota), currentMonthKey());
    return rowToLicense(db.prepare('SELECT * FROM licenses WHERE id = ?').get(r.lastInsertRowid));
  },
  // Sửa thông tin khách: chỉ cập nhật các trường có trong patch
  // (zalo, note, expiresAt, maxDevices + 1.4.0: plan, monthlyQuota, product).
  // Trả license đã sửa, hoặc null nếu không có license nào mang id đó.
  // Patch rỗng → trả nguyên bản.
  updateLicense(id, patch) {
    const row = db.prepare('SELECT * FROM licenses WHERE id = ?').get(id);
    if (!row) return null;
    const fields = [];
    const vals = [];
    if (typeof patch.zalo === 'string') { fields.push('zalo = ?'); vals.push(patch.zalo); }
    if (typeof patch.note === 'string') { fields.push('note = ?'); vals.push(patch.note); }
    if (Number.isFinite(patch.expiresAt)) { fields.push('expires_at = ?'); vals.push(patch.expiresAt); }
    if (Number.isFinite(patch.maxDevices)) { fields.push('max_devices = ?'); vals.push(patch.maxDevices); }
    if (typeof patch.product === 'string' && patch.product) { fields.push('product = ?'); vals.push(patch.product); }
    if (typeof patch.plan === 'string') { fields.push('plan = ?'); vals.push(patch.plan); }
    if (patch.monthlyQuota === null || Number.isFinite(patch.monthlyQuota)) { fields.push('monthly_quota = ?'); vals.push(patch.monthlyQuota); }
    if (Number.isFinite(patch.usedThisMonth) && patch.usedThisMonth >= 0) { fields.push('used_this_month = ?'); vals.push(Math.floor(patch.usedThisMonth)); }
    if (typeof patch.monthKey === 'string') { fields.push('month_key = ?'); vals.push(patch.monthKey); }
    if (fields.length) {
      vals.push(id);
      db.prepare(`UPDATE licenses SET ${fields.join(', ')} WHERE id = ?`).run(...vals);
    }
    const lic = rowToLicense(db.prepare('SELECT * FROM licenses WHERE id = ?').get(id));
    lic.deviceCount = db.prepare('SELECT COUNT(*) AS n FROM devices WHERE key_hash = ?').get(row.key_hash).n;
    return lic;
  },
  // product: lọc theo tool. Mặc định 'doc-helper' để /api/verify cũ (và
  // test cũ) không bao giờ vô tình tra trúng license Flow/Blueberry.
  findLicenseByHash(keyHash, product) {
    const prod = product || 'doc-helper';
    return rowToLicense(db.prepare('SELECT * FROM licenses WHERE key_hash = ? AND product = ?').get(keyHash, prod));
  },
  // Tìm license theo email (email đã chuẩn hoá thường). Trả về bản mới nhất
  // nếu có nhiều bản (ví dụ gia hạn tạo bản mới mà chưa xóa bản cũ).
  // product mặc định 'doc-helper' — cùng 1 email có thể có license ở cả
  // Doc Helper và Flow, đó là 2 bản riêng, không lẫn nhau.
  findLicenseByEmail(email, product) {
    const prod = product || 'doc-helper';
    const row = db.prepare(
      'SELECT * FROM licenses WHERE email = ? AND product = ? ORDER BY id DESC LIMIT 1'
    ).get(email || '', prod);
    return row ? rowToLicense(rollMonthIfNeeded(row)) : null;
  },
  findFlowLicenseById(id) {
    const row = db.prepare('SELECT * FROM licenses WHERE id = ? AND product = ?').get(id, 'blueberry-flow');
    return row ? rowToLicense(rollMonthIfNeeded(row)) : null;
  },
  listLicenses(product) {
    const rows = product
      ? db.prepare('SELECT * FROM licenses WHERE product = ? ORDER BY id DESC').all(product)
      : db.prepare('SELECT * FROM licenses ORDER BY id DESC').all();
    return rows.map((r) => {
      const l = rowToLicense(r);
      l.deviceCount = db.prepare('SELECT COUNT(*) AS n FROM devices WHERE key_hash = ?').get(r.key_hash).n;
      return l;
    });
  },
  revokeLicense(id, revoked) {
    const r = db.prepare('UPDATE licenses SET revoked = ? WHERE id = ?').run(revoked ? 1 : 0, id);
    return r.changes > 0;
  },
  deleteLicense(id) {
    const row = db.prepare('SELECT key_hash FROM licenses WHERE id = ?').get(id);
    if (!row) return false;
    db.prepare('DELETE FROM devices WHERE key_hash = ?').run(row.key_hash);
    const r = db.prepare('DELETE FROM licenses WHERE id = ?').run(id);
    return r.changes > 0;
  },
  touchDevice,
  // Đếm thiết bị theo ID license (dùng cho license email — không có key
  // để tính hash từ phía gọi).
  touchDeviceByLicenseId(id, deviceId) {
    return touchDevice(id, deviceId, true);
  },
  stats(product) {
    const where = product ? ' AND product = ?' : '';
    const args = product ? [product] : [];
    const total = db.prepare(`SELECT COUNT(*) AS n FROM licenses WHERE 1=1${where}`).get(...args).n;
    const active = db.prepare(
      `SELECT COUNT(*) AS n FROM licenses WHERE revoked = 0 AND expires_at > ?${where}`
    ).get(Date.now(), ...args).n;
    const expired = db.prepare(
      `SELECT COUNT(*) AS n FROM licenses WHERE revoked = 0 AND expires_at <= ?${where}`
    ).get(Date.now(), ...args).n;
    const revoked = db.prepare(`SELECT COUNT(*) AS n FROM licenses WHERE revoked = 1${where}`).get(...args).n;
    return { total, active, expired, revoked };
  },
  // ---- Blueberry Flow (1.4.0): trừ quota tháng ----
  // Trả { ok:true, license } khi trừ được, hoặc { ok:false, reason } khi
  // license không tồn tại / bị khóa / hết hạn / hết quota. DatabaseSync
  // chạy đồng bộ nên đọc-kiểm-tra-ghi trong 1 lượt là nguyên tử trong
  // process này (không có 2 request chen nhau giữa chừng).
  // units: 1 (text/ảnh) hoặc 5 (video). kind: 'text'|'image'|'video'.
  consumeFlowQuota(licenseId, units, deviceId, kind) {
    const row = db.prepare('SELECT * FROM licenses WHERE id = ? AND product = ?').get(licenseId, 'blueberry-flow');
    if (!row) return { ok: false, reason: 'invalid' };
    if (row.revoked) return { ok: false, reason: 'revoked', license: rowToLicense(row) };
    if (row.expires_at <= Date.now()) return { ok: false, reason: 'expired', license: rowToLicense(row) };
    rollMonthIfNeeded(row);
    const quota = row.monthly_quota; // null = không giới hạn (VIP)
    const used = row.used_this_month || 0;
    if (quota !== null && quota !== undefined && used + units > quota) {
      return { ok: false, reason: 'quota_exceeded', license: rowToLicense(row), remaining: Math.max(0, quota - used) };
    }
    const now = Date.now();
    db.prepare('UPDATE licenses SET used_this_month = used_this_month + ?, last_used_at = ? WHERE id = ?').run(units, now, licenseId);
    db.prepare('INSERT INTO flow_usage (license_id, device_id, units, kind, created_at) VALUES (?, ?, ?, ?, ?)').run(licenseId, deviceId || '', units, kind || '', now);
    const lic = rowToLicense(db.prepare('SELECT * FROM licenses WHERE id = ?').get(licenseId));
    return { ok: true, license: lic, remaining: (lic.monthlyQuota === null ? null : lic.monthlyQuota - lic.usedThisMonth) };
  },
  listFlowUsage(licenseId, limit) {
    const n = Number.isFinite(limit) && limit > 0 && limit <= 500 ? Math.floor(limit) : 100;
    const rows = licenseId
      ? db.prepare('SELECT * FROM flow_usage WHERE license_id = ? ORDER BY id DESC LIMIT ?').all(licenseId, n)
      : db.prepare('SELECT * FROM flow_usage ORDER BY id DESC LIMIT ?').all(n);
    return rows.map((r) => ({ id: r.id, licenseId: r.license_id, deviceId: r.device_id, units: r.units, kind: r.kind || '', createdAt: r.created_at }));
  },
  flowStats() {
    const mk = currentMonthKey();
    const byPlan = db.prepare(
      `SELECT plan, COUNT(*) AS n, COALESCE(SUM(used_this_month),0) AS used FROM licenses WHERE product = 'blueberry-flow' GROUP BY plan`
    ).all();
    const monthUsage = db.prepare(
      `SELECT COALESCE(SUM(units),0) AS units, COUNT(*) AS runs FROM flow_usage WHERE created_at >= ?`
    ).get(Date.now() - 30 * 24 * 60 * 60 * 1000);
    return { monthKey: mk, byPlan, monthUsage };
  },
  // ---- Hàng đợi Muse (1.5.0, Blueberry Flow v0.2.3) ----
  // id: chuỗi ngẫu nhiên 'mt_...' do server cấp (không đoán được).
  // task_id: id task trong extension (dùng để idempotency: POST lại cùng
  // task_id khi task còn pending thì trả về bản cũ, không tạo trùng).
  // status: 'pending' | 'done' | 'failed'. result_text chỉ có khi done.
  createMuseTask({ id, taskId, workflowId, email, deviceId, prompt, upstreamText }) {
    const now = Date.now();
    db.prepare(
      'INSERT INTO muse_tasks (id, task_id, workflow_id, email, device_id, prompt, upstream_text, status, result_text, created_at, updated_at, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)'
    ).run(id, taskId, workflowId || '', email || '', deviceId || '', prompt, upstreamText || '', 'pending', '', now, now);
    return this.getMuseTask(id);
  },
  getMuseTask(id) {
    const r = db.prepare('SELECT * FROM muse_tasks WHERE id = ?').get(id);
    return r ? museTaskRow(r) : null;
  },
  findPendingMuseTaskByTaskId(taskId) {
    const r = db.prepare(
      "SELECT * FROM muse_tasks WHERE task_id = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 1"
    ).get(taskId);
    return r ? museTaskRow(r) : null;
  },
  listMuseTasks(status, limit) {
    const n = Number.isFinite(limit) && limit > 0 && limit <= 500 ? Math.floor(limit) : 100;
    const rows = status
      ? db.prepare('SELECT * FROM muse_tasks WHERE status = ? ORDER BY created_at ASC LIMIT ?').all(status, n)
      : db.prepare('SELECT * FROM muse_tasks ORDER BY created_at DESC LIMIT ?').all(n);
    return rows.map(museTaskRow);
  },
  // Chỉ task pending mới nhận kết quả. Trả { ok:true, task } hoặc
  // { ok:false, reason:'not_found'|'already_done' }.
  completeMuseTask(id, resultText) {
    const row = db.prepare('SELECT * FROM muse_tasks WHERE id = ?').get(id);
    if (!row) return { ok: false, reason: 'not_found' };
    if (row.status !== 'pending') return { ok: false, reason: 'already_done', task: museTaskRow(row) };
    const now = Date.now();
    db.prepare(
      "UPDATE muse_tasks SET status = 'done', result_text = ?, updated_at = ?, completed_at = ? WHERE id = ?"
    ).run(resultText, now, now, id);
    return { ok: true, task: this.getMuseTask(id) };
  },
  countMuseTasksByStatus() {
    const rows = db.prepare('SELECT status, COUNT(*) AS n FROM muse_tasks GROUP BY status').all();
    const out = { pending: 0, done: 0, failed: 0 };
    rows.forEach((r) => { out[r.status] = r.n; });
    return out;
  },
  currentMonthKey,
  rollMonthIfNeeded
};
