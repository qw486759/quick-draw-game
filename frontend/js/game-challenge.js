/* =============================================================
   game-challenge.js — Challenge Mode Controller (M3)
   Depends on: canvas.js (DrawingCanvas), model.js (QuickDrawModel),
               scoring.js (calcChallengeScore)
   ============================================================= */

'use strict';

// -------------------------------------------------------------
// 1. CONFIG — all magic numbers live here, nowhere else
// -------------------------------------------------------------
const CHALLENGE_CONFIG = {
  countdownSec: 3,          // pre-round "3-2-1" countdown length

  // Time available per round: starts at 25s, drops 1s per round,
  // floors at 10s (round 16 onward stays at 10s).
  timeStart:  25,
  timeMin:    10,
  timeStep:   1,

  // Confidence threshold the player must reach to pass.
  thresholdEasy:    0.70,
  thresholdMedium:  0.75,
  thresholdHard:    0.80,
  thresholdExtreme: 0.85,

  // Round ranges that define each difficulty tier.
  mediumStartRound:  6,
  hardStartRound:   11,
  extremeStartRound: 16,

  // How long the "Passed!" screen stays visible (ms).
  passScreenDuration: 1200,

  // Debounce delay for AI inference after each stroke (ms).
  inferenceDebounceMs: 200,

  // localStorage key for personal best.
  localStorageKey: 'quickdraw_challenge_best',
};

// Hint text thresholds — shown in the confidence panel.
const HINT_COLD  = 0.30;   // below this: "Keep drawing!"
const HINT_WARM  = 0.55;   // below this: "Getting closer…"
const HINT_HOT   = 0.80;   // below threshold: "Almost there!"


// -------------------------------------------------------------
// 2. STATE — single source of truth for the current session
// -------------------------------------------------------------
let state = {
  round:          0,      // current round number (1-indexed)
  score:          0,      // cumulative score this session
  currentPrompt:  '',     // word the player must draw
  timeLeft:       0,      // seconds remaining in this round
  roundTimerId:   null,   // setInterval ID for the round clock
  debounceTimer:  null,   // setTimeout ID for inference debounce
  isDrawing:      false,  // true while the drawing screen is active
  personalBest:   0,      // rounds cleared, loaded from localStorage
};


// -------------------------------------------------------------
// 3. DOM REFS — queried once at startup
// -------------------------------------------------------------
const SCREENS = {
  loading:    document.getElementById('screen-loading'),
  ready:      document.getElementById('screen-ready'),
  roundStart: document.getElementById('screen-round-start'),
  drawing:    document.getElementById('screen-drawing'),
  pass:       document.getElementById('screen-pass'),
  gameOver:   document.getElementById('screen-game-over'),
};

const DOM = {
  // Ready screen
  personalBestDisplay: document.getElementById('personal-best-display'),
  btnStart:            document.getElementById('btn-start'),

  // Round-start screen
  rsDifficultyBadge:   document.getElementById('rs-difficulty-badge'),
  rsPrompt:            document.getElementById('rs-prompt'),
  rsRoundNumber:       document.getElementById('rs-round-number'),
  rsThreshold:         document.getElementById('rs-threshold'),
  rsTimeLimit:         document.getElementById('rs-time-limit'),
  rsCountdown:         document.getElementById('rs-countdown'),

  // Drawing screen — header
  drawDifficultyBadge: document.getElementById('draw-difficulty-badge'),
  drawRoundLabel:      document.getElementById('draw-round-label'),
  timerRingFill:       document.getElementById('timer-ring-fill'),
  timerLabel:          document.getElementById('timer-text'),
  btnExit:             document.getElementById('btn-exit'),

  // Drawing screen — canvas area
  drawPrompt:          document.getElementById('draw-prompt'),
  canvas:              document.getElementById('drawing-canvas'),
  btnClear:            document.getElementById('btn-clear'),

  // Drawing screen — confidence panel
  aiTopLabel:          document.getElementById('ai-top-label'),
  thresholdMarker:     document.getElementById('threshold-marker'),
  confidenceFill:      document.getElementById('confidence-fill'),
  confidencePct:       document.getElementById('confidence-pct'),
  thresholdLabelInline:document.getElementById('threshold-label-inline'),
  confidenceHint:      document.getElementById('confidence-hint'),
  scoreValue:          document.getElementById('score-value'),

  // Pass screen
  passRoundLabel:      document.getElementById('pass-round-label'),
  passScoreLabel:      document.getElementById('pass-score-label'),

  // Game-over screen
  gameoverWord:        document.getElementById('gameover-word'),
  goRounds:            document.getElementById('go-rounds'),
  goScore:             document.getElementById('go-score'),
  goBest:              document.getElementById('go-best'),
  newRecordBanner:     document.getElementById('new-record-banner'),
  btnPlayAgain:        document.getElementById('btn-play-again'),
};


