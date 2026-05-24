/**
 * server.js
 *
 * Entry point for the Quick Draw backend.
 * Responsibilities:
 *   - Serve the frontend as static files
 *   - Expose REST API under /api
 *   - Handle Socket.io connections for real-time lobby + game sync
 *
 * Run with: npm run dev   (i.e. node backend/server.js)
 */

const path = require("path");
const http = require("http");
const express = require("express");
const { Server } = require("socket.io");
const roomManager = require("./room-manager");
const roomsRouter = require("./routes/rooms");

// ---------------------------------------------------------------------------
// CORS config — shared between REST and Socket.io
// ---------------------------------------------------------------------------
const allowedOrigins = [
  'http://localhost:3000',
  'https://quick-draw-game.vercel.app',
];

// ---------------------------------------------------------------------------
// Payload validation helpers
// ---------------------------------------------------------------------------

/**
 * Returns true if value is a plain object (not null, not array).
 * Used to safely validate Socket.io event payloads before destructuring.
 */
function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Safely extracts a trimmed string from a payload field.
 * Returns empty string if the field is missing or not a string.
 */
function readString(value, maxLen = 80) {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, maxLen);
}

// ---------------------------------------------------------------------------
// Game constants
// ---------------------------------------------------------------------------

// Load categories from the single source of truth shared with the frontend.
// modelCategories order must match the CNN training order exactly.
const categoriesPath = require("path").join(
  __dirname, "../frontend/assets/words/categories.json"
);
const categoriesData = require(categoriesPath);
const CATEGORIES = categoriesData.modelCategories;

/** Duration of each drawing round in seconds. */
const ROUND_DURATION = 30;

// ---------------------------------------------------------------------------
// In-memory leaderboard (survives game restarts, cleared on server restart)
// Top entries are keyed by playerName — last game score updates their entry.
// ---------------------------------------------------------------------------

/**
 * @type {Array<{playerName: string, score: number, date: string}>}
 */
const leaderboard = [];
const LEADERBOARD_MAX = 20; // keep top 20 so we have buffer for the top-5 query

/**
 * Submit a player's final score to the leaderboard.
 * If the player already has an entry, only update if the new score is higher.
 */
function submitToLeaderboard(playerName, score) {
  const existing = leaderboard.find((e) => e.playerName === playerName);
  if (existing) {
    if (score > existing.score) {
      existing.score = score;
      existing.date  = new Date().toISOString().slice(0, 10);
    }
  } else {
    leaderboard.push({
      playerName,
      score,
      date: new Date().toISOString().slice(0, 10),
    });
  }
  // Keep sorted, trim to max
  leaderboard.sort((a, b) => b.score - a.score);
  if (leaderboard.length > LEADERBOARD_MAX) leaderboard.length = LEADERBOARD_MAX;
}

/** Number of rounds per game. */
const TOTAL_ROUNDS = 5;

/** Seconds to wait between round_end broadcast and the next new_round. */
const BETWEEN_ROUND_DELAY = 4000; // ms

// ---------------------------------------------------------------------------
// Express + HTTP server
// ---------------------------------------------------------------------------

const app = express();
const server = http.createServer(app);

// Parse JSON bodies for REST endpoints
const cors = require('cors');
app.use(cors({
  origin: allowedOrigins,
  methods: ['GET', 'POST'],
}));
app.use(express.json());

// Serve the entire frontend/ folder as static files.
// Path: backend/server.js -> ../frontend
app.use(express.static(path.join(__dirname, "../frontend")));

// REST routes
app.use("/api/rooms", roomsRouter);

// Leaderboard REST endpoint — returns top 5
app.get("/api/leaderboard", (req, res) => {
  res.json(leaderboard.slice(0, 5));
});

// Fallback: any unknown route serves index.html (SPA-friendly)
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "../frontend/index.html"));
});

// ---------------------------------------------------------------------------
// Socket.io
// ---------------------------------------------------------------------------

const io = new Server(server, {
  cors: {
    origin: allowedOrigins,
    methods: ['GET', 'POST'],
  },
});

