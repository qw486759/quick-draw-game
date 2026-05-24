/**
 * room.js
 *
 * Room lobby controller for room.html.
 * Depends on: socket-client.js (SocketClient singleton)
 *
 * Responsibilities:
 *   - Parse roomId and playerName from URL params
 *   - Render player list and action area (host vs. guest view)
 *   - Handle ready/start/leave/restart game flow via Socket.io
 *   - Display notification log and toast messages
 */

// ---------------------------------------------------------------------------
// URL params
// ---------------------------------------------------------------------------

const params     = new URLSearchParams(window.location.search);
const roomId     = params.get("roomId");
const playerName = params.get("name") || localStorage.getItem("playerName") || "Player";

localStorage.setItem("playerName", playerName);

if (!roomId) window.location.href = "lobby.html";

// ---------------------------------------------------------------------------
// DOM refs
// ---------------------------------------------------------------------------

const headerRoomId     = document.getElementById("header-room-id");
const playerListEl     = document.getElementById("player-list");
const playerCountLabel = document.getElementById("player-count-label");
const actionAreaEl     = document.getElementById("action-area");
const notifLogEl       = document.getElementById("notif-log");
const leaveBtn         = document.getElementById("leave-btn");
const toastEl          = document.getElementById("toast");

headerRoomId.textContent = roomId;
document.title = `Quick Draw — Room ${roomId}`;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let currentRoom      = null;
let mySocketId       = null;
let navigatingToGame = false;

// ---------------------------------------------------------------------------
// Toast
// ---------------------------------------------------------------------------

let toastTimer = null;

