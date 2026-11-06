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
Photos are served at `/api/photos/<itemId>`, with `/api/health` for status.
A normal Vite browser session still uses disposable in-memory data.

The server binds to all interfaces (`0.0.0.0`) and currently uses HTTP, wildcard
CORS, and no request authentication. Anyone able to reach the port can invoke
supported data operations; the user/PIN UI does not secure this endpoint.
Use only an isolated, trusted shop network; do not expose or forward this port
to the internet. This implementation does not provide encrypted transport,
per-client authorization, or a separate offline database on each counter.

Backups, recovery keys, marketplace connection and other native capabilities
remain desktop workflows. Browser clients are not a replacement for host backups.

If a device cannot connect, confirm that the server is running, both devices
are on the same LAN, and the host firewall permits the selected port. Guest
Wi-Fi client isolation can prevent access. In development, missing UI assets
require rebuilding `apps/web/dist`.
