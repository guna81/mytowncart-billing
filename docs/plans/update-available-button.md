# Plan: "Update available" button (decision B4-3)

Audience: an implementing agent with no prior context. Read `DECISIONS.md`
entries B4-2 and B4-3 first. Do not commit or tag unless asked.

## Goal
When a newer GitHub Release than the running app exists, show an
**Update available (vX.Y.Z)** button. Clicking it opens the release page in the
system browser. Notify only; no in-app install, no signing keys.

## Repo facts (verified)
- Desktop shell: Tauri 2 in `apps/desktop/src-tauri` (`tauri = "2"`, no plugins
  yet; commands registered in `src/lib.rs` `invoke_handler`).
- Frontend: React 19 + Vite + zustand in `apps/web/src`. Tauri detection:
  `isInTauri()` in `lib/tauri.ts`; commands via `invokeCmd` (dynamic import).
- Running version: `APP_VERSION` in `packages/core/src/index.ts` (currently
  `"0.1.0"`), shown in the sidebar footer in `components/Layout.tsx`
  (~line 333, `v{APP_VERSION}`; collapsed sidebar variant ~line 352).
- Settings has an Updates section: `screens/SettingsScreen.tsx` ~line 165 using
  i18n keys `settings.updates` / `settings.updates_note`
  ("Automatic updates arrive in a later update.").
- i18n: `i18n/en.ts`, `hi.ts`, `ta.ts` (typed `I18nKey`; all three must have
  every key). `t("key", {param})` style interpolation, e.g. `{count}`.
- CSP in `apps/desktop/src-tauri/tauri.conf.json`:
  `connect-src 'self' ipc: http://ipc.localhost https://mytowncart.com https://api.mytowncart.com`.
- Capabilities: `apps/desktop/src-tauri/capabilities/default.json`
  (`core:default` only).
- Repo: `guna81/mytowncart-billing`. Release flow: tag `v*` -> draft release ->
  maintainer publishes (`docs/RELEASING.md`). `/releases/latest` returns only
  published, non-prerelease releases.
- Tests: vitest (`pnpm test`), Playwright e2e in `apps/web/e2e` (runs against
  the web build, not Tauri). Gates: `pnpm lint`, `pnpm typecheck`, `pnpm test`,
  `pnpm build`.

## Steps

### 1. Pure logic + tests: `apps/web/src/lib/updateCheck.ts`
- `parseVersion(s)`: strip leading `v`, parse `MAJOR.MINOR.PATCH` (ignore
  `-pre`/`+build` suffix for compare; return `null` if unparseable).
- `isNewer(latestTag, current)`: numeric tuple compare; `false` if either is
  unparseable.
- `fetchLatestRelease(fetchImpl = fetch)`: GET
  `https://api.github.com/repos/guna81/mytowncart-billing/releases/latest`
  with header `Accept: application/vnd.github+json`, 8 s timeout via
  `AbortController`. Return `{ tag, url }` (`tag_name`, `html_url`) or `null`
  on any non-200, network error, timeout, or malformed JSON. Never throw.
  Validate `html_url` starts with
  `https://github.com/guna81/mytowncart-billing/releases/` else return `null`.
- `checkForUpdate({ current, force, now, storage, fetchImpl })`:
  - Throttle: unless `force`, skip the network call if last check was < 24 h
    ago (`localStorage` key `mtc.updateCheck.lastAt`; wrap storage access in
    try/catch). Cache last result (`mtc.updateCheck.latest` = `{tag,url}`) so
    the button can show from cache while throttled.
  - Return `{ available: boolean, tag?, url?, checkedAt, failed?: boolean }`.
- `apps/web/src/lib/updateCheck.test.ts` (vitest, inject `fetchImpl`/storage/
  clock): version parsing and comparison (`v0.1.0` vs `0.1.1`, `0.10.0` >
  `0.9.0`, equal -> false, garbage -> false, older -> false); 200 newer ->
  available; 200 same -> not; 404/403(rate limit)/network reject/bad JSON/
  timeout -> `failed`, no throw, not available; non-GitHub `html_url`
  rejected; throttle skips fetch within 24 h but still returns cached result;
  `force` bypasses throttle; storage unavailable doesn't crash.

### 2. Open-in-browser support (Rust + JS)
- Add `tauri-plugin-opener = "2"` to `apps/desktop/src-tauri/Cargo.toml`;
  register `.plugin(tauri_plugin_opener::init())` in the builder in
  `src/lib.rs`; add `@tauri-apps/plugin-opener` to `apps/web/package.json`
  (run `pnpm install`, commit lockfile changes; update `Cargo.lock` via
  `cargo check`).
