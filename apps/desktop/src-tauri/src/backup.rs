// SPDX-License-Identifier: Apache-2.0
//! B3 — filesystem primitives for encrypted backup/restore (roadmap §8.7).
//!
//! Encryption is done in TypeScript (WebCrypto AES-256-GCM) so the same code
//! runs in the desktop shell and a future PWA; this module only produces the
//! plaintext snapshot, moves bytes, and protects the database file:
//!
//!  - `snapshot`: `VACUUM INTO` a temp file (a consistent copy even mid-write),
//!    gzip it, return the compressed bytes, delete the temp files.
//!  - `write_file` / `read_file`: create the parent folder, write atomically.
//!  - `replace_database`: keep the current DB (and its WAL/SHM) as a
//!    pre-restore copy, then swap the restored bytes in. The app must be
//!    restarted afterwards; the caller says so in the UI.
//!
//! The recovery key and the encryption happen never in this file.

use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use flate2::read::GzDecoder;
use flate2::write::GzEncoder;
use flate2::Compression;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};

pub const SNAPSHOT_SUFFIX: &str = ".sqlite.gz";

fn unix_ts() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Gzip-compressed, consistent copy of the database at `db_path`.
pub fn snapshot(db_path: &Path, tmp_dir: &Path) -> Result<Vec<u8>, String> {
    fs::create_dir_all(tmp_dir).map_err(|e| e.to_string())?;
    let tmp = tmp_dir.join(format!("snapshot-{}{SNAPSHOT_SUFFIX}", unix_ts()));
    let _ = fs::remove_file(&tmp);
    {
        let conn = Connection::open(db_path).map_err(|e| e.to_string())?;
        // Bound the SQL parameter so a stray quote can never break the statement.
        let literal = tmp.to_string_lossy().replace('\'', "''");
        conn.execute_batch(&format!("VACUUM INTO '{literal}'"))
            .map_err(|e| format!("snapshot failed: {e}"))?;
    }
    let raw = fs::read(&tmp).map_err(|e| e.to_string())?;
    let _ = fs::remove_file(&tmp);
    let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
    encoder.write_all(&raw).map_err(|e| e.to_string())?;
    encoder.finish().map_err(|e| e.to_string())
}

/// Plaintext SQLite bytes from a gzip'd snapshot; capped so a corrupt file
/// cannot exhaust memory.
pub fn decompress_snapshot(gz: &[u8], max_bytes: u64) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    GzDecoder::new(gz)
        .take(max_bytes + 1)
        .read_to_end(&mut out)
        .map_err(|e| format!("snapshot is not valid gzip: {e}"))?;
    if out.len() as u64 > max_bytes {
        return Err("snapshot is larger than this app supports".to_string());
    }
    if !out.starts_with(b"SQLite format 3\0") {
        return Err("snapshot does not contain a database".to_string());
    }
    Ok(out)
}

pub fn write_file(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path.parent().ok_or("the destination has no folder")?;
    fs::create_dir_all(parent).map_err(|e| format!("cannot create folder: {e}"))?;
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, bytes).map_err(|e| format!("cannot write backup: {e}"))?;
    fs::rename(&tmp, path).map_err(|e| format!("cannot finish backup: {e}"))?;
    Ok(())
}

pub fn read_file(path: &Path, max_bytes: u64) -> Result<Vec<u8>, String> {
    let meta = fs::metadata(path).map_err(|e| format!("cannot read backup: {e}"))?;
    if meta.len() > max_bytes {
        return Err("backup file is too large".to_string());
    }
    fs::read(path).map_err(|e| format!("cannot read backup: {e}"))
}

pub fn file_modified_secs(path: &Path) -> Option<u64> {
    fs::metadata(path)
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
}

/// Whether `a` and `b` sit on the same filesystem/volume. Used for the
/// "a backup on the same disk won't survive a dead PC" warning (§8.7);
/// when the check is unavailable the caller warns conservatively.
pub fn same_volume(a: &Path, b: &Path) -> Option<bool> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let ma = fs::metadata(a).ok()?;
        let mb = fs::metadata(b).ok()?;
        Some(ma.dev() == mb.dev())
    }
    #[cfg(not(unix))]
    {
        use std::path::Component;
        let root = |p: &Path| -> Option<PathBuf> {
            let mut c = p.components();
            match c.next()? {
                Component::Prefix(pre) => Some(PathBuf::from(pre.as_os_str())),
                Component::RootDir => Some(PathBuf::from(std::path::MAIN_SEPARATOR.to_string())),
                _ => None,
            }
        };
        Some(root(a)? == root(b)?)
    }
}

