# Gitubgen Recorder

Recorder mandiri untuk perubahan status GitHub Project V2. Service ini dibuat sebagai mitigasi ketika `ProjectV2ItemStatusChangedEvent` tidak ditulis ke timeline issue oleh GitHub.

## Cara kerja

1. Scheduler eksternal memanggil `GET /api/record-status` setiap menit.
2. Recorder membaca maksimal lima halaman (500 item) Project V2, lalu menyimpan cursor untuk request berikutnya.
3. Status dibandingkan dengan snapshot sebelumnya di Turso.
4. Perubahan disimpan ke `status_history` menggunakan `Status.updatedAt` sebagai `occurred_at`.
5. Gitubgen V2 mengambil transition melalui `POST /api/status-history`.

Dengan 2.659 item dan cron setiap menit, satu putaran penuh membutuhkan sekitar enam menit tanpa melewati batas timeout 30 detik. Run pertama membuat event `baseline` agar status dan waktu status terkini tetap tersedia. Baseline tidak mengarang status sebelumnya.

## Environment variables

Salin `.env.example` menjadi `.env.local`.

| Variable | Kegunaan |
|---|---|
| `GITHUB_TOKEN` | Fine-grained/classic token yang dapat membaca organisasi dan Project 11 |
| `GITHUB_ORG` | Default `GO-Bimbel` |
| `GITHUB_PROJECT_NUMBER` | Default `11` |
| `TURSO_DATABASE_URL` | URL database Turso |
| `TURSO_AUTH_TOKEN` | Token database Turso |
| `CRON_SECRET` | Bearer secret khusus endpoint polling |
| `RECORDER_API_SECRET` | Bearer secret khusus endpoint history |

Token dan secret tidak boleh memakai prefix `NEXT_PUBLIC_`.

## API

### Health

```http
GET /api/health
```

### Record status

```http
GET /api/record-status
Authorization: Bearer <CRON_SECRET>
```

### Read history

```http
POST /api/status-history
Authorization: Bearer <RECORDER_API_SECRET>
Content-Type: application/json

{
  "issueUrls": ["https://github.com/GO-Bimbel/go-superapp-api/issues/3908"],
  "from": "2026-10-14T00:00:00+07:00",
  "to": "2026-10-14T23:59:59+07:00"
}
```

## Development

```bash
npm install
npm run check
npm run dev
```

Database schema dibuat secara idempotent ketika endpoint pertama dijalankan.

## Deployment gratis

- Vercel Hobby untuk web/API.
- Turso Free untuk database.
- cron-job.org untuk request per menit pada jam kerja.

Atur cron-job.org setiap satu menit dengan timeout 30 detik dan header `Authorization: Bearer <CRON_SECRET>` ke `/api/record-status`.
