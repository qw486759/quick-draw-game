/**
 * room-manager.js
 *
 * Pure data layer for room state. Has no knowledge of sockets or HTTP.
 * Both server.js (Socket.io) and routes/rooms.js (REST) import from here.
 *
 * Room status lifecycle:
 *   waiting -> playing -> finished
 */

const { randomUUID } = require("crypto");

// In-memory store: { [roomId]: Room }
const rooms = {};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Generate a short 6-char room ID (good enough for in-memory use). */
function generateRoomId() {
  return randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase();
}

/** Return a safe public view of a room (strip internal timer refs). */
function publicRoom(room) {
  return {
    id: room.id,
    name: room.name,
    hostId: room.hostId,
    status: room.status,
    players: room.players.map((p) => ({
      id: p.id,
      name: p.name,
      score: p.score,
      connected: p.connected,
      ready: p.ready || false,
    })),
    maxPlayers: room.maxPlayers,
    currentRound: room.currentRound,
    totalRounds: room.totalRounds,
  };
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

/**
 * Create a new room.
 * @param {string} roomName   - Display name chosen by the host
 * @param {number} maxPlayers - 2–6
 * @param {string} hostSocketId
 * @param {string} hostName
 * @returns {object} The new room (public view)
 */
function createRoom(roomName, maxPlayers, hostSocketId, hostName) {
  const id = generateRoomId();

  rooms[id] = {
    id,
    name: roomName,
    hostId: hostSocketId,
    status: "waiting",
    players: [
      { id: hostSocketId, name: hostName, score: 0, connected: true, ready: false },
    ],
    maxPlayers: Math.min(6, Math.max(2, maxPlayers)), // clamp to [2, 6]
    currentRound: 0,
    totalRounds: 5,
    currentPrompt: null,
    roundTimer: null,
    submittedScores: {},
    updatedAt: Date.now(),
  };

  return publicRoom(rooms[id]);
}

/**
 * Add a player to an existing room.
 * @returns {{ ok: boolean, error?: string, room?: object }}
 */
function joinRoom(roomId, socketId, playerName) {
  const room = rooms[roomId];

  if (!room) return { ok: false, error: "Room not found." };
  if (room.status !== "waiting") return { ok: false, error: "Game already started." };
  if (room.players.length >= room.maxPlayers) return { ok: false, error: "Room is full." };

  // Prevent duplicate socket IDs (e.g. accidental double-join)
  if (room.players.find((p) => p.id === socketId)) {
    return { ok: true, room: publicRoom(room) }; // idempotent
  }

  // New players start as not ready; host is always considered ready
  room.players.push({ id: socketId, name: playerName, score: 0, connected: true, ready: false });
  return { ok: true, room: publicRoom(room) };
}

/**
 * Mark a player as disconnected (keep them in the list for reconnect UX).
 * If they were the host, promote the next connected player.
 * If no players remain connected, delete the room entirely.
 * @returns {{ deleted: boolean, room?: object }}
 */
function disconnectPlayer(socketId) {
  const room = findRoomByPlayer(socketId);
  if (!room) return { deleted: false };

  const player = room.players.find((p) => p.id === socketId);
  if (player) player.connected = false;
  room.updatedAt = Date.now();

  // Host promotion only applies in "waiting" state.
  // During "playing" or "finished", the disconnect is a page navigation —
  // the host will rejoin momentarily with a new socket id, so don't transfer.
  if (room.status === "waiting" && room.hostId === socketId) {
    const nextHost = room.players.find((p) => p.connected);
    if (nextHost) {
      room.hostId = nextHost.id;
    }
  }

  // Remove disconnected players entirely while room is still in "waiting"
  if (room.status === "waiting") {
    room.players = room.players.filter((p) => p.connected);
  }

  // Destroy empty rooms only when in "waiting" state.
  // During "playing": players disconnect temporarily for page navigation.
  // During "finished": players are viewing the end screen.
  // In both cases, keep the room alive.
  const connectedCount = room.players.filter((p) => p.connected).length;
  if (connectedCount === 0 && room.status === "waiting") {
    delete rooms[room.id];
    return { deleted: true };
  }

  return { deleted: false, room: publicRoom(room) };
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/** Return all rooms as a public list (for the lobby). */
function listRooms() {
  return Object.values(rooms).map(publicRoom);
}

/** Find a room by its ID. Returns null if not found. */
function getRoom(roomId) {
  return rooms[roomId] ? publicRoom(rooms[roomId]) : null;
}

/**
 * Find the raw (internal) room object that contains a given socket ID.
 * Used internally for mutations. Returns null if not found.
 */
function findRoomByPlayer(socketId) {
  return (
    Object.values(rooms).find((r) => r.players.some((p) => p.id === socketId)) ||
    null
  );
}

/**
 * Find the raw room containing a player by name (used for reconnect after page nav).
 * Returns the first match — player names should be unique within a room.
 */
function findRoomByPlayerName(playerName) {
  return (
    Object.values(rooms).find((r) => r.players.some((p) => p.name === playerName)) ||
    null
  );
}

/** Expose the raw room for server.js mutations (e.g. game start, timers). */
function getRawRoom(roomId) {
  return rooms[roomId] || null;
}

/**
 * Delete rooms that have been empty or finished for too long.
 * Called periodically by server.js to prevent memory accumulation.
 * @param {number} maxAgeMs - max milliseconds a dead room is kept (default 15 min)
 */
function cleanupRooms(maxAgeMs = 15 * 60 * 1000) {
  const now = Date.now();
  let count = 0;

  Object.values(rooms).forEach((room) => {
    const connectedCount = room.players.filter((p) => p.connected).length;
    const isEmpty    = connectedCount === 0;
    const isFinished = room.status === 'finished';
    const isStale    = room.updatedAt && (now - room.updatedAt) > maxAgeMs;

    if (isEmpty && isStale) {
      if (room.roundTimer) clearInterval(room.roundTimer);
      delete rooms[room.id];
      count++;
    } else if (isFinished && isStale) {
      if (room.roundTimer) clearInterval(room.roundTimer);
      delete rooms[room.id];
      count++;
    }
  });

  if (count > 0) {
    console.log(`[cleanup] Removed ${count} stale room(s)`);
  }
}

/**
 * Immediately delete a room by ID and clear its timer.
 * @param {string} roomId
 */
function deleteRoom(roomId) {
  const room = rooms[roomId];
  if (!room) return;
  if (room.roundTimer) clearInterval(room.roundTimer);
  delete rooms[roomId];
  console.log(`[room] Room ${roomId} deleted (all players gone)`);
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  createRoom,
  joinRoom,
  disconnectPlayer,
  listRooms,
  getRoom,
  findRoomByPlayer,
  findRoomByPlayerName,
  getRawRoom,
  publicRoom,
  cleanupRooms,
  deleteRoom,
};