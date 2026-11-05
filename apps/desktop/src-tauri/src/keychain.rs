// SPDX-License-Identifier: Apache-2.0
//! Cross-platform secret storage (roadmap §8.7): the integration token and
//! the backup recovery key live in the OS credential store — Windows
//! Credential Manager, macOS Keychain, Linux Secret Service — never in
//! SQLite, never in backups, never in logs.

use keyring::Entry;
use thiserror::Error;

const SERVICE: &str = "com.mytowncart.billing";
const MAX_KEY_LEN: usize = 128;

#[derive(Debug, Error)]
pub enum KeychainError {
    #[error("invalid key: {0}")]
    InvalidKey(&'static str),
    #[error("keychain error: {0}")]
    Backend(#[from] keyring::Error),
}

fn entry(key: &str) -> Result<Entry, KeychainError> {
    if key.is_empty() {
        return Err(KeychainError::InvalidKey("key must not be empty"));
    }
    if key.len() > MAX_KEY_LEN {
        return Err(KeychainError::InvalidKey("key too long"));
    }
    if !key
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | ':'))
    {
        return Err(KeychainError::InvalidKey(
            "only [a-zA-Z0-9._:-] characters are allowed",
        ));
    }
    Ok(Entry::new(SERVICE, key)?)
}

pub fn set(key: &str, value: &str) -> Result<(), KeychainError> {
    entry(key)?.set_password(value)?;
    Ok(())
}

pub fn get(key: &str) -> Result<Option<String>, KeychainError> {
    match entry(key)?.get_password() {
        Ok(v) => Ok(Some(v)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(KeychainError::Backend(e)),
    }
}

pub fn delete(key: &str) -> Result<(), KeychainError> {
    match entry(key)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(KeychainError::Backend(e)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_empty_key() {
        assert!(matches!(set("", "v"), Err(KeychainError::InvalidKey(_))));
    }

    #[test]
    fn rejects_overlong_key() {
        let key = "a".repeat(MAX_KEY_LEN + 1);
        assert!(matches!(set(&key, "v"), Err(KeychainError::InvalidKey(_))));
    }

    #[test]
    fn rejects_keys_with_unsafe_characters() {
        assert!(matches!(get("bad key!"), Err(KeychainError::InvalidKey(_))));
        assert!(matches!(delete("../x"), Err(KeychainError::InvalidKey(_))));
    }

    // A real set/get/delete round-trip needs a desktop session (an
    // interactive credential store), so it is exercised by the B0 hello UI
    // and CI smoke run instead of a headless unit test.
}