// -------------------------------------------------------------
// 4. MODULE INSTANCES — canvas & model created in main()
// -------------------------------------------------------------
let drawingCanvas = null;
let aiModel       = null;


// =============================================================
// DIFFICULTY HELPERS
// Pure functions: given a round number, return the right values.
// =============================================================

/**
 * Returns the difficulty tier name for a given round.
 * @param {number} round - 1-indexed round number
 * @returns {'easy'|'medium'|'hard'|'extreme'}
 */
function getDifficultyTier(round) {
  if (round >= CHALLENGE_CONFIG.extremeStartRound) return 'extreme';
  if (round >= CHALLENGE_CONFIG.hardStartRound)    return 'hard';
  if (round >= CHALLENGE_CONFIG.mediumStartRound)  return 'medium';
  return 'easy';
}

/**
 * Returns the confidence threshold (0–1) for a given round.
 * @param {number} round
 * @returns {number}
 */
function getThreshold(round) {
  const tier = getDifficultyTier(round);
  return CHALLENGE_CONFIG[`threshold${tier.charAt(0).toUpperCase() + tier.slice(1)}`];
}

/**
 * Returns the time limit (seconds) for a given round.
 * @param {number} round
 * @returns {number}
 */
function getTimeLimit(round) {
  return Math.max(
    CHALLENGE_CONFIG.timeStart - (round - 1) * CHALLENGE_CONFIG.timeStep,
    CHALLENGE_CONFIG.timeMin
  );
}

/**
 * Returns the display label for a difficulty tier.
 * @param {'easy'|'medium'|'hard'|'extreme'} tier
 * @returns {string}
 */
function getTierLabel(tier) {
  return tier.toUpperCase();
}

/**
 * Picks a random word from the appropriate tier in the word list.
 * Falls back to 'easy' if the tier pool is empty (e.g. medium/hard
 * not yet populated while the model only knows 5 categories).
 * @param {'easy'|'medium'|'hard'|'extreme'} tier
 * @param {Object} categories - the parsed categories.json object
 * @returns {string}
 */
function pickWord(tier, categories) {
  // 'extreme' uses the hard word pool
  const pool = tier === 'extreme' ? categories.hard : categories[tier];
  const source = (pool && pool.length > 0) ? pool : categories.easy;
  return source[Math.floor(Math.random() * source.length)];
}


// =============================================================
// SCREEN MANAGEMENT
// =============================================================

/**
 * Hides all screens then shows the requested one.
 * Uses the CSS class 'screen--active' (defined in main.css / game.css).
 * @param {HTMLElement} screenEl
 */
function showScreen(screenEl) {
  // Directly set display via JS — no CSS class priority issues
  const DISPLAY_MAP = {
    'screen-loading':    'grid',
    'screen-ready':      'flex',
    'screen-round-start':'grid',
    'screen-drawing':    'flex',
    'screen-pass':       'grid',
    'screen-game-over':  'grid',
  };
  Object.values(SCREENS).forEach(s => { s.style.display = 'none'; });
  screenEl.style.display = DISPLAY_MAP[screenEl.id] || 'flex';
}


// =============================================================
// TIMER HELPERS
// =============================================================

/**
 * Updates the SVG ring and label to reflect remaining time.
 * Progress fraction: 1.0 = full circle (start), 0.0 = empty (expired).
 * @param {number} timeLeft  - seconds remaining
 * @param {number} totalTime - total seconds for this round
 */
