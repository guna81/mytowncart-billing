// SPDX-License-Identifier: Apache-2.0
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/build/**",
      "**/src-tauri/target/**",
      "**/src-tauri/gen/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts", "**/*.tsx"],
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  {
    // Boundary rule (roadmap §8.1): packages/core is pure TypeScript.
    // No react, no tauri, no DOM, no fs — enforced here and by its
    // tsconfig (lib: ES2022 only, no DOM types).
    files: ["packages/core/**/*.ts"],
    languageOptions: {
      globals: {},
    },
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["react", "react/*", "react-dom", "react-dom/*"],
              message: "packages/core must not import react.",
            },
            {
              group: ["@tauri-apps/*"],
              message: "packages/core must not import tauri.",
            },
            {
              group: ["fs", "node:*"],
              message: "packages/core must not import node builtins (fs etc.).",
            },
          ],
        },
      ],
    },
  },
);
