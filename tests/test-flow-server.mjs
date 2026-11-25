// Blueberry Flow — tests/test-flow-server.mjs (server v1.4.0)
// Kiểm chứng qua HTTP thật: verify / consume / quota / hết hạn / revoke /
// tách product (Doc Helper <> Flow) / latest-flow / admin Flow CRUD / log.
// Dùng DATA_DIR tạm — không chạm DB thật, không deploy gì.
// Chạy: node tests/test-flow-server.mjs   (cần express trong node_modules)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-test-'));
process.env.DATA_DIR = tmpDir;
process.env.ADMIN_PASSWORD = 'Test-Admin-123';

let pass = 0, fail = 0;
function check(name, ok, extra) {
  if (ok) { pass++; console.log('PASS', name); }
  else { fail++; console.log('FAIL', name, extra ? JSON.stringify(extra) : ''); }
}

const app = (await import('../server.js')).default;
const srv = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
const port = srv.address().port;
const base = `http://127.0.0.1:${port}`;
const j = async (p, opts = {}) => {
  const { headers: h = {}, ...rest } = opts;
  const r = await fetch(base + p, { headers: { 'Content-Type': 'application/json', ...h }, ...rest });
  return { status: r.status, data: await r.json().catch(() => ({})), setCookie: r.headers.get('set-cookie') || '' };
};
const login = await j('/api/admin/login', { method: 'POST', body: JSON.stringify({ password: 'Test-Admin-123' }) });
check('admin login 200 + cookie', login.status === 200 && /admin_token=/.test(login.setCookie));
const cookie = login.setCookie.split(';')[0];
const auth = { headers: { Cookie: cookie } };
const flowVerify = (email, deviceId) => j('/api/flow/verify', { method: 'POST', body: JSON.stringify({ email, deviceId: deviceId || 'dev-1' }) });
const flowConsume = (email, units, kind) => j('/api/flow/consume', { method: 'POST', body: JSON.stringify({ email, deviceId: 'dev-1', units, kind: kind || 'text' }) });
const createFlow = (body) => j('/api/admin/flow/licenses', { ...auth, method: 'POST', body: JSON.stringify(body) });

// ---------- health + latest-flow ----------
const health = await j('/');
check('health: version 1.4.0', health.status === 200 && health.data.version === '1.4.0', health.data);
const latest = await j('/api/latest-flow');
check('latest-flow: version 0.2.1 + url', latest.status === 200 && latest.data.ok && latest.data.version === '0.2.1' && latest.data.url.includes('blueberry-flow'), latest.data);

// ---------- tạo + verify Free 30 ----------
const c1 = await createFlow({ email: 'flow-free@example.com', plan: 'free', days: 30, note: 'test free' });
check('tạo Flow Free: 200, plan free, quota 30', c1.status === 200 && c1.data.ok && c1.data.license?.plan === 'free' && c1.data.license?.monthlyQuota === 30 && c1.data.license?.product === 'blueberry-flow', c1.data);
const flowFreeId = c1.data.license?.id;
const v1 = await flowVerify('flow-free@example.com');
check('flow verify Free: valid, remaining 30, monthKey YYYY-MM', v1.status === 200 && v1.data.valid && v1.data.plan === 'free' && v1.data.monthlyQuota === 30 && v1.data.usedThisMonth === 0 && v1.data.remaining === 30 && /^\d{4}-\d{2}$/.test(v1.data.monthKey || ''), v1.data);
const vBad = await flowVerify('khong-co@example.com');
check('flow verify email lạ: valid:false invalid', vBad.data.valid === false && vBad.data.reason === 'invalid');

// ---------- consume 1 + 5 (video) ----------
const con1 = await flowConsume('flow-free@example.com', 1, 'text');
check('flow consume 1 (text): remaining 29', con1.status === 200 && con1.data.valid && con1.data.usedThisMonth === 1 && con1.data.remaining === 29, con1.data);
const con5 = await flowConsume('flow-free@example.com', 5, 'video');
check('flow consume 5 (video): remaining 24', con5.status === 200 && con5.data.valid && con5.data.usedThisMonth === 6 && con5.data.remaining === 24, con5.data);
const conBad = await flowConsume('flow-free@example.com', 6, 'text');
check('flow consume units=6: 400 bad_units', conBad.status === 400 && conBad.data.error === 'bad_units');
const conBad2 = await flowConsume('flow-free@example.com', 0, 'text');
check('flow consume units=0: 400 bad_units', conBad2.status === 400);

// ---------- hết quota (quota override 3) ----------
const c2 = await createFlow({ email: 'flow-het@example.com', plan: 'free', days: 30, monthlyQuota: 3 });
check('tạo Flow quota override 3', c2.status === 200 && c2.data.license?.monthlyQuota === 3, c2.data);
await flowConsume('flow-het@example.com', 1, 'text');
await flowConsume('flow-het@example.com', 1, 'text');
const c3 = await flowConsume('flow-het@example.com', 1, 'text');
check('consume tới quota 3: remaining 0', c3.data.valid && c3.data.remaining === 0, c3.data);
const c4 = await flowConsume('flow-het@example.com', 1, 'text');
check('consume quá quota: valid:false quota_exceeded', c4.data.valid === false && c4.data.reason === 'quota_exceeded', c4.data);
const vHet = await flowVerify('flow-het@example.com');
check('verify khi hết quota: valid:false quota_exceeded', vHet.data.valid === false && vHet.data.reason === 'quota_exceeded', vHet.data);

// ---------- VIP không giới hạn ----------
const cVip = await createFlow({ email: 'flow-vip@example.com', plan: 'vip', days: 0 });
check('tạo Flow VIP: quota null (không giới hạn)', cVip.status === 200 && cVip.data.license?.monthlyQuota === null, cVip.data);
const vVip = await flowVerify('flow-vip@example.com');
check('verify VIP: remaining null, unlimitedTime', vVip.data.valid && vVip.data.remaining === null && vVip.data.unlimitedTime === true, vVip.data);
const conVip = await flowConsume('flow-vip@example.com', 5, 'video');
check('consume VIP 5: vẫn valid, remaining null', conVip.data.valid && conVip.data.remaining === null, conVip.data);

// ---------- hết hạn ----------
const cExp = await createFlow({ email: 'flow-exp@example.com', plan: 'pro', days: 30 });
const idExp = cExp.data.license?.id;
const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
const ymd = yesterday.getFullYear() + '-' + String(yesterday.getMonth() + 1).padStart(2, '0') + '-' + String(yesterday.getDate()).padStart(2, '0');
const patched = await j(`/api/admin/flow/licenses/${idExp}`, { ...auth, method: 'PATCH', body: JSON.stringify({ expiresAtISO: ymd }) });
check('PATCH Flow: đổi hạn về hôm qua', patched.status === 200 && patched.data.ok, patched.data);
const vExp = await flowVerify('flow-exp@example.com');
check('verify hết hạn: valid:false expired', vExp.data.valid === false && vExp.data.reason === 'expired', vExp.data);
const conExp = await flowConsume('flow-exp@example.com', 1, 'text');
check('consume hết hạn: valid:false expired', conExp.data.valid === false && conExp.data.reason === 'expired', conExp.data);

// ---------- revoke / restore ----------
const rev = await j(`/api/admin/flow/licenses/${flowFreeId}/revoke`, { ...auth, method: 'POST' });
check('revoke Flow: ok', rev.status === 200 && rev.data.ok);
const vRev = await flowVerify('flow-free@example.com');
check('verify sau revoke: valid:false revoked', vRev.data.valid === false && vRev.data.reason === 'revoked', vRev.data);
const res2 = await j(`/api/admin/flow/licenses/${flowFreeId}/restore`, { ...auth, method: 'POST' });
check('restore Flow: ok', res2.status === 200 && res2.data.ok);
const vRes = await flowVerify('flow-free@example.com');
check('verify sau restore: valid trở lại, used giữ 6', vRes.data.valid && vRes.data.usedThisMonth === 6, vRes.data);

// ---------- tách product ----------
// Cùng 1 email có cả Doc Helper và Flow: tạo cả 2 đều phải được (409 chỉ
// tính trong cùng product), và mỗi endpoint chỉ thấy license của mình.
const docOnly = await j('/api/admin/licenses', { ...auth, method: 'POST', body: JSON.stringify({ email: 'doc-only@example.com', days: 30, maxDevices: 2, note: 'doc helper' }) });
check('tạo Doc Helper doc-only@example.com', docOnly.status === 200 && docOnly.data.ok, docOnly.data);
const vDocAtFlow = await flowVerify('doc-only@example.com');
check('TÁCH: license Doc Helper KHÔNG verify được ở /api/flow/verify', vDocAtFlow.data.valid === false && vDocAtFlow.data.reason === 'invalid', vDocAtFlow.data);
const vDocAtDoc = await j('/api/verify', { method: 'POST', body: JSON.stringify({ email: 'doc-only@example.com', deviceId: 'dev-1' }) });
check('HỒI QUY: license Doc Helper vẫn verify được ở /api/verify', vDocAtDoc.data.valid === true, vDocAtDoc.data);
const vFlowAtDoc = await j('/api/verify', { method: 'POST', body: JSON.stringify({ email: 'flow-free@example.com', deviceId: 'dev-1' }) });
check('TÁCH: license Flow KHÔNG verify được ở /api/verify', vFlowAtDoc.data.valid === false && vFlowAtDoc.data.reason === 'invalid', vFlowAtDoc.data);
const both = await createFlow({ email: 'doc-only@example.com', plan: 'pro', days: 30 });
check('cùng email tạo thêm Flow: không 409 (409 chỉ trong cùng product)', both.status === 200 && both.data.ok, both.data);
const dup = await createFlow({ email: 'flow-free@example.com', plan: 'pro', days: 30 });
check('tạo trùng email Flow: 409 email_exists', dup.status === 409 && dup.data.error === 'email_exists');

// ---------- admin Flow: list / stats / usage / patch plan+quota ----------
const listFlow = await j('/api/admin/flow/licenses', auth);
check('admin flow list: chỉ license Flow, không lẫn Doc Helper', listFlow.status === 200 && listFlow.data.ok && listFlow.data.licenses.length >= 5 && listFlow.data.licenses.every((l) => l.product === 'blueberry-flow'), { n: listFlow.data.licenses?.length });
const listAll = await j('/api/admin/licenses', auth);
check('admin list tất cả: có cả Doc Helper và Flow', listAll.data.licenses.some((l) => l.product === 'doc-helper') && listAll.data.licenses.some((l) => l.product === 'blueberry-flow'));
const listDoc = await j('/api/admin/licenses?product=doc-helper', auth);
check('admin list ?product=doc-helper: chỉ Doc Helper', listDoc.data.licenses.every((l) => l.product === 'doc-helper'));
const fstats = await j('/api/flow/stats', auth);
check('flow stats: có byPlan + monthUsage', fstats.status === 200 && fstats.data.ok && Array.isArray(fstats.data.stats.byPlan) && fstats.data.stats.monthUsage, fstats.data);
const usage = await j(`/api/admin/flow/usage?licenseId=${flowFreeId}`, auth);
check('flow usage log: ghi đủ lần consume (2 lần: 1+5)', usage.status === 200 && usage.data.usage.length === 2 && usage.data.usage.reduce((s, u) => s + u.units, 0) === 6, usage.data);
const patchPlan = await j(`/api/admin/flow/licenses/${flowFreeId}`, { ...auth, method: 'PATCH', body: JSON.stringify({ plan: 'pro', monthlyQuota: 500 }) });
check('PATCH Flow: đổi plan pro + quota 500', patchPlan.status === 200 && patchPlan.data.license?.plan === 'pro' && patchPlan.data.license?.monthlyQuota === 500, patchPlan.data);
const patchBadPlan = await j(`/api/admin/flow/licenses/${flowFreeId}`, { ...auth, method: 'PATCH', body: JSON.stringify({ plan: 'sieucap' }) });
check('PATCH Flow plan sai: 400 bad_plan', patchBadPlan.status === 400 && patchBadPlan.data.error === 'bad_plan');
const patch404 = await j('/api/admin/flow/licenses/99999', { ...auth, method: 'PATCH', body: JSON.stringify({ note: 'x' }) });
check('PATCH Flow id lạ: 404', patch404.status === 404);
const noAuthFlow = await j('/api/admin/flow/licenses');
check('admin Flow chưa đăng nhập: 401', noAuthFlow.status === 401);
const del = await j(`/api/admin/flow/licenses/${idExp}`, { ...auth, method: 'DELETE' });
check('DELETE Flow: ok, verify sau đó invalid', del.status === 200 && del.data.ok && (await flowVerify('flow-exp@example.com')).data.reason === 'invalid');

await new Promise((resolve) => srv.close(resolve));
fs.rmSync(tmpDir, { recursive: true, force: true });
console.log(`\n${pass} PASS, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
