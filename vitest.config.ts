import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "node",
    globals: true,
    setupFiles: ["tests/setup.ts"],
    include: ["tests/**/*.test.{ts,tsx}"],
    exclude: ["tests/e2e/**"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary", "html"],
      include: [
        "src/main/domain/**/*.ts",
        "src/main/application/**/*.ts",
        "src/shared/**/*.ts",
        "src/renderer/**/*.{ts,tsx}"
      ],
      exclude: ["src/renderer/main.tsx", "src/renderer/vite-env.d.ts"],
      thresholds: {
        statements: 90,
        branches: 90,
        functions: 90,
        lines: 90
      }
    },
  },
});