io.on("connection", (socket) => {
  console.log(`[socket] connected: ${socket.id}`);

  // ------------------------------------------------------------------
  // join_room
  // Emitted by a client when they enter a room page.
  // Payload: { roomId: string, playerName: string }
  // ------------------------------------------------------------------
  socket.on("join_room", (payload) => {
    if (!isObject(payload)) {
      socket.emit("join_error", { error: "Invalid payload." });
      return;
    }

    const roomId     = readString(payload.roomId, 12).toUpperCase();
    const playerName = readString(payload.playerName, 30);

    if (!roomId || !playerName) {
      socket.emit("join_error", { error: "roomId and playerName are required." });
      return;
    }

    const rawRoom = roomManager.getRawRoom(roomId);

    // -- Rejoin during active game ------------------------------------------
    // When game-multi.html loads it emits join_room to resubscribe to the
    // Socket.io channel. The room is already "playing" at this point, so skip
    // the normal joinRoom() check and just re-add the socket to the channel.
    if (rawRoom && (rawRoom.status === "playing" || rawRoom.status === "finished")) {
      const existingPlayer = rawRoom.players.find((p) => p.name === playerName);
      if (existingPlayer) {
        const oldSocketId = existingPlayer.id; // capture BEFORE overwriting

        // Update socket id (changed after page navigation) and mark connected
        existingPlayer.id = socket.id;
        existingPlayer.connected = true;

        // If this player was the host, sync hostId to the new socket id.
        // Must compare against oldSocketId, not existingPlayer.id (already updated above).
        if (rawRoom.hostId === oldSocketId) {
          rawRoom.hostId = socket.id;
        }

        socket.join(roomId);
        socket.emit("join_success", { room: roomManager.publicRoom(rawRoom) });

        // If the game is already finished, replay the game_end event so the
        // client can show the results overlay immediately without waiting.
        if (rawRoom.status === "finished" && rawRoom.lastGameEnd) {
          socket.emit("game_end", rawRoom.lastGameEnd);
        }

        console.log(`[room] ${playerName} (${socket.id}) rejoined ${rawRoom.status} room ${roomId}`);
        return;
      }
      socket.emit("join_error", { error: "Game already in progress." });
      return;
    }

    // -- Normal join (room is "waiting") ------------------------------------
    // If the room was created via REST, its hostId is "pending".
    // Only the player who carries the correct hostToken can claim host.
    if (rawRoom && rawRoom.hostId === "pending") {
      const hostToken = readString(payload.hostToken, 40);

      if (hostToken && hostToken === rawRoom.hostToken) {
        // Verified host — assign socket as host
        rawRoom.hostId = socket.id;
        const placeholder = rawRoom.players.find((p) => p.id === "pending");
        if (placeholder) placeholder.id = socket.id;
      } else {
        // Wrong or missing token — reject
        socket.emit("join_error", { error: "Host has not joined yet. Please try again." });
        return;
      }
    }

    const result = roomManager.joinRoom(roomId, socket.id, playerName);

    if (!result.ok) {
      socket.emit("join_error", { error: result.error });
      return;
    }

    socket.join(roomId);
    socket.emit("join_success", { room: result.room });
    socket.to(roomId).emit("room_update", { players: result.room.players, hostId: result.room.hostId });
    roomManager.touchRoom(roomId);

    console.log(`[room] ${playerName} (${socket.id}) joined ${roomId}`);
  });

  // ------------------------------------------------------------------
  // leave_room
  // Emitted when a player explicitly clicks "Leave Room".
  // Payload: { roomId: string }
  // ------------------------------------------------------------------
  socket.on("leave_room", (payload) => {
    if (!isObject(payload)) return;
    const roomId = readString(payload.roomId, 12).toUpperCase();
    if (!roomId) return;
    handlePlayerLeave(socket, roomId, "explicit");
  });

  // ------------------------------------------------------------------
  // disconnect
  // Fired automatically by Socket.io when the connection drops.
  // ------------------------------------------------------------------
  socket.on("disconnect", () => {
    console.log(`[socket] disconnected: ${socket.id}`);
    handlePlayerLeave(socket, null, "disconnect");
  });

  // ------------------------------------------------------------------
  // start_game
  // Only the host can emit this. Validates the room, then kicks off
  // the server-side game loop for all players.
  // Payload: { roomId: string }
  // ------------------------------------------------------------------
  socket.on("start_game", (payload) => {
    if (!isObject(payload)) return;
    const roomId = readString(payload.roomId, 12).toUpperCase();
    if (!roomId) return;
    const room = roomManager.getRawRoom(roomId);
    if (!room) return;

    // Guard: only the host can start
    if (room.hostId !== socket.id) {
      socket.emit("start_error", { error: "Only the host can start the game." });
      return;
    }

    // Guard: need at least 2 connected players
    const connectedPlayers = room.players.filter((p) => p.connected);
    if (connectedPlayers.length < 2) {
      socket.emit("start_error", { error: "Need at least 2 players to start." });
      return;
    }

    // Guard: don't start if already playing
    if (room.status === "playing") {
      socket.emit("start_error", { error: "Game already in progress." });
      return;
    }

    // Guard: all non-host players must be ready
    const nonHostPlayers = connectedPlayers.filter((p) => p.id !== room.hostId);
    const allReady = nonHostPlayers.length > 0 && nonHostPlayers.every((p) => p.ready);
    if (!allReady) {
      socket.emit("start_error", { error: "Waiting for all players to ready up." });
      return;
    }

    // Transition room to playing state
    room.status = "playing";
    room.currentRound = 0;

    // Reset all player scores, ready flags, and used prompts for a fresh game
    room.players.forEach((p) => { p.score = 0; p.ready = false; });
    room.usedPrompts = [];

    console.log(`[game] Game starting in room ${roomId}`);

    // Tell all clients to navigate to the game screen.
    // The client uses this event to redirect from room.html → game-multi.html.
    io.to(roomId).emit("game_start", {
      totalRounds: TOTAL_ROUNDS,
      roundDuration: ROUND_DURATION,
    });
    roomManager.touchRoom(roomId);

    // Small delay so clients can finish their page transition before
    // the first new_round fires.
    setTimeout(() => startRound(roomId), 5000);
  });

  // ------------------------------------------------------------------
  // player_ready
  // Non-host players toggle their ready state.
  // Server broadcasts updated room so host's Start button can enable/disable.
  // Payload: { roomId: string }
  // ------------------------------------------------------------------
  socket.on("player_ready", (payload) => {
    if (!isObject(payload)) return;
    const roomId = readString(payload.roomId, 12).toUpperCase();
    if (!roomId) return;

    const room = roomManager.getRawRoom(roomId);
    if (!room || room.status !== "waiting") return;

    const player = room.players.find((p) => p.id === socket.id);
    if (!player || player.id === room.hostId) return; // host has no ready state

    player.ready = !player.ready; // toggle

    const pub = roomManager.publicRoom(room);
    // Broadcast to everyone so all clients see updated ready indicators
    io.to(roomId).emit("room_update", { players: pub.players, hostId: pub.hostId });
    roomManager.touchRoom(roomId);

    console.log(`[room] ${player.name} is ${player.ready ? "ready" : "not ready"} in ${roomId}`);
  });

  // ------------------------------------------------------------------
  // submit_score
  // Players send this whenever their AI confidence updates (or at round
  // end). The server stores the latest value and uses it when the timer
  // expires. Sending multiple times is fine — last write wins.
  // Payload: { roomId: string, score: number, topLabel: string, confidence: number }
  // ------------------------------------------------------------------
  socket.on("submit_score", (payload) => {
    if (!isObject(payload)) return;
    const roomId     = readString(payload.roomId, 12).toUpperCase();
    const topLabel   = readString(payload.topLabel, 40);
    const confidence = typeof payload.confidence === 'number'
      ? Math.max(0, Math.min(1, payload.confidence))
      : 0;
    const drawing    = typeof payload.drawing === 'string'
      ? payload.drawing.slice(0, 50000)
      : null;
    if (!roomId) return;

    const room = roomManager.getRawRoom(roomId);
    if (!room || room.status !== "playing") return;

    // Store the latest score + drawing for this player (last write wins)
    // Calculate score server-side to prevent client score manipulation.
    // Only award points if the top label matches the current prompt.
    const score = topLabel === room.currentPrompt
      ? Math.round(confidence * 1000)
      : 0;

    room.submittedScores[socket.id] = {
      score,
      topLabel,
      confidence,
      drawing,
    };
    roomManager.touchRoom(roomId);
  });

  // ------------------------------------------------------------------
  // restart_game
  // Host can restart after game_end — resets scores and starts fresh.
  // Payload: { roomId: string }
  // ------------------------------------------------------------------
  socket.on("restart_game", (payload) => {
    if (!isObject(payload)) return;
    const roomId = readString(payload.roomId, 12).toUpperCase();
    if (!roomId) return;

    const room = roomManager.getRawRoom(roomId);
    if (!room) return;
    if (room.hostId !== socket.id) {
      socket.emit("start_error", { error: "Only the host can restart." });
      return;
    }
    if (room.status !== "finished") return;

    // Reset room back to "waiting" so players can ready up again.
    // We do NOT go straight to "playing" — the Ready system must run first.
    room.status = "waiting";
    room.currentRound = 0;
    room.currentPrompt = null;
    room.submittedScores = {};
    room.roundHistory = [];
    room.lastGameEnd = null;
    room.players.forEach((p) => { p.score = 0; p.ready = false; });
    room.usedPrompts = [];

    console.log(`[room] Room ${roomId} reset to waiting by host`);

    // Broadcast the updated room so all clients re-render the lobby UI
    io.to(roomId).emit("room_reset", {
      room: roomManager.publicRoom(room),
    });
    roomManager.touchRoom(roomId);
  });
});

