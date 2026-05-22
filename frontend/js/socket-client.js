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
  // Socket.io client is loaded via <script> tag (/socket.io/socket.io.js).
  // `io` is the global function it exposes.

  let socket = null;

  /**
   * Connect to the server (idempotent — safe to call multiple times).
   * If a connected socket already exists, returns it without reconnecting.
   * @param {string} [serverUrl] - Defaults to the current origin (same host).
   * @returns {Socket}
   */
  function connect(serverUrl = window.location.origin) {
    if (socket && socket.connected) return socket;

    socket = io(serverUrl, {
      // Reconnect automatically if the connection drops
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
   * Use this to access socket.emit() and socket.on() directly.
   * @returns {Socket|null}
   */
  function getSocket() {
    return socket;
  }

  return { connect, getSocket };
})();