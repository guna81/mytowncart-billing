# MyTownCart Billing logo

The receipt and cart mark connects shop sales with billing. The simple silhouette
works at small sizes and the SVG originals scale without losing detail.

## Assets

- `apps/web/public/brand/logo-mark.svg`: standalone mark and browser favicon.
- `apps/web/public/brand/logo-full.svg`: horizontal logo for light backgrounds.
- `apps/web/public/brand/logo-full-light.svg`: horizontal logo for dark backgrounds.
- `apps/desktop/src-tauri/icons/`: generated desktop and platform icons.

Use royal blue `#1D4ED8`, mint `#34D399`, and navy `#172554`.
Keep clear space of at least one eighth of the mark width around the logo.
Use the standalone mark below 160 px wide; use the full logo at 160 px or wider.
Do not stretch, rotate, recolor, or add shadows to the artwork.
The wordmark uses Inter with Arial and sans-serif fallbacks.

Regenerate platform icons from the repository root:

```sh
pnpm --filter @mytowncart-billing/desktop exec tauri icon ../web/public/brand/logo-mark.svg
```

The existing trademark policy in `TRADEMARK.md` applies to these assets.
