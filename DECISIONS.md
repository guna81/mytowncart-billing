# DECISIONS

Decisions taken in this repo, including every deviation from the hand-off
spec (`my-town-cart/roadmap/billing-integration.md`, referenced as "roadmap
§x"). Programme-level decisions (D1–D12, O1–O6) live in roadmap §2 and are
not repeated here.

## B0-1 — SQLite via `rusqlite` commands, not `tauri-plugin-sql`
**Date:** 2026-11-04 · **Deviates from:** roadmap §8.1 ("SQLite plugin")

The migrations runner must copy the DB file to
`backups-local/pre-migration-*.db` *before* migrating (§8.2) and must be
forward-only with a tested downgrade refusal. That control lives naturally
in Rust behind Tauri commands (`db_status`, `db_hello`, …) using `rusqlite`
(bundled SQLite, so no system dependency on Windows). `tauri-plugin-sql`
runs its own migration list without a pre-migration hook and exposes SQL to
the webview, which we do not want. If a future package needs JS-side SQL we
can add the plugin then; all data access for now goes through typed commands.

## B0-2 — Pre-migration backup naming and new-DB behaviour
**Date:** 2026-11-04 · **Deviates from:** roadmap §8.2 ("copies the DB file
to `backups-local/pre-migration-<ver>.db`")

Files are named `pre-migration-v<from_version>-<unix_ts>.db` so successive
upgrades never overwrite an earlier copy (the spec's literal name would
clobber the previous backup on every second migration). No copy is made for
a brand-new/empty database — there is nothing to lose. Copies are never
deleted automatically yet; B3's backup work adds retention.

## B0-3 — Tailwind / react-router / Zustand deferred to B1
**Date:** 2026-11-04 · **Deviates from:** roadmap §8.1 (apps/web stack)

B0 ships a single "hello" screen; adding Tailwind, a router and a store for
one screen would be unused dependency weight. They land together with the
first real screens in B1. Plain CSS keeps the hello UI dependency-free.

## B0-4 — Playwright deferred to B1
**Date:** 2026-11-04 · **Deviates from:** roadmap §8.1 (test stack)

There are no UI flows to drive yet. The OS-level proof in B0 is the CI
build + the launch smoke test (`tooling/scripts/smoke-app.sh`). Playwright
arrives with the first real flow (POS) in B1.

## B0-5 — Keychain covered by the hello UI, not by headless unit tests
**Date:** 2026-11-04

A real credential-store round trip needs a desktop session (and on macOS CI
can block on a Keychain prompt), so `cargo test` covers only key validation.
The runtime path is proven manually via the B0 hello screen (and, on Windows,
in the CI build job where Credential Manager is available to the runner).

## B0-6 — Unsigned builds + checksums, per D12
**Date:** 2026-11-04 · **Implements:** roadmap §2.3

No code-signing certificates (O3/O5 are owner tasks). Release builds are
unsigned; the release workflow attaches SHA-256 checksums for every
installer and builds only in public CI so users can verify what they run.
The README documents the Windows SmartScreen and macOS Gatekeeper steps.

## B3-1 — Backup envelope format (`.mtcb`) and key wrapping
**Date:** 2026-11-05 · **Implements:** roadmap §8.3, D9

One file: magic `MTCB1`, a u32-BE header length, the JSON header, then
AES-256-GCM ciphertext. The header (version, per-backup salt + nonce, cipher,
KDF, schema/app version, UTC timestamp) is the GCM *associated data*, so
tampering with any bound field fails decryption. The key is HKDF-SHA-256 over
a 160-bit recovery key (salt per backup, fixed `info`), shown as 8 × 4 base32
groups. The recovery key is wrapped with a non-extractable AES-GCM key derived
by PBKDF2 and stored in the OS credential store under
`backup.recovery-key`; it is never written to SQLite or localStorage and never
logged (diagnostics redact the grouped form). The desktop shell snapshots via
`VACUUM INTO`, gzips, writes atomically, and warns when the folder is on the
same drive as the database; restore always copies the current DB to
`backups-local/pre-restore-<ts>.db` first.

## B5-1 — Outbox entries, merge-per-run, fresh idempotency keys
**Date:** 2026-11-05 · **Implements:** roadmap §8.6, BR5

The ledger writes one outbox row per remote-linked movement
(`bill:<bill_id>:<movement_id>`, `adj:<id>`). Fractional (by-weight) deltas are
kept local — truncating them would push a sale the shop did not make. Each sync
run merges pending rows per item into one net delta and sends it under a new
key (`itm_<id>:merge:<ts>:<rand>`), so intermediate clamped values never reach
the marketplace; the server's clamp result is applied locally before catalog
hashes are compared. Failed batches back off 30 s × 2ⁿ (cap 30 min). The stock
pull cursor advances in the same transaction as the applied moves.

## B4-1 — Diagnostics are opt-in, local-only and redacted
**Date:** 2026-11-05 · **Implements:** roadmap §8.9, D12

The pilot toggle (`pilot.diagnostics` app setting) starts an in-memory ring
buffer of screen/render events; nothing is transmitted. The report copies
environment details and the buffer after redacting recovery keys and
token-like strings. Cloud telemetry stays out of scope (zero-spend).

## B4-2 — Auto-update configured but disabled until signing keys exist
**Date:** 2026-11-05 · **Implements:** roadmap §2.3

`createUpdaterArtifacts` is pinned to `false`: signing updater artifacts needs a
key the owner generates and stores, which is an O-series owner task. The
release workflow keeps publishing unsigned installers + SHA-256 checksums, and
the Settings screen tells users to download the new build manually.
