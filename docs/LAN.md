# LAN browser access (development)

The current development source can serve the billing UI to other devices on
the same local network. This is separate from the standalone Vite demo and
from MyTownCart marketplace synchronization. It is not yet part of a newly
published installer release.

## Start and connect

1. Run a desktop build containing the LAN server. For local development, run
   `pnpm build` first so `apps/web/dist` contains the UI assets, then start
   `pnpm desktop:dev`.
2. Open **Settings → LAN server** on the desktop host.
3. Choose an available port (default `8080`, accepted range `1024–65535`) and
   start the server. Stop it before changing the port.
4. Connect the other device to the same shop network. Open the displayed LAN
   address or scan its QR code. Use the host's LAN address, not `localhost`,
   from another device.
5. Keep the desktop app and host computer running. Stop the server in Settings
   when access is no longer needed. Optional autostart uses the saved port
   when the desktop app next launches.

## Data and limits

LAN-served pages set `window.__MTC_LAN_SERVER__` and select `HttpRepository`.
Requests go to `POST /api/invoke` on the host; the host dispatches supported
repository operations against the same SQLite database used by the desktop.
Photos are served at `/api/photos/<itemId>?key=<access key>`, with `/api/health`
for status (it reveals nothing about the shop). The server binds to all
interfaces (`0.0.0.0`) over plain HTTP. It sends no cross-origin (CORS)
headers, and every data request needs the per-start access key (below) plus,
once PINs exist, a PIN login session. Traffic is not encrypted, so anyone able
to watch the network could read it.
Use only an isolated, trusted shop network; do not expose or forward this port
to the internet. This implementation does not provide encrypted transport,
per-client authorization, or a separate offline database on each counter.

Backups, recovery keys, marketplace connection and other native capabilities
remain desktop workflows.

The browser can start the marketplace connection and read the catalog through the
host's proxy (`/api/marketplace/proxy`, which attaches the stored token), but it
**cannot run a sync**: the host's invoke table does not include the outbox, stock-pull,
sync-cursor, catalog-record, image-upload or reconcile commands. Run *Sync now* in the
desktop window. The connection is stored once in the host's keychain, so connecting from a
browser replaces the desktop's. The proxy always targets production; debug builds can
point it at a local backend with `MTC_DEV_API_URL` (loopback addresses only). Browser clients are not a replacement for host backups.

If a device cannot connect, confirm that the server is running, both devices
are on the same LAN, and the host firewall permits the selected port. Guest
Wi-Fi client isolation can prevent access. In development, missing UI assets
require rebuilding `apps/web/dist`.

## Access key

Each time the LAN server starts it creates a random access key. The addresses
and QR code shown in Settings include it (`?key=...`). The browser keeps the key
for that tab and sends it as `X-MTC-Key` on every request; `/api/invoke` returns
401 without it. Stopping and restarting the server issues a new key. Cross-origin
(CORS) access to `/api/invoke` is not allowed, and `query_rows` accepts only
read-only statements.

## Logging in from the browser

When users have PINs, the browser shows the PIN screen first. Owner-only actions
(void, stock changes, credit notes, purchases, settings, users) are refused for a
cashier session. The login lasts until the terminal is locked, the server
restarts, or 12 hours pass.