function updateTimerUI(timeLeft, totalTime) {
  const fraction = timeLeft / totalTime;
  // r=18 circle circumference = 2 * PI * 18 = 113.1 (matches free mode)
  const offset = 113.1 * (1 - fraction);

  DOM.timerRingFill.style.strokeDashoffset = offset;
  DOM.timerLabel.textContent = timeLeft;

  // Colour: same classes as free mode timer
  DOM.timerRingFill.classList.remove('timer-warning', 'timer-danger');
  if (timeLeft <= 5)       DOM.timerRingFill.classList.add('timer-danger');
  else if (timeLeft <= 10) DOM.timerRingFill.classList.add('timer-warning');
}

/** Stops the active round timer without triggering game-over logic. */
function clearRoundTimer() {
  if (state.roundTimerId !== null) {
    clearInterval(state.roundTimerId);
    state.roundTimerId = null;
  }
}


// =============================================================
// CONFIDENCE PANEL HELPERS
// =============================================================

/**
 * Updates the confidence bar, threshold marker, percentage label,
 * and hint text for the given confidence value.
 * @param {number} confidence - 0 to 1
 * @param {number} threshold  - 0 to 1
 */
function updateConfidenceUI(confidence, threshold) {
  const pct       = Math.round(confidence * 100);
  const targetPct = Math.round(threshold  * 100);

  // Fill bar width
  DOM.confidenceFill.style.width = pct + '%';

  // Fill bar colour: green when at/above threshold, amber when warm
  DOM.confidenceFill.classList.remove(
    'confidence-meter__fill--near',
    'confidence-meter__fill--passed'
  );
  if (confidence >= threshold) {
    DOM.confidenceFill.classList.add('confidence-meter__fill--passed');
  } else if (confidence >= threshold - 0.15) {
    DOM.confidenceFill.classList.add('confidence-meter__fill--near');
  }

  // Threshold marker position
  DOM.thresholdMarker.style.left = targetPct + '%';

  // Percentage label
  DOM.confidencePct.textContent = pct + '%';

  // Inline target label
  DOM.thresholdLabelInline.textContent = 'Target: ' + targetPct + '%';

  // Hint text + colour
  DOM.confidenceHint.classList.remove('confidence-hint--warm', 'confidence-hint--hot');
  if (confidence < HINT_COLD) {
    DOM.confidenceHint.textContent = 'Start drawing!';
  } else if (confidence < HINT_WARM) {
    DOM.confidenceHint.textContent = 'Getting closer…';
    DOM.confidenceHint.classList.add('confidence-hint--warm');
  } else if (confidence < threshold) {
    DOM.confidenceHint.textContent = 'Almost there!';
    DOM.confidenceHint.classList.add('confidence-hint--hot');
  } else {
    DOM.confidenceHint.textContent = '✓ Threshold reached!';
  }
}

/**
 * Resets the confidence panel to its blank state (between rounds).
 */
function resetConfidenceUI() {
  DOM.confidenceFill.style.width = '0%';
  DOM.confidenceFill.classList.remove(
    'confidence-meter__fill--near',
    'confidence-meter__fill--passed'
  );
  DOM.confidencePct.textContent    = '0%';
  DOM.aiTopLabel.textContent       = '—';
  DOM.confidenceHint.textContent   = 'Start drawing!';
  DOM.confidenceHint.classList.remove('confidence-hint--warm', 'confidence-hint--hot');
}


// =============================================================
// DIFFICULTY BADGE HELPER
// =============================================================

/**
 * Sets the text and colour modifier class on a badge element.
 * @param {HTMLElement} badgeEl
 * @param {'easy'|'medium'|'hard'|'extreme'} tier
 */
function setDifficultyBadge(badgeEl, tier) {
  // Remove all possible modifier classes
  badgeEl.classList.remove(
    'difficulty-badge--easy',
    'difficulty-badge--medium',
    'difficulty-badge--hard',
    'difficulty-badge--extreme'
  );
  badgeEl.classList.add(`difficulty-badge--${tier}`);
  badgeEl.textContent = getTierLabel(tier);
}


// =============================================================
// PERSONAL BEST (localStorage)
// =============================================================

function loadPersonalBest() {
  const stored = localStorage.getItem(CHALLENGE_CONFIG.localStorageKey);
  state.personalBest = stored ? parseInt(stored, 10) : 0;
}

/**
 * Saves a new personal best if roundsCleared beats the stored value.
 * @param {number} roundsCleared
 * @returns {boolean} true if a new record was set
 */
