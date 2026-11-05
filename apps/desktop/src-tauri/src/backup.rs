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
}
