# README_DEPLOY — License server cho Doc Helper (key Tailieu.vn)

Server nhỏ kiểm tra key online cho extension Doc Helper: user tạo key trên
trang quản trị, khách nhập key vào extension, server trả về còn hạn hay hết
hạn / bị khóa / quá số thiết bị. Hết hạn hoặc bị khóa thì extension tự dừng
tải Tailieu.vn. Chỉ Tailieu.vn cần key — 4 site còn lại vẫn miễn phí.

## 1. Công nghệ

| Hạng mục | Lựa chọn | Lý do |
|---|---|---|
| Hosting | Hostinger **Business** (Web App Node.js) | Cùng gói đang chạy fbads.digimar.site; mỗi gói tối đa 5 website Node.js |
| Runtime | **Node.js 24** | `node:sqlite` có sẵn từ Node 22+, không cần gói native |
| Backend | **Express 4** (1 dependency duy nhất) | `npm install` chạy được trên shared hosting |
| Cơ sở dữ liệu | **SQLite (file `licenses.db`)** qua `node:sqlite` | 1 file duy nhất, đã gitignore nên deploy lại không mất key |
| Bảo mật key | Chỉ lưu **hash SHA-256** của key | Lộ DB cũng không dùng được key; key gốc chỉ hiện 1 lần lúc tạo |

## 2. Cấu trúc

```
license-server/
├── package.json            (start: node server.js; engines: node >= 22)
├── server.js               (Express: /api/verify + /api/admin/*)
├── src/
│   ├── db.js               (SQLite: bảng licenses + devices)
│   └── keys.js             (sinh key TLV-XXXX-XXXX-XXXX-XXXX, hash, chuẩn hoá)
├── public/
│   └── admin.html          (trang Quản trị: tạo/khóa/mở lại/xóa key)
├── scripts/
│   └── admin.js            (quản lý key từ dòng lệnh trên máy chủ)
├── data/                   (licenses.db — gitignore, chỉ có trên máy chủ)
├── .env.example
└── README_DEPLOY.md        (file này)
```

## 3. API

### `POST /api/verify` — extension gọi
Body: `{ "key": "TLV-XXXX-XXXX-XXXX-XXXX", "deviceId": "uuid-cua-may-khach" }`
Trả về:
- `{ ok: true, valid: true, expiresAt, expiresAtISO, deviceCount, maxDevices }`
- `{ ok: true, valid: false, reason: "invalid" | "expired" | "revoked" | "device_limit", expiresAt? }`
- Rate-limit: 60 lần / 10 phút / IP → 429.

### API quản trị — cần đăng nhập (cookie `admin_token`, httpOnly, 12 giờ)
- `POST /api/admin/login` `{ password }` — mật khẩu = biến môi trường `ADMIN_PASSWORD`
- `GET /api/admin/stats`, `GET /api/admin/licenses`
- `POST /api/admin/licenses` `{ days, maxDevices, note }` → trả về key gốc **1 lần duy nhất**
- `POST /api/admin/licenses/:id/revoke` | `/restore` — khóa / mở lại key
- `DELETE /api/admin/licenses/:id` — xóa hẳn key

## 4. Deploy lên Hostinger (làm theo thứ tự)

### Bước 1 — Đẩy code lên GitHub
Đặt thư mục `license-server/` vào repo (ví dụ repo `doc-helper` hoặc repo
riêng). Không đẩy `node_modules/` và `data/` — đã gitignore.

### Bước 2 — Tạo Web App trong hPanel
1. hPanel → Websites → Add Website → **Deploy Web App**.
2. Chọn **Connect with GitHub** → chọn repo, nhánh `main`.
3. Cấu hình app:
   - **Application root / Root directory:** `license-server` (thư mục chứa
     `package.json` của server này)
   - **Node.js version:** 24
   - **Install command:** `npm install`
   - **Start command:** `npm start`
   - **Domain:** subdomain mới, ví dụ `license.digimar.site`
     (đăng ký subdomain trong hPanel → Domains trước, rồi gắn cho Web App).
4. Biến môi trường (Environment variables):
   - `NODE_ENV=production`
   - `ADMIN_PASSWORD=` — mật khẩu quản trị trang /admin (đặt mật khẩu mạnh,
     **không để mặc định**; quên thì đổi lại biến này rồi redeploy)
   - `DATA_DIR=` — nên đặt **ngoài thư mục repo** để dữ liệu an toàn tuyệt
     đối, ví dụ `/home/u215032752/license-data` (xem đúng đường dẫn home
     trong hPanel → File Manager; tự tạo thư mục này trước). Nếu để trống,
     app dùng `license-server/data/` (vẫn an toàn qua các lần git pull vì
     file đã gitignore).
5. Bấm Deploy, chờ báo thành công.

