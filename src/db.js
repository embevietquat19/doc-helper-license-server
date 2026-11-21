// Doc Helper License Server 1.0.0 — src/db.js
// SQLite qua node:sqlite (có sẵn từ Node 22+, không cần gói native).
// Lưu key dạng HASH SHA-256 (không lưu key gốc — lộ DB cũng không dùng được
// key). Mỗi key: hạn dùng, trạng thái, số thiết bị tối đa, ghi chú.
// Bảng devices: 1 dòng / (key, deviceId) — đếm thiết bị đã kích hoạt.
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
    last_used_at INTEGER
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

function rowToLicense(r) {
  if (!r) return null;
  return {
    id: r.id,
    prefix: r.prefix,
    note: r.note || '',
    expiresAt: r.expires_at,
    expiresAtISO: new Date(r.expires_at).toISOString(),
    maxDevices: r.max_devices,
    revoked: !!r.revoked,
    createdAt: r.created_at,
    lastUsedAt: r.last_used_at || null
  };
}

module.exports = {
  db,
  DB_PATH,
  createLicense({ keyHash, prefix, note, expiresAt, maxDevices }) {
    const now = Date.now();
    const r = db.prepare(
      'INSERT INTO licenses (key_hash, prefix, note, expires_at, max_devices, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(keyHash, prefix, note || '', expiresAt, maxDevices, now);
    return rowToLicense(db.prepare('SELECT * FROM licenses WHERE id = ?').get(r.lastInsertRowid));
  },
  findLicenseByHash(keyHash) {
    return rowToLicense(db.prepare('SELECT * FROM licenses WHERE key_hash = ?').get(keyHash));
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
  // Ghi nhận 1 thiết bị dùng key. Trả { ok, deviceCount, reason }:
  // - ok=false khi đã đủ số thiết bị tối đa mà deviceId này chưa từng dùng.
  touchDevice(keyHash, deviceId) {
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
