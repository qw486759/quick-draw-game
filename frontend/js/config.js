/**
 * config.js
 * Runtime configuration for the frontend.
 * In development, SOCKET_URL is empty so socket-client.js uses window.location.origin.
 * In production, set this to the Render backend URL.
 */
const APP_CONFIG = {
  SOCKET_URL: window.location.hostname === 'localhost'
    ? ''
    : 'https://quick-draw-game.onrender.com',
};