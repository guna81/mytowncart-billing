// SPDX-License-Identifier: Apache-2.0
//! Item photos live as private files next to the database
//! (`<data>/photos/<item>.<ext>`), never inside SQLite. `items.photo_path`
//! holds only the relative file name, so an absolute path never leaks into a
//! backup or a CSV export (roadmap §8.6).
//!
//! Browsers cannot tell a file's bytes from its name, so the type is sniffed
//! from magic numbers here and the extension is derived from that — a
//! `image/jpeg` label on an HTML file is stored as `.bin` and refused by the
//! marketplace-side upload.

use std::fs;
use std::path::{Path, PathBuf};

pub const MAX_IMAGE_BYTES: usize = 5 * 1024 * 1024;
pub const PHOTO_DIR_NAME: &str = "photos";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ImageKind {
    Jpeg,
    Png,
    Webp,
}

impl ImageKind {
    pub fn extension(self) -> &'static str {
        match self {
            ImageKind::Jpeg => "jpg",
            ImageKind::Png => "png",
            ImageKind::Webp => "webp",
        }
    }

    #[allow(dead_code)]
    pub fn mime(self) -> &'static str {
        match self {
            ImageKind::Jpeg => "image/jpeg",
            ImageKind::Png => "image/png",
            ImageKind::Webp => "image/webp",
        }
    }
}

pub fn sniff(bytes: &[u8]) -> Option<ImageKind> {
    if bytes.len() >= 3 && bytes[0] == 0xFF && bytes[1] == 0xD8 && bytes[2] == 0xFF {
        return Some(ImageKind::Jpeg);
    }
    if bytes.len() >= 8 && &bytes[..8] == b"\x89PNG\r\n\x1a\n" {
        return Some(ImageKind::Png);
    }
    if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        return Some(ImageKind::Webp);
    }
    None
}

pub fn photos_dir(data_dir: &Path) -> PathBuf {
    data_dir.join(PHOTO_DIR_NAME)
}

/// Reject anything but a plain file name (no separators, no `..`), since the
/// stored value becomes a path component.
pub fn is_safe_file_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 120
        && !name.contains('/')
        && !name.contains('\\')
        && name != "."
        && name != ".."
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

/// Write one item's photo, replacing any previous file. Returns the new
/// relative file name to store in `items.photo_path`.
pub fn store_photo(data_dir: &Path, item_id: i64, bytes: &[u8]) -> Result<String, String> {
    if bytes.is_empty() {
        return Err("the photo is empty".to_string());
    }
    if bytes.len() > MAX_IMAGE_BYTES {
        return Err(format!(
            "the photo is {} MB; the limit is {} MB",
            bytes.len() / (1024 * 1024),
            MAX_IMAGE_BYTES / (1024 * 1024)
        ));
    }
    let kind = sniff(bytes)
        .ok_or("this is not a JPEG, PNG or WebP image — use a photo from your camera or gallery")?;
    let dir = photos_dir(data_dir);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    // Remove any earlier photo for this item so only one file exists.
    if let Ok(entries) = fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with(&format!("{item_id}.")) {
                let _ = fs::remove_file(entry.path());
            }
        }
    }
    let name = format!("{item_id}.{}", kind.extension());
    let path = dir.join(&name);
    let tmp = dir.join(format!("{name}.tmp"));
    fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
    Ok(name)
}

pub fn read_photo(data_dir: &Path, file_name: &str) -> Result<Vec<u8>, String> {
    if !is_safe_file_name(file_name) {
        return Err("bad photo file name".to_string());
    }
    let path = photos_dir(data_dir).join(file_name);
    fs::read(&path).map_err(|e| format!("cannot read photo {file_name}: {e}"))
}

pub fn delete_photo(data_dir: &Path, file_name: &str) -> Result<(), String> {
    if !is_safe_file_name(file_name) {
        return Err("bad photo file name".to_string());
    }
    let path = photos_dir(data_dir).join(file_name);
    match fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    const PNG: &[u8] = b"\x89PNG\r\n\x1a\nrest-of-a-fake-png";
    const JPEG: &[u8] = b"\xFF\xD8\xFF\xE0rest-of-a-fake-jpeg";
    const WEBP: &[u8] = b"RIFF\x10\x00\x00\x00WEBPVP8 ";

    #[test]
    fn sniffs_by_magic_numbers_not_by_claim() {
        assert_eq!(sniff(PNG), Some(ImageKind::Png));
        assert_eq!(sniff(JPEG), Some(ImageKind::Jpeg));
        assert_eq!(sniff(WEBP), Some(ImageKind::Webp));
        assert_eq!(sniff(b"<html>not an image</html>"), None);
        assert_eq!(sniff(b""), None);
    }

    #[test]
    fn storing_replaces_the_previous_extension() {
        let dir = TempDir::new().unwrap();
        let first = store_photo(dir.path(), 7, PNG).unwrap();
        assert_eq!(first, "7.png");
        let second = store_photo(dir.path(), 7, JPEG).unwrap();
        assert_eq!(second, "7.jpg");
        assert!(!photos_dir(dir.path()).join("7.png").exists());
        assert_eq!(read_photo(dir.path(), "7.jpg").unwrap(), JPEG);
    }

    #[test]
    fn refuses_non_images_and_oversized_files() {
        let dir = TempDir::new().unwrap();
        assert!(store_photo(dir.path(), 1, b"hello").unwrap_err().contains("not a JPEG"));
        let big = vec![0u8; MAX_IMAGE_BYTES + 1];
        assert!(store_photo(dir.path(), 1, &big).unwrap_err().contains("limit"));
    }

    #[test]
    fn rejects_path_traversal_file_names() {
        let dir = TempDir::new().unwrap();
        for bad in ["../secret", "a/b.png", "..", "", "x\\y"] {
            assert!(!is_safe_file_name(bad), "{bad} should be rejected");
            assert!(read_photo(dir.path(), bad).is_err());
        }
        assert!(is_safe_file_name("12.png"));
    }
}
