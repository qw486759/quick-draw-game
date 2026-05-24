/**
 * game-multi.js
 *
 * Multiplayer game controller for game-multi.html.
 *
 * Responsibilities:
 *   - Read session data (roomId, playerName) set by room.html
 *   - Re-join the socket room after page navigation
 *   - Listen for game events: new_round, timer_sync, round_end, game_end
 *   - Run AI inference after each stroke (via canvas 'strokeend' CustomEvent)
 *   - Submit score + canvas drawing to server after every inference
 *   - Render: prompt, timer, AI predictions, live scoreboard, overlays
 *   - game_end: show drawing gallery per round + personal best (localStorage)
 */

// ---------------------------------------------------------------------------
// Session data (set by room.html before redirecting here)
// ---------------------------------------------------------------------------

const roomId     = sessionStorage.getItem("roomId");
const playerName = sessionStorage.getItem("playerName");

if (!roomId || !playerName) {
  window.location.href = "lobby.html";
}

// ---------------------------------------------------------------------------
// DOM references
// ---------------------------------------------------------------------------

const loadingOverlay  = document.getElementById("loading-overlay");
const loadingMsg      = document.getElementById("loading-msg");
const roundendOverlay = document.getElementById("roundend-overlay");
const gameoverOverlay = document.getElementById("gameover-overlay");
const toastEl         = document.getElementById("toast");

const promptBanner    = document.getElementById("prompt-banner");
const roundBadge      = document.getElementById("round-badge");
const timerNumber     = document.getElementById("timer-number");
const predictionList  = document.getElementById("prediction-list");
const scoreList       = document.getElementById("score-list");
const btnClear        = document.getElementById("btn-clear");

// Round-end overlay
const reRoundNumber   = document.getElementById("re-round-number");
const rePrompt        = document.getElementById("re-prompt");
const reTableBody     = document.getElementById("re-table-body");

// Game-over overlay
const goRankingList   = document.getElementById("go-ranking-list");
const goRoundGallery  = document.getElementById("go-round-gallery");
const goPersonalBest  = document.getElementById("go-personal-best");
const goBtnLobby      = document.getElementById("go-btn-lobby");

// ---------------------------------------------------------------------------
// Game state
// ---------------------------------------------------------------------------

let localScores       = {}; // { playerName: cumulativeScore }
let roundActive       = false;
let inferenceDebounce = null;

// ---------------------------------------------------------------------------
// Personal best (localStorage)
// ---------------------------------------------------------------------------

const PB_KEY = `quickdraw_pb_${playerName}`;

function getPersonalBest() {
  return parseInt(localStorage.getItem(PB_KEY) || "0", 10);
}

function updatePersonalBest(score) {
  const current = getPersonalBest();
  if (score > current) {
    localStorage.setItem(PB_KEY, String(score));
    return true; // new record
  }
  return false;
}

// ---------------------------------------------------------------------------
// Canvas setup
// ---------------------------------------------------------------------------

const canvasEl      = document.getElementById("draw-canvas");
const drawingCanvas = new DrawingCanvas(canvasEl);

btnClear.addEventListener("click", () => {
  drawingCanvas.clear();
  renderPredictions([]);
});

// 200ms debounce — canvas.js fires 'strokeend' after each stroke
canvasEl.addEventListener("strokeend", () => {
  clearTimeout(inferenceDebounce);
  inferenceDebounce = setTimeout(runInference, 200);
});

// ---------------------------------------------------------------------------
// AI inference
// ---------------------------------------------------------------------------

/**
 * Run CNN inference, update predictions panel, and submit score + drawing.
 * Drawing is sent as a small base64 PNG (canvas scaled to 120px for display).
 */
function runInference() {
  if (!roundActive) return;

  const tensor         = drawingCanvas.getImageTensor();
  const topPredictions = quickDrawModel.predict(tensor);
  tensor.dispose();

  if (!topPredictions || topPredictions.length === 0) return;

  renderPredictions(topPredictions.slice(0, 3));

  const best = topPredictions[0];

  // Export canvas as a small PNG for the gallery.
  const drawing = getCanvasSnapshot(120);

  socket.emit("submit_score", {
    roomId,
    topLabel:   best.label,
    confidence: best.confidence,
    drawing,
  });
}

