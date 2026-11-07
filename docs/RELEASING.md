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

Publishing is automatic once you push a tag. The download section of
<https://guna81.github.io/mytowncart-billing/#download> updates itself.

1. **Prepare on a branch, merge to `main`.** Run
   `python3 tooling/bump-version.py X.Y.Z`. It sets every `package.json`,
   `tauri.conf.json`, `Cargo.toml`, the app's `Cargo.lock` entry and
   `APP_VERSION` together. Add the changes to `docs/WHATS-NEW.md`.
2. **Check.** `pnpm lint && pnpm typecheck && pnpm test && pnpm build`, then
   `cargo test --locked` in `apps/desktop/src-tauri`. Work through
   [MANUAL-CHECKS.md](MANUAL-CHECKS.md) on a *copy* of real shop data
   (database upgrade, roles, LAN phone login, billing numbers). CI on `main`
   must be green. A tag builds committed files only.
3. **Tag the merged commit** on `main`:

   ```sh
   git tag vX.Y.Z
   git push origin vX.Y.Z
   ```

4. **Wait for the Release workflow.** It runs these jobs in order:

   | Job | What it does | If it fails |
   |---|---|---|
   | Tag matches app version | Fails fast if the tag differs from `tauri.conf.json`, `Cargo.toml` or `APP_VERSION` | Fix versions, delete the tag (nothing was published), tag again |
   | Build installers | Windows x64 (required), macOS arm64, macOS x64, Linux x64 (community, may fail) | Windows failure stops everything; a community failure only means that download is missing |
   | Publish release | Needs the Windows installer and checksums, then publishes the draft as **latest** (tags with a `-suffix`, e.g. `v0.2.0-rc1`, become pre-releases and never "latest") | Release stays a draft; fix and re-run the failed job |
   | Refresh download page | Redeploys GitHub Pages; `release.json` is regenerated from the latest release | Run **Deploy site to GitHub Pages** manually |

   The page lists only installers that exist in the release, so a missing
   community build hides its own button instead of giving a broken link.
5. **Verify** (about ten minutes): open the Pages download section and check the
   version, then download the installer for each device you can reach, compare
   the SHA-256 and launch it. Anything wrong: do not move the tag; fix and
   release the next version. Publishing a release is also what triggers the
   in-app "Update available" button for users on older builds.

### One-time repository setup

- **Settings → Pages → Source: GitHub Actions.**
- **Settings → Environments → github-pages → Deployment branches and tags:**
  allow `main` **and** the tag pattern `v*`. Without the tag rule, the page
  refresh that runs after a release is rejected.
- **Settings → Actions → General → Workflow permissions:** read and write
  (the release job edits the release).
- Optional safety net: protect `v*` tags so only maintainers can create them.

### If you want a human gate before publishing

Delete the `publish` job's `gh release edit` step (or set `releaseDraft: true`
and remove the job) and publish by hand from the Releases page; the Pages
workflow also runs when a release is published by hand.

## How the workflow works

- [release.yml](../.github/workflows/release.yml) runs on pushed `v*` tags,
  verifies versions, installs each Rust target and invokes `pnpm exec tauri`
  through `tauri-apps/tauri-action`. Tauri uploads its original installer
  filenames to a shared draft release.
- [release-downloads.py](../tooling/release-downloads.py) copies installers to
  versioned and stable filenames, calculates SHA-256 hashes, and uploads those
  plus a checksum file per platform. It fails if an installer is missing or
  ambiguous.
- The `publish` job flips the draft to a published release, and the `site` job
  calls [pages.yml](../.github/workflows/pages.yml). A release published with
  `GITHUB_TOKEN` does not trigger other workflows, which is why the site job is
  called directly rather than waiting for the `release` event.
- The page links to `releases/latest/download/<stable name>` as a no-JavaScript
  fallback, then rewrites links to the exact version using `release.json`
  (falling back to the GitHub API). It highlights the download for the visitor's
  operating system and opens the matching install notes.
- Code signing and automatic in-app updates are not enabled; see the unsigned
  build notes in the README.

## Device notes to keep current

The install notes on the site (Windows, macOS Apple Silicon/Intel, Linux deb/
AppImage, phone/tablet via LAN) are in `site/index.html`. When the installer set
changes (new formats, signing, notarization), update that section and the
filename table above in the same change.

## Publish documentation and GitHub Pages

The landing page lives in `site/`; it has no build step. The Pages workflow
deploys on `site/**` changes to `main`, on manual run, on release events, and
after every release. A docs-only update needs no version bump, tag or installer
rebuild.

1. Keep README, operator docs and `site/index.html` aligned. Mark unreleased
   features explicitly; publishing Pages does not change the installer.
2. Check links, structure and desktop/mobile layout.
3. Push `main`, watch **Deploy site to GitHub Pages**, then verify
   <https://guna81.github.io/mytowncart-billing/#download>.

Preserve the stable download filenames.
