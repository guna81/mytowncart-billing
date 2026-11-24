# Windows code signing with SignPath Foundation: setup

Zero-spend signing for the Windows installers. Applies to
[`release.yml`](../../.github/workflows/release.yml), which already contains a
signing step that stays off until the repository variable
`SIGNPATH_ORGANIZATION_ID` exists.

## Status

| Date | Step | State |
| --- | --- | --- |
| 2026-11-23 | Policy page, workflow change and this guide committed to `dev` (`7c25774`) | Done, not yet on `main` |
| 2026-11-24 | Application submitted at signpath.org/apply | Done; waiting for SignPath's email |
| | Approval | Pending |
| | SignPath project, GitHub secret and variables | Not started |
| | Release-candidate tag to test signing | Not started |
| | Update README, site, `RELEASING.md`, release notes from "unsigned" | Not started |

What the application said:

- Project, repository and homepage as in section 1 below, category Productivity,
  maintainer type individual, build system GitHub Actions.
- Download URL: the GitHub Releases page. It does not mention SignPath, which the
  form says it should. Add a code-signing note to the site and README (and merge
  `dev` to `main`) if SignPath asks.
- Privacy URL: the README's privacy section on `main`.
- Reputation, stated honestly: repo created 2026-11-05, 7 releases, about 120
  downloads, 0 stars, one maintainer. Early-stage, so a rejection is possible.

If SignPath rejects the application or asks for more:

- Asked to mention SignPath on the download page: add it, merge to `main`, reply.
- Too new: reapply when usage has grown, or use the Certum open-source
  certificate (check the live price first).
- While waiting, nothing changes: releases keep working unsigned.

## Order of work

1. Commit `docs/CODE_SIGNING_POLICY.md` and the `release.yml` change on `main`
   (the policy page must be public before applying).
2. Apply (below).
3. After approval, do the SignPath-side setup and add the GitHub secret and
   variables.
4. Tag a pre-release such as `v0.1.7-rc1` to test. Signing must work before a
   real release depends on it.
5. Update README, `site/index.html`, `RELEASING.md`, `DECISIONS.md` and the
   release notes in `release.yml`, which all say "unsigned" today. Change them
   only after a signed build is verified.

## 1. Application text

Apply at <https://signpath.org/apply>. Re-check the form and
<https://signpath.org/terms> first; wording and conditions can change. Suggested
answers:

- **Project name:** MyTownCart Billing
- **Repository:** https://github.com/guna81/mytowncart-billing
- **Website:** https://guna81.github.io/mytowncart-billing/
- **Licence:** Apache-2.0 (OSI approved)
- **Description:** Free, open-source desktop billing and point-of-sale software
  for small local shops in India (GST invoices, inventory, receipts). Built with
  Tauri; the Windows installer is the supported release. Bills and customer data
  stay on the shop's own PC.
- **Why signing is needed:** Shop owners are not technical. The unsigned
  installer triggers a Windows SmartScreen "unrecognized app" warning that stops
  many of them from installing. We cannot afford a commercial certificate.
- **Build system:** GitHub Actions, GitHub-hosted runners, built from a pushed
  `v*` tag. No manual or local builds are signed.
- **Code signing policy URL:**
  https://github.com/guna81/mytowncart-billing/blob/main/docs/CODE_SIGNING_POLICY.md
- **Team:** one maintainer (committer, reviewer and approver) with MFA on GitHub
  and SignPath.
- **Download and usage:** Free to download from GitHub Releases. The project has
  no paid tier.

Be honest on the form that this is a one-maintainer project, and that the app is
used commercially by shops while the software itself is free and open source.

## 2. SignPath-side setup (after approval)

Names below are suggestions; use the slugs SignPath gives you.

- **Project slug:** `mytowncart-billing`
- **Signing policy slug:** `release-signing` (set it to require the approver)
- **Trusted build system:** link the predefined GitHub.com trusted build system
  to the project, and install the SignPath GitHub App on the repository.
- **Artifact configuration** (default one for the project):

  ```xml
  <artifact-configuration xmlns="http://signpath.io/artifact-configuration/v1">
    <zip-file>
      <pe-file path="*.exe">
        <authenticode-sign/>
      </pe-file>
      <msi-file path="*.msi">
        <authenticode-sign/>
      </msi-file>
    </zip-file>
  </artifact-configuration>
  ```

  Validate it in SignPath's editor; I wrote it from memory of their syntax and
  could not test it.
- Create a CI user with submitter permission on that signing policy and copy its
  API token.

## 3. GitHub settings

Repository **Settings → Secrets and variables → Actions**:

| Kind | Name | Value |
| --- | --- | --- |
| Secret | `SIGNPATH_API_TOKEN` | the CI user's API token |
| Variable | `SIGNPATH_ORGANIZATION_ID` | SignPath organization id |
| Variable | `SIGNPATH_PROJECT_SLUG` | `mytowncart-billing` |
| Variable | `SIGNPATH_SIGNING_POLICY_SLUG` | `release-signing` |

Setting `SIGNPATH_ORGANIZATION_ID` is what switches signing on. Delete it to
switch signing off again, for example if SignPath is down and you must ship.

## Known limits of the workflow change

- Only the installers are signed. The app executable inside them is not, which
  is normal for SmartScreen but may matter to some antivirus tools. Signing it
  too means a Tauri `bundle.windows.signCommand`, which needs SignPath's CLI
  or a different flow. Not done.
- The workflow replaces the unsigned installers on the draft release, then
  `release-downloads.py` makes the versioned and stable copies and checksums
  from the signed files.
- SignPath's open-source programme requires every job leading to the signing
  request to run on GitHub-hosted runners. `windows-latest` does.
- Not tested end to end. The first run happens when you tag a release candidate.
- A signed file can still show SmartScreen at first. The SignPath certificate
  belongs to SignPath Foundation and its reputation is shared across projects,
  so results vary.

## winget (optional, free)

After a release is published, with the versioned URL, install `wingetcreate`
(`winget install wingetcreate`) and run:

```powershell
wingetcreate new https://github.com/guna81/mytowncart-billing/releases/download/vX.Y.Z/MyTownCart-Billing-vX.Y.Z-windows-x64.msi
```

Follow the prompts, then submit the pull request it offers to
`microsoft/winget-pkgs`. Use the versioned filename, not the stable one, because
winget stores a hash that must match the file at that URL. Do this after
signing works so the hash is that of the signed installer.