function maybeSavePersonalBest(roundsCleared) {
  if (roundsCleared > state.personalBest) {
    state.personalBest = roundsCleared;
    localStorage.setItem(CHALLENGE_CONFIG.localStorageKey, roundsCleared);
    return true;
  }
  return false;
}


// =============================================================
// GAME FLOW — STATE MACHINE
// Each function represents entering one state.
// =============================================================

// ---- READY SCREEN -------------------------------------------
function enterReady() {
  loadPersonalBest();
  DOM.personalBestDisplay.textContent =
    state.personalBest > 0 ? `Round ${state.personalBest}` : '—';
  showScreen(SCREENS.ready);
}

// ---- ROUND START SCREEN -------------------------------------
/**
 * Populates the round-start info screen and runs the 3-2-1 countdown,
 * then transitions to the drawing state.
 * @param {string} prompt    - word to draw
 * @param {number} round     - current round number
 * @param {Object} categories - parsed categories.json
 */
function enterRoundStart(prompt, round, categories) {
  const tier      = getDifficultyTier(round);
  const threshold = getThreshold(round);
  const timeLimit = getTimeLimit(round);

  // Populate static info
  setDifficultyBadge(DOM.rsDifficultyBadge, tier);
  DOM.rsPrompt.textContent      = prompt;
  DOM.rsRoundNumber.textContent = round;
  DOM.rsThreshold.textContent   = Math.round(threshold * 100) + '%';
  DOM.rsTimeLimit.textContent   = timeLimit + 's';

  showScreen(SCREENS.roundStart);

  // 3-2-1 countdown
  let count = CHALLENGE_CONFIG.countdownSec;
  DOM.rsCountdown.textContent = count;

  const countdownId = setInterval(() => {
    count--;
    if (count <= 0) {
      clearInterval(countdownId);
      enterDrawing(prompt, round, threshold, timeLimit);
    } else {
      DOM.rsCountdown.textContent = count;
    }
  }, 1000);
}

// ---- DRAWING SCREEN -----------------------------------------
/**
 * Activates the drawing screen and starts the round timer.
 * Inference runs on a debounce whenever the player lifts the pen.
 */
function enterDrawing(prompt, round, threshold, timeLimit) {
  state.round = round;
  const tier = getDifficultyTier(round);

  // Update header
  setDifficultyBadge(DOM.drawDifficultyBadge, tier);
  DOM.drawRoundLabel.textContent = `Round ${round}`;
  DOM.drawPrompt.textContent     = prompt;

  // Reset canvas and confidence panel
  drawingCanvas.clear();
  resetConfidenceUI();

  // Initialise timer display
  state.timeLeft = timeLimit;
  updateTimerUI(state.timeLeft, timeLimit);

  // Update threshold marker immediately (before any drawing)
  updateConfidenceUI(0, threshold);

  showScreen(SCREENS.drawing);
  state.isDrawing = true;

  // ---- Round timer ----------------------------------------
  clearRoundTimer(); // safety: clear any leftover timer
  state.roundTimerId = setInterval(() => {
    state.timeLeft--;
    updateTimerUI(state.timeLeft, timeLimit);

    if (state.timeLeft <= 0) {
      clearRoundTimer();
      enterGameOver(prompt, round - 1); // round-1 = rounds actually cleared
    }
  }, 1000);
}

// ---- PASS SCREEN --------------------------------------------
/**
 * Shows the "Passed!" screen briefly, then starts the next round.
 * @param {number} clearedRound - the round number that was just passed
 * @param {number} roundScore   - points earned this round
 * @param {Object} categories
 */
function enterPass(clearedRound, roundScore, categories) {
  state.isDrawing = false;
  clearRoundTimer();

  DOM.passRoundLabel.textContent = `Round ${clearedRound} cleared`;
  DOM.passScoreLabel.textContent = `+${roundScore} pts`;

  showScreen(SCREENS.pass);

  setTimeout(() => {
    const nextRound  = clearedRound + 1;
    const nextPrompt = pickWord(getDifficultyTier(nextRound), categories);
    state.currentPrompt = nextPrompt;
    enterRoundStart(nextPrompt, nextRound, categories);
  }, CHALLENGE_CONFIG.passScreenDuration);
}

// ---- GAME OVER SCREEN ---------------------------------------
/**
 * @param {string} failedPrompt  - the word the player failed to draw
 * @param {number} roundsCleared - how many rounds they actually passed
 */
