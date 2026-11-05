# Documentation

| Document | Read it for |
|---|---|
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | layers, package boundaries, Tauri commands, boot and print flow |
| [`DATA-MODEL.md`](DATA-MODEL.md) | units, every SQLite table/column, settings keys, what is not stored in SQLite |
| [`SYNC.md`](SYNC.md) | marketplace connection, outbox/merge, stock pull, catalog push, photos (D9), reconcile, orders |
| [`BACKUP.md`](BACKUP.md) | `.mtcb` format, recovery key and key wrapping, backup and restore steps, limits |
| [`SCREENS.md`](SCREENS.md) | every screen, keyboard shortcuts, workflows, reports, print preview |
| [`DEVELOPING.md`](DEVELOPING.md) | setup, commands, browser-only mode, where to change things, tests, releasing |
| [`PILOT.md`](PILOT.md) | operator runbook: day-one checklist, daily routine, troubleshooting, diagnostics |

Related, at the repo root:

- `README.md` — what the project is, privacy, installing a release.
- `DECISIONS.md` — every decision and deviation from the roadmap, with dates.
- `CONTRIBUTING.md` — ground rules for changes.
- `TRADEMARK.md` — naming rules for forks.
- Roadmap and programme decisions (D1–D12, O1–O6): `my-town-cart` repo,
  `roadmap/billing-integration.md`.

The roadmap is the spec of record. Where this repo deviates, the numbered
entries in `DECISIONS.md` win over this docs folder; if you change behaviour,
update the matching document here in the same change.