function showToast(msg, isError = false) {
  toastEl.textContent = msg;
  toastEl.className   = "show" + (isError ? " error" : "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.className = ""; }, 2800);
}

// ---------------------------------------------------------------------------
// Notification log
// ---------------------------------------------------------------------------

function addNotif(msg, type = "") {
  const item = document.createElement("div");
  item.className = "notif-item" + (type ? " " + type : "");
  item.textContent = msg;
  notifLogEl.appendChild(item);
  notifLogEl.scrollTop = notifLogEl.scrollHeight;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const AVATARS = ["🎨", "🖌️", "✏️", "🖍️", "📐", "🎭", "🌟", "🦊"];

function avatarFor(name) {
  return AVATARS[name.charCodeAt(0) % AVATARS.length];
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ---------------------------------------------------------------------------
// Render: player list
// ---------------------------------------------------------------------------

function renderPlayers(room) {
  currentRoom = room;
  const { players, maxPlayers, hostId } = room;
  playerCountLabel.textContent = `${players.length} / ${maxPlayers}`;

  const rows = players.map(p => {
    const isMe    = p.id === mySocketId;
    const isHostP = p.id === hostId;
    // Host is always implicitly ready — only show the dot for non-host players
    const dotHtml = !isHostP
      ? `<span class="ready-dot${p.ready ? " ready" : ""}" title="${p.ready ? "Ready" : "Not ready"}"></span>`
      : '<span style="width:10px;flex-shrink:0"></span>';

    return `
      <div class="player-row${isMe ? " you" : ""}${!p.connected ? " disconnected" : ""}">
        ${dotHtml}
        <div class="player-avatar">${avatarFor(p.name)}</div>
        <div class="player-name">${escapeHtml(p.name)}</div>
        ${isMe    ? '<span class="you-tag">You</span>'   : ""}
        ${isHostP ? '<span class="host-tag">Host</span>' : ""}
      </div>`;
  }).join("");

  const emptyCount = maxPlayers - players.length;
  const slots = Array.from({ length: emptyCount }, () =>
    `<div class="empty-slot">Waiting for player…</div>`
  ).join("");

  playerListEl.innerHTML = rows + (emptyCount > 0
    ? `<div class="empty-slots">${slots}</div>`
    : "");

  renderActionArea(room);
}

// ---------------------------------------------------------------------------
// Render: action area (host vs. guest)
// ---------------------------------------------------------------------------

function renderActionArea(room) {
  const { players, hostId, status } = room;
  const connected      = players.filter(p => p.connected);
  const amHost         = hostId === mySocketId;
  const me             = players.find(p => p.id === mySocketId);
  const nonHostReady   = connected.filter(p => p.id !== hostId).every(p => p.ready);
  const canStart       = connected.length >= 2 && nonHostReady;

  if (status === "finished") {
    actionAreaEl.innerHTML = `
      <div class="status-area">
        <div class="status-icon">🏁</div>
        <div class="status-title">Game Finished</div>
        <p class="status-sub" style="margin-bottom:20px">
          ${amHost
            ? "View the results, or start a new game."
            : "View the results, or wait for the host to start again."}
        </p>
        <button class="btn btn-neutral" id="btn-back-game" style="margin-bottom:10px">
          View Results →
        </button>
        ${amHost
          ? `<button class="btn btn-primary" id="btn-restart-room">Play Again ↩</button>`
          : `<p style="font-family:var(--font-mono);font-size:.72rem;color:var(--muted);margin-top:8px">
               Waiting for host to restart…
             </p>`
        }
      </div>`;

    document.getElementById("btn-back-game")?.addEventListener("click", () => {
      navigatingToGame = true;
      sessionStorage.setItem("roomId", roomId);
      sessionStorage.setItem("playerName", playerName);
      window.location.href = "game-multi.html";
    });

    document.getElementById("btn-restart-room")?.addEventListener("click", () => {
      socket.emit("restart_game", { roomId });
    });
    return;
  }

  if (amHost) {
    const notReadyCount = connected.filter(p => p.id !== hostId && !p.ready).length;
    const subMsg = connected.length < 2
      ? `Need at least 2 players (${connected.length}/2)`
      : notReadyCount > 0
        ? `Waiting for ${notReadyCount} player${notReadyCount > 1 ? "s" : ""} to ready up…`
        : "All players ready! Click to start.";

    actionAreaEl.innerHTML = `
      <div class="status-area">
        <div class="status-icon">👑</div>
        <div class="status-title">You're the Host</div>
        <p class="status-sub" style="margin-bottom:24px">${subMsg}</p>
        <button class="btn btn-primary" id="start-btn" ${canStart ? "" : "disabled"}>
          Start Game →
        </button>
      </div>`;

    document.getElementById("start-btn")?.addEventListener("click", () => {
      socket.emit("start_game", { roomId });
    });

  } else {
    const imReady = me ? me.ready : false;

    actionAreaEl.innerHTML = `
      <div class="status-area">
        <div class="status-icon">${imReady ? "✅" : "⏳"}</div>
        <div class="status-title">${imReady ? "You're Ready!" : "Waiting for Host"}</div>
        <p class="status-sub" style="margin-bottom:24px">
          ${imReady
            ? "Waiting for the host to start the game."
            : "Press Ready when you're prepared to play."}
        </p>
        <button class="btn ${imReady ? "btn-neutral" : "btn-primary"}" id="ready-btn">
          ${imReady ? "Cancel Ready ✕" : "Ready ✓"}
        </button>
      </div>`;

    document.getElementById("ready-btn")?.addEventListener("click", () => {
      socket.emit("player_ready", { roomId });
    });
  }
}

// ---------------------------------------------------------------------------
// Socket setup
// ---------------------------------------------------------------------------

const socket = SocketClient.connect();

socket.on("connect", () => {
  mySocketId = socket.id;
  const hostToken = sessionStorage.getItem(`hostToken_${roomId}`) || null;
  socket.emit("join_room", { roomId, playerName, hostToken });
  addNotif(`Connected as ${playerName}`, "info");
});

socket.on("join_success", ({ room }) => {
  mySocketId = socket.id;
  renderPlayers(room);
  addNotif(`Joined room ${room.id}`, "join");
});

socket.on("join_error", ({ error }) => {
  showToast(error, true);
  addNotif(`Error: ${error}`, "leave");
  setTimeout(() => { window.location.href = "lobby.html"; }, 2000);
});

socket.on("room_update", ({ players, hostId }) => {
  if (!currentRoom) return;
  const prevCount  = currentRoom.players.length;
  const prevHostId = currentRoom.hostId;

  currentRoom.players = players;
  if (hostId) currentRoom.hostId = hostId;

  renderPlayers(currentRoom);

  if (players.length > prevCount) {
    const newest = players[players.length - 1];
    addNotif(`${newest.name} joined the room`, "join");
  } else if (players.length < prevCount) {
    addNotif("A player left the room", "leave");
  }

  if (hostId && hostId !== prevHostId) {
    const newHost = players.find(p => p.id === hostId);
    if (newHost) {
      addNotif(`${newHost.name} is now the host`, "info");
      showToast(`${newHost.name} is now the host`);
    }
  }
});

socket.on("player_disconnect", ({ playerName: who }) => {
  addNotif(`${who} disconnected`, "leave");
  showToast(`${who} disconnected`, true);
});

socket.on("start_error", ({ error }) => {
  showToast(error, true);
});

socket.on("game_start", () => {
  addNotif("Game starting!", "info");
  navigatingToGame = true;
  sessionStorage.setItem("roomId", roomId);
  sessionStorage.setItem("playerName", playerName);
  window.location.href = "game-multi.html";
});

socket.on("room_reset", ({ room }) => {
  mySocketId  = socket.id;
  currentRoom = room;
  renderPlayers(room);
  addNotif("Room reset — ready up to play again!", "info");
});

// ---------------------------------------------------------------------------
// Leave room
// ---------------------------------------------------------------------------

leaveBtn.addEventListener("click", () => {
  socket.emit("leave_room", { roomId });
  window.location.href = "lobby.html";
});

window.addEventListener("beforeunload", () => {
  if (!navigatingToGame) socket.emit("leave_room", { roomId });
});