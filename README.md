# GitubGen Recorder

Next.js di Vercel + Turso/libSQL untuk mengamati status GitHub Project V2. Cron eksternal tetap **setiap satu menit, sepanjang hari**. Tidak ada perubahan jadwal 09–17, webhook, debounce dua polling, atau backfill transisi singkat.

## Konfigurasi

Environment server:

- `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`
- `GITHUB_TOKEN` dengan akses baca project/repository yang diperlukan
- `GITHUB_ORG` (default GO-Bimbel), `GITHUB_PROJECT_NUMBER` (default 11)
- `CRON_SECRET` untuk poll; `RECORDER_API_SECRET` untuk history

Panggil `GET /api/record-status` dengan `Authorization: Bearer <CRON_SECRET>` dari cron-job.org setiap menit. Jangan menaruh secret pada URL. Timeout fungsi 30 detik. Fast poll mengambil maksimal 500 item aktif/recent dengan rotasi berdasarkan waktu pemeriksaan; full sweep dipaginasi dengan cursor, maksimal lima halaman per invocation.

## Integritas data

Identitas snapshot adalah project item ID yang stabil (unik global GitHub), dengan project number, issue node ID, canonical URL, dan URL alias. Tiket pindah repository mempertahankan history melalui alias. Active/sweep dipilih berdasarkan timestamp terbaru. Transaction write dan snapshot monotonic mencegah data lama menimpa data baru. Lease mencegah dua poll baru berjalan bersamaan; lease kedaluwarsa jika fungsi terhenti.

Status berbeda saat polling menjadi transition. Status sama dengan timestamp field yang berubah menjadi **observation** dengan gap, bukan transisi status→status yang sama. Perubahan beberapa detik yang tidak tertangkap polling tidak direkonstruksi ke database. Perubahan yang kebetulan tepat tertangkap polling tetap bisa tercatat. `No status` memakai timestamp item bila field Status sudah tidak ada; bukti ini ditandai gap/ketidakpastian waktu.

`last_polled_at` terpisah dari `last_status_change_at`. Percobaan terhadap item hilang juga dirotasi agar tidak menghalangi active set lain. Heartbeat poll, sweep completion, missing active count, error, durasi, stale input, observation, seeded, dan changed tersedia melalui health/logs. Timeout GitHub delapan detik per request, retry maksimal satu kali untuk HTTP 5xx; izin/rate limit errors tidak diulang tanpa batas.

## Migrasi aditif v2

Writer pertama setelah deployment menjalankan migrasi satu kali per database:

1. Validasi timestamp legacy. Kegagalan preflight menghentikan migrasi tanpa mengubah bukti legacy.
2. Tabel lama `status_snapshot` dan `status_history` **tetap dipertahankan** sebagai backup sebelum migrasi; writer baru tidak memodifikasinya.
3. Buat `current_items`, `issue_aliases`, `status_events`, dan `poll_leases`.
4. Kelompokkan snapshot hanya berdasarkan project item ID; pilih timestamp terbaru, lalu checked_at, lalu URL untuk tie-break deterministik. Semua URL lama menjadi alias.
5. Salin history dengan legacy ID; event status sama→sama diberi kind observation. Tidak mengarang event perantara. Bukti duplikat legacy yang mewakili identitas/transisi sama didedup pada model baru; bukti mentah lengkap tetap di tabel lama.
6. Commit schema version secara atomik bersama model baru.

Read endpoint tidak menjalankan DDL/migrasi. Bila belum siap, mengembalikan 503. Rollback deployment tidak menghapus tabel v2; ekspor/simpan bukti v2 sebelum memakai writer lama karena writer lama hanya memahami tabel legacy. Jangan menghapus tabel lama atau v2 untuk melakukan rollback.

## API

`GET /api/health?check=live`: liveness saja. `GET /api/health`: DB readiness dan heartbeat; 503 bila belum siap atau poll terakhir lebih dari tiga menit. Tidak menampilkan secret/detail error internal.

`POST /api/status-history`, header `Authorization: Bearer <RECORDER_API_SECRET>`:

```json
{
  "issueUrls": ["https://github.com/OWNER/REPO/issues/123"],
  "from": "2026-10-14T00:00:00+07:00",
  "to": "2026-10-17T00:00:00+07:00",
  "includeContext": true
}
```

Maksimal 250 URL per request; input oversize/invalid ditolak dengan 400, tidak dipotong diam-diam. Timestamp ISO harus memiliki timezone dan dinormalisasi UTC; rentang `[from,to)` (akhir eksklusif). `history` berisi baseline/transition, `context` state sebelum rentang, dan `observations` bukti gap terpisah. Setiap event membawa `requestedUrls`, canonical dan original URL, project/item/node ID, waktu occurrence/detection, serta provenance. `coverage` berisi requested/processed/missing/truncated, range, readiness, freshness, heartbeat, dan kebijakan polling. Missing berarti tidak ada bukti dalam range/context, bukan bukti issue tidak ada.

## Development

Node.js 22+:

```sh
npm ci
npm run check
```

Tes SQLite menggunakan file temporer terisolasi (transaksi memerlukan koneksi database bersama, bukan `file::memory:` per koneksi). Cakupan termasuk baseline/poll/observation, alias transfer, migrasi, stale snapshot, multi-project, lease, rotasi >500 item, UTC/WIB, context, kontrak API, freshness, dan GitHub pagination.