/// Swap the database file for `bytes`, keeping the current one as a
/// pre-restore copy. WAL/SHM side files are moved with it so a stale WAL can
/// never be replayed onto the restored data.
pub fn replace_database(data_dir: &Path, db_path: &Path, bytes: &[u8]) -> Result<PathBuf, String> {
    let stamp = unix_ts();
    let keep_dir = data_dir.join(crate::db::BACKUP_DIR_NAME);
    fs::create_dir_all(&keep_dir).map_err(|e| e.to_string())?;
    let keep = keep_dir.join(format!("pre-restore-{stamp}.db"));
    if db_path.exists() {
        fs::copy(db_path, &keep).map_err(|e| format!("cannot keep the current database: {e}"))?;
    }
    for suffix in ["-wal", "-shm"] {
        let side = PathBuf::from(format!("{}{suffix}", db_path.display()));
        if side.exists() {
            let _ = fs::rename(&side, keep_dir.join(format!("pre-restore-{stamp}.db{suffix}")));
        }
    }
    let tmp = db_path.with_extension("restore.tmp");
    fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
    fs::rename(&tmp, db_path).map_err(|e| format!("cannot replace the database: {e}"))?;
    Ok(keep)
}

// ---------------------------------------------------------------------------
// Master backup bundle (format v2): database snapshot + item photos.
//
//   "MTBD1" · u32 BE manifest length · manifest JSON · db.gz bytes ·
//   photo bytes (concatenated in manifest order)
//
// The bundle is the plaintext that gets AES-GCM encrypted by the web layer,
// so integrity of every byte is already covered by the GCM tag.
// ---------------------------------------------------------------------------

pub const BUNDLE_MAGIC: &[u8] = b"MTBD1";
const MAX_MANIFEST_BYTES: usize = 8 * 1024 * 1024;
const MAX_BUNDLE_PHOTOS: usize = 200_000;

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct PhotoEntry {
    pub name: String,
    pub len: u64,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct Manifest {
    pub v: u32,
    pub db_len: u64,
    pub item_count: u64,
    pub photos: Vec<PhotoEntry>,
}

pub struct ParsedBundle<'a> {
    pub manifest: Manifest,
    pub db_gz: &'a [u8],
    /// Photo bytes in manifest order.
    pub photos: Vec<(String, &'a [u8])>,
}

fn count_items(db_path: &Path) -> u64 {
    Connection::open(db_path)
        .and_then(|c| c.query_row("SELECT COUNT(*) FROM items", [], |r| r.get::<_, i64>(0)))
        .map(|n| n.max(0) as u64)
        .unwrap_or(0)
}

/// Database snapshot plus every photo file, packed into one buffer.
pub fn build_bundle(db_path: &Path, tmp_dir: &Path, photos_dir: &Path) -> Result<Vec<u8>, String> {
    let db_gz = snapshot(db_path, tmp_dir)?;
    let item_count = count_items(db_path);
    let mut photos: Vec<(String, Vec<u8>)> = Vec::new();
    if let Ok(entries) = fs::read_dir(photos_dir) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.ends_with(".tmp") || !crate::media::is_safe_file_name(&name) {
                continue;
            }
            if !entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
                continue;
            }
            let bytes = fs::read(entry.path()).map_err(|e| format!("cannot read photo {name}: {e}"))?;
            photos.push((name, bytes));
        }
    }
    photos.sort_by(|a, b| a.0.cmp(&b.0));
    let manifest = Manifest {
        v: 1,
        db_len: db_gz.len() as u64,
        item_count,
        photos: photos
            .iter()
            .map(|(n, b)| PhotoEntry { name: n.clone(), len: b.len() as u64 })
            .collect(),
    };
    let manifest_json = serde_json::to_vec(&manifest).map_err(|e| e.to_string())?;
    let mut out = Vec::with_capacity(
        BUNDLE_MAGIC.len() + 4 + manifest_json.len() + db_gz.len()
            + photos.iter().map(|(_, b)| b.len()).sum::<usize>(),
    );
    out.extend_from_slice(BUNDLE_MAGIC);
    out.extend_from_slice(&(manifest_json.len() as u32).to_be_bytes());
    out.extend_from_slice(&manifest_json);
    out.extend_from_slice(&db_gz);
    for (_, bytes) in &photos {
        out.extend_from_slice(bytes);
    }
    Ok(out)
}