- Capability: in `capabilities/default.json` add
  `{ "identifier": "opener:allow-open-url", "allow": [{ "url": "https://github.com/guna81/mytowncart-billing/releases/*" }] }`
  (use the exact permission/scope shape the installed plugin version's schema
  in `gen/schemas` requires; do NOT grant open-anything).
- In `lib/tauri.ts` add `openReleasePage(url)`: if `isInTauri()` dynamic-import
  `@tauri-apps/plugin-opener` and call `openUrl(url)`; else
  `window.open(url, "_blank", "noopener,noreferrer")`.
- Verify the plugin names/APIs against the installed version's docs/types
  before coding (Tauri 2 opener replaced the older `shell.open`).

### 3. CSP
In `tauri.conf.json` append `https://api.github.com` to `connect-src`. Change
nothing else. Do not touch `createUpdaterArtifacts` (stays `false`).

### 4. State: `apps/web/src/store/appStore.ts`
Add `updateInfo: { tag: string; url: string } | null`, `updateChecking: boolean`,
and an action `runUpdateCheck(force?: boolean)` that calls `checkForUpdate`
with `APP_VERSION`, and sets `updateInfo` only when available. Skip entirely
when `!isInTauri()` (web/dev builds show nothing, and avoid hitting the API in
Playwright). Call `runUpdateCheck()` once on app start (where the store is
initialised / `App.tsx` mount effect, after setup wizard & PIN gate are not
required — the check is independent of login). Do not block rendering.

### 5. UI
- New `components/UpdateAvailableButton.tsx`: renders nothing unless
  `updateInfo`; otherwise a button
  `data-testid="update-available-btn"` labelled `t("update.available", {version})`
  (e.g. "Update available (v0.2.0)"), `title` = `t("update.available_hint")`,
  `onClick` -> `openReleasePage(updateInfo.url)`. Visually distinct (amber/blue
  pill), keyboard accessible, `aria-label` set.
- Place in `Layout.tsx` sidebar footer next to the `v{APP_VERSION}` line (both
  expanded and collapsed variants; collapsed = icon-only with title/aria-label).
  Must not appear on the POS print view or inside modals.
- `SettingsScreen.tsx` Updates section: replace the "later update" note with
  current version, a **Check for updates** button
  (`data-testid="check-updates-btn"`, calls `runUpdateCheck(true)`, disabled
  while checking), and a result line: "You're up to date (v0.1.0)", "Version
  vX is available" + the same open button, or "Couldn't check right now —
  you can download new versions from the releases page" on failure. Keep a
  short manual-download/backup-first note (reuse wording from
  `docs/RELEASING.md`: back up shop data before upgrading).
- i18n: add keys to `en.ts`, `hi.ts`, `ta.ts` (all three, same keys):
  `update.available` (`"Update available ({version})"`), `update.available_hint`,
  `update.check`, `update.checking`, `update.up_to_date`, `update.check_failed`,
  `update.backup_first`; update/remove `settings.updates_note` (remove from all
  three if unused). Provide real Hindi and Tamil text, not English copies.

### 6. Docs
- `docs/RELEASING.md`: in "Publish a new version" step 6 note that publishing
  the draft (as latest, non-prerelease) is what triggers the in-app button;
  also fix the "Automatic updates are disabled" paragraph to mention the
  notify-only button. Mention a prerelease/draft will not notify.
- `README.md`/`docs/SCREENS.md`: update only if they describe Settings > Updates.
- `DECISIONS.md` B4-3 already written; amend only if implementation deviates.

### 7. Verification (must all pass)
- `pnpm lint && pnpm typecheck && pnpm test && pnpm build`
- `cargo check --manifest-path apps/desktop/src-tauri/Cargo.toml` and
  `pnpm --filter @mytowncart-billing/desktop test`
- Playwright: existing e2e must still pass (button hidden since not in Tauri).
  Optionally add an e2e that stubs `window.__TAURI_INTERNALS__` and routes
  `api.github.com` to a newer tag to assert the button and Settings flow; skip
  if it requires invasive test hooks.
- Manual (`pnpm desktop:dev`): temporarily set `APP_VERSION` lower than the
  latest published release (v0.1.0 is published; if it is the latest, point the
  fetch at a mock or temporarily compare against `0.0.1`) and confirm: button
  shows, click opens the GitHub release in the default browser, nothing opens
  for other URLs, offline shows no button and no error toast, Settings check
  shows the right state. Revert any temporary change.

## Edge cases / non-goals
- No auto-download/install, no signing keys, no telemetry, no workflow change.
- Never block or toast-spam on failure; never throw from the check.
- Don't show for prerelease/draft (API already excludes them).
- Single-source the repo slug and API URL as constants in `updateCheck.ts`.
- Don't bump the app version as part of this work.

## Done when
Button appears only when a newer published release exists, opens only the
scoped release URL in the system browser, all gates above pass, three locales
are complete, and RELEASING.md describes the trigger.
