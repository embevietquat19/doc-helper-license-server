// Doc Helper License Server 1.2.0 — src/keys.js
// Định dạng key: TLV-XXXX-XXXX-XXXX-XXXX (16 ký tự, Crockford base32,
// bỏ 0/O/1/I/L để tránh nhầm khi gõ tay). 16 ký tự = 80 bit — không đoán
// nổi, kể cả khi kẻ xấu thử hàng triệu lần (có rate-limit ở /verify).
// Từ 1.1.0: license có thể gắn với EMAIL khách thay vì key rời — khách
// thanh toán rồi gửi email, shop kích hoạt email đó; extension nhập email
// là tải được, không cần cấp key.
// Từ 1.2.0: license KHÔNG GIỚI HẠN — days = 0 → hết hạn 31/12/9999
// (UNLIMITED_EXPIRES_AT), maxDevices = 0 → không giới hạn thiết bị.
// Dùng mốc 9999 thay vì NULL để không phải migrate DB đang chạy.
'use strict';
const crypto = require('node:crypto');

const ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ0123456789'; // Crockford base32, không 0/O/1/I/L
const KEY_RE = /^TLV-([A-Z0-9]{4})-([A-Z0-9]{4})-([A-Z0-9]{4})-([A-Z0-9]{4})$/;

function generateKey() {
  const bytes = crypto.randomBytes(10); // 80 bit
  let bits = 0;
  let value = 0;
  let out = '';
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += ALPHABET[(value >> bits) & 31];
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return `TLV-${out.slice(0, 4)}-${out.slice(4, 8)}-${out.slice(8, 12)}-${out.slice(12, 16)}`;
}

// Chuẩn hoá key người dùng nhập: bỏ khoảng trắng/gạch, viết hoa, thêm dấu -.
// Lưu ý: chỉ sửa O/I/L trong PHẦN THÂN key (TLV là tiền tố cố định, chữ L
// trong đó không được đổi thành 1).
function normalizeKey(raw) {
  if (typeof raw !== 'string') return '';
  let clean = raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (clean.startsWith('TLV')) clean = clean.slice(3);
  const body = clean.replace(/O/g, '0').replace(/I/g, '1').replace(/L/g, '1');
  if (body.length !== 16) return '';
  return `TLV-${body.slice(0, 4)}-${body.slice(4, 8)}-${body.slice(8, 12)}-${body.slice(12, 16)}`;
}

function isValidKeyFormat(raw) {
  return KEY_RE.test(normalizeKey(raw));
}

function hashKey(normalizedKey) {
  return crypto.createHash('sha256').update(normalizedKey, 'utf8').digest('hex');
}

// Mốc "không giới hạn thời gian": 31/12/9999 23:59:59.999 UTC.
// DB hiện tại để expires_at NOT NULL nên dùng mốc này thay vì NULL —
// mọi phép so sánh hết hạn vẫn đúng, không cần migrate DB đang chạy.
const UNLIMITED_EXPIRES_AT = 253402300799999;

function isUnlimitedExpiry(expiresAt) {
  return typeof expiresAt === 'number' && expiresAt >= UNLIMITED_EXPIRES_AT;
}

// Số ngày còn lại (làm tròn lên); null khi không giới hạn thời gian.
function daysRemaining(expiresAt, nowMs) {
  if (isUnlimitedExpiry(expiresAt)) return null;
  const now = typeof nowMs === 'number' ? nowMs : Date.now();
  return Math.max(0, Math.ceil((expiresAt - now) / (24 * 60 * 60 * 1000)));
}

function isUnlimitedDevices(maxDevices) {
  return maxDevices === 0;
}

// Tạo key mới: { key (hiển thị 1 lần duy nhất), prefix, expiresAt }.
// days: số ngày dùng được (mặc định 30); days = 0 → không giới hạn thời
// gian. maxDevices = 0 → không giới hạn thiết bị.
function makeLicense({ days = 30, note = '', maxDevices = 2 } = {}) {
  const key = generateKey();
  const expiresAt = days === 0 ? UNLIMITED_EXPIRES_AT : Date.now() + Math.max(1, days) * 24 * 60 * 60 * 1000;
  return {
    key,
    keyHash: hashKey(key),
    prefix: key.slice(0, 8), // "TLV-XXXX" — để nhận diện key trong danh sách
    note,
    expiresAt,
    maxDevices
  };
}

// --- License theo email ---
// Chuẩn hoá email: cắt khoảng trắng, viết thường (so sánh không phân biệt
// hoa/thường).
function normalizeEmail(raw) {
  if (typeof raw !== 'string') return '';
  return raw.trim().toLowerCase();
}

function isValidEmail(raw) {
  const e = normalizeEmail(raw);
  return e.length > 0 && e.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e);
}

// Tạo license theo email: khách không nhận key — key_hash lưu 1 key ngẫu
// nhiên rồi bỏ đi (không trả về, không ai biết), chỉ để đủ cột NOT NULL /
// UNIQUE của bảng. prefix 'EMAIL' để nhận diện trong danh sách.
function makeEmailLicense({ days = 30, note = '', maxDevices = 2, email = '' } = {}) {
  const key = generateKey(); // sinh rồi bỏ — không trả về cho ai
  const expiresAt = days === 0 ? UNLIMITED_EXPIRES_AT : Date.now() + Math.max(1, days) * 24 * 60 * 60 * 1000;
  return {
    email: normalizeEmail(email),
    keyHash: hashKey(key),
    prefix: 'EMAIL',
    note,
    expiresAt,
    maxDevices
  };
}

module.exports = { generateKey, normalizeKey, isValidKeyFormat, hashKey, makeLicense, normalizeEmail, isValidEmail, makeEmailLicense, UNLIMITED_EXPIRES_AT, isUnlimitedExpiry, daysRemaining, isUnlimitedDevices };
