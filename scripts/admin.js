// Doc Helper License Server — scripts/admin.js
// Quản lý key từ dòng lệnh trên máy chủ (không cần đăng nhập web).
//   node scripts/admin.js create --days 30 --note "Khách A" --max-devices 2
//   node scripts/admin.js create --days 30 --email khach@gmail.com --note "Khách A"
//   node scripts/admin.js list
//   node scripts/admin.js stats
//   node scripts/admin.js revoke 3 | restore 3 | delete 3
'use strict';
const db = require('../src/db');
const { makeLicense, makeEmailLicense, isValidEmail } = require('../src/keys');

function arg(name, def) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
function fmtDate(ms) {
  return new Date(ms).toLocaleString('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}
const cmd = process.argv[2];

if (cmd === 'create') {
  const days = Number(arg('--days', '30'));
  const maxDevices = Number(arg('--max-devices', '2'));
  const note = arg('--note', '');
  const email = arg('--email', '');
  if (email) {
    if (!isValidEmail(email)) { console.error('Email không đúng định dạng.'); process.exit(1); }
    const existing = db.findLicenseByEmail(email.trim().toLowerCase());
    if (existing) { console.error(`Email này đã có license #${existing.id} rồi.`); process.exit(1); }
    const lic = makeEmailLicense({ days, maxDevices, note, email });
    const saved = db.createLicense({
      keyHash: lic.keyHash, prefix: lic.prefix, note: lic.note,
      expiresAt: lic.expiresAt, maxDevices: lic.maxDevices, email: lic.email
    });
    console.log('Đã kích hoạt email (khách nhập email này trong extension là tải được):');
    console.log(lic.email);
    console.log(`ID: ${saved.id} | Hết hạn: ${fmtDate(saved.expiresAt)} | Thiết bị tối đa: ${saved.maxDevices} | Ghi chú: ${saved.note || '(trống)'}`);
    process.exit(0);
  }
  const lic = makeLicense({ days, maxDevices, note });
  const saved = db.createLicense({
    keyHash: lic.keyHash, prefix: lic.prefix, note: lic.note,
    expiresAt: lic.expiresAt, maxDevices: lic.maxDevices
  });
  console.log('Key mới (chỉ hiện 1 lần — copy gửi khách ngay):');
  console.log(lic.key);
  console.log(`ID: ${saved.id} | Hết hạn: ${fmtDate(saved.expiresAt)} | Thiết bị tối đa: ${saved.maxDevices} | Ghi chú: ${saved.note || '(trống)'}`);
} else if (cmd === 'list') {
  const list = db.listLicenses();
  if (!list.length) { console.log('Chưa có key nào.'); process.exit(0); }
  for (const l of list) {
    const status = l.revoked ? 'BỊ KHÓA' : (l.expiresAt <= Date.now() ? 'HẾT HẠN' : 'CÒN HẠN');
    const ident = l.email ? l.email : `${l.prefix}…`;
    console.log(`#${l.id} ${ident} | ${status} | hết hạn ${fmtDate(l.expiresAt)} | thiết bị ${l.deviceCount}/${l.maxDevices} | ${l.note || '(không ghi chú)'}`);
  }
} else if (cmd === 'stats') {
  console.log(db.stats());
} else if (cmd === 'revoke' || cmd === 'restore' || cmd === 'delete') {
  const id = Number(process.argv[3]);
  if (!Number.isFinite(id)) { console.error('Thiếu ID. Ví dụ: node scripts/admin.js revoke 3'); process.exit(1); }
  const ok = cmd === 'delete' ? db.deleteLicense(id) : db.revokeLicense(id, cmd === 'revoke');
  console.log(ok ? 'Xong.' : `Không tìm thấy key #${id}.`);
} else {
  console.log('Dùng: node scripts/admin.js <create|list|stats|revoke|restore|delete> [tuỳ chọn]');
  console.log('  create --days 30 --note "Khách A" --max-devices 2');
  console.log('  create --days 30 --email khach@gmail.com --note "Khách A"');
  process.exit(1);
}
