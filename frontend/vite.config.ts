import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    // Proxy so the dev server and the built app hit identical relative paths.
    // Without this, `fetch('/api/...')` works in production but 404s in dev,
    // and the difference tends to surface at the worst possible moment.
    proxy: {
      "/api": { target: "http://127.0.0.1:8000", changeOrigin: true },
      "/sse": {
        target: "http://127.0.0.1:8000",
        changeOrigin: true,
        // Buffering would defeat the point of an event stream.
        configure: (proxy) => {
          proxy.on("proxyRes", (proxyRes) => {
            proxyRes.headers["cache-control"] = "no-cache, no-transform";
          });
        },
      },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: true,
  },
});
