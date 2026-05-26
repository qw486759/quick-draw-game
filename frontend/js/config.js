/**
 * config.js
 * Runtime configuration for the frontend.
 *
 * Deployment modes:
 *   1. Local development
 *      - Frontend and backend are served from localhost:3000.
 *
 *   2. Hosted public demo
 *      - Frontend is served from Vercel.
 *      - Backend runs on Render.
 *
 *   3. AWS ECS Fargate demo
 *      - Frontend and backend are served from the same ALB origin.
 *
 * This file intentionally avoids build-time environment variables because
 * the project uses vanilla JavaScript without a bundler.
 */
(function () {
  const hostname = window.location.hostname;
  const origin = window.location.origin;

  const HOSTED_BACKEND_URL = "https://quick-draw-game.onrender.com";

  const isLocalhost =
    hostname === "localhost" ||
    hostname === "127.0.0.1";

  const isVercel =
    hostname === "quick-draw-game.vercel.app" ||
    hostname.endsWith(".vercel.app");

  const backendOrigin = isLocalhost
    ? "http://localhost:3000"
    : isVercel
      ? HOSTED_BACKEND_URL
      : origin;

  window.APP_CONFIG = {
    SOCKET_URL: backendOrigin,
    API_BASE_URL: backendOrigin,
  };
})();