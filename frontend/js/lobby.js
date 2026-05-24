/**
 * lobby.js
 *
 * Multiplayer lobby controller.
 * Depends on: socket-client.js (SocketClient singleton)
 *
 * Responsibilities:
 *   - Persist and display player name (localStorage)
 *   - Create room via REST POST /api/rooms
 *   - Fetch and render room list via REST GET /api/rooms (auto-refresh)
 *   - Fetch and render leaderboard via REST GET /api/leaderboard (auto-refresh)
 *   - Join a room by navigating to room.html with query params
 */

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let playerName = localStorage.getItem("playerName") || "";
let isCreating = false;

// ---------------------------------------------------------------------------
// DOM refs
// ---------------------------------------------------------------------------

const playerNameInput = document.getElementById("player-name");
const nameDisplay     = document.getElementById("name-display");
const avatarEl        = document.getElementById("avatar");
const saveNameBtn     = document.getElementById("save-name-btn");
const roomNameInput   = document.getElementById("room-name-input");
const maxPlayersInput = document.getElementById("max-players-input");
const createRoomBtn   = document.getElementById("create-room-btn");
const roomListEl      = document.getElementById("room-list");
const refreshBtn      = document.getElementById("refresh-btn");
const lbListEl        = document.getElementById("lb-list");
const toastEl         = document.getElementById("toast");

const AVATARS = ["🎨", "🖌️", "✏️", "🖍️", "📐", "🎭", "🌟", "🦊"];
const MEDALS  = ["🥇", "🥈", "🥉"];

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
// XSS guard
// ---------------------------------------------------------------------------

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ---------------------------------------------------------------------------
// Identity / player name
// ---------------------------------------------------------------------------

function updateNameDisplay() {
  if (playerName) {
    nameDisplay.textContent = playerName;
    nameDisplay.classList.remove("empty");
    avatarEl.textContent = AVATARS[playerName.charCodeAt(0) % AVATARS.length];
  } else {
    nameDisplay.textContent = "Not set";
    nameDisplay.classList.add("empty");
    avatarEl.textContent = "🎨";
  }
}

// Populate input and display on page load
if (playerName) playerNameInput.value = playerName;
updateNameDisplay();

saveNameBtn.addEventListener("click", () => {
  const val = playerNameInput.value.trim();
  if (!val) { showToast("Please enter a name.", true); return; }
  playerName = val;
  localStorage.setItem("playerName", val);
  updateNameDisplay();
  showToast("Name saved!");
  // Refresh leaderboard to highlight the updated name
  fetchLeaderboard();
});

playerNameInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") saveNameBtn.click();
});

// ---------------------------------------------------------------------------
// Room list
// ---------------------------------------------------------------------------

async function fetchRooms() {
  refreshBtn.classList.add("spinning");
  try {
    const res   = await fetch(`${APP_CONFIG.API_BASE_URL}/api/rooms`);
    const rooms = await res.json();
    renderRooms(rooms);
  } catch {
    showToast("Could not load rooms.", true);
  } finally {
    refreshBtn.classList.remove("spinning");
  }
}

