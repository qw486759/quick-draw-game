/**
 * config.js
 * Runtime configuration for the frontend.
 * Mounted on window.APP_CONFIG so all scripts can access it
 * regardless of load order.
 */
(function () {
  const origin = window.location.origin;

  window.APP_CONFIG = {
    SOCKET_URL: origin,
    API_BASE_URL: origin,
  };
})();