// ---------------------------------------------------------------------------
// Game loop helpers
// ---------------------------------------------------------------------------

/**
 * Pick a random category that hasn't been used this game yet.
 * Falls back to a full shuffle if somehow all categories are exhausted.
 * @param {string[]} usedPrompts - prompts already used this game
 * @returns {string}
 */
function pickPrompt(usedPrompts) {
  const available = CATEGORIES.filter((c) => !usedPrompts.includes(c));
  // Fallback: if we've somehow used every category, reset (shouldn't happen for 5 rounds)
  const pool = available.length > 0 ? available : CATEGORIES;
  return pool[Math.floor(Math.random() * pool.length)];
}

/**
 * Start a new round: increment round counter, broadcast new_round,
 * clear submitted scores, and kick off the countdown timer.
 * @param {string} roomId
 */
function startRound(roomId) {
  const room = roomManager.getRawRoom(roomId);
  if (!room || room.status !== "playing") return;

  // Advance round counter
  room.currentRound += 1;

  // Pick a prompt not yet used this game
  if (!room.usedPrompts) room.usedPrompts = [];
  room.currentPrompt = pickPrompt(room.usedPrompts);
  room.usedPrompts.push(room.currentPrompt);

  // Clear scores from the previous round
  room.submittedScores = {};

  // Initialize round history array if it doesn't exist yet
  if (!room.roundHistory) room.roundHistory = [];

  console.log(
    `[game] Room ${roomId} — Round ${room.currentRound}/${TOTAL_ROUNDS}: "${room.currentPrompt}"`
  );

  // Broadcast the new round info to all players in the room
  io.to(roomId).emit("new_round", {
    prompt: room.currentPrompt,
    roundNumber: room.currentRound,
    totalRounds: TOTAL_ROUNDS,
  });

  // Start the server-side countdown
  startRoundTimer(roomId, ROUND_DURATION);
}

