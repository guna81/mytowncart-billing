# Backup and restore (B3)

Encrypted, **local-folder** backups. Nothing is uploaded anywhere; the
seller picks a folder (ideally a USB drive) and the app writes `.mtcb` files
into it. Restore validates and decrypts one of those files and swaps it in.

Decision record: `DECISIONS.md` B3-1. Code: `packages/backup/src/crypto.ts`
(envelope), `packages/backup/src/files.ts` (folder/file helpers, all I/O via
an injected `invoke`), `apps/web/src/lib/cryptoStore.ts` (key wrapping and
storage), `apps/web/src/components/BackupPanel.tsx` (UI), and
`apps/desktop/src-tauri/src/backup.rs` (Rust side).

## Recovery key

- 160 random bits, shown as **8 groups of 4 base32 characters**
  (`ABCA FGHK …`), e.g. `QK4V 7M2X …`.
- Shown in full once, on creation, with a "I wrote it down" acknowledgement.
  The panel can reveal it again later through the keychain.
- Parsing tolerates lower case, spaces and dashes (`parseRecoveryKey`).
- The seller must keep a paper copy. Without the key, a backup cannot be
  opened — there is no recovery mechanism by design.

## Where the key lives

The key is wrapped and stored in the **OS credential store** under
`backup.recovery-key`:

1. PBKDF2-SHA-256 (100 000 iterations, fixed password
   `mytowncart-billing key wrap`, random 16-byte salt) derives a non-extractable
   AES-256-GCM key.
2. That key seals the 20 raw bytes with AAD
   `mytowncart-billing recovery key wrap`.
3. The JSON blob `{v:1, salt_b64, nonce_b64, data_b64}` is stored in the
   keychain.

The fixed password is deliberate: the OS keychain *is* the secret boundary
(only the signed-in desktop user can read it), and the derived key never
leaves memory in extractable form. The recovery key is never written to
SQLite, `localStorage`, a file, or a log.

## File format (`.mtcb`)

```
offset 0     "MTCB1"                      magic
offset 5     u32 big-endian header length
offset 9     header JSON (UTF-8, ≤ 4096 bytes), used as GCM AAD
…            AES-256-GCM ciphertext || 16-byte tag
```

Header:

```json
{
  "v": 1,
  "salt_b64": "…",           // per-backup HKDF salt (16 bytes)
  "nonce_b64": "…",          // per-backup GCM nonce (12 bytes)
  "cipher": "aes-256-gcm",
  "kdf": "hkdf-sha-256",
  "schema_version": 5,
  "app_version": "0.1.0",
  "created_at": "2026-11-05T13:00:00.000Z"
}
```

Key derivation: HKDF-SHA-256(recovery key, salt, info
`mytowncart-billing backup v1`) → 32-byte AES key. A fresh salt and nonce per
backup mean one recovery key can decrypt many backups without key/nonce reuse.

Because the header is the associated data, any edit to version, schema,
salt or nonce makes decryption fail.

Header `v` is the format: **1** = plaintext is the gzip-compressed SQLite
snapshot (database only, older backups); **2** = master bundle (below). The
app restores both.

### Master bundle (format v2)

A v2 backup holds the database **and every item photo** (photos are files in
the app-data `photos/` folder, not in SQLite):

```
"MTBD1" · u32 BE manifest length · manifest JSON · db.gz · photo bytes…
```

The manifest (`{v, db_len, item_count, photos:[{name,len}]}`) lets the restore
screen show what a backup contains before anything is overwritten. Integrity
of every byte is covered by the AES-GCM tag. Code: `backup.rs`
(`build_bundle`, `parse_bundle`, `restore_plaintext`) and
`packages/backup/src/bundle.ts`. Large payloads use raw binary IPC
(`bundle_snapshot`, `write_backup_raw`, `read_backup_raw`, `restore_backup`).

## Creating a backup