function enterGameOver(failedPrompt, roundsCleared) {
  state.isDrawing = false;
  clearRoundTimer();

  const isNewRecord = maybeSavePersonalBest(roundsCleared);

  DOM.gameoverWord.textContent = failedPrompt;
  DOM.goRounds.textContent     = roundsCleared;
  DOM.goScore.textContent      = state.score;
  DOM.goBest.textContent       = state.personalBest;

  if (isNewRecord && roundsCleared > 0) {
    DOM.newRecordBanner.classList.remove('new-record-banner--hidden');
  } else {
    DOM.newRecordBanner.classList.add('new-record-banner--hidden');
  }

  showScreen(SCREENS.gameOver);
}


// =============================================================
// INFERENCE LOOP
// Called (debounced) after every stroke on the canvas.
// =============================================================

/**
 * Runs the model on the current canvas content and updates the UI.
 * If the top prediction matches the prompt AND confidence ≥ threshold,
 * the player passes the round.
 * @param {number} threshold  - current round's required confidence
 * @param {Object} categories
 */
function runInference(threshold, categories) {
  if (!state.isDrawing) return;

  const tensor      = drawingCanvas.getImageTensor();
  const predictions = aiModel.predict(tensor); // [{label, confidence}, ...]
  tensor.dispose();

  if (!predictions || predictions.length === 0) return;

  const top = predictions[0];

  // Update confidence panel
  DOM.aiTopLabel.textContent = top.label;
  updateConfidenceUI(top.confidence, threshold);

  // Check pass condition: label matches AND confidence clears the threshold
  const { correct } = aiModel.checkCorrect(predictions, state.currentPrompt, threshold);
  if (correct) {
    // Stop drawing phase immediately
    state.isDrawing = false;
    clearRoundTimer();

    const roundScore = calcChallengeScore(state.round);
    state.score += roundScore;
    DOM.scoreValue.textContent = state.score;

    enterPass(state.round, roundScore, categories);
  }
}


// =============================================================
// MAIN — entry point
// =============================================================
async function main() {
  showScreen(SCREENS.loading);

  // Load word categories
  let categories;
  try {
    const response = await fetch('assets/words/categories.json');
    categories = await response.json();
  } catch (err) {
    console.error('Failed to load categories.json:', err);
    return;
  }

  // Load TF.js model
  aiModel = new QuickDrawModel();
  try {
    await aiModel.load();
  } catch (err) {
    console.error('Failed to load model:', err);
    return;
  }

  // Initialise canvas module
  drawingCanvas = new DrawingCanvas(DOM.canvas);

  // ---- Debounced inference on every stroke end ----------------
  // We read 'threshold' fresh each time so it always reflects the
  // current round (the value is closed over via state.round).
  DOM.canvas.addEventListener('strokeend', () => {
    if (!state.isDrawing) return;
    clearTimeout(state.debounceTimer);
    state.debounceTimer = setTimeout(() => {
      const threshold = getThreshold(state.round);
      runInference(threshold, categories);
    }, CHALLENGE_CONFIG.inferenceDebounceMs);
  });

  // ---- Button: Start Challenge --------------------------------
  DOM.btnStart.addEventListener('click', () => {
    state.round  = 1;
    state.score  = 0;

    const prompt = pickWord(getDifficultyTier(1), categories);
    state.currentPrompt = prompt;
    enterRoundStart(prompt, 1, categories);
  });

  // ---- Button: Clear canvas -----------------------------------
  DOM.btnClear.addEventListener('click', () => {
    drawingCanvas.clear();
    resetConfidenceUI();
  });

  // ---- Button: Exit mid-game ----------------------------------
  DOM.btnExit.addEventListener('click', () => {
    state.isDrawing = false;
    clearRoundTimer();
    clearTimeout(state.debounceTimer);
    enterReady();
  });

  // ---- Button: Play Again -------------------------------------
  DOM.btnPlayAgain.addEventListener('click', () => {
    state.round  = 1;
    state.score  = 0;

    const prompt = pickWord(getDifficultyTier(1), categories);
    state.currentPrompt = prompt;
    enterRoundStart(prompt, 1, categories);
  });

  // ---- Show ready screen --------------------------------------
  enterReady();
}

// Kick off when DOM is fully parsed.
main();