### Bước 3 — Thiết lập lần đầu
1. Mở `https://license.digimar.site/admin` → đăng nhập bằng
   `ADMIN_PASSWORD` vừa đặt.
2. Tạo 1 key thử (30 ngày, ghi chú "key test") → copy key.
3. Test kiểm tra key bằng curl (xem mục 5).

### Bước 4 — Nối extension với server
Trong extension, file `shared/license.js` có hằng `LICENSE_SERVER_URL` —
đổi thành URL thật (`https://license.digimar.site`), build lại extension
v1.5.0 rồi đưa cho khách. Extension gọi `POST {URL}/api/verify`.

## 5. Kiểm tra sau deploy (checklist)

```bash
# 1. Server sống
curl https://license.digimar.site/
# → {"ok":true,"service":"doc-helper-license","version":"1.0.0"}

# 2. Tạo key từ dòng lệnh trên máy chủ (SSH hoặc terminal hPanel)
node scripts/admin.js create --days 30 --note "key test" --max-devices 2
# → in ra key TLV-XXXX-...

# 3. Verify key còn hạn (thay KEY và DEVICE-ID)
curl -X POST https://license.digimar.site/api/verify \
  -H "Content-Type: application/json" \
  -d '{"key":"TLV-XXXX-XXXX-XXXX-XXXX","deviceId":"test-device-1"}'
# → {"ok":true,"valid":true,"expiresAt":...}

# 4. Verify key sai → invalid
curl -X POST https://license.digimar.site/api/verify \
  -H "Content-Type: application/json" \
  -d '{"key":"TLV-AAAA-AAAA-AAAA-AAAA","deviceId":"test-device-1"}'
# → {"ok":true,"valid":false,"reason":"invalid"}

# 5. Khóa key trên trang /admin rồi verify lại → reason "revoked"
# 6. Mở trang /admin trên trình duyệt → đăng nhập được, thấy danh sách key
```

## 6. Vận hành hằng ngày

- **Bán key:** vào `/admin` → Tạo key mới (chọn số ngày, số thiết bị tối
  đa, ghi chú tên khách) → copy key gửi khách. Khách dán key vào popup
  extension (mục Tailieu.vn) là dùng được.
- **Khách hết hạn:** khách mua key mới, nhập key mới vào popup (key cũ tự
  thay bằng key mới).
- **Khách vi phạm / đòi hoàn tiền:** vào `/admin` → bấm **Khóa** — key dừng
  ngay trên mọi thiết bị (lần kiểm tra tiếp theo, tối đa 1 giờ sau vì
  extension cache kết quả 1 giờ).
- **Key dùng quá số máy:** khách báo lỗi "vượt số thiết bị" thì vào `/admin`
  xem cột Thiết bị; có thể xóa key cũ và tạo key mới, hoặc tăng
  `maxDevices` bằng cách tạo key mới với số lớn hơn.
- **Sao lưu:** tải file `licenses.db` trong `DATA_DIR` (hoặc `data/`) qua
  File Manager trước mỗi lần deploy lớn. Mất file này = mất toàn bộ key.
- **Quên mật khẩu quản trị:** đổi biến môi trường `ADMIN_PASSWORD` trong
  hPanel rồi redeploy Web App.

## 7. Bảo mật & giới hạn

- Key gốc không lưu ở đâu trên server — chỉ lưu hash. Mất key đã cấp thì
  chỉ còn cách khóa key cũ và tạo key mới.
- Mật khẩu quản trị so sánh bằng `timingSafeEqual` (chống đo thời gian);
  đăng nhập sai không bị khóa tài khoản (chỉ dựa vào mật khẩu mạnh).
- API đổi dữ liệu kiểm tra Origin cùng host (chống CSRF cơ bản).
- Extension cache kết quả verify 1 giờ: key bị khóa/hết hạn có thể dùng
  tiếp tối đa 1 giờ; khi mất mạng, extension cho dùng tiếp tối đa 24 giờ
  từ lần kiểm tra thành công gần nhất (để khách không bị kẹt vì mạng chập
  chờn) — sau đó bắt buộc phải kiểm tra lại online.
- DeviceId do extension tự sinh (UUID lưu trong `chrome.storage.local`),
  chỉ dùng để đếm thiết bị — không thu thập thông tin cá nhân.
- **Giới hạn gói Business:** tối đa 5 website Node.js; app này dùng 1
  process Node nên thoải mái.

## 8. Chạy local (test trước khi deploy)

```bash
cd license-server
npm install
ADMIN_PASSWORD=mat-khau-test npm start   # mở http://localhost:3001
# Tạo key thử:
node scripts/admin.js create --days 30 --note "key test"
# Verify thử:
curl -X POST http://localhost:3001/api/verify -H "Content-Type: application/json" \
  -d '{"key":"TLV-XXXX-XXXX-XXXX-XXXX","deviceId":"test-1"}'
```