1. The app provides a sensible default backup folder under the user's
   Documents (`Documents/MyTownCart Backups`) which is created automatically if
   missing. The seller can keep this default, type a custom path, or click
   **Browse…** to choose any folder (e.g. a USB drive) using the native folder
   dialog. The selected folder is remembered in `app_settings` (`backup.local`
   = `{folder, lastSuccessAt, sameDrive}`). An **Open folder** button lets the
   seller browse and inspect the backups directly in their operating system's
   file manager (Finder/Explorer). A same-drive folder shows a warning because
   it does not protect against disk failure.
2. *Back up now*:
   - `db_snapshot` runs `VACUUM INTO` a temporary file under the app-data dir
     and gzips it (`backup.rs::snapshot`);
   - the web layer encrypts it with the recovery key
     (`encryptCurrentDatabase`, records `schema_version` 5 and `APP_VERSION`
     in the header);
   - `write_backup_raw` writes to `<folder>/mytowncart-YYYY-MM-DD-HHmm.mtcb`
     via a temp file + rename (atomic on the same filesystem);
   - `lastSuccessAt` is updated.
3. The panel shows the last backup time and warns when the newest backup is
   more than 7 days old.

## Verifying

Every backup (manual and startup) is read back and decrypted with the stored
key right after it is written; if that fails it is reported as failed rather
than saved. The restore screen's **Check backup** button does the same for any
file and shows date, item count and photo count without restoring.

## Restoring (also on a new PC)

On a fresh install the setup wizard has **Restore from a backup**
(`#/restore`), so a dead PC can be recovered before the shop is set up. The
typed recovery key is saved to the new computer's keychain after a successful
restore, so automatic backups continue.

Flow: choose file (native picker or path) → type key → **Check backup** →
review contents → **Restore**. A backup from a newer schema is refused.
Restore validates the whole bundle first, stages photos, swaps the database,
then swaps the photo folder; the previous data is kept at
`backups-local/pre-restore-<ts>.db` and photos at
`backups-local/pre-restore-<ts>-photos/`.

### Restoring (details of the original flow)

1. The seller enters the backup path and the recovery key, then confirms.
2. `read_backup_file` reads the bytes (size-capped), the web layer checks the
   magic (`isBackupFile`), derives the key and decrypts:
   - `not_backup` — not a `.mtcb` file;
   - `bad_key` — the key is not a valid recovery key;
   - `wrong_key` / `corrupt` — GCM authentication failed (wrong key or a
     damaged file).
3. `restore_snapshot(gz)` in Rust:
   - decompresses with a size cap and requires the `SQLite format 3` header
     before touching anything (one restore at a time);
   - copies the current database to
     `backups-local/pre-restore-<ts>.db` (reusing the migration backup
     naming);
   - writes a temp file and renames it over the database (atomic), moving
     `-wal`/`-shm` side files aside;
   - returns the pre-restore path, which the UI shows;
   - the app asks the seller to restart.
4. A backup made by a **newer** app (higher `schema_version`) is refused the
   same way the migration runner refuses a downgrade.

## Guarantees and limits

- Encryption and decryption happen on this machine (WebCrypto); the folder
  only ever sees ciphertext.
- The pre-migration path (`backups-local/pre-migration-*.db`) and the
  pre-restore copy are **plaintext** local safety copies in the app-data dir;
  they exist for crash recovery, not for off-machine storage.
- Losing both the recovery key and the keychain entry makes backups
  unreadable. That is the point of the key; it is also why the panel insists
  on the written-down acknowledgement.
- Cloud backup (M5) is out of scope and gated (zero-spend D12).
- The browser dev build shows "backups need the desktop app" — it has no
  filesystem access and no keychain.

## Startup backup check

The current source calls `checkAndRunAutoBackup` at desktop startup. It attempts
an encrypted backup when a saved destination and recovery key exist and the
last successful backup is over 24 hours old (or absent). The destination must
be available. This is a startup check, not an operating-system background
schedule; keep the manual daily backup routine and verify the resulting file.
Browser and LAN clients do not run native backups.
