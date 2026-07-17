import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// The live backend. Dev fetches are relative (client base = '' by default), so the
// dev server proxies the two API path prefixes to this origin — the same paths that
// CloudFront forwards to the HTTP API in production (/sessions*, /state/*). Override
// with VITE_PROXY_TARGET when pointing dev at a different stack.
const PROXY_TARGET =
  process.env.VITE_PROXY_TARGET ?? 'https://6iw72nh7nk.execute-api.us-east-1.amazonaws.com';

// Repo root — the frontend imports pure domain types from the sibling backend
// workspace, which lives outside frontend/, so the dev server must be allowed to
// read it.
const repoRoot = fileURLToPath(new URL('..', import.meta.url));

// Shared by `vite dev` and `vite preview` so the built SPA can also be smoke-tested
// same-origin against the live API (mirrors CloudFront's /sessions* and /state/* behaviors).
const apiProxy = {
  '/sessions': { target: PROXY_TARGET, changeOrigin: true, secure: true },
  '/state': { target: PROXY_TARGET, changeOrigin: true, secure: true },
};

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      // Shared, frontend-safe domain barrel (pure TS — no node/aws). Points straight
      // at the barrel file so `import ... from '@domain'` resolves for Vite and tsc.
      '@domain': fileURLToPath(new URL('../backend/src/domain/index.ts', import.meta.url)),
      // Shipped game data (JSON) shared with the backend — e.g. `@data/conditions.json`.
      '@data': fileURLToPath(new URL('../data', import.meta.url)),
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    fs: {
      // Allow serving the sibling backend/src/domain sources during dev.
      allow: [repoRoot],
    },
    proxy: apiProxy,
  },
  preview: {
    proxy: apiProxy,
  },
});