pub fn is_bundle(bytes: &[u8]) -> bool {
    bytes.starts_with(BUNDLE_MAGIC)
}

/// Validates the container fully (lengths, names) before anything is written.
pub fn parse_bundle(bytes: &[u8]) -> Result<ParsedBundle<'_>, String> {
    let bad = || "backup bundle is damaged".to_string();
    if !is_bundle(bytes) {
        return Err(bad());
    }
    let mut pos = BUNDLE_MAGIC.len();
    let len_bytes: [u8; 4] = bytes.get(pos..pos + 4).ok_or_else(bad)?.try_into().map_err(|_| bad())?;
    let manifest_len = u32::from_be_bytes(len_bytes) as usize;
    pos += 4;
    if manifest_len == 0 || manifest_len > MAX_MANIFEST_BYTES {
        return Err(bad());
    }
    let manifest: Manifest =
        serde_json::from_slice(bytes.get(pos..pos + manifest_len).ok_or_else(bad)?).map_err(|_| bad())?;
    pos += manifest_len;
    if manifest.v != 1 || manifest.photos.len() > MAX_BUNDLE_PHOTOS {
        return Err(bad());
    }
    let db_end = pos.checked_add(manifest.db_len as usize).ok_or_else(bad)?;
    let db_gz = bytes.get(pos..db_end).ok_or_else(bad)?;
    pos = db_end;
    let mut photos = Vec::with_capacity(manifest.photos.len());
    for entry in &manifest.photos {
        if !crate::media::is_safe_file_name(&entry.name) {
            return Err(format!("backup contains an unsafe photo name: {}", entry.name));
        }
        let end = pos.checked_add(entry.len as usize).ok_or_else(bad)?;
        photos.push((entry.name.clone(), bytes.get(pos..end).ok_or_else(bad)?));
        pos = end;
    }
    if pos != bytes.len() {
        return Err(bad());
    }
    Ok(ParsedBundle { manifest, db_gz, photos })
}