/**
 * Export the current canvas contents as a base64 PNG at the given size.
 * @param {number} size - output pixel size (square)
 * @returns {string} data URL
 */
function getCanvasSnapshot(size) {
  const tmp    = document.createElement("canvas");
  tmp.width    = size;
  tmp.height   = size;
  const tmpCtx = tmp.getContext("2d");
  tmpCtx.fillStyle = "#ffffff";
  tmpCtx.fillRect(0, 0, size, size);
  tmpCtx.drawImage(canvasEl, 0, 0, size, size);
  return tmp.toDataURL("image/png");
}

// ---------------------------------------------------------------------------
// Render helpers
// ---------------------------------------------------------------------------

function renderPredictions(predictions) {
  if (predictions.length === 0) {
    predictionList.innerHTML = '<p class="hint-text">Start drawing to see predictions.</p>';
    return;
  }
  predictionList.innerHTML = predictions
    .map(({ label, confidence }) => {
      const pct      = (confidence * 100).toFixed(1);
      const barWidth = Math.round(confidence * 100);
      return `
        <div class="prediction-item">
          <div class="prediction-label-row">
            <span>${escapeHtml(label)}</span>
            <span>${pct}%</span>
          </div>
          <div class="prediction-bar-track">
            <div class="prediction-bar-fill" style="width:${barWidth}%"></div>
          </div>
        </div>`;
    })
    .join("");
}

function renderScoreboard() {
  const sorted = Object.entries(localScores).sort((a, b) => b[1] - a[1]);
  if (sorted.length === 0) {
    scoreList.innerHTML = '<p class="hint-text">Scores will appear here.</p>';
    return;
  }
  scoreList.innerHTML = sorted
    .map(([name, score]) => `
      <div class="score-row">
        <span class="score-name">${escapeHtml(name)}</span>
        <span class="score-value">${score}</span>
      </div>`)
    .join("");
}

function updateTimer(timeLeft) {
  timerNumber.textContent = timeLeft;
  timerNumber.classList.remove("warn", "urgent");
  if (timeLeft <= 5)       timerNumber.classList.add("urgent");
  else if (timeLeft <= 10) timerNumber.classList.add("warn");
}

