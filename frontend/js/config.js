/**
 * config.js
 * Runtime configuration for the frontend.
 * Mounted on window.APP_CONFIG so all scripts can access it
 * regardless of load order.
 */
window.APP_CONFIG = {
  SOCKET_URL: window.location.hostname === 'localhost'
    ? ''
    : 'https://quick-draw-game.onrender.com',
  API_BASE_URL: window.location.hostname === 'localhost'
    ? ''
    : 'https://quick-draw-game.onrender.com',
};