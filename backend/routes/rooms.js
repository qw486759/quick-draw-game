/**
 * routes/rooms.js
 *
 * REST endpoints for the lobby:
 *   GET  /api/rooms        -> list all waiting/playing rooms
 *   POST /api/rooms        -> create a room (pre-socket, returns roomId for redirect)
 *
 * Note: actual *joining* happens over Socket.io (join_room event), not REST.
 * These endpoints are only for the lobby UI to display and navigate to rooms.
 */

const express = require("express");
const router = express.Router();
const roomManager = require("../room-manager");
const { randomUUID } = require("crypto");

// GET /api/rooms
// Returns only waiting/playing rooms — finished rooms are excluded from lobby.
router.get("/", (req, res) => {
  const allRooms = roomManager.listRooms();
  const visibleRooms = allRooms
    .filter((r) => r.status !== "finished")
    .map((r) => ({
      ...r,
      // Only count connected players for lobby display
      players: r.players.filter((p) => p.connected),
    }));
  res.json(visibleRooms);
});

// POST /api/rooms
// Body: { roomName: string, maxPlayers: number, hostName: string }
// This creates the room record. The host socket join happens separately
// when the client connects via Socket.io and emits join_room.
router.post("/", (req, res) => {
  const { roomName, maxPlayers, hostName } = req.body;

  if (!roomName || typeof roomName !== "string" || roomName.trim().length === 0) {
    return res.status(400).json({ error: "roomName is required." });
  }
  if (!hostName || typeof hostName !== "string" || hostName.trim().length === 0) {
    return res.status(400).json({ error: "hostName is required." });
  }

  const trimmedRoomName = roomName.trim();
  const trimmedHostName = hostName.trim();

  if (trimmedRoomName.length > 40) {
    return res.status(400).json({
      error: "roomName must be 40 characters or fewer.",
    });
  }

  if (trimmedHostName.length > 30) {
    return res.status(400).json({
      error: "hostName must be 30 characters or fewer.",
    });
  }

  const max = maxPlayers === undefined || maxPlayers === null || maxPlayers === ""
    ? 6
    : Number(maxPlayers);

  if (!Number.isInteger(max) || max < 2 || max > 6) {
    return res.status(400).json({
      error: "maxPlayers must be an integer from 2 to 6.",
    });
  }

  // We don't have a socket ID yet at REST time.
  // Pass a placeholder; server.js will update hostId when socket connects.
  const hostToken = randomUUID();

  const room = roomManager.createRoom(
    trimmedRoomName,
    max,
    "pending",
    trimmedHostName,
    hostToken
  );

  res.status(201).json({ roomId: room.id, hostToken, room });
});

module.exports = router;