import eslint from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      // Agent worktrees are whole copies of this repository, checked out under .claude so a
      // delegated task can work in isolation. Linting them reports another branch's in-progress
      // state against this checkout's rules, which is noise on every run.
      ".claude/worktrees/**",
      "coverage/**",
      "apps/joi_mobile/build/**",
      "dist/**",
      "node_modules/**",
      "playwright-report/**",
      "release/**",
      "release-joi*/**",
      "test-results/**",
      "tmp/**",
      "temp/**",
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked.map((config) => ({
    ...config,
    files: ["**/*.{ts,tsx,cts}"],
  })),
  ...tseslint.configs.stylisticTypeChecked.map((config) => ({
    ...config,
    files: ["**/*.{ts,tsx,cts}"],
  })),
  {
    files: ["**/*.{ts,tsx,cts}"],
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ["*.config.ts"],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": ["error", { "fixStyle": "inline-type-imports" }],
      "@typescript-eslint/no-confusing-void-expression": "off",
      "@typescript-eslint/no-unused-vars": ["error", { "argsIgnorePattern": "^_" }],
    },
  },
  {
    files: ["src/renderer/**/*.{ts,tsx}"],
    languageOptions: { globals: globals.browser },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "react-refresh/only-export-components": ["warn", { "allowConstantExport": true }],
    },
  },
  {
    files: ["src/main/**/*.ts", "src/preload/**/*.cts", "tests/**/*.{ts,tsx}"],
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.vitest,
      },
    },
  },
  {
    files: ["scripts/**/*.mjs", "*.config.{js,mjs}"],
    languageOptions: { globals: globals.node },
  },
);
