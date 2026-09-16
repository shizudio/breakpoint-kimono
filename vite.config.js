import { defineConfig, loadEnv } from "vite";

/* The front end is its own app; the API is `npm run server`.
 *
 * VITE_SERVER_URL decides how they meet, and the two modes are not equivalent:
 *
 *   empty (default)  — Vite proxies /api and /admin to the API. The browser
 *                      only ever sees one origin, so the session cookie stays
 *                      SameSite=Lax and nothing needs CORS. Mirror this in
 *                      production with a reverse proxy and there is nothing
 *                      further to configure.
 *
 *   an absolute URL  — the browser talks to the API directly, cross-origin.
 *                      This needs three things to line up or sign-in silently
 *                      fails: ALLOWED_ORIGINS on the server must name this app's
 *                      origin, SECURE_COOKIES=1 must be set so the cookie is
 *                      SameSite=None; Secure, and both sides must be https in
 *                      production. Safari and Chrome both restrict third-party
 *                      cookies, so prefer the proxy where you can.
 */
export default defineConfig(function ({ mode }) {
  var env = loadEnv(mode, process.cwd(), "");
  var api = (env.VITE_SERVER_URL || "").trim();
  var proxyTarget = env.DEV_API_URL || "http://localhost:4321";

  return {
    root: "site",
    // Relative to root, so site/public/ — frames, photography, the vendored
    // web3 bundle. Vite copies these verbatim; it must not fingerprint them,
    // because the turntable builds its frame paths as strings at runtime.
    publicDir: "public",
    envDir: "..",
    build: {
      outDir: "../dist",
      emptyOutDir: true,
      assetsDir: "build"
    },
    server: {
      port: 5173,
      strictPort: false,
      // Only when same-origin: with VITE_SERVER_URL set, the app calls the API
      // directly and the proxy would be dead weight.
      proxy: api ? undefined : {
        "/api": { target: proxyTarget, changeOrigin: false },
        "/admin": { target: proxyTarget, changeOrigin: false }
      }
    },
    preview: {
      port: 4173,
      proxy: api ? undefined : {
        "/api": { target: proxyTarget, changeOrigin: false },
        "/admin": { target: proxyTarget, changeOrigin: false }
      }
    }
  };
});