function renderRooms(rooms) {
  if (!rooms.length) {
    roomListEl.innerHTML = `
      <div class="empty-state">
        <div class="big">🎲</div>
        <p>No rooms yet — create one!</p>
      </div>`;
    return;
  }

  roomListEl.innerHTML = rooms.map(room => {
    const count     = room.players.length;
    const max       = room.maxPlayers;
    const isFull    = count >= max;
    const isPlaying = room.status === "playing";
    const canJoin   = !isFull && room.status === "waiting";

    let badgeClass, badgeText;
    if (isPlaying)   { badgeClass = "badge-playing"; badgeText = "In game"; }
    else if (isFull) { badgeClass = "badge-full";    badgeText = "Full"; }
    else             { badgeClass = "badge-waiting"; badgeText = "Waiting"; }

    const cardClass = isFull    ? "room-card full"
                    : isPlaying ? "room-card playing"
                    :             "room-card";

    return `
      <div class="${cardClass}" data-room-id="${room.id}" data-can-join="${canJoin}">
        <div class="room-info">
          <div class="room-name">${escapeHtml(room.name)}</div>
          <div class="room-meta">${escapeHtml(room.players.map(p => p.name).join(", ") || "—")}</div>
        </div>
        <span class="room-count">${count}/${max}</span>
        <span class="room-badge ${badgeClass}">${badgeText}</span>
      </div>`;
  }).join("");

  roomListEl.querySelectorAll(".room-card").forEach(card => {
    card.addEventListener("click", () => {
      if (card.dataset.canJoin !== "true") return;
      attemptJoin(card.dataset.roomId);
    });
  });
}

refreshBtn.addEventListener("click", fetchRooms);

// Initial load + auto-refresh every 5 seconds
fetchRooms();
setInterval(fetchRooms, 5000);

// ---------------------------------------------------------------------------
// Leaderboard
// ---------------------------------------------------------------------------

async function fetchLeaderboard() {
  try {
    const res     = await fetch(`${APP_CONFIG.API_BASE_URL}/api/leaderboard`);
    const entries = await res.json();
    renderLeaderboard(entries);
  } catch {
    // Silently fail — leaderboard is non-critical
  }
}

function renderLeaderboard(entries) {
  if (!entries || entries.length === 0) {
    lbListEl.innerHTML = `
      <div class="lb-empty">No scores yet.<br/>Play a game to get on the board!</div>`;
    return;
  }

  lbListEl.innerHTML = entries.map((entry, i) => {
    const medal = MEDALS[i] || `${i + 1}.`;
    const isMe  = playerName && entry.playerName === playerName;
    return `
      <div class="lb-row">
        <span class="lb-rank">${medal}</span>
        <span class="lb-name${isMe ? " me" : ""}">${escapeHtml(entry.playerName)}</span>
        <span class="lb-score">${entry.score}</span>
      </div>`;
  }).join("");
}

// Initial load + auto-refresh every 10 seconds
fetchLeaderboard();
setInterval(fetchLeaderboard, 10000);

// ---------------------------------------------------------------------------
// Create room
// ---------------------------------------------------------------------------

createRoomBtn.addEventListener("click", async () => {
  if (isCreating) return;
  if (!playerName) {
    showToast("Please set your name first.", true);
    playerNameInput.focus();
    return;
  }

  const roomName   = roomNameInput.value.trim() || `${playerName}'s Room`;
  const maxPlayers = parseInt(maxPlayersInput.value, 10);

  isCreating = true;
  createRoomBtn.disabled    = true;
  createRoomBtn.textContent = "Creating…";

  try {
    const res = await fetch(`${APP_CONFIG.API_BASE_URL}/api/rooms`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ roomName, maxPlayers, hostName: playerName }),
    });

    if (!res.ok) {
      const err = await res.json();
      showToast(err.error || "Failed to create room.", true);
      return;
    }

    const { roomId, hostToken } = await res.json();
    sessionStorage.setItem(`hostToken_${roomId}`, hostToken);
    window.location.href =
      `room.html?roomId=${roomId}&name=${encodeURIComponent(playerName)}&host=1`;

  } catch {
    showToast("Network error. Try again.", true);
  } finally {
    isCreating = false;
    createRoomBtn.disabled    = false;
    createRoomBtn.textContent = "Create & Join →";
  }
});

// ---------------------------------------------------------------------------
// Join room
// ---------------------------------------------------------------------------

function attemptJoin(roomId) {
  if (!playerName) {
    showToast("Please set your name first.", true);
    playerNameInput.focus();
    return;
  }
  window.location.href =
    `room.html?roomId=${roomId}&name=${encodeURIComponent(playerName)}`;
}