/**
 * Run a countdown timer for the current round.
 * Broadcasts timer_sync every second, then calls endRound() at zero.
 * @param {string} roomId
 * @param {number} duration  - seconds
 */
function startRoundTimer(roomId, duration) {
  const room = roomManager.getRawRoom(roomId);
  if (!room) return;

  // Clear any stale timer from a previous round (safety net)
  if (room.roundTimer) {
    clearInterval(room.roundTimer);
    room.roundTimer = null;
  }

  let timeLeft = duration;

  room.roundTimer = setInterval(() => {
    timeLeft -= 1;

    // Broadcast remaining time so all clients stay in sync
    io.to(roomId).emit("timer_sync", { timeLeft });

    if (timeLeft <= 0) {
      clearInterval(room.roundTimer);
      room.roundTimer = null;
      endRound(roomId);
    }
  }, 1000);
}

/**
 * End the current round:
 *   1. Collect all submitted scores (fill in 0 for players who didn't submit)
 *   2. Apply rank bonuses (+200 / +100 / +50)
 *   3. Add round scores to cumulative player totals
 *   4. Broadcast round_end with the ranking
 *   5. After a short delay, either start the next round or end the game
 * @param {string} roomId
 */
function endRound(roomId) {
  const room = roomManager.getRawRoom(roomId);
  if (!room) return;

  // Build this round's score list — one entry per connected player
  const roundScores = room.players
    .filter((p) => p.connected)
    .map((p) => {
      const submission = room.submittedScores[p.id] || {
        score: 0,
        topLabel: "",
        confidence: 0,
      };
      return {
        playerId:   p.id,
        playerName: p.name,
        roundScore: submission.score,
        topLabel:   submission.topLabel,
        confidence: submission.confidence,
        drawing:    submission.drawing || null,
      };
    });

  // Sort descending by roundScore to determine rank
  roundScores.sort((a, b) => b.roundScore - a.roundScore);

  // Apply rank bonuses (only to the top 3)
  const RANK_BONUSES = [200, 100, 50];
  roundScores.forEach((entry, index) => {
    const bonus = RANK_BONUSES[index] ?? 0;
    entry.rankBonus = bonus;
    entry.totalRoundScore = entry.roundScore + bonus;
  });

  // Add this round's total to each player's cumulative score
  roundScores.forEach((entry) => {
    const player = room.players.find((p) => p.id === entry.playerId);
    if (player) {
      player.score += entry.totalRoundScore;
    }
    // Attach cumulative score to the entry so the client can display it
    entry.cumulativeScore = room.players.find((p) => p.id === entry.playerId)?.score ?? 0;
  });

  console.log(
    `[game] Room ${roomId} — Round ${room.currentRound} ended. Scores:`,
    roundScores.map((e) => `${e.playerName}: ${e.totalRoundScore}`).join(", ")
  );

  // Save round result to history so game_end can include it
  if (!room.roundHistory) room.roundHistory = [];
  room.roundHistory.push({
    roundNumber: room.currentRound,
    prompt:      room.currentPrompt,
    scores:      roundScores,
  });

  // Broadcast round results to all players
  io.to(roomId).emit("round_end", {
    roundNumber: room.currentRound,
    scores:      roundScores,
    prompt:      room.currentPrompt,
  });
  roomManager.touchRoom(roomId);

  // Decide what happens next
  if (room.currentRound >= TOTAL_ROUNDS) {
    // All rounds done — end the game after a short viewing delay
    setTimeout(() => endGame(roomId), BETWEEN_ROUND_DELAY);
  } else {
    // Start next round after players have had time to see the results
    setTimeout(() => startRound(roomId), BETWEEN_ROUND_DELAY);
  }
}

/**
 * End the entire game: compute final rankings and broadcast game_end.
 * Resets the room to "finished" so it can be restarted if needed.
 * @param {string} roomId
 */
function endGame(roomId) {
  const room = roomManager.getRawRoom(roomId);
  if (!room) return;

  room.status = "finished";

  // Build final ranking sorted by cumulative score (descending)
  const finalRanking = room.players
    .map((p) => ({ playerName: p.name, score: p.score }))
    .sort((a, b) => b.score - a.score)
    .map((entry, index) => ({ ...entry, rank: index + 1 }));

  // Update global leaderboard with each player's score
  room.players.forEach((p) => submitToLeaderboard(p.name, p.score));

  console.log(
    `[game] Room ${roomId} — Game over. Final ranking:`,
    finalRanking.map((e) => `${e.rank}. ${e.playerName}: ${e.score}`).join(", ")
  );

  const gameEndPayload = {
    finalRanking,
    roundHistory: room.roundHistory || [],
  };

  // Cache the payload so rejoining players can receive it on demand
  room.lastGameEnd = gameEndPayload;

  io.to(roomId).emit("game_end", gameEndPayload);
  roomManager.touchRoom(roomId);
}

// ---------------------------------------------------------------------------
// Shared disconnect/leave helper
// ---------------------------------------------------------------------------

