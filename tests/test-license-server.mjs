// License Server 1.0.0 — tests/test-license-server.mjs
// Kiểm chứng src/keys.js (sinh + chuẩn hoá key) và src/db.js (lưu key dạng
// hash, đếm thiết bị, khóa key). Dùng DATA_DIR tạm — không chạm DB thật.
// Chạy: DATA_DIR=/tmp/license-test-db node tests/test-license-server.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// DB test riêng trong thư mục tạm (ghi đè DATA_DIR trước khi nạp db.js).
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'license-test-'));
process.env.DATA_DIR = tmpDir;

const { generateKey, normalizeKey, isValidKeyFormat, hashKey, makeLicense } = (await import('../src/keys.js')).default;
const db = (await import('../src/db.js')).default;

let pass = 0, fail = 0;
function check(name, ok) {
  if (ok) { pass++; console.log('PASS', name); }
  else { fail++; console.log('FAIL', name); }
}

// ---------- keys.js ----------
const k1 = generateKey();
check('generateKey: đúng dạng TLV-XXXX-XXXX-XXXX-XXXX', /^TLV-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(k1));
check('generateKey: 2 key sinh ra khác nhau', generateKey() !== k1);
check('generateKey: không chứa I/L/O (tránh nhầm khi gõ)', !/[ILO]/.test(k1.replace('TLV-', '')));
check('normalizeKey: key sinh ra chuẩn hoá lại ra chính nó', normalizeKey(k1) === k1);
check('normalizeKey: chữ L trong TLV không đổi thành 1 (hồi quy)',
  normalizeKey('TLV-AAAA-AAAA-AAAA-AAAA') === 'TLV-AAAA-AAAA-AAAA-AAAA');
check('normalizeKey: O/I/L trong thân → 0/1/1', normalizeKey('TLV-2OAA-AAIA-AAAA-AAAA') === 'TLV-20AA-AA1A-AAAA-AAAA');
check('isValidKeyFormat', isValidKeyFormat(k1) && !isValidKeyFormat('hello'));
check('hashKey: cùng key → cùng hash, khác key → khác hash',
  hashKey(k1) === hashKey(k1) && hashKey(k1) !== hashKey(generateKey()));
check('hashKey: 64 ký tự hex', /^[0-9a-f]{64}$/.test(hashKey(k1)));
{
  const lic = makeLicense({ days: 30, note: 'test', maxDevices: 2 });
  check('makeLicense: key hợp lệ + hết hạn sau ~30 ngày',
    isValidKeyFormat(lic.key) && Math.abs(lic.expiresAt - (Date.now() + 30 * 24 * 60 * 60 * 1000)) < 60 * 1000);
  check('makeLicense: prefix là 8 ký tự đầu của key', lic.prefix === lic.key.slice(0, 8));
}

// ---------- db.js ----------
// Lưu key dạng hash — DB không chứa key gốc.
const lic = makeLicense({ days: 30, note: 'khách test', maxDevices: 2 });
const saved = db.createLicense({ keyHash: lic.keyHash, prefix: lic.prefix, note: lic.note, expiresAt: lic.expiresAt, maxDevices: lic.maxDevices });
check('db.createLicense: lưu được, trả về id', saved && saved.id > 0 && saved.prefix === lic.prefix);
{
  const raw = fs.readFileSync(path.join(tmpDir, 'licenses.db'));
  check('db: file DB không chứa key gốc (chỉ hash)', !raw.includes(Buffer.from(lic.key)));
}
check('db.findLicenseByHash: tìm được key vừa tạo', db.findLicenseByHash(lic.keyHash)?.prefix === lic.prefix);
check('db.findLicenseByHash: key lạ → null', db.findLicenseByHash(hashKey(generateKey())) === null);
{
  const t1 = db.touchDevice(lic.keyHash, 'device-A');
  check('db.touchDevice: thiết bị 1 OK, đếm 1', t1.ok && t1.deviceCount === 1);
  const t2 = db.touchDevice(lic.keyHash, 'device-B');
  check('db.touchDevice: thiết bị 2 OK, đếm 2', t2.ok && t2.deviceCount === 2);
  const t3 = db.touchDevice(lic.keyHash, 'device-C');
  check('db.touchDevice: thiết bị 3 vượt giới hạn (max 2) → chặn', !t3.ok && t3.reason === 'device_limit' && t3.deviceCount === 2);
  const t1b = db.touchDevice(lic.keyHash, 'device-A');
  check('db.touchDevice: thiết bị cũ dùng lại vẫn OK (không tính thêm)', t1b.ok && t1b.deviceCount === 2);
}
{
  const list = db.listLicenses();
  check('db.listLicenses: 1 key, đếm đúng 2 thiết bị', list.length === 1 && list[0].deviceCount === 2);
  const stats = db.stats();
  check('db.stats: total 1, active 1', stats.total === 1 && stats.active === 1);
}
check('db.revokeLicense: khóa key → tìm lại thấy revoked', db.revokeLicense(saved.id, true) && db.findLicenseByHash(lic.keyHash).revoked === true);
check('db.revokeLicense: mở lại key → hết revoked', db.revokeLicense(saved.id, false) && db.findLicenseByHash(lic.keyHash).revoked === false);
check('db.deleteLicense: xóa key → không tìm thấy nữa', db.deleteLicense(saved.id) && db.findLicenseByHash(lic.keyHash) === null);
check('db.stats sau xóa: total 0', db.stats().total === 0);

// Dọn thư mục tạm.
fs.rmSync(tmpDir, { recursive: true, force: true });

console.log(`\n${pass} PASS, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