let toastTimer = null;
function showToast(msg, isError = false) {
  toastEl.textContent = msg;
  toastEl.className   = "show" + (isError ? " error" : "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.className = ""; }, 2800);
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ---------------------------------------------------------------------------
// Game-over overlay: drawing gallery + personal best
// ---------------------------------------------------------------------------

/**
 * Populate and show the game-over overlay.
 * @param {Array}  finalRanking  - [{rank, playerName, score}]
 * @param {Array}  roundHistory  - [{roundNumber, prompt, scores:[{playerName, drawing, roundScore, topLabel}]}]
 */
function showGameOver(finalRanking, roundHistory) {
  // ── Final ranking list ────────────────────────────────────────
  const MEDALS = ["🥇", "🥈", "🥉"];
  goRankingList.innerHTML = finalRanking
    .map(({ rank, playerName: name, score }) => {
      const medal = MEDALS[rank - 1] || `${rank}.`;
      const isMe  = name === playerName;
      return `
        <li class="${isMe ? "me" : ""}">
          <span class="rank-medal">${medal}</span>
          <span class="rank-name">${escapeHtml(name)}${isMe ? " <em>(you)</em>" : ""}</span>
          <span class="rank-score">${score} pts</span>
        </li>`;
    })
    .join("");

  // ── Personal best ─────────────────────────────────────────────
  const myEntry    = finalRanking.find((e) => e.playerName === playerName);
  const myScore    = myEntry ? myEntry.score : 0;
  const isNewBest  = updatePersonalBest(myScore);
  const bestScore  = getPersonalBest();

  goPersonalBest.innerHTML = isNewBest
    ? `🏆 New personal best: <strong>${bestScore} pts</strong>!`
    : `Your best: <strong>${bestScore} pts</strong>`;

  // ── Drawing gallery (one section per round) ───────────────────
  goRoundGallery.innerHTML = roundHistory
    .map((round) => {
      const cards = round.scores
        .map((entry) => {
          const imgTag = entry.drawing
            ? `<img src="${entry.drawing}" alt="${escapeHtml(entry.playerName)}'s drawing" class="gallery-img" />`
            : `<div class="gallery-img gallery-blank">—</div>`;
          const pct = (entry.confidence * 100).toFixed(0);
          return `
            <div class="gallery-card">
              ${imgTag}
              <div class="gallery-name">${escapeHtml(entry.playerName)}</div>
              <div class="gallery-score">${entry.roundScore} pts</div>
              <div class="gallery-label">${escapeHtml(entry.topLabel)} ${pct}%</div>
            </div>`;
        })
        .join("");

      return `
        <div class="gallery-round">
          <div class="gallery-round-title">
            Round ${round.roundNumber} — <em>${escapeHtml(round.prompt)}</em>
          </div>
          <div class="gallery-cards">${cards}</div>
        </div>`;
    })
    .join("");

  gameoverOverlay.classList.add("active");
}

// ---------------------------------------------------------------------------
// Socket setup
// ---------------------------------------------------------------------------

const socket = SocketClient.connect();

socket.on("join_success", ({ room }) => {
  console.log(`[game-multi] Room join confirmed.`);
});

socket.on("join_error", ({ error }) => {
  console.error("[game-multi] join_error:", error);
  window.location.href = "lobby.html";
});

socket.on("new_round", ({ prompt, roundNumber, totalRounds }) => {
  roundendOverlay.classList.remove("active");

  promptBanner.textContent   = `Draw: ${prompt}`;
  roundBadge.textContent     = `Round ${roundNumber} / ${totalRounds}`;

  drawingCanvas.clear();
  renderPredictions([]);

  roundActive = true;
});

socket.on("timer_sync", ({ timeLeft }) => {
  updateTimer(timeLeft);
  if (timeLeft <= 0) roundActive = false;
});

socket.on("round_end", (data) => {
  roundActive = false;

  data.scores.forEach((entry) => {
    localScores[entry.playerName] = entry.cumulativeScore;
  });
  renderScoreboard();

  reRoundNumber.textContent = data.roundNumber;
  rePrompt.textContent      = data.prompt;

  reTableBody.innerHTML = data.scores
    .map((entry, i) => `
      <tr>
        <td class="rank-cell">${i + 1}</td>
        <td>${escapeHtml(entry.playerName)}</td>
        <td>${entry.roundScore}</td>
        <td>+${entry.rankBonus}</td>
        <td><strong>${entry.totalRoundScore}</strong></td>
      </tr>`)
    .join("");

  roundendOverlay.classList.add("active");
});

socket.on("game_end", ({ finalRanking, roundHistory }) => {
  roundendOverlay.classList.remove("active");
  showGameOver(finalRanking, roundHistory);
});

socket.on("player_disconnect", ({ playerName: name, connectedCount }) => {
  showToast(`${name} disconnected`, true);

  // If only 1 player remains, show the overlay so they can exit gracefully
  if (connectedCount <= 1) {
    const overlay = document.getElementById("player-left-overlay");
    const message = document.getElementById("player-left-message");
    message.textContent = `${name} has left the game.`;
    overlay.classList.add("active");
    roundActive = false;
  }
});

// ---------------------------------------------------------------------------
// Back to Room button
// ---------------------------------------------------------------------------

goBtnLobby.addEventListener("click", () => {
  window.location.href = `room.html?roomId=${encodeURIComponent(roomId)}&name=${encodeURIComponent(playerName)}`;
});

document.getElementById("btn-exit-game").addEventListener("click", () => {
  window.location.href = "lobby.html";
});

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

(async function init() {
  try {
    await quickDrawModel.load((status, message) => {
      if (status === "loading") loadingMsg.textContent = "Loading AI model…";
      if (status === "error")   loadingMsg.textContent = `Error: ${message}`;
    });

    loadingOverlay.classList.remove("active");

    socket.emit("join_room", { roomId, playerName });

    console.log(`[game-multi] Ready — room: ${roomId}, player: ${playerName}`);
  } catch (err) {
    console.error("[game-multi] Init failed:", err);
    loadingMsg.textContent = "Failed to load AI model. Please refresh.";
  }
})();