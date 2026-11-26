// Blueberry Flow — tests/test-muse-tasks.mjs (server v1.5.0)
// Kiểm chứng qua HTTP thật: tạo muse task -> pending, poll GET :id,
// list ?status=pending (Muse phía chat poll), POST result -> done,
// idempotency (giao lại cùng taskId), lỗi 400/404/409.
// Dùng DATA_DIR tạm — không chạm DB thật, không deploy gì.
// Chạy: node tests/test-muse-tasks.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-test-'));
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
  const r = await fetch(base + p, { headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) }, ...opts });
  return { status: r.status, data: await r.json().catch(() => ({})) };
};
const health = await j('/');
check('health: version 1.5.0', health.status === 200 && health.data.version === '1.5.0', health.data);

// ---------- tạo task ----------
const bad1 = await j('/api/flow/muse-tasks', { method: 'POST', body: JSON.stringify({ taskId: 't1' }) });
check('POST thiếu prompt: 400 bad_task', bad1.status === 400 && bad1.data.error === 'bad_task', bad1.data);
const bad2 = await j('/api/flow/muse-tasks', { method: 'POST', body: JSON.stringify({ prompt: 'hello' }) });
check('POST thiếu taskId: 400 bad_task', bad2.status === 400 && bad2.data.error === 'bad_task');
const c1 = await j('/api/flow/muse-tasks', { method: 'POST', body: JSON.stringify({ workflowId: 'wf-1', taskId: 'ext-task-1', prompt: 'Rà soát caption này', upstreamText: 'Caption gốc: biển Đà Nẵng', email: 'vietdq.ncs@gmail.com', deviceId: 'dev-1' }) });
check('POST tạo: 200, status pending, giữ đúng prompt + upstream', c1.status === 200 && c1.data.ok && c1.data.status === 'pending' && c1.data.prompt === 'Rà soát caption này' && c1.data.upstreamText === 'Caption gốc: biển Đà Nẵng' && typeof c1.data.id === 'string' && c1.data.id.startsWith('mt_'), c1.data);
const id = c1.data.id;

// ---------- poll GET :id + list pending ----------
const g1 = await j('/api/flow/muse-tasks/' + id);
check('GET :id: pending, đúng taskId', g1.status === 200 && g1.data.status === 'pending' && g1.data.taskId === 'ext-task-1', g1.data);
const g404 = await j('/api/flow/muse-tasks/mt_khong-co');
check('GET id lạ: 404 not_found', g404.status === 404 && g404.data.error === 'not_found');
const list1 = await j('/api/flow/muse-tasks?status=pending');
check('GET ?status=pending: thấy task vừa tạo (Muse phía chat poll)', list1.status === 200 && Array.isArray(list1.data.tasks) && list1.data.tasks.some((t) => t.id === id) && list1.data.counts.pending === 1, list1.data);
const listBad = await j('/api/flow/muse-tasks?status=xxx');
check('GET ?status=xxx: 400 bad_status', listBad.status === 400 && listBad.data.error === 'bad_status');

// ---------- idempotency: giao lại cùng taskId ----------
const c2 = await j('/api/flow/muse-tasks', { method: 'POST', body: JSON.stringify({ taskId: 'ext-task-1', prompt: 'Rà soát caption này' }) });
check('POST lại cùng taskId khi pending: trả bản cũ, không tạo trùng', c2.status === 200 && c2.data.id === id && c2.data.deduped === true, c2.data);

// ---------- POST result ----------
const rBad = await j('/api/flow/muse-tasks/' + id + '/result', { method: 'POST', body: JSON.stringify({ resultText: '   ' }) });
check('POST result rỗng: 400 bad_result', rBad.status === 400 && rBad.data.error === 'bad_result');
const r404 = await j('/api/flow/muse-tasks/mt_khong-co/result', { method: 'POST', body: JSON.stringify({ resultText: 'x' }) });
check('POST result id lạ: 404 not_found', r404.status === 404 && r404.data.error === 'not_found');
const RESULT = 'Caption đã rà soát: Biển Đà Nẵng lúc hoàng hôn — đã sửa chính tả, giọng kể chuyện.';
const r1 = await j('/api/flow/muse-tasks/' + id + '/result', { method: 'POST', body: JSON.stringify({ result: RESULT }) });
check('POST result (field result): 200, status done, giữ đúng text', r1.status === 200 && r1.data.status === 'done' && r1.data.resultText === RESULT && r1.data.completedAt, r1.data);
const g2 = await j('/api/flow/muse-tasks/' + id);
check('GET :id sau result: done + đúng resultText (extension poll thấy)', g2.status === 200 && g2.data.status === 'done' && g2.data.resultText === RESULT, g2.data);
const r2 = await j('/api/flow/muse-tasks/' + id + '/result', { method: 'POST', body: JSON.stringify({ resultText: 'khác' }) });
check('POST result lần 2: 409 already_done, không ghi đè', r2.status === 409 && r2.data.error === 'already_done' && r2.data.task.resultText === RESULT, r2.data);
const list2 = await j('/api/flow/muse-tasks?status=pending');
check('GET ?status=pending sau done: hết pending', list2.status === 200 && list2.data.counts.pending === 0 && !list2.data.tasks.some((t) => t.id === id), list2.data);

// ---------- endpoint license cũ không đổi ----------
const v = await j('/api/flow/verify', { method: 'POST', body: JSON.stringify({ email: 'khong-co@example.com', deviceId: 'dev-1' }) });
check('endpoint cũ /api/flow/verify vẫn chạy (invalid)', v.status === 200 && v.data.valid === false && v.data.reason === 'invalid', v.data);

srv.close();
console.log(`\n${pass} PASS, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
