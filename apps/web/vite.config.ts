// SPDX-License-Identifier: Apache-2.0
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Tauri expects a fixed dev port.
  server: { port: 5173, strictPort: true },
  clearScreen: false,
});
