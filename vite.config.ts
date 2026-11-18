import { randomBytes } from "node:crypto";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

function developmentCsp(): Plugin {
  const nonce = randomBytes(18).toString("base64");
  return {
    name: "joi-development-csp",
    apply: "serve",
    config: () => ({ html: { cspNonce: nonce } }),
    transformIndexHtml: html => html
      .replace("script-src 'self';", `script-src 'self' 'nonce-${nonce}';`)
      .replace("connect-src 'self' http://127.0.0.1:*;", "connect-src 'self' http://127.0.0.1:* ws://127.0.0.1:*;"),
  };
}

export default defineConfig({
  base: "./",
  plugins: [react(), developmentCsp()],
  root: ".",
  build: {
    outDir: "dist/renderer",
    emptyOutDir: false,
    sourcemap: false,
  },
  server: {
    host: "127.0.0.1",
    port: Number(process.env.JOI_DEV_PORT ?? 43_715),
    proxy: {
      "/api": `http://127.0.0.1:${String(Number(process.env.JOI_DEV_API_PORT ?? 43_130))}`,
    },
    strictPort: true,
  },
});
