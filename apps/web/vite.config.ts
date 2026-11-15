// SPDX-License-Identifier: Apache-2.0
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ command, mode }) => {
  const env = loadEnv(mode, process.cwd(), "VITE_MTC_");
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
  return {
  plugins: [react(), tailwindcss()],
  // Tauri expects a fixed dev port.
  server: { port: 5173 },
  clearScreen: false,
  };
});
