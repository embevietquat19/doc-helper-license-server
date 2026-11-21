// Doc Helper License Server 1.1.0 — src/db.js
// SQLite qua node:sqlite (có sẵn từ Node 22+, không cần gói native).
// Lưu key dạng HASH SHA-256 (không lưu key gốc — lộ DB cũng không dùng được
// key). Mỗi key: hạn dùng, trạng thái, số thiết bị tối đa, ghi chú.
// Từ 1.1.0: license có thể gắn EMAIL khách thay vì key rời (cột email;
// license email có prefix 'EMAIL' và key_hash là 1 key ngẫu nhiên đã bỏ
// đi, không ai biết). Bảng devices: 1 dòng / (key, deviceId) — đếm thiết
// bị đã kích hoạt.
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
    email TEXT DEFAULT ''
  );
  CREATE TABLE IF NOT EXISTS devices (
    key_hash TEXT NOT NULL,
    device_id TEXT NOT NULL,
    first_seen_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    PRIMARY KEY (key_hash, device_id)
  );
  CREATE INDEX IF NOT EXISTS idx_licenses_expires ON licenses(expires_at);
`);
// DB cũ (tạo trước 1.1.0) chưa có cột email — thêm vào, đã có thì bỏ qua.
try { db.exec(`ALTER TABLE licenses ADD COLUMN email TEXT DEFAULT ''`); } catch (e) { /* cột đã có */ }

function rowToLicense(r) {
  if (!r) return null;
  return {
    id: r.id,
    prefix: r.prefix,
    email: r.email || '',
    note: r.note || '',
    expiresAt: r.expires_at,
    expiresAtISO: new Date(r.expires_at).toISOString(),
    maxDevices: r.max_devices,
    revoked: !!r.revoked,
    createdAt: r.created_at,
    lastUsedAt: r.last_used_at || null
  };
}

// Ghi nhận 1 thiết bị dùng key. Trả { ok, deviceCount, reason }:
// - ok=false khi đã đủ số thiết bị tối đa mà deviceId này chưa từng dùng.
function touchDevice(keyHash, deviceId) {
  const now = Date.now();
  const lic = db.prepare('SELECT max_devices FROM licenses WHERE key_hash = ?').get(keyHash);
  if (!lic) return { ok: false, reason: 'not_found' };
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
  if (count >= lic.max_devices) return { ok: false, reason: 'device_limit', deviceCount: count };
  db.prepare(
    'INSERT INTO devices (key_hash, device_id, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?)'
  ).run(keyHash, deviceId, now, now);
  db.prepare('UPDATE licenses SET last_used_at = ? WHERE key_hash = ?').run(now, keyHash);
  return { ok: true, deviceCount: count + 1 };
}

module.exports = {
  db,
  DB_PATH,
  createLicense({ keyHash, prefix, note, expiresAt, maxDevices, email }) {
    const now = Date.now();
    const r = db.prepare(
      'INSERT INTO licenses (key_hash, prefix, note, expires_at, max_devices, created_at, email) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(keyHash, prefix, note || '', expiresAt, maxDevices, now, email || '');
    return rowToLicense(db.prepare('SELECT * FROM licenses WHERE id = ?').get(r.lastInsertRowid));
  },
  findLicenseByHash(keyHash) {
    return rowToLicense(db.prepare('SELECT * FROM licenses WHERE key_hash = ?').get(keyHash));
  },
  // Tìm license theo email (email đã chuẩn hoá thường). Trả về bản mới nhất
  // nếu có nhiều bản (ví dụ gia hạn tạo bản mới mà chưa xóa bản cũ).
  findLicenseByEmail(email) {
    return rowToLicense(db.prepare(
      'SELECT * FROM licenses WHERE email = ? ORDER BY id DESC LIMIT 1'
    ).get(email || ''));
  },
  listLicenses() {
    const rows = db.prepare('SELECT * FROM licenses ORDER BY id DESC').all();
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
    const row = db.prepare('SELECT key_hash FROM licenses WHERE id = ?').get(id);
    if (!row) return { ok: false, reason: 'not_found' };
    return touchDevice(row.key_hash, deviceId);
  },
  stats() {
    const total = db.prepare('SELECT COUNT(*) AS n FROM licenses').get().n;
    const active = db.prepare(
      'SELECT COUNT(*) AS n FROM licenses WHERE revoked = 0 AND expires_at > ?'
    ).get(Date.now()).n;
    const expired = db.prepare(
      'SELECT COUNT(*) AS n FROM licenses WHERE revoked = 0 AND expires_at <= ?'
    ).get(Date.now()).n;
    const revoked = db.prepare('SELECT COUNT(*) AS n FROM licenses WHERE revoked = 1').get().n;
    return { total, active, expired, revoked };
  }
};
