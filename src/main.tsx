import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import { shareTokenFromPath } from "@/lib/tennis/live";
import Live from "./Live.tsx";
import "./globals.css";

const container = document.getElementById("root");
if (!container) throw new Error("Root container #root is missing from index.html.");

/**
 * `/live/<token>` is the read-only spectator view; every other path is the
 * tracker. The SPA fallback in wrangler.jsonc serves index.html for both, so
 * this is the whole router — the tracker has no navigation of its own.
 */
const shareToken = shareTokenFromPath(window.location.pathname);

createRoot(container).render(
  <StrictMode>
    {shareToken ? <Live token={shareToken} /> : <App />}
  </StrictMode>,
);
