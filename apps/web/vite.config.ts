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
  // path (it is served at the root of billing.mytowncart.com), plus the PWA manifest.
  // Old links to the landing page's sections (e.g. /#download, opened by
  // released desktop builds) now land on the app, so send those to /download/.
  // App routes use "#/…", so these plain anchors never clash with them.
  const hosted = process.env.VITE_HOSTED === "1";
  const hostedHtml = {
    name: "mtc-hosted-html",
    transformIndexHtml(html: string) {
      if (!hosted) return html;
      return html
        .replace('href="/brand/logo-mark.svg"', 'href="./brand/logo-mark.svg"')
        .replace(
          "<title>",
          "<script>if (/^#(download|features|improvements|start|privacy|faq)$/.test(location.hash)) " +
            'location.replace("download/" + location.hash);</script>\n    ' +
            '<link rel="canonical" href="https://billing.mytowncart.com/" />\n    ' +
            '<meta name="description" content="Free GST billing and POS for local shops, in your browser. ' +
            'Sign in with your MyTownCart seller account; bills are backed up, encrypted, automatically." />\n    ' +
            '<meta property="og:site_name" content="MyTownCart Billing" />\n    ' +
            '<meta property="og:type" content="website" />\n    ' +
            '<meta property="og:title" content="MyTownCart Billing — Free GST billing &amp; POS in your browser" />\n    ' +
            '<meta property="og:description" content="Free GST billing and POS for local shops, in your browser. ' +
            'Sign in with your MyTownCart seller account; bills are backed up, encrypted, automatically." />\n    ' +
            '<meta property="og:url" content="https://billing.mytowncart.com/" />\n    ' +
            '<meta property="og:locale" content="en_IN" />\n    ' +
            '<meta property="og:image" content="https://billing.mytowncart.com/screenshots/og.png" />\n    ' +
            '<meta property="og:image:width" content="1200" />\n    ' +
            '<meta property="og:image:height" content="630" />\n    ' +
            '<meta name="twitter:card" content="summary_large_image" />\n    ' +
            '<meta name="twitter:title" content="MyTownCart Billing — Free GST billing &amp; POS in your browser" />\n    ' +
            '<meta name="twitter:description" content="Free GST billing and POS for local shops, in your browser." />\n    ' +
            '<meta name="twitter:image" content="https://billing.mytowncart.com/screenshots/og.png" />\n    <title>',
        )
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
