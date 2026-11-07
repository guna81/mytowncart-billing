// SPDX-License-Identifier: Apache-2.0
//! SQLite database bootstrap and the forward-only migrations runner
//! (roadmap §8.2): before applying pending migrations the DB file is copied
//! to `backups-local/pre-migration-v<from>-<unix_ts>.db` next to the
//! database. Migrations are plain SQL files applied in ascending version
//! order, each in its own transaction together with its `schema_version`
//! row. Downgrades (DB newer than the app knows) are refused.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::Connection;
use thiserror::Error;

pub const DB_FILE_NAME: &str = "mytowncart-billing.db";
pub const BACKUP_DIR_NAME: &str = "backups-local";

pub struct Migration {
    pub version: u32,
    pub name: &'static str,
    pub sql: &'static str,
}

/// All known migrations, ascending by `version`. Add new ones at the end.
pub const MIGRATIONS: &[Migration] = &[
    Migration {
        version: 1,
        name: "init",
        sql: include_str!("../migrations/0001_init.sql"),
    },
    Migration {
        version: 2,
        name: "schema",
        sql: include_str!("../migrations/0002_schema.sql"),
    },
    Migration {
        version: 3,
        name: "item_media_settings",
        sql: include_str!("../migrations/0003_item_media_settings.sql"),
    },
    Migration {
        version: 4,
        name: "held_bills",
        sql: include_str!("../migrations/0004_held_bills.sql"),
    },
    Migration {
        version: 5,
        name: "catalog_sync",
        sql: include_str!("../migrations/0005_catalog_sync.sql"),
    },
    Migration {
        version: 6,
        name: "phase1_pilot",
        sql: include_str!("../migrations/0006_phase1_pilot.sql"),
    },
    Migration {
        version: 7,
        name: "phase2_daily_driver",
        sql: include_str!("../migrations/0007_phase2_daily_driver.sql"),
    },
    Migration {
        version: 8,
        name: "phase3_growth",
        sql: include_str!("../migrations/0008_phase3_growth.sql"),
    },
    Migration {
        version: 9,
        name: "user_pins",
        sql: include_str!("../migrations/0009_user_pins.sql"),
    },
];

#[derive(Debug, Error)]
pub enum MigrateError {
    #[error("i/o error: {0}")]
    Io(#[from] std::io::Error),
    #[error("sqlite error: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error(
        "database schema version {db} is newer than this app supports ({known}); \
         refusing to open — update the app instead of downgrading"
    )]
    Downgrade { db: u32, known: u32 },
    #[error("migration list is invalid: {0}")]
    InvalidList(&'static str),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MigrationOutcome {
    pub from_version: u32,
    pub to_version: u32,
    /// Where the pre-migration copy was written, if one was needed.
    pub backup_path: Option<PathBuf>,
}

fn unix_ts() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn ensure_schema_version_table(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS schema_version (
           version    INTEGER PRIMARY KEY,
           name       TEXT NOT NULL,
           applied_at TEXT NOT NULL
         );",
    )
}

fn current_version(conn: &Connection) -> rusqlite::Result<u32> {
    conn.query_row(
        "SELECT COALESCE(MAX(version), 0) FROM schema_version",
        [],
        |row| row.get(0),
    )
}

fn validate_migrations(migrations: &[Migration]) -> Result<(), MigrateError> {
    let mut prev = 0u32;
    for m in migrations {
        if m.version <= prev {
            return Err(MigrateError::InvalidList(
                "versions must be unique and strictly ascending",
            ));
        }
        prev = m.version;
    }
    Ok(())
}

/// Open (creating if needed) the database at `db_path` and apply every
/// pending migration from `migrations`.
pub fn migrate_with(db_path: &Path, migrations: &[Migration]) -> Result<MigrationOutcome, MigrateError> {
    validate_migrations(migrations)?;
    let parent = db_path.parent().unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(parent)?;

    let existed_with_data = db_path.metadata().map(|m| m.len() > 0).unwrap_or(false);

    let mut conn = Connection::open(db_path)?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    ensure_schema_version_table(&conn)?;

    let from = current_version(&conn)?;
    let latest = migrations.last().map(|m| m.version).unwrap_or(0);
    if from > latest {
        return Err(MigrateError::Downgrade { db: from, known: latest });
    }
    let pending: Vec<&Migration> = migrations.iter().filter(|m| m.version > from).collect();
    if pending.is_empty() {
        return Ok(MigrationOutcome {
            from_version: from,
            to_version: from,
            backup_path: None,
        });
    }

    // Make sure everything committed is in the main file before copying it.
    conn.pragma_update(None, "wal_checkpoint", "TRUNCATE")?;

    let backup_path = if existed_with_data {
        let dir = parent.join(BACKUP_DIR_NAME);
        fs::create_dir_all(&dir)?;
        let dest = dir.join(format!("pre-migration-v{from}-{}.db", unix_ts()));
        fs::copy(db_path, &dest)?;
        Some(dest)
    } else {
        None
    };

    for m in pending {
        let tx = conn.transaction()?;
        tx.execute_batch(m.sql)?;
        tx.execute(
            "INSERT INTO schema_version (version, name, applied_at) VALUES (?1, ?2, ?3)",
            rusqlite::params![m.version, m.name, unix_ts().to_string()],
        )?;
        tx.commit()?;
    }

    Ok(MigrationOutcome {
        from_version: from,
        to_version: latest,
        backup_path,
    })
}

