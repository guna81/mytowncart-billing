// SPDX-License-Identifier: Apache-2.0
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ command, mode }) => {
  // `--mode hosted` (build:hosted) is a production build of the hosted web app.
  // A mode, not an inline `VITE_HOSTED=1 vite build`, so the script also runs
  // on Windows. Vite reads VITE_* from process.env after this function runs,
  // so the app sees import.meta.env.VITE_HOSTED === "1".
  if (mode === "hosted") process.env.VITE_HOSTED = "1";
  const env = loadEnv(mode === "hosted" ? "production" : mode, process.cwd(), "VITE_MTC_");
  if (command === "build") {
    const allowed: Record<string, string> = {
      VITE_MTC_API_URL: "https://api.mytowncart.com/api/v1/integrations",
      VITE_MTC_WEB_URL: "https://api.mytowncart.com",
    };
    for (const [key, value] of Object.entries(allowed)) {
      if (env[key] && env[key].replace(/\/+$/, "") !== value) {
        throw new Error(`${key} must target production in a release build`);
      }
    }
  }
  // Hosted web app (D2/D13): relative asset paths so it can live under any
  // sub-path (e.g. GitHub Pages /mytowncart-billing/app/), plus the PWA manifest.
  const hosted = process.env.VITE_HOSTED === "1";
  const hostedHtml = {
    name: "mtc-hosted-html",
    transformIndexHtml(html: string) {
      if (!hosted) return html;
      return html
        .replace('href="/brand/logo-mark.svg"', 'href="./brand/logo-mark.svg"')
        .replace(
          "</head>",
          '    <link rel="manifest" href="./manifest.webmanifest" />\n' +
            '    <meta name="theme-color" content="#2563eb" />\n' +
            '    <link rel="apple-touch-icon" href="./pwa/icon-256.png" />\n  </head>',
        );
    },
  };
  return {
  base: hosted ? "./" : "/",
  plugins: [react(), tailwindcss(), hostedHtml],
  // Tauri expects a fixed dev port.
  server: { port: 5173 },
  clearScreen: false,
  };
});
