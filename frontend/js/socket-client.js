/**
 * socket-client.js
 *
 * Singleton wrapper around Socket.io client.
 * Import this file in any page that needs real-time communication.
 *
 * Usage (direct socket access — used by room.html):
 *   const socket = SocketClient.connect();
 *   socket.emit("join_room", { roomId, playerName });
 *   socket.on("room_update", ({ players }) => { ... });
 *
 * Usage (convenience wrappers — used by game-multi.js):
 *   SocketClient.connect();
 *   SocketClient.getSocket().emit("join_room", { ... });
 *   SocketClient.getSocket().on("new_round", (data) => { ... });
 */

const SocketClient = (() => {
  let socket = null;

  /**
   * Reads the backend URL from window.APP_CONFIG.
   * Falls back to window.location.origin if config is missing or SOCKET_URL
   * is empty (which is correct for local dev — same-origin connection).
   * @returns {string}
   */
  function getDefaultSocketUrl() {
    const config = window.APP_CONFIG || {};
    return config.SOCKET_URL || window.location.origin;
  }

  /**
   * Connect to the server (idempotent — safe to call multiple times).
   * If a connected socket already exists, returns it without reconnecting.
   * @param {string} [serverUrl] - Defaults to getDefaultSocketUrl().
   * @returns {Socket}
   */
  function connect(serverUrl = getDefaultSocketUrl()) {
    if (socket && socket.connected) return socket;

    socket = io(serverUrl, {
      reconnection: true,
      reconnectionAttempts: 5,
      reconnectionDelay: 1000,
    });

    socket.on("connect", () => {
      console.log(`[socket] connected: ${socket.id}`);
    });

    socket.on("disconnect", (reason) => {
      console.warn(`[socket] disconnected: ${reason}`);
    });

    socket.on("connect_error", (err) => {
      console.error(`[socket] connection error: ${err.message}`);
    });

    return socket;
  }

  /**
   * Return the active socket instance (or null if not connected yet).
   * @returns {Socket|null}
   */
  function getSocket() {
    return socket;
  }

  return { connect, getSocket };
})();