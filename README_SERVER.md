# License server v1.4.0 — 3 tool, tách theo product

Server Express + SQLite duy nhất chạy tại `license.digimar.site`, phục vụ
cả 3 tool của anh. **v1.4.0 = v1.3.3 + Blueberry Flow.** Endpoint cũ của
Doc Helper và Blueberry giữ nguyên hành vi (test hồi quy 83/83).

## Tool nào dùng endpoint nào

| Tool | License? | Endpoint kiểm tra | Endpoint báo bản mới | Quản trị |
|---|---|---|---|---|
| **Doc Helper** (Tailieu.vn) | Có — key `TLV-…` hoặc email | `POST /api/verify` `{key\|email, deviceId}` | `GET /api/latest-extension` (file `latest.json`, v1.7.9) | Tab **Doc Helper** trên `/admin`: tạo key / kích hoạt email, sửa Zalo/ghi chú/hạn/thiết bị, khóa/mở/xóa |
| **Blueberry ADS Block** | Không | — (không có) | `GET /api/latest-blueberry` (file `latest-blueberry.json`, v2.4.0) + ZIP tại `/downloads/` | Tab **Blueberry ADS Block**: chỉ xem bản mới nhất + hướng dẫn phát hành bản mới |
| **Blueberry Flow** | Có — email + gói Free/Pro/VIP | `POST /api/flow/verify` `{key\|email, deviceId}` | `GET /api/latest-flow` (file `latest-flow.json`, v0.2.1) + ZIP tại `/downloads/` | Tab **Blueberry Flow** trên `/admin`: tạo/sửa/khóa/mở/xóa license Flow, xem quota tháng |

## Blueberry Flow — API chi tiết

### Gói (đã chốt)
- **Free:** 30 lượt/tháng · **Pro:** 300 lượt/tháng · **VIP:** không giới hạn (`monthlyQuota: null`).
- 1 lượt = 1 đơn vị quota. **Video = 5 đơn vị.** Quota reset vào đầu tháng
  (theo `monthKey` YYYY-MM, giờ UTC); sang tháng mới `usedThisMonth` về 0.

### `POST /api/flow/verify` — extension gọi trước khi chạy
Body: `{ "email": "khach@gmail.com", "deviceId": "bf-..." }` (hoặc `key`
thay email). Trả về:
```json
{ "ok": true, "valid": true, "plan": "pro", "expiresAt": 1780000000000,
  "daysRemaining": 29, "monthlyQuota": 300, "usedThisMonth": 12,
  "remaining": 288, "monthKey": "2026-11" }
```
`valid:false` với `reason`: `invalid` | `revoked` | `expired` |
`quota_exceeded`. VIP trả `monthlyQuota: null, remaining: null`.

### `POST /api/flow/consume` — extension gọi SAU MỖI TASK HOÀN THÀNH
Body: `{ "email": "...", "deviceId": "...", "units": 1, "kind": "text" }`
(`units` 1–5; video gửi `units: 5, kind: "video"`). Trả về số lượt còn
lại sau khi trừ + ghi 1 dòng vào bảng `flow_usage`. Hết quota / hết hạn /
bị khóa → `{ valid:false, reason }`, không trừ.
Rate-limit riêng: 300 lần / 10 phút / chứng chỉ (đủ cho 1 batch Pro chạy
dồn), 600 / 10 phút / IP. Verify dùng chung giới hạn cũ (30 / 10 phút).

### Admin Flow (cần đăng nhập, cookie `admin_token`)
- `GET /api/flow/stats` — tổng quan: số license theo gói, lượt đã dùng 30 ngày qua.
- `GET /api/admin/flow/licenses` (+ `?plan=free|pro|vip`) — chỉ license Flow.
- `POST /api/admin/flow/licenses` `{ email*, plan, days, monthlyQuota?, note, zalo }`
  — email đã có license Flow thì `409 email_exists` (cùng email vẫn có thể
  có license Doc Helper riêng — 409 chỉ tính trong cùng product).
- `PATCH /api/admin/flow/licenses/:id` `{ plan, monthlyQuota, usedThisMonth,
  note, zalo, expiresAtISO, days, unlimitedTime }` — đổi gói/quota, hoàn
  lượt cho khách bằng cách đặt lại `usedThisMonth`.
- `POST /api/admin/flow/licenses/:id/revoke|restore`, `DELETE ...`
- `GET /api/admin/flow/usage?licenseId=&limit=` — log trừ quota.

### Tách product — nguyên tắc
- Mọi license có cột `product`: `doc-helper` | `blueberry` | `blueberry-flow`.
  License cũ (trước 1.4.0) mặc định `doc-helper`.
- `/api/verify` chỉ tìm `product='doc-helper'`; `/api/flow/*` chỉ tìm
  `product='blueberry-flow'`. Cùng 1 email có thể có license ở cả 2 tool —
  đó là 2 bản riêng, không lẫn nhau (đã có test).
- `GET /api/admin/licenses?product=...` và `GET /api/admin/stats?product=...`
  lọc theo tool; không truyền thì trả tất cả (trang admin cũ vẫn thấy đủ).

## DB (SQLite, `licenses.db` — migrate tự động, không mất dữ liệu cũ)

Cột mới trên bảng `licenses`: `product`, `plan`, `monthly_quota` (NULL =
không giới hạn), `used_this_month`, `month_key`. Bảng mới `flow_usage`
(`license_id, device_id, units, kind, created_at`) — log từng lần trừ.
DB cũ tự thêm cột khi server khởi động (`ALTER TABLE ... ADD COLUMN`,
đã có thì bỏ qua) nên deploy 1.4.0 lên DB đang chạy không cần migrate tay.

## Test

```bash
cd server
node tests/test-flow-server.mjs   # 40 test Flow (verify/consume/quota/hết hạn/revoke/tách product/admin)
node tests/test-license-server.mjs # bộ test gốc Doc Helper — cần sửa version 1.3.3 → 1.4.0 trong file test trước khi chạy (xem DEPLOY.md)
```

## Deploy

Xem `DEPLOY.md` trong thư mục này. Tóm tắt: copy các file trong `server/`
(trừ `node_modules/` và `data/`) sang repo `doc-helper-license-server`,
commit, Hostinger tự deploy lại (Web App Node.js 24). **Không tự deploy
trong lần này.**
