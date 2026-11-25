# Code signing policy

MyTownCart Billing is free, open-source software (Apache-2.0). This page
describes how its Windows installers are signed and who is responsible.

## Attribution

Windows installers: **Free code signing provided by
[SignPath.io](https://signpath.io), certificate by
[SignPath Foundation](https://signpath.org).**

> Status: the SignPath Foundation application was declined on 2026-11-24
> because the project is too new to show enough public adoption. Releases are
> unsigned for now and this page describes the intended process if signing is
> set up later. See [RELEASING.md](RELEASING.md) for the current state.

## What is signed

- The Windows x64 installers (`.exe` and `.msi`) attached to a GitHub Release.
- Only files built by the [Release workflow](../.github/workflows/release.yml)
  on GitHub-hosted runners from a pushed `v*` tag of this repository.
- Nothing built on a developer's computer is ever signed.
- macOS and Linux builds are not signed with this certificate.

## Roles

| Role | Who | Responsibility |
| --- | --- | --- |
| Committers and reviewers | [@guna81](https://github.com/guna81) | Write and review code; merge to `main`. |
| Approver | [@guna81](https://github.com/guna81) | Approves each signing request after checking that the tag, the CI result and the build match the release being published. |

Contributions from other people are reviewed by a team member before they are
merged. Every team member must use multi-factor authentication on GitHub and on
SignPath.

## Process

1. A version is prepared on a branch, merged to `main`, and CI passes.
2. A maintainer pushes the `vX.Y.Z` tag.
3. The Release workflow builds the installers on GitHub-hosted runners and
   uploads them as a workflow artifact.
4. The workflow submits that artifact to SignPath. SignPath checks that the
   request came from this repository's workflow, then waits for the approver.
5. After approval, SignPath signs the files and the workflow publishes them with
   SHA-256 checksums.

## Privacy

The app keeps bills and customer data on the shop's own computer. It contacts
the GitHub Releases API to look for a newer version, and contacts the
MyTownCart platform only when the shop has linked a MyTownCart account. Details
are in the [README privacy section](../README.md#privacy-what-leaves-the-machine).
The signing process does not add telemetry to the app.

## Reporting a problem

If you think a signed file is malicious or was signed by mistake, open an issue
at <https://github.com/guna81/mytowncart-billing/issues> or follow
[CONTRIBUTING.md](../CONTRIBUTING.md). A bad release will be withdrawn and the
signing request reported to SignPath so the signature can be revoked.
