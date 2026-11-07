"""Upload consistently named installers and checksums for README download links."""
import hashlib
import os
from pathlib import Path
import shutil
import subprocess


def prepare(root: Path, output: Path, platform: str) -> list[Path]:
    extensions = {"windows-x64": [".exe", ".msi"], "macos-arm64": [".dmg"],
                  "macos-x64": [".dmg"], "linux-x64": [".deb", ".AppImage"]}[platform]
    output.mkdir(parents=True, exist_ok=True)
    assets = []
    tag = os.environ.get("RELEASE_TAG", "").strip()
    tag_prefix = f"-{tag}" if tag else ""
    for extension in extensions:
        matches = sorted(p for p in root.rglob(f"*{extension}") if "bundle" in p.parts)
        if len(matches) != 1:
            raise RuntimeError(f"Expected one {extension} installer, found {matches}")

        # Versioned installer filename: MyTownCart-Billing-vX.Y.Z-platform.ext
        if tag_prefix:
            dest_versioned = output / f"MyTownCart-Billing{tag_prefix}-{platform}{extension}"
            shutil.copy2(matches[0], dest_versioned)
            assets.append(dest_versioned)

        # Stable unversioned filename: MyTownCart-Billing-platform.ext
        destination = output / f"MyTownCart-Billing-{platform}{extension}"
        shutil.copy2(matches[0], destination)
        assets.append(destination)
    checksums = output / f"checksums-{platform}.txt"
    checksums.write_text("".join(
        f"{hashlib.sha256(asset.read_bytes()).hexdigest()}  {asset.name}\n" for asset in assets
    ))
    return [*assets, checksums]


if __name__ == "__main__":
    assets = prepare(Path("apps/desktop/src-tauri/target"), Path("release-downloads"),
                     os.environ["DOWNLOAD_PLATFORM"])
    subprocess.run(["gh", "release", "upload", os.environ["RELEASE_TAG"],
                    *map(str, assets), "--clobber"], check=True)