/**
 * Handle a player leaving (either explicitly or via disconnect).
 * @param {Socket} socket
 * @param {string|null} roomId  - Provided on explicit leave; null on disconnect
 * @param {"explicit"|"disconnect"} reason
 */
function handlePlayerLeave(socket, roomId, reason) {
  const result = roomManager.disconnectPlayer(socket.id);

  if (result.deleted) {
    console.log(`[room] room deleted — last player left`);
    return;
  }

  if (!result.room) return; // Player wasn't in any room

  const rid = result.room.id;

  socket.leave(rid);

  // During an active game, a disconnect is likely just the player navigating
  // to game-multi.html (page transition). Don't broadcast a leave event yet —
  // the player will rejoin with a new socket id in a moment.
  // We only notify others once the game is NOT playing (lobby disconnect).
  const rawRoom = roomManager.getRawRoom(rid);
  const status  = rawRoom ? rawRoom.status : "waiting";

  // During "playing" or "finished", a disconnect is a page navigation
  // (game-multi.html ↔ room.html). The player will rejoin momentarily
  // with a new socket id — so we suppress all broadcast and do NOT
  // remove them from the connected list.
  //
  // Edge case: the rejoin handler runs first (sets connected=true),
  // then this disconnect fires and would set connected=false again.
  // Guard: if the player's current socket.id in the room no longer
  // matches this (old) socket.id, they have already rejoined — skip.
  const isTransitioning = status === "playing" || status === "finished";

  if (isTransitioning) {
    const leavingPlayerName = rawRoom?.players.find(
      (p) => p.name === result.room.players.find((rp) => rp.id === socket.id)?.name
    )?.name;

    // Wait 2 seconds before broadcasting — gives the player time to rejoin
    // after a page navigation (room.html → game-multi.html).
    // If they haven't rejoined by then, treat it as a real disconnect.
    setTimeout(() => {
      const currentRoom = roomManager.getRawRoom(rid);
      if (!currentRoom) return;

      const player = currentRoom.players.find((p) => p.name === leavingPlayerName);

      // If the player already rejoined with a new socket id, ignore
      if (player && player.id !== socket.id && player.connected) {
        console.log(`[room] ${socket.id} stale disconnect ignored (${leavingPlayerName} already rejoined)`);
        return;
      }

      // Real disconnect — mark as disconnected and notify others
      if (player) player.connected = false;

      const connectedCount = currentRoom.players.filter((p) => p.connected).length;

      console.log(`[room] ${leavingPlayerName} really disconnected from ${rid} (${connectedCount} remaining)`);

      // If nobody is left, delete the room immediately
      if (connectedCount === 0) {
        roomManager.deleteRoom(rid);
        return;
      }

      io.to(rid).emit("player_disconnect", {
        playerName: leavingPlayerName,
        connectedCount,
      });
    }, 8000);

    return;
  }

  // Normal waiting-room disconnect: broadcast to remaining players
  io.to(rid).emit("room_update", { players: result.room.players, hostId: result.room.hostId });

  if (reason === "disconnect") {
    const playerName =
      result.room.players.find((p) => p.id === socket.id)?.name ?? "A player";
    io.to(rid).emit("player_disconnect", { playerName });
  }

  console.log(`[room] ${socket.id} left room ${rid} (${reason})`);
}

// ---------------------------------------------------------------------------
// Room cleanup — runs every 60 seconds
// Removes rooms that have been empty or finished for more than 15 minutes.
// ---------------------------------------------------------------------------
setInterval(() => {
  roomManager.cleanupRooms();
}, 60 * 1000);

// ---------------------------------------------------------------------------
// Start listening
// ---------------------------------------------------------------------------

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Quick Draw server running at http://localhost:${PORT}`);
});