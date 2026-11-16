// SPDX-License-Identifier: Apache-2.0
fn main() {
    #[cfg(target_os = "macos")]
    {
        use std::env;
        use std::fs;
        use std::path::PathBuf;

        let out_dir = PathBuf::from(env::var("OUT_DIR").unwrap());
        let plist_path = out_dir.join("Info.plist");
        let plist_content = r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>CFBundleName</key>
    <string>MyTownCart Billing</string>
    <key>CFBundleDisplayName</key>
    <string>MyTownCart Billing</string>
    <key>CFBundleIdentifier</key>
    <string>com.mytowncart.billing</string>
    <key>CFBundleVersion</key>
    <string>0.1.5</string>
    <key>CFBundleShortVersionString</key>
    <string>0.1.5</string>
</dict>
</plist>"#;
        let _ = fs::write(&plist_path, plist_content);
        println!(
            "cargo:rustc-link-arg=-Wl,-sectcreate,__TEXT,__info_plist,{}",
            plist_path.display()
        );
    }

    tauri_build::build()
}
