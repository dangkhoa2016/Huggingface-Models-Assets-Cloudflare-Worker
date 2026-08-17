# Hugging Face Models Assets trên R2 cho Cloudflare Workers

> 🌐 Language / Ngôn ngữ: [English](README.md) | **Tiếng Việt**

Cloudflare Worker lưu trữ và phục vụ snapshot model-card của Hugging Face
trên Cloudflare R2. Đối tượng bất biến theo key; upload được xác thực bằng
publisher token và kiểm tra bằng SHA-256 content digest. Worker này được
thiết kế để chạy phía sau [Huggingface Stream Proxy](https://github.com/dangkhoa2016/Huggingface-Stream-Proxy-Cloudflare-Worker)
qua Cloudflare Service Binding.

```text
Client
  -> Stream Proxy Worker (/assets/*)
  -> ASSET_SERVICE (Service Binding)
  -> Worker này
  -> Cloudflare R2
```

## Tính năng

- Lưu trữ snapshot model-card dưới dạng đối tượng R2 bất biến, được đánh dấu
  theo commit hash và đường dẫn.
- Xác thực upload bằng bearer `PUBLISH_TOKEN` và so sánh token theo thời
  gian hằng số.
- Kiểm tra `X-Content-SHA256` content digest trên mỗi upload và áp dụng giới
  hạn `MAX_UPLOAD_BYTES` tùy chọn.
- Trả `409 Conflict` khi cùng một key được upload với nội dung khác; upload
  cùng digest là idempotent và trả `200` mà không ghi R2.
- Stream phản hồi `GET` trực tiếp từ R2 mà không buffer; hỗ trợ byte `Range`
  request, `If-Range`, và HTTP conditional request bao gồm `If-Match`,
  `If-Unmodified-Since`, `If-None-Match`, và `If-Modified-Since` với ngữ
  cảnh entity-tag wildcard, list và weak/strong comparison đầy đủ.
- Trả `Content-Range` trên phản hồi một phần (`206`), `Accept-Ranges: bytes`,
  và `Last-Modified` trên mọi lần đọc.
- Đặt `Cache-Control` bất biến (`public, max-age=31536000, immutable`) trên
  đối tượng đã lưu.
- Trả CORS header (`Access-Control-Allow-Origin: *`) trên mọi phản hồi.
- Từ chối đường dẫn asset sai, encoded separator (`%2F`, `%5C`) và thiếu
  segment đường dẫn.
- Kiểm tra commit hash là chuỗi hex 40 ký tự thường.

## Mô hình bảo mật

Upload yêu cầu `Bearer` token khớp với secret `PUBLISH_TOKEN`. So sánh token
dùng hằng số thời gian để chống tấn công timing. Worker không lưu trữ hay
expose `PUBLISH_TOKEN` trong phản hồi.

Integrity nội dung được thực thi bởi `X-Content-SHA256`:
- Digest phải là chuỗi hex 64 ký tự thường của SHA-256.
- Header `Content-Length` là bắt buộc để giới hạn upload.
- Upload vượt quá `MAX_UPLOAD_BYTES` bị từ chối với `413`.

Object key bất biến khi đã ghi. Upload lần hai với cùng key và cùng digest
là idempotent (`200 already_exists`). Upload lần hai với cùng key nhưng nội
dung khác trả `409 Conflict`.

Không có endpoint public list, delete hoặc overwrite. Asset chỉ có thể đọc,
không thể chỉnh sửa hay xóa qua API công khai.

## Cấu trúc dự án

```text
src/worker.js               Mã nguồn Worker
wrangler.jsonc              Cấu hình triển khai
worker-configuration.d.ts   Được tạo bởi `npm run types` (bị gitignore)
test/worker.test.js         Tests với R2 bucket giả lập
package.json                Scripts kiểm thử và syntax check
.gitignore                  Các file bị bỏ qua
```

## Yêu cầu

- Tài khoản Cloudflare đã bật Workers và R2.
- Node.js 20 trở lên để chạy kiểm tra local.
- Wrangler 4 để triển khai; các ví dụ sử dụng `npx wrangler`.

Clone repository:

```bash
git clone https://github.com/dangkhoa2016/Huggingface-Models-Assets-Cloudflare-Worker.git
cd Huggingface-Models-Assets-Cloudflare-Worker
```

## Cấu hình

Triển khai được cấu hình trong `wrangler.jsonc`. R2 bucket binding và biến
môi trường được khai báo ở đó:

```jsonc
{
  "name": "huggingface-models-assets-worker",
  "main": "src/worker.js",
  "r2_buckets": [
    { "binding": "ASSETS", "bucket_name": "huggingface-models-assets" }
  ],
  "vars": {
    "MAX_UPLOAD_BYTES": "16777216"
  }
}
```

- `MAX_UPLOAD_BYTES`: kích thước upload tối đa tính bằng byte. Mặc định
  `16777216` (16 MiB) khi chưa thiết lập hoặc giá trị không hợp lệ.

**Lưu ý:** `wrangler.jsonc` trong repository đặt `workers_dev=false`. Deploy
Worker này sẽ không tạo endpoint `workers.dev` công khai. Worker được thiết kế
chạy nội bộ và được Stream Proxy truy cập qua Service Binding. Để expose
trực tiếp, hãy bật `workers_dev` hoặc cấu hình Route / Custom Domain.

## Cloudflare secrets

Secret publisher `PUBLISH_TOKEN` là bắt buộc cho upload. Xem phần Triển
khai bên dưới để biết workflow khởi tạo lần đầu. Không lưu giá trị token
trong mã nguồn, file cấu hình, command history hoặc log.

## Khởi tạo ban đầu

Cài dependency, xác minh local, sau đó cấu hình tài nguyên Cloudflare:

```bash
npm install

npm run check
npm test
npm run deploy:dry-run

npx wrangler r2 bucket create huggingface-models-assets

npx wrangler deploy --secrets-file <secure-secret-file>
```

Secrets file có thể ở định dạng JSON hoặc `.env`. Giữ file ngoài repository
và không commit nó. Ví dụ định dạng `.env`:

```text
PUBLISH_TOKEN=<your-token-value>
```

`wrangler secret put` cũng được hỗ trợ nhưng là thao tác có ảnh hưởng tới
deployment và tạo Worker version mới. Ưu tiên `--secrets-file` cho deployment
lần đầu để tránh intermediate draft deployment.

## Triển khai

### Độc lập

Worker này có thể chạy độc lập. Sau khi khởi tạo, deploy bằng:

```bash
npx wrangler deploy
```

### Cùng Stream Proxy (Service Binding)

Worker này là backend cho [Huggingface Stream Proxy](https://github.com/dangkhoa2016/Huggingface-Stream-Proxy-Cloudflare-Worker).
`wrangler.toml` của dự án companion phải khai báo Service Binding:

```toml
[[services]]
binding = "ASSET_SERVICE"
service = "huggingface-models-assets-worker"
```

Deploy Worker lưu trữ này **trước**, sau đó deploy Stream Proxy. Cloudflare
yêu cầu target Worker tồn tại trước khi deploy caller có Service Binding.

## API

### `PUT /assets/hf/<owner>/<repo>/<commit>/<path>`

Upload bất biến có xác thực.

Header bắt buộc:

```text
Authorization: Bearer <PUBLISH_TOKEN>
Content-Length: <độ dài byte>
X-Content-SHA256: <64 ký tự hex thường>
Content-Type: <media type của asset>
```

Phản hồi:

| Status | Ý nghĩa |
|--------|---------|
| `201` | Đối tượng đã tạo |
| `200` | Cùng key và cùng digest đã tồn tại (idempotent) |
| `400` | Định dạng digest không hợp lệ, `Content-Length` không hợp lệ hoặc đường dẫn sai |
| `401` | Thiếu hoặc bearer token không hợp lệ |
| `409` | Cùng key tồn tại với nội dung khác |
| `411` | Thiếu `Content-Length` |
| `413` | Upload vượt quá `MAX_UPLOAD_BYTES` |

### `GET /assets/hf/<owner>/<repo>/<commit>/<path>`

Đọc stream công khai. Hỗ trợ byte `Range` request và conditional header
(`If-Match`, `If-Unmodified-Since`, `If-None-Match`, `If-Modified-Since`).
Hỗ trợ `If-Range` với ETag validator: khi ETag khớp với object hiện tại,
Worker trả byte range được yêu cầu; khi không khớp, Worker bỏ qua `Range`
và trả toàn bộ object với `200`.

Đánh giá conditional tuân theo HTTP precedence: `If-Match` được đánh giá
trước; `If-Unmodified-Since` chỉ được đánh giá khi `If-Match` vắng mặt.
`If-None-Match` được đánh giá tiếp; `If-Modified-Since` chỉ được đánh giá
khi `If-None-Match` vắng mặt.

Phản hồi:

| Status | Ý nghĩa |
|--------|---------|
| `200` | Đọc toàn bộ đối tượng (hoặc `If-Range` không khớp, bỏ qua `Range`) |
| `206` | Nội dung một phần (byte range) |
| `304` | Không thay đổi (`If-None-Match` / `If-Modified-Since`) |
| `404` | Asset không tồn tại |
| `412` | Precondition failed (`If-Match` / `If-Unmodified-Since`) |

### `HEAD /assets/hf/<owner>/<repo>/<commit>/<path>`

Đọc metadata công khai. Trả cùng header như `GET` nhưng không có response
body. Hỗ trợ cùng conditional header với `GET` và cùng quy tắc precedence.

### `OPTIONS`

Trả CORS preflight header. Các method được phép: `GET, HEAD, PUT, OPTIONS`.

## Cấu trúc URL

Asset key theo cấu trúc đường dẫn:

```text
/assets/hf/<owner>/<repo>/<commit 40 ký tự hex>/<file-path>
```

Ví dụ:

```text
/assets/hf/zai-org/GLM-4-9B-0414/645b8482494e31b6b752272bf7f7f273ef0f3caf/config.json
```

Segment commit phải đúng 40 ký tự hex thường. Đường dẫn chứa encoded
separator (`%2F`, `%5C`), dot segment (`.` hoặc `..`) hoặc ký tự điều khiển
(`\`, `\0`, `\r`, `\n`) bị từ chối.

## Phát triển local đa Worker

Từ thư mục Stream Proxy, Wrangler có thể chạy cả hai Worker cùng lúc:

```bash
npx wrangler dev \
  -c wrangler.toml \
  -c ../Huggingface-Models-Assets-Cloudflare-Worker/wrangler.jsonc
```

R2 dùng local emulated storage trừ khi binding được cấu hình cho remote
development.

## Môi trường publisher

Công cụ Python mirror gửi upload qua public gateway và đọc token từ biến
môi trường:

```bash
export R2_ASSET_PUBLISH_TOKEN='<giá trị giống PUBLISH_TOKEN đã cấu hình>'
```

Không commit `.dev.vars` hoặc bất kỳ file nào chứa token.

## Kiểm thử local

Test suite không cần thêm runtime dependency:

```bash
npm test
npm run check
```

Tests bao phủ xác thực PUT, kiểm tra digest, giới hạn kích thước upload,
idempotent, phát hiện conflict, stream GET với metadata và CORS, phản hồi byte
range, HEAD metadata, 404 cho asset không tồn tại, phản hồi conditional, CORS
preflight và xử lý method-not-allowed.

## Tài liệu tham khảo

- [Cloudflare R2 Object Storage](https://developers.cloudflare.com/r2/)
- [Cloudflare Workers](https://developers.cloudflare.com/workers/)
- [Cloudflare Service Bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/)
- [Huggingface Stream Proxy](https://github.com/dangkhoa2016/Huggingface-Stream-Proxy-Cloudflare-Worker)

## Giấy phép

[MIT](LICENSE)
