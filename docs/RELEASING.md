# Releases and installer downloads

MyTownCart Billing installers are hosted on public
[GitHub Releases](https://github.com/guna81/mytowncart-billing/releases).
The MyTownCart platform is at <https://mytowncart.com>.

## First public release

[Version 0.1.0](https://github.com/guna81/mytowncart-billing/releases/tag/v0.1.0)
was published on November 5, 2026. All four installer jobs and the CI workflow
passed. The five README download links were checked after publishing and
returned HTTP 200. This verifies build and download availability; it does not
replace installation and billing checks on each operating system.

Windows is the supported v1 platform. macOS and Linux are community builds.
The installers are unsigned, and macOS builds are not notarized. Automatic
in-app installation is disabled; instead, a notify-only "Update available"
button in the development source appears when a newer published release exists, opening the
release page so users can download and upgrade manually. Drafts and
prereleases do not notify. Back up shop data before upgrading.
See the [installation notes](../README.md#installing-a-release-build).

## Stable and versioned download links

Release assets are published with both versioned filenames (e.g. `MyTownCart-Billing-v0.1.2-windows-x64.exe`) and stable unversioned filenames (`MyTownCart-Billing-windows-x64.exe`).

| Computer / format | Versioned filename (`download/vX.Y.Z/`) | Stable unversioned filename (`latest/download/`) | Checksum file |
| --- | --- | --- | --- |
| Windows x64 EXE | `MyTownCart-Billing-vX.Y.Z-windows-x64.exe` | `MyTownCart-Billing-windows-x64.exe` | `checksums-windows-x64.txt` |
| Windows x64 MSI | `MyTownCart-Billing-vX.Y.Z-windows-x64.msi` | `MyTownCart-Billing-windows-x64.msi` | `checksums-windows-x64.txt` |
| macOS Apple Silicon (M1+) | `MyTownCart-Billing-vX.Y.Z-macos-arm64.dmg` | `MyTownCart-Billing-macos-arm64.dmg` | `checksums-macos-arm64.txt` |
| macOS Intel | `MyTownCart-Billing-vX.Y.Z-macos-x64.dmg` | `MyTownCart-Billing-macos-x64.dmg` | `checksums-macos-x64.txt` |
| Debian / Ubuntu x64 | `MyTownCart-Billing-vX.Y.Z-linux-x64.deb` | `MyTownCart-Billing-linux-x64.deb` | `checksums-linux-x64.txt` |
| Linux x64 AppImage | `MyTownCart-Billing-vX.Y.Z-linux-x64.AppImage` | `MyTownCart-Billing-linux-x64.AppImage` | `checksums-linux-x64.txt` |

Versioned filenames ensure downloaded files clearly display their version and platform name. The unversioned names are retained so permanent download links and automated scripts continue working.

Download the installer and its matching checksum file from the same release.
Compare the SHA-256 output with the entry for that filename:

```powershell
# Windows PowerShell
Get-FileHash .\MyTownCart-Billing-windows-x64.exe -Algorithm SHA256
```

```sh
# macOS (choose arm64 or x64 for your Mac)
shasum -a 256 MyTownCart-Billing-macos-arm64.dmg
# Linux (with both files in the current directory)
sha256sum --check checksums-linux-x64.txt
```

The Linux checksum file lists both DEB and AppImage; download both to check the
entire file, or compare the individual installer's `sha256sum` output.
Checksums detect changed or incomplete downloads; they are not code signatures.

## Publish a new version

1. Update the desktop version in `apps/desktop/src-tauri/tauri.conf.json` and
   `apps/desktop/src-tauri/Cargo.toml`, and update the corresponding local
   package entry in `Cargo.lock`. Keep package versions and the displayed
   `APP_VERSION` in `packages/core/src/index.ts` consistent with the release.
2. Run `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm build`.
   Commit the intended release files, push `main`, and check its CI results.
   A tag builds committed files only; uncommitted working changes are excluded.
3. From the reviewed commit, create and push a new tag, for example:

   ```sh
   git tag v0.1.1
   git push origin v0.1.1
   ```

4. Monitor the **Release** workflow in GitHub Actions. It builds Windows x64,
   macOS arm64, macOS x64, and Linux x64. Windows is required; macOS and Linux
   allow failure, so inspect each job rather than only the overall run status.
5. Open the draft release. Check the expected assets and checksum files,
   verify hashes, and test installation, launch, and a basic billing workflow
   on the platforms being offered. Document any unavailable community build.
6. Edit the release notes, publish the draft, and mark the stable release as
   latest. Publishing the draft (as the latest, non-prerelease release) is what
   triggers the in-app "Update available" button for users on older builds;
   drafts and prereleases will not trigger notifications. Check each README
   download link after publication. Do not reuse or move a published version tag;
   make a new version for corrections.

## How the workflow works

- [release.yml](../.github/workflows/release.yml) runs on pushed `v*` tags,
  installs each Rust target, and invokes `pnpm exec tauri` through
  `tauri-apps/tauri-action`. The explicit command is needed because the desktop
  package has no `tauri` npm script.
- Tauri uploads its original installer filenames to a shared draft release.
- [release-downloads.py](../tooling/release-downloads.py) copies installers to
  the stable filenames above, calculates SHA-256 hashes, and uploads those
  files plus a separate checksum file for each platform. It fails if an
  expected installer is missing or ambiguous.
- The workflow uses GitHub's supplied `GITHUB_TOKEN` with `contents: write`;
  publishing remains a separate maintainer step. Code signing and automatic
  updates require additional setup and are not enabled by this workflow.

## Publish documentation and GitHub Pages

The static landing page lives in `site/`; it has no application build step.
The [Pages workflow](../.github/workflows/pages.yml) uploads that directory
and deploys it when `site/**` or the workflow changes on `main`. Documentation
under `docs/` is linked from the site and rendered by GitHub.

1. Keep README, operator/developer docs and `site/index.html` aligned with the
   reviewed source. Mark unreleased features explicitly; publishing Pages does
   not update the latest desktop installer.
2. Check local assets, internal links, HTML structure and desktop/mobile layout.
3. Commit only intended documentation/site changes and push `main`.
4. Watch **Deploy site to GitHub Pages** finish, then verify
   <https://guna81.github.io/mytowncart-billing/> contains the new content.

No version bump, release tag or installer rebuild is needed for a docs-only
site update. Preserve the stable download filenames.
