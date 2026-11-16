# Shared catalog MVP

Deploy the marketplace backend's shared catalog migration/API before distributing this client.
The companion backend work is on `feature/shared-catalog-mvp` in the marketplace repository.

For a connected shop, Add Item includes **Find in MyTownCart catalog** when categories
have loaded online. Search by name or scan/type a barcode, confirm the exact pack and
choose **Use this pack**. Details and an approved image are downloaded. Enter the shop's
own price, tax and opening stock. A failed photo download leaves a visible notice and
permits manual photography. Lookup errors leave manual item entry available.
Existing local items with the same catalog ID/barcode open for editing instead of being
replaced. Catalog selection starts with a single packaged item, sold by count.

SQLite migration 0018 adds `items.catalog_entry_id`; memory and Tauri/LAN adapters
carry the same field. The image uses existing local photo storage. Catalog IDs are
separate from seller offer product/variant IDs. Single-item publication includes
`catalog_entry_id`; the server checks that it references the correct barcode variant.
Existing clients/items without a catalog ID retain their prior behavior.

Lookup uses the existing integration credential and `products:write` scope via
`GET /api/v1/integrations/catalog/?kind=product&search=...&page=1`. It sends search text,
not bills or customer records. Image downloads use the existing public-media downloader.
Checkout reads local SQLite and does not call the catalog. Saved invoice snapshots
are not refreshed from shared catalog changes.

Catalog details/photos are snapshots. Automatic refresh, image-license revocation delivery,
shared variant-group import and merge redirects are deferred. Images already downloaded
require separate removal on revocation. The platform admin records permission for participating
sellers and billing downloads before approving an image.

Validation: connector/storage tests, publish/sync tests, TypeScript, changed-file ESLint,
Rust library tests including migrations, production web build, and
`apps/web/e2e/shared-catalog.spec.ts`. The browser test uses mocked catalog assets and
checks photo storage, duplicate selection and scanning with marketplace requests blocked.