/// Restores database and photos from plaintext that is either a v2 bundle or
/// a legacy gzip'd database (v1, photos untouched). Returns the pre-restore
/// database copy. Order: validate everything, stage photos, swap the DB, then
/// swap photos — so a bad file changes nothing.
pub fn restore_plaintext(
    data_dir: &Path,
    db_path: &Path,
    photos_dir: &Path,
    plain: &[u8],
    max_db_bytes: u64,
) -> Result<PathBuf, String> {
    if !is_bundle(plain) {
        let raw = decompress_snapshot(plain, max_db_bytes)?;
        return replace_database(data_dir, db_path, &raw);
    }
    let parsed = parse_bundle(plain)?;
    let raw = decompress_snapshot(parsed.db_gz, max_db_bytes)?;

    let stage = data_dir.join("photos.restore.tmp");
    let _ = fs::remove_dir_all(&stage);
    fs::create_dir_all(&stage).map_err(|e| e.to_string())?;
    for (name, bytes) in &parsed.photos {
        if let Err(e) = fs::write(stage.join(name), bytes) {
            let _ = fs::remove_dir_all(&stage);
            return Err(format!("cannot stage photo {name}: {e}"));
        }
    }
    let keep = match replace_database(data_dir, db_path, &raw) {
        Ok(k) => k,
        Err(e) => {
            let _ = fs::remove_dir_all(&stage);
            return Err(e);
        }
    };
    if photos_dir.exists() {
        let stamp = keep
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| "pre-restore".to_string());
        let aside = data_dir.join(crate::db::BACKUP_DIR_NAME).join(format!("{stamp}-photos"));
        fs::rename(photos_dir, &aside).map_err(|e| format!("cannot set aside current photos: {e}"))?;
    }
    fs::rename(&stage, photos_dir).map_err(|e| format!("cannot put restored photos in place: {e}"))?;
    Ok(keep)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn make_db(path: &Path) {
        let conn = Connection::open(path).unwrap();
        conn.execute_batch("CREATE TABLE t (v TEXT); INSERT INTO t VALUES ('hello');")
            .unwrap();
    }

    #[test]
    fn snapshot_round_trips_through_gzip() {
        let dir = TempDir::new().unwrap();
        let db = dir.path().join("app.db");
        make_db(&db);
        let gz = snapshot(&db, &dir.path().join("tmp")).unwrap();
        assert_eq!(&gz[..2], &[0x1f, 0x8b], "gzip header");
        let raw = decompress_snapshot(&gz, 50 * 1024 * 1024).unwrap();
        let restored = dir.path().join("restored.db");
        fs::write(&restored, &raw).unwrap();
        let conn = Connection::open(&restored).unwrap();
        let v: String = conn.query_row("SELECT v FROM t", [], |r| r.get(0)).unwrap();
        assert_eq!(v, "hello");
        // No temp snapshot is left behind.
        let left: Vec<_> = fs::read_dir(dir.path().join("tmp")).unwrap().collect();
        assert!(left.is_empty());
    }

    #[test]
    fn decompress_rejects_garbage_and_non_sqlite() {
        assert!(decompress_snapshot(b"not gzip", 1024).is_err());
        let mut enc = GzEncoder::new(Vec::new(), Compression::default());
        enc.write_all(b"plain text").unwrap();
        let gz = enc.finish().unwrap();
        assert!(decompress_snapshot(&gz, 1024).unwrap_err().contains("does not contain a database"));
    }

    #[test]
    fn replace_database_keeps_a_pre_restore_copy() {
        let dir = TempDir::new().unwrap();
        let db = dir.path().join("app.db");
        make_db(&db);
        let other = dir.path().join("other.db");
        let conn = Connection::open(&other).unwrap();
        conn.execute_batch("CREATE TABLE t (v TEXT); INSERT INTO t VALUES ('restored');")
            .unwrap();
        drop(conn);
        let bytes = fs::read(&other).unwrap();
        let keep = replace_database(dir.path(), &db, &bytes).unwrap();
        assert!(keep.exists());
        let conn = Connection::open(&keep).unwrap();
        let v: String = conn.query_row("SELECT v FROM t", [], |r| r.get(0)).unwrap();
        assert_eq!(v, "hello");
        let conn = Connection::open(&db).unwrap();
        let v: String = conn.query_row("SELECT v FROM t", [], |r| r.get(0)).unwrap();
        assert_eq!(v, "restored");
    }

    #[test]
    fn same_volume_on_one_temp_dir() {
        let dir = TempDir::new().unwrap();
        assert_eq!(same_volume(dir.path(), dir.path()), Some(true));
    }

    #[test]
    fn bundle_round_trips_db_and_photos() {
        let dir = TempDir::new().unwrap();
        let db = dir.path().join("app.db");
        make_db(&db);
        let photos = dir.path().join("photos");
        fs::create_dir_all(&photos).unwrap();
        fs::write(photos.join("1.png"), b"png-bytes").unwrap();
        fs::write(photos.join("2.jpg"), b"jpg-bytes!").unwrap();
        fs::write(photos.join("3.png.tmp"), b"half").unwrap();
        let bundle = build_bundle(&db, &dir.path().join("tmp"), &photos).unwrap();
        let parsed = parse_bundle(&bundle).unwrap();
        assert_eq!(parsed.manifest.photos.len(), 2);
        assert_eq!(parsed.photos[0], ("1.png".to_string(), &b"png-bytes"[..]));
        assert_eq!(parsed.photos[1], ("2.jpg".to_string(), &b"jpg-bytes!"[..]));
    }

    #[test]
    fn bundle_rejects_truncation_trailing_bytes_and_unsafe_names() {
        let dir = TempDir::new().unwrap();
        let db = dir.path().join("app.db");
        make_db(&db);
        let photos = dir.path().join("photos");
        fs::create_dir_all(&photos).unwrap();
        fs::write(photos.join("1.png"), b"png-bytes").unwrap();
        let bundle = build_bundle(&db, &dir.path().join("tmp"), &photos).unwrap();
        assert!(parse_bundle(&bundle[..bundle.len() - 1]).is_err());
        let mut extra = bundle.clone();
        extra.push(0);
        assert!(parse_bundle(&extra).is_err());
        let evil = String::from_utf8_lossy(&bundle).replace("1.png", "../x");
        assert!(parse_bundle(evil.as_bytes()).is_err());
    }

    #[test]
    fn restore_swaps_db_and_photos_and_keeps_the_old_ones() {
        let src = TempDir::new().unwrap();
        let src_db = src.path().join("app.db");
        make_db(&src_db);
        let src_photos = src.path().join("photos");
        fs::create_dir_all(&src_photos).unwrap();
        fs::write(src_photos.join("1.png"), b"new-photo").unwrap();
        let bundle = build_bundle(&src_db, &src.path().join("tmp"), &src_photos).unwrap();

        let dst = TempDir::new().unwrap();
        let dst_db = dst.path().join("app.db");
        let conn = Connection::open(&dst_db).unwrap();
        conn.execute_batch("CREATE TABLE t (v TEXT); INSERT INTO t VALUES ('old');").unwrap();
        drop(conn);
        let dst_photos = dst.path().join("photos");
        fs::create_dir_all(&dst_photos).unwrap();
        fs::write(dst_photos.join("9.png"), b"old-photo").unwrap();

        let keep = restore_plaintext(dst.path(), &dst_db, &dst_photos, &bundle, 50 * 1024 * 1024).unwrap();
        assert!(keep.exists());
        let conn = Connection::open(&dst_db).unwrap();
        let v: String = conn.query_row("SELECT v FROM t", [], |r| r.get(0)).unwrap();
        assert_eq!(v, "hello");
        assert_eq!(fs::read(dst_photos.join("1.png")).unwrap(), b"new-photo");
        assert!(!dst_photos.join("9.png").exists());
        let aside = dst.path().join(crate::db::BACKUP_DIR_NAME).join(format!(
            "{}-photos",
            keep.file_stem().unwrap().to_string_lossy()
        ));
        assert_eq!(fs::read(aside.join("9.png")).unwrap(), b"old-photo");
    }

    #[test]
    fn restore_accepts_legacy_v1_and_leaves_photos_alone() {
        let src = TempDir::new().unwrap();
        let src_db = src.path().join("app.db");
        make_db(&src_db);
        let gz = snapshot(&src_db, &src.path().join("tmp")).unwrap();
        let dst = TempDir::new().unwrap();
        let dst_db = dst.path().join("app.db");
        fs::write(&dst_db, fs::read(&src_db).unwrap()).unwrap();
        let photos = dst.path().join("photos");
        fs::create_dir_all(&photos).unwrap();
        fs::write(photos.join("9.png"), b"keep").unwrap();
        restore_plaintext(dst.path(), &dst_db, &photos, &gz, 50 * 1024 * 1024).unwrap();
        assert_eq!(fs::read(photos.join("9.png")).unwrap(), b"keep");
    }

    #[test]
    fn bad_bundle_changes_nothing() {
        let dst = TempDir::new().unwrap();
        let dst_db = dst.path().join("app.db");
        make_db(&dst_db);
        let photos = dst.path().join("photos");
        fs::create_dir_all(&photos).unwrap();
        fs::write(photos.join("9.png"), b"keep").unwrap();
        let mut junk = BUNDLE_MAGIC.to_vec();
        junk.extend_from_slice(&[0, 0, 0, 9, b'{']);
        assert!(restore_plaintext(dst.path(), &dst_db, &photos, &junk, 1024).is_err());
        assert_eq!(fs::read(photos.join("9.png")).unwrap(), b"keep");
        let conn = Connection::open(&dst_db).unwrap();
        let v: String = conn.query_row("SELECT v FROM t", [], |r| r.get(0)).unwrap();
        assert_eq!(v, "hello");
    }
}
