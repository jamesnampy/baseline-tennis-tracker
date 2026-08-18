import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";
import { defineConfig, loadEnv, type Plugin } from "vite";

/**
 * The former app/layout.tsx built absolute social-image URLs per request from
 * the Host header. A static SPA has no request context, so the origin is baked
 * in at build time instead. Unset means a relative URL.
 */
function publicOrigin(origin: string): Plugin {
  return {
    name: "baseline-public-origin",
    transformIndexHtml(html) {
      return html.replaceAll("__PUBLIC_ORIGIN__", origin.replace(/\/$/, ""));
    },
  };
}

export default defineConfig(({ mode }) => {
  // loadEnv, not process.env: Vite does not copy .env files into process.env,
  // and scripts/deploy.mjs records the discovered origin in .env.production.
  // An explicit environment variable still wins.
  const env = loadEnv(mode, process.cwd(), "VITE_");
  return {
    plugins: [
      react(),
      publicOrigin(process.env.VITE_PUBLIC_ORIGIN ?? env.VITE_PUBLIC_ORIGIN ?? ""),
      cloudflare(),
    ],
    resolve: {
      alias: {
        "@": fileURLToPath(new URL("./", import.meta.url)),
      },
    },
  };
});
