import { fileURLToPath, URL } from 'node:url';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Repo root — the frontend imports pure domain types from the sibling backend
// workspace, which lives outside frontend/, so the dev server must be allowed to
// read it.
const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const frontendDir = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig(({ command, mode }) => {
  // Dev fetches are relative (client base = '' by default), so the dev server
  // proxies the two API path prefixes — the same ones CloudFront forwards to the
  // HTTP API in production (/sessions*, /state/*) — to a deployed backend. There is
  // no local backend emulator: point VITE_PROXY_TARGET at your stack's API origin
  // (the CDK deploy prints it), via the environment or frontend/.env.local.
  const PROXY_TARGET =
    process.env.VITE_PROXY_TARGET ?? loadEnv(mode, frontendDir).VITE_PROXY_TARGET ?? '';

  if (!PROXY_TARGET && command === 'serve') {
    console.warn(
      '[vite.config] VITE_PROXY_TARGET is not set — /sessions and /state requests will not be ' +
        'proxied to an API. Put VITE_PROXY_TARGET=https://<api-id>.execute-api.<region>.amazonaws.com ' +
        "in frontend/.env.local (see README “Local development”).",
    );
  }

  // Shared by `vite dev` and `vite preview` so the built SPA can also be smoke-tested
  // same-origin against a live API (mirrors CloudFront's /sessions* and /state/* behaviors).
  const apiProxy = PROXY_TARGET
    ? {
        '/sessions': { target: PROXY_TARGET, changeOrigin: true, secure: true },
        '/state': { target: PROXY_TARGET, changeOrigin: true, secure: true },
      }
    : undefined;

  return {
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
  };
});
