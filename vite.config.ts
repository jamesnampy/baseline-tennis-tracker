import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";
import { defineConfig, type Plugin } from "vite";

/**
 * The former app/layout.tsx built absolute social-image URLs per request from
 * the Host header. A static SPA has no request context, so the origin is baked
 * in at build time instead. Unset means a relative URL.
 */
function publicOrigin(): Plugin {
  return {
    name: "baseline-public-origin",
    transformIndexHtml(html) {
      const origin = (process.env.VITE_PUBLIC_ORIGIN ?? "").replace(/\/$/, "");
      return html.replaceAll("__PUBLIC_ORIGIN__", origin);
    },
  };
}

export default defineConfig({
  plugins: [react(), publicOrigin(), cloudflare()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./", import.meta.url)),
    },
  },
});