/// Apply the app's built-in migrations to the database at `db_path`.
pub fn migrate(db_path: &Path) -> Result<MigrationOutcome, MigrateError> {
    migrate_with(db_path, MIGRATIONS)
}

pub fn open(db_path: &Path) -> rusqlite::Result<Connection> {
    let conn = Connection::open(db_path)?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    // Writers serialize via BEGIN IMMEDIATE; a busy timeout turns a locked
    // database into a wait instead of an immediate SQLITE_BUSY error.
    conn.pragma_update(None, "busy_timeout", 5_000)?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    Ok(conn)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    const M1: Migration = Migration {
        version: 1,
        name: "one",
        sql: "CREATE TABLE t1 (id INTEGER PRIMARY KEY);",
    };
    const M2: Migration = Migration {
        version: 2,
        name: "two",
        sql: "CREATE TABLE t2 (id INTEGER PRIMARY KEY);",
    };

    fn db_path(dir: &TempDir) -> PathBuf {
        dir.path().join(DB_FILE_NAME)
    }

    fn table_exists(path: &Path, table: &str) -> bool {
        let conn = Connection::open(path).unwrap();
        conn.query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
            [table],
            |r| r.get::<_, i64>(0),
        )
        .unwrap()
            > 0
    }

    #[test]
    fn built_in_migrations_are_strictly_ascending() {
        validate_migrations(MIGRATIONS).unwrap();
    }

    #[test]
    fn fresh_db_migrates_to_latest_without_a_backup() {
        let dir = TempDir::new().unwrap();
        let out = migrate_with(&db_path(&dir), &[M1, M2]).unwrap();
        assert_eq!(out.from_version, 0);
        assert_eq!(out.to_version, M2.version);
        assert_eq!(out.backup_path, None);
        assert!(table_exists(&db_path(&dir), "t2"));
    }

    #[test]
    fn re_running_is_a_noop() {
        let dir = TempDir::new().unwrap();
        migrate_with(&db_path(&dir), &[M1, M2]).unwrap();
        let out = migrate_with(&db_path(&dir), &[M1, M2]).unwrap();
        assert_eq!(out.from_version, M2.version);
        assert_eq!(out.to_version, M2.version);
        assert_eq!(out.backup_path, None);
        assert!(!dir.path().join(BACKUP_DIR_NAME).exists());
    }

    #[test]
    fn upgrade_copies_the_db_to_backups_local_first() {
        let dir = TempDir::new().unwrap();
        migrate_with(&db_path(&dir), &[M1]).unwrap();
        let out = migrate_with(&db_path(&dir), &[M1, M2]).unwrap();
        assert_eq!(out.from_version, 1);
        assert_eq!(out.to_version, 2);

        let backup = out.backup_path.expect("a pre-migration copy is required");
        let name = backup.file_name().unwrap().to_string_lossy().to_string();
        assert!(name.starts_with("pre-migration-v1-"), "got {name}");
        assert!(name.ends_with(".db"), "got {name}");
        assert!(backup.exists());

        // The backup holds the pre-upgrade state: v1 with t1 but no t2.
        assert!(table_exists(&backup, "t1"));
        assert!(!table_exists(&backup, "t2"));
    }

    #[test]
    fn refuses_to_open_a_newer_database() {
        let dir = TempDir::new().unwrap();
        migrate_with(&db_path(&dir), &[M1, M2]).unwrap();
        let err = migrate_with(&db_path(&dir), &[M1]).unwrap_err();
        assert!(matches!(err, MigrateError::Downgrade { db: 2, known: 1 }));
    }

    #[test]
    fn a_failing_migration_rolls_back_and_keeps_the_old_version() {
        let dir = TempDir::new().unwrap();
        migrate_with(&db_path(&dir), &[M1]).unwrap();
        const BAD: Migration = Migration {
            version: 2,
            name: "bad",
            sql: "THIS IS NOT SQL;",
        };
        assert!(migrate_with(&db_path(&dir), &[M1, BAD]).is_err());

        let conn = open(&db_path(&dir)).unwrap();
        ensure_schema_version_table(&conn).unwrap();
        assert_eq!(current_version(&conn).unwrap(), 1);
        drop(conn);
        assert!(!table_exists(&db_path(&dir), "t2"));
    }

    #[test]
    fn duplicate_versions_are_rejected() {
        const M2_DUP: Migration = Migration {
            version: 2,
            name: "dup",
            sql: "CREATE TABLE t2_dup (id INTEGER PRIMARY KEY);",
        };
        let dir = TempDir::new().unwrap();
        let err = migrate_with(&db_path(&dir), &[M1, M2, M2_DUP]).unwrap_err();
        assert!(matches!(err, MigrateError::InvalidList(_)));
    }
}
