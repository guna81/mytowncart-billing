# Contributing

Thanks for helping build MyTownCart Billing. By contributing you license
your work under Apache-2.0 (see `LICENSE`).

## Ground rules

- **Never commit secrets.** Tokens and recovery keys live in the OS keychain
  via the desktop shell, never in SQLite, logs, or the repo.
- **`packages/core` stays pure:** no react, tauri, DOM, or fs imports. The
  ESLint `no-restricted-imports` boundary rule and its `lib: ES2022`
  tsconfig will fail the build if you try.
- **Money is integer paise; quantities are integer thousandths**
  (`qty_milli`). No floats for either, ever.
- **Migrations are forward-only SQL files**
  (`apps/desktop/src-tauri/migrations/NNNN_name.sql`). Never edit an applied
  migration; add the next number. The runner copies the DB aside before
  migrating.
- **Bills are immutable** (B1): fix mistakes with void-with-reason or a
  credit note.
- TypeScript is `strict`; run `pnpm lint && pnpm typecheck && pnpm test`
  before opening a PR, plus `pnpm --filter @mytowncart-billing/desktop test`
  if you touched the Rust shell.
- Record any deviation from the roadmap spec in `DECISIONS.md` and keep the
  matching document in `docs/` (architecture, data model, sync, backup,
  screens) in step with the code.
- Change a repository behaviour in **both** adapters
  (`packages/storage/src/tauri.ts` and `memory.ts`) and add a
  `memory.test.ts` case.

## Repo setup

```sh
corepack enable   # provides pnpm
pnpm install
pnpm --filter @mytowncart-billing/web dev   # UI in a browser (in-memory data)
pnpm desktop:dev                            # real app: SQLite + keychain
```

The full developer guide (commands, where to change things, tests,
releasing) is [`docs/DEVELOPING.md`](docs/DEVELOPING.md); the docs index is
[`docs/README.md`](docs/README.md).

## CI

The Windows job is required; macOS/Linux are informational community-build
checks. Please don't silence a failing community job without noting it in
`DECISIONS.md`.

## Trademarks

Forks are welcome but must be renamed — see `TRADEMARK.md`.
