/**
 * config.js
 * Runtime configuration for the frontend.
 * In development, SOCKET_URL is empty so socket-client.js uses window.location.origin.
 * In production, set this to the Render backend URL.
 */
const APP_CONFIG = {
  SOCKET_URL: '',  // e.g. 'https://your-app.onrender.com'
};