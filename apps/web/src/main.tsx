// SPDX-License-Identifier: Apache-2.0
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";
import { HostedGate } from "./components/hosted/HostedGate";
import { isHosted } from "./lib/hosted/mode";
import "./styles.css";

const rootEl = document.getElementById("root");
if (!rootEl) {
  throw new Error("missing #root element");
}

createRoot(rootEl).render(
  <StrictMode>
    {isHosted() ? (
      <HostedGate>
        <App />
      </HostedGate>
    ) : (
      <App />
    )}
  </StrictMode>,
);

// Hosted web app: offline app shell (public/sw.js). Desktop and dev never register it.
if (isHosted() && "serviceWorker" in navigator && window.isSecureContext) {
  window.addEventListener("load", () => {
    void navigator.serviceWorker
      .register("./sw.js")
      .then(async (own) => {
        // The app used to live at /app/; drop that old worker so it stops serving a stale copy.
        for (const reg of await navigator.serviceWorker.getRegistrations()) {
          if (reg.scope !== own.scope) await reg.unregister();
        }
      })
      .catch((err) => console.warn("service worker:", err));
  });
}
