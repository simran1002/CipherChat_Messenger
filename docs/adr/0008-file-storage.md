# ADR-0008: File storage behind an interface — local disk or S3-compatible

**Status:** Accepted (post-Phase-4 remediation)

## Problem
Uploads (avatars, attachments, voice notes) were written by multer straight
to `uploads/` on the pod's disk and served by a static route. With two
replicas, a file uploaded to pod A 404s when the next request lands on pod B;
the compose stack papered over it with a shared volume. Old avatars were
never deleted. The interview review listed this as the last substantive
infrastructure gap.

## Requirement
Uploads must work identically on N replicas with no shared filesystem, be
servable from a CDN, keep the dev/test experience dependency-free, and reclaim
replaced files.

## Decision
- `IFileStorage { put, delete, keyFromUrl }` in `src/storage/`, selected at
  boot by `STORAGE_DRIVER`:
  - **`local`** (default): `uploads/` on disk + the `/uploads` static route.
    Dev, tests, single node.
  - **`s3`**: `@aws-sdk/client-s3` against AWS S3 or any S3-compatible
    endpoint (MinIO, R2, LocalStack via `S3_ENDPOINT` + path-style). Objects
    are keyed `uploads/<unique>.<ext>`, written with
    `Cache-Control: immutable`, and served from `S3_PUBLIC_BASE_URL`
    (bucket website or CDN).
- multer switches to `memoryStorage` so the HTTP layer no longer assumes a
  local disk; the 10 MB cap bounds memory.
- Profile-photo replacement deletes the previous object (`keyFromUrl` maps a
  stored URL back to a key; both drivers refuse foreign URLs and path
  escapes).
- The S3 client is injected, so the driver is unit-tested with a fake
  `send()` — no network, no mocking library.

## Rejected
- **Presigned GET URLs** — message documents store URLs forever; presigned
  URLs expire (max 7 days). A public base URL/CDN is the durable form.

## Follow-on adopted: browser-direct presigned PUT (encrypted blobs only)
`POST /upload/encrypted/presign` returns a 5-minute PUT URL when the s3
driver is active, and the ciphertext goes straight to the bucket without
transiting the app server. The earlier objection — losing the server-enforced
MIME/size boundary — doesn't apply here: the signature itself pins
`Content-Type: application/octet-stream` and the exact byte length the app
authorized, so the bucket rejects anything else. The plaintext room-upload
route keeps its proxied path and MIME allow-list unchanged, and the client
falls back to the proxied `POST /upload/encrypted` whenever presigning is
unavailable (local driver answers 501, bucket CORS, expired URL).

## Trade-off
- S3 mode needs bucket/CDN configuration and the default AWS credential
  chain; local mode needs a shared volume for multi-replica — the compose
  demo keeps the volume so it runs with zero cloud dependencies.
- DM attachments ARE E2EE (added as the follow-on this ADR anticipated):
  the client seals each file with a per-file AES-256-GCM key and uploads the
  ciphertext to `/upload/encrypted` (octet-stream only, no metadata echo);
  the key and real metadata travel only inside the message envelope. Room
  attachments remain server-readable, consistent with ADR-0004.
