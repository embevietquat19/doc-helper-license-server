# DEPLOY.md — đưa server v1.4.0 lên license.digimar.site

> **KHÔNG tự deploy trong lần này.** File này chỉ là hướng dẫn để anh (hoặc
> lần sau) deploy bằng tay. Server đang chạy (v1.3.3) không bị chạm tới.

## 1. File nào cần copy sang repo `doc-helper-license-server`

Thư mục nguồn: `~/workspace/flow-canvas-extension/server/` (trong workspace
này). Đích: repo `embevietquat19/doc-helper-license-server` (đang chạy
v1.3.3 tại Hostinger).

| Copy | Ghi chú |
|---|---|
| `server.js` | v1.4.0 (thay file cũ) |
| `src/db.js`, `src/keys.js` | thay file cũ (migrate DB tự động lúc khởi động) |
| `public/admin.html` | thay file cũ (thêm tab theo tool) |
| `package.json` | version 1.4.0 |
| `latest-flow.json` | **mới** — bản Flow mới nhất (v0.2.1) |
| `latest.json`, `latest-blueberry.json` | đã có trong repo, không cần copy lại (giữ nguyên) |
| `tests/test-flow-server.mjs` | **mới** — test Flow |
| `README_SERVER.md`, `DEPLOY.md` | **mới** — tài liệu |
| `scripts/admin.js` | giữ nguyên (không đổi) |

**KHÔNG copy:** `node_modules/` (symlink local chỉ để test — Hostinger chạy
`npm install`), `data/` (DB thật chỉ có trên máy chủ, đã gitignore),
file test tạm nào khác.

```bash
# Ví dụ copy bằng rsync (chạy trên máy có cả 2 repo):
rsync -av --exclude node_modules --exclude data --exclude '*.db' \
  ~/workspace/flow-canvas-extension/server/ \
  ~/path/to/doc-helper-license-server/
```

## 2. Kiểm tra trước khi deploy

```bash
cd doc-helper-license-server   # repo đích sau khi copy
node --check server.js && node --check src/db.js && node --check src/keys.js
node tests/test-flow-server.mjs
# kỳ vọng: 40 PASS, 0 FAIL (test dùng DATA_DIR tạm, không chạm DB thật)
```

## 3. Deploy lên Hostinger (Web App Node.js 24)

1. Commit + push repo lên GitHub (nhánh `main`).
2. hPanel → Web App `license.digimar.site` → Deploy lại (hoặc chờ auto-deploy
   theo GitHub nếu đã bật). Không đổi biến môi trường: `NODE_ENV=production`,
   `ADMIN_PASSWORD` (giữ nguyên), `DATA_DIR` (giữ nguyên đường dẫn ngoài repo).
3. Đợi app khởi động lại — log phải hiện `[license-server] listening on :3001`.
   Lúc khởi động, DB cũ tự thêm cột `product/plan/monthly_quota/
   used_this_month/month_key` (đã có thì bỏ qua) — **không cần migrate tay,
   không mất license cũ**.

## 4. Kiểm tra sau deploy (checklist)

```bash
# 1. Server sống, version mới
curl https://license.digimar.site/
# → {"ok":true,"service":"doc-helper-license","version":"1.4.0"}

# 2. Endpoint Flow mới
curl https://license.digimar.site/api/latest-flow
# → {"ok":true,"version":"0.2.1","url":"https://license.digimar.site/downloads/blueberry-flow-v0.2.1.zip",...}

# 3. Endpoint cũ vẫn sống (hồi quy)
curl https://license.digimar.site/api/latest-extension   # → 1.7.9
curl https://license.digimar.site/api/latest-blueberry  # → 2.4.0

# 4. Verify Flow với email chưa có license → invalid (không lỗi 500)
curl -X POST https://license.digimar.site/api/flow/verify \
  -H "Content-Type: application/json" \
  -d '{"email":"chua-co@example.com","deviceId":"test-1"}'
# → {"ok":true,"valid":false,"reason":"invalid"}

# 5. Mở https://license.digimar.site/admin → đăng nhập → thấy 3 tab
#    Doc Helper / Blueberry ADS Block / Blueberry Flow.
# 6. Tab Flow: tạo 1 license test (email của anh, Free, 30 ngày) →
#    verify lại bằng curl phải trả valid:true, remaining 30.
# 7. Xóa license test đó sau khi kiểm tra xong.
```

## 5. Sao lưu trước khi deploy (bắt buộc)

Tải file `licenses.db` trong `DATA_DIR` qua File Manager **trước** khi
deploy. Mất file này = mất toàn bộ license (Doc Helper + Flow). Nếu deploy
lỗi, khôi phục bằng cách trả lại file `licenses.db` cũ + redeploy code 1.3.3.

## 6. Rollback

Nếu v1.4.0 lỗi sau deploy: checkout lại tag/commit v1.3.3 trong repo,
redeploy. DB đã thêm cột mới vẫn tương thích ngược với code 1.3.3 (code cũ
không đọc các cột đó); license Flow tạo trong thời gian chạy 1.4.0 sẽ nằm
yên trong DB, không ảnh hưởng Doc Helper.
