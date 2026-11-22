// License Server 1.3.2 — tests/test-license-server.mjs
// Kiểm chứng src/keys.js (sinh + chuẩn hoá key, email, không giới hạn) và
// src/db.js (lưu key dạng hash, license theo email, license không giới hạn,
// đếm thiết bị, khóa key, sửa thông tin khách + số Zalo) và server.js qua
// HTTP thật (đăng nhập quản trị, tạo/sửa license qua API, rate-limit đăng
// nhập). Dùng DATA_DIR tạm — không chạm DB thật.
// Chạy: DATA_DIR=/tmp/license-test-db node tests/test-license-server.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// DB test riêng trong thư mục tạm (ghi đè DATA_DIR trước khi nạp db.js).
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'license-test-'));
process.env.DATA_DIR = tmpDir;

const { generateKey, normalizeKey, isValidKeyFormat, hashKey, makeLicense, normalizeEmail, isValidEmail, makeEmailLicense, UNLIMITED_EXPIRES_AT, isUnlimitedExpiry, daysRemaining, isUnlimitedDevices } = (await import('../src/keys.js')).default;
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

// ---------- keys.js — email ----------
check('normalizeEmail: cắt khoảng trắng + viết thường', normalizeEmail('  Khach@Gmail.COM ') === 'khach@gmail.com');
check('normalizeEmail: không phải chuỗi → rỗng', normalizeEmail(null) === '' && normalizeEmail(123) === '');
check('isValidEmail: đúng/sai', isValidEmail('khach@gmail.com') && isValidEmail('a.b+tag@sub.example.vn')
  && !isValidEmail('khong-phai-email') && !isValidEmail('thieu@domain') && !isValidEmail('') && !isValidEmail('a@b.c'));
{
  const lic = makeEmailLicense({ days: 90, note: 'khách email', maxDevices: 2, email: '  Khach@Gmail.COM ' });
  check('makeEmailLicense: email chuẩn hoá thường + prefix EMAIL + hết hạn ~90 ngày',
    lic.email === 'khach@gmail.com' && lic.prefix === 'EMAIL'
    && Math.abs(lic.expiresAt - (Date.now() + 90 * 24 * 60 * 60 * 1000)) < 60 * 1000);
  check('makeEmailLicense: key_hash là hash 64 hex (key gốc đã bỏ đi)',
    /^[0-9a-f]{64}$/.test(lic.keyHash));
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

// ---------- db.js — license theo email ----------
{
  const eLic = makeEmailLicense({ days: 30, note: 'khách email test', maxDevices: 2, email: 'Khach@Gmail.COM' });
  const eSaved = db.createLicense({
    keyHash: eLic.keyHash, prefix: eLic.prefix, note: eLic.note,
    expiresAt: eLic.expiresAt, maxDevices: eLic.maxDevices, email: eLic.email
  });
  check('db.createLicense (email): lưu được, email đã chuẩn hoá thường', eSaved && eSaved.id > 0 && eSaved.email === 'khach@gmail.com' && eSaved.prefix === 'EMAIL');
  check('db.findLicenseByEmail: tìm được email đã chuẩn hoá',
    db.findLicenseByEmail('khach@gmail.com')?.id === eSaved.id);
  check('db.findLicenseByEmail: email lạ → null', db.findLicenseByEmail('ai-do@khac.vn') === null);
  {
    const t1 = db.touchDeviceByLicenseId(eSaved.id, 'device-A');
    check('db.touchDeviceByLicenseId: thiết bị 1 OK, đếm 1', t1.ok && t1.deviceCount === 1);
    const t2 = db.touchDeviceByLicenseId(eSaved.id, 'device-B');
    check('db.touchDeviceByLicenseId: thiết bị 2 OK, đếm 2', t2.ok && t2.deviceCount === 2);
    const t3 = db.touchDeviceByLicenseId(eSaved.id, 'device-C');
    check('db.touchDeviceByLicenseId: thiết bị 3 vượt giới hạn → chặn', !t3.ok && t3.reason === 'device_limit');
    const tBad = db.touchDeviceByLicenseId(99999, 'device-A');
    check('db.touchDeviceByLicenseId: id lạ → not_found', !tBad.ok && tBad.reason === 'not_found');
  }
  {
    const list = db.listLicenses();
    check('db.listLicenses: license email có email trong danh sách', list.length === 1 && list[0].email === 'khach@gmail.com' && list[0].deviceCount === 2);
  }
  check('db.revokeLicense (email): khóa → tìm lại thấy revoked', db.revokeLicense(eSaved.id, true) && db.findLicenseByEmail('khach@gmail.com').revoked === true);
  check('db.deleteLicense (email): xóa → không tìm thấy nữa', db.deleteLicense(eSaved.id) && db.findLicenseByEmail('khach@gmail.com') === null);
}
check('db.stats sau xóa email: total 0', db.stats().total === 0);

// ---------- keys.js + db.js — license không giới hạn ----------
check('UNLIMITED_EXPIRES_AT là 31/12/9999', UNLIMITED_EXPIRES_AT === 253402300799999
  && new Date(UNLIMITED_EXPIRES_AT).toISOString().startsWith('9999-12-31'));
check('isUnlimitedExpiry: mốc 9999 → true, ngày thường → false',
  isUnlimitedExpiry(UNLIMITED_EXPIRES_AT) && !isUnlimitedExpiry(Date.now() + 30 * 24 * 60 * 60 * 1000));
check('isUnlimitedDevices: 0 → true, 2 → false', isUnlimitedDevices(0) && !isUnlimitedDevices(2));
check('daysRemaining: không giới hạn → null; 30 ngày → ~30',
  daysRemaining(UNLIMITED_EXPIRES_AT) === null
  && daysRemaining(Date.now() + 30 * 24 * 60 * 60 * 1000) >= 29
  && daysRemaining(Date.now() + 30 * 24 * 60 * 60 * 1000) <= 30);
{
  const lic = makeLicense({ days: 0, maxDevices: 0, note: 'không giới hạn' });
  check('makeLicense days=0: hết hạn = mốc 9999', lic.expiresAt === UNLIMITED_EXPIRES_AT && isUnlimitedExpiry(lic.expiresAt));
  check('makeLicense maxDevices=0: không giới hạn thiết bị', lic.maxDevices === 0 && isUnlimitedDevices(lic.maxDevices));
  const lic30 = makeLicense({ days: 30, maxDevices: 2 });
  check('makeLicense days=30 vẫn có hạn như cũ', !isUnlimitedExpiry(lic30.expiresAt) && lic30.maxDevices === 2);
}
{
  const eLic = makeEmailLicense({ days: 0, maxDevices: 0, email: 'vietquat19@gmail.com', note: 'test không giới hạn' });
  const eSaved = db.createLicense({
    keyHash: eLic.keyHash, prefix: eLic.prefix, note: eLic.note,
    expiresAt: eLic.expiresAt, maxDevices: eLic.maxDevices, email: eLic.email
  });
  check('db.createLicense (email không giới hạn): lưu được, hết hạn mốc 9999',
    eSaved && eSaved.email === 'vietquat19@gmail.com' && eSaved.expiresAt === UNLIMITED_EXPIRES_AT && eSaved.maxDevices === 0);
  const found = db.findLicenseByEmail('vietquat19@gmail.com');
  check('db.findLicenseByEmail: tìm được license không giới hạn', found?.id === eSaved.id && found.expiresAt === UNLIMITED_EXPIRES_AT);
  {
    // Không giới hạn thiết bị: máy 1, 2, 3, 4, 5 đều OK.
    let allOk = true;
    for (let i = 1; i <= 5; i++) {
      const t = db.touchDeviceByLicenseId(eSaved.id, 'device-' + i);
      if (!t.ok || t.deviceCount !== i) allOk = false;
    }
    check('db.touchDevice (không giới hạn): 5 thiết bị đều OK, đếm đủ 5', allOk);
    const again = db.touchDeviceByLicenseId(eSaved.id, 'device-2');
    check('db.touchDevice (không giới hạn): thiết bị cũ dùng lại vẫn OK, không tính thêm', again.ok && again.deviceCount === 5);
  }
  {
    const list = db.listLicenses();
    check('db.listLicenses: license không giới hạn đếm 5 thiết bị', list.length === 1 && list[0].deviceCount === 5 && list[0].maxDevices === 0);
    const stats = db.stats();
    check('db.stats: license không giới hạn vẫn tính active', stats.total === 1 && stats.active === 1);
  }
  check('db.deleteLicense (email không giới hạn): xóa → không tìm thấy nữa', db.deleteLicense(eSaved.id) && db.findLicenseByEmail('vietquat19@gmail.com') === null);
}
check('db.stats cuối: total 0', db.stats().total === 0);

// ---------- db.js — sửa thông tin khách + số Zalo ----------
{
  const eLic = makeEmailLicense({ days: 30, note: 'khách zalo', maxDevices: 2, email: 'zalo-khach@gmail.com' });
  const eSaved = db.createLicense({
    keyHash: eLic.keyHash, prefix: eLic.prefix, note: eLic.note,
    expiresAt: eLic.expiresAt, maxDevices: eLic.maxDevices, email: eLic.email, zalo: '0901234567'
  });
  check('db.createLicense (zalo): lưu được số Zalo khách', eSaved && eSaved.zalo === '0901234567');
  const u1 = db.updateLicense(eSaved.id, { zalo: '0912345678', note: 'đổi tên khách', maxDevices: 5 });
  check('db.updateLicense: đổi được zalo + ghi chú + số thiết bị',
    u1 && u1.zalo === '0912345678' && u1.note === 'đổi tên khách' && u1.maxDevices === 5 && u1.email === 'zalo-khach@gmail.com');
  const u2 = db.updateLicense(eSaved.id, { expiresAt: UNLIMITED_EXPIRES_AT });
  check('db.updateLicense: đổi hạn dùng sang không giới hạn', u2 && u2.expiresAt === UNLIMITED_EXPIRES_AT);
  const u3 = db.updateLicense(eSaved.id, {});
  check('db.updateLicense: patch rỗng → trả nguyên bản, không đổi gì',
    u3 && u3.zalo === '0912345678' && u3.expiresAt === UNLIMITED_EXPIRES_AT);
  check('db.updateLicense: id lạ → null', db.updateLicense(99999, { note: 'x' }) === null);
  check('db.deleteLicense (zalo): xóa → không tìm thấy nữa', db.deleteLicense(eSaved.id) && db.findLicenseByEmail('zalo-khach@gmail.com') === null);
}
check('db.stats sau xóa zalo: total 0', db.stats().total === 0);

// ---------- server.js qua HTTP thật ----------
{
  // Rate-limit đăng nhập đặt nhỏ (3 lần) để test được 429 mà không chờ.
  // Rate-limit kiểm tra license theo email/key cũng đặt nhỏ (3 lần).
  process.env.ADMIN_PASSWORD = 'Test-Admin-123';
  process.env.LOGIN_RATE_LIMIT_MAX = '3';
  process.env.LOGIN_RATE_LIMIT_WINDOW_MS = '60000';
  process.env.VERIFY_RATE_LIMIT_MAX = '3';
  process.env.VERIFY_RATE_LIMIT_WINDOW_MS = '60000';
  const app = (await import('../server.js')).default;
  const srv = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const port = srv.address().port;
  const base = `http://127.0.0.1:${port}`;
  const j = async (path, opts = {}) => {
    const { headers: extraHeaders = {}, ...rest } = opts;
    const r = await fetch(base + path, { headers: { 'Content-Type': 'application/json', ...extraHeaders }, ...rest });
    return { status: r.status, data: await r.json().catch(() => ({})), setCookie: r.headers.get('set-cookie') || '' };
  };
  const login = (pw) => j('/api/admin/login', { method: 'POST', body: JSON.stringify({ password: pw }) });

  const bad = await login('sai-mat-khau');
  check('HTTP login: sai mật khẩu → 401', bad.status === 401);
  const good = await login('Test-Admin-123');
  check('HTTP login: đúng mật khẩu → 200 + cookie admin', good.status === 200 && /admin_token=/.test(good.setCookie));
  const cookie = good.setCookie.split(';')[0];
  const auth = { headers: { Cookie: cookie } };
  const noAuth = await j('/api/admin/stats');
  check('HTTP stats: chưa đăng nhập → 401', noAuth.status === 401);
  const stats = await j('/api/admin/stats', auth);
  check('HTTP stats: đã đăng nhập → 200', stats.status === 200 && stats.data.ok);

  const created = await j('/api/admin/licenses', {
    ...auth, method: 'POST',
    body: JSON.stringify({ email: 'http-khach@gmail.com', days: 30, maxDevices: 2, note: 'khách HTTP', zalo: '0901234567' })
  });
  check('HTTP tạo license: email + zalo lưu được',
    created.status === 200 && created.data.ok && created.data.license?.email === 'http-khach@gmail.com' && created.data.license?.zalo === '0901234567');
  const id = created.data.license.id;
  const badZalo = await j('/api/admin/licenses', {
    ...auth, method: 'POST',
    body: JSON.stringify({ email: 'http-khach@gmail.com', days: 30, maxDevices: 2, note: 'x', zalo: 'abc' })
  });
  check('HTTP tạo license: zalo sai định dạng → 400', badZalo.status === 400 && badZalo.data.error === 'bad_zalo');

  const patched = await j(`/api/admin/licenses/${id}`, {
    ...auth, method: 'PATCH',
    body: JSON.stringify({ zalo: '0911111111', note: 'khách VIP', maxDevices: 5, expiresAtISO: '2027-06-30' })
  });
  check('HTTP PATCH: đổi được zalo + ghi chú + thiết bị + hạn dùng',
    patched.status === 200 && patched.data.ok && patched.data.license?.zalo === '0911111111'
    && patched.data.license?.note === 'khách VIP' && patched.data.license?.maxDevices === 5
    && new Date(patched.data.license.expiresAt).toISOString().startsWith('2027-06-30'));
  const patched2 = await j(`/api/admin/licenses/${id}`, {
    ...auth, method: 'PATCH',
    body: JSON.stringify({ unlimitedTime: true })
  });
  check('HTTP PATCH: unlimitedTime → hết hạn mốc 9999',
    patched2.status === 200 && patched2.data.license?.expiresAt === 253402300799999);
  const badPatch = await j(`/api/admin/licenses/${id}`, {
    ...auth, method: 'PATCH',
    body: JSON.stringify({ maxDevices: 99 })
  });
  check('HTTP PATCH: maxDevices 99 → 400', badPatch.status === 400 && badPatch.data.error === 'bad_max_devices');
  const notFound = await j('/api/admin/licenses/99999', {
    ...auth, method: 'PATCH',
    body: JSON.stringify({ note: 'x' })
  });
  check('HTTP PATCH: id lạ → 404', notFound.status === 404);
  const patchNoAuth = await j(`/api/admin/licenses/${id}`, {
    method: 'PATCH',
    body: JSON.stringify({ note: 'x' })
  });
  check('HTTP PATCH: chưa đăng nhập → 401', patchNoAuth.status === 401);

  // Rate-limit đăng nhập (giới hạn test = 3): đã dùng 2 lần (1 sai + 1
  // đúng) → 1 lần sai nữa là đủ 3, lần tiếp theo bị 429.
  const third = await login('sai-nua');
  check('HTTP login rate-limit: lần thứ 3 → 401 (chưa vượt)', third.status === 401);
  const fourth = await login('sai-nua');
  check('HTTP login rate-limit: lần thứ 4 → 429', fourth.status === 429 && fourth.data.error === 'rate_limited');
  const blocked = await login('Test-Admin-123');
  check('HTTP login rate-limit: mật khẩu đúng cũng bị chặn khi đã vượt', blocked.status === 429);

  // Rate-limit kiểm tra license theo email (giới hạn test = 3): 3 lần đầu
  // vẫn qua (200, license chưa có nên valid:false), lần thứ 4 bị 429; email
  // khác thì không bị ảnh hưởng (giới hạn tính theo từng email, không phải
  // toàn cục hay theo IP).
  const verify = (email) => j('/api/verify', {
    method: 'POST',
    body: JSON.stringify({ email, deviceId: 'rl-device-1' }),
  });
  const v1 = await verify('rl-test@example.com');
  const v2 = await verify('rl-test@example.com');
  const v3 = await verify('rl-test@example.com');
  check('HTTP verify rate-limit: 3 lần cùng email → 200', v1.status === 200 && v2.status === 200 && v3.status === 200);
  const v4 = await verify('rl-test@example.com');
  check('HTTP verify rate-limit: lần thứ 4 cùng email → 429', v4.status === 429 && v4.data.error === 'rate_limited');
  const vOther = await verify('rl-khac@example.com');
  check('HTTP verify rate-limit: email khác không bị chặn', vOther.status === 200);

  const health = await j('/');
  check('HTTP health: version 1.3.3', health.status === 200 && health.data.version === '1.3.3');
  const latest = await j('/api/latest-extension');
  check('HTTP latest-extension: trả bản mới nhất 1.7.9 + link GitHub Releases',
    latest.status === 200 && latest.data.ok && latest.data.version === '1.7.9'
    && latest.data.url === 'https://github.com/embevietquat19/doc-helper/releases/download/v1.7.9/doc-helper-v1.7.9.zip'
    && typeof latest.data.notes === 'string' && latest.data.notes.length > 0);
  const latestBb = await j('/api/latest-blueberry');
  check('HTTP latest-blueberry: trả bản mới nhất 2.4.0 + link ZIP trên server',
    latestBb.status === 200 && latestBb.data.ok && latestBb.data.version === '2.4.0'
    && latestBb.data.url === 'https://license.digimar.site/downloads/blueberry-ads-block-v2.4.0.zip'
    && typeof latestBb.data.notes === 'string' && latestBb.data.notes.length > 0);

  await new Promise((resolve) => srv.close(resolve));
}

// Dọn thư mục tạm.
fs.rmSync(tmpDir, { recursive: true, force: true });

console.log(`\n${pass} PASS, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
