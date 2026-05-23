/* ============================================================
   game-single.js
   Responsibilities:
   - Game state machine for single-player free mode
   - Wire DrawingCanvas -> QuickDrawModel -> ScoringSystem -> UI
   - Manage round timer, screen transitions, score display
   ============================================================ */

/* ── Game Config ────────────────────────────────────────────── */
const CONFIG = {
  TOTAL_ROUNDS:       6,
  ROUND_DURATION:     20,   // seconds per round
  COUNTDOWN_DURATION: 3,    // "3-2-1" before drawing starts
  RESULT_DISPLAY_MS:  2500, // how long to show round result before next round
  CORRECT_THRESHOLD:  0.7,  // AI confidence needed to count as correct
  TIMER_CIRCUMFERENCE: 113.1, // 2 * PI * 18 (SVG circle radius)
};

// Word pool
const WORD_POOL = []; // populated at init from categories.json

/* ── Game States ────────────────────────────────────────────── */
const STATE = {
  IDLE:         'IDLE',
  LOADING:      'LOADING',
  READY:        'READY',
  ROUND_START:  'ROUND_START',
  DRAWING:      'DRAWING',
  ROUND_RESULT: 'ROUND_RESULT',
  GAME_OVER:    'GAME_OVER',
};

/* ── Module Instances ───────────────────────────────────────── */
const model   = new QuickDrawModel();
const scoring = new ScoringSystem();
let   canvas  = null; // initialized after model loads

/* ── Game State ─────────────────────────────────────────────── */
let currentState    = STATE.IDLE;
let currentRound    = 0;   // 1-indexed during play
let currentWord     = '';
let secondsLeft     = 0;
let roundTimer      = null; // setInterval handle
let countdownTimer  = null; // setInterval handle for 3-2-1
let resultTimer     = null;
let bestCombo       = 0;
let correctCount    = 0;
// Track rounds already used to avoid duplicate words in one game
let usedWords       = [];

/* ── DOM References ─────────────────────────────────────────── */
const dom = {
  // Screens
  loadingScreen:     document.getElementById('loading-screen'),
  loadingMessage:    document.getElementById('loading-message'),
  app:               document.getElementById('app'),
  screenReady:       document.getElementById('screen-ready'),
  screenRoundStart:  document.getElementById('screen-round-start'),
  screenDrawing:     document.getElementById('screen-drawing'),
  screenRoundResult: document.getElementById('screen-round-result'),
  screenGameOver:    document.getElementById('screen-game-over'),

  // Round start screen
  roundCurrent:      document.getElementById('round-current'),
  roundTotal:        document.getElementById('round-total'),
  promptWord:        document.getElementById('prompt-word'),
  countdownStart:    document.getElementById('countdown-start'),

  // Drawing screen
  topbarRound:       document.getElementById('topbar-round'),
  topbarWord:        document.getElementById('topbar-word'),
  timerText:         document.getElementById('timer-text'),
  timerRingFill:     document.getElementById('timer-ring-fill'),
  scoreDisplay:      document.getElementById('score-display'),
  drawingCanvas:     document.getElementById('drawing-canvas'),
  btnClear:          document.getElementById('btn-clear'),
  predictionList:    document.getElementById('prediction-list'),
  aiIdleMessage:     document.getElementById('ai-idle-message'),

  // Round result screen
  resultIcon:        document.getElementById('result-icon'),
  resultTitle:       document.getElementById('result-title'),
  resultSubtitle:    document.getElementById('result-subtitle'),
  bdBase:            document.getElementById('bd-base'),
  bdTime:            document.getElementById('bd-time'),
  bdConfidence:      document.getElementById('bd-confidence'),
  bdMultiplier:      document.getElementById('bd-multiplier'),
  bdRoundScore:      document.getElementById('bd-round-score'),

  // Game over screen
  finalScoreDisplay: document.getElementById('final-score-display'),
  statCorrect:       document.getElementById('stat-correct'),
  statCombo:         document.getElementById('stat-combo'),

  // Buttons
  btnStart:          document.getElementById('btn-start'),
  btnPlayAgain:      document.getElementById('btn-play-again'),
};

/* ============================================================
   STATE MACHINE — transition to a new state
   All screen switching goes through here.
   ============================================================ */

const SCREEN_KEYS = [
  'screenReady',
  'screenRoundStart',
  'screenDrawing',
  'screenRoundResult',
  'screenGameOver',
];

function showScreen(screenKey) {
  SCREEN_KEYS.forEach(key => dom[key].classList.remove('screen--active'));
  dom[screenKey].classList.add('screen--active');
}

function transition(newState, payload = {}) {
  currentState = newState;

  switch (newState) {

    case STATE.READY:
      dom.app.classList.remove('hidden');
      showScreen('screenReady');
      break;

    case STATE.ROUND_START:
      showScreen('screenRoundStart');
      _runRoundStart(payload.word, payload.round);
      break;

    case STATE.DRAWING:
      showScreen('screenDrawing');
      _runDrawing(payload.word);
      break;

    case STATE.ROUND_RESULT:
      showScreen('screenRoundResult');
      _showRoundResult(payload);
      break;

    case STATE.GAME_OVER:
      showScreen('screenGameOver');
      _showGameOver();
      break;
  }
}

/* ============================================================
   ROUND START — show word + 3-2-1 countdown
   ============================================================ */

function _runRoundStart(word, round) {
  // Update round indicator
  dom.roundCurrent.textContent = round;
  dom.roundTotal.textContent   = CONFIG.TOTAL_ROUNDS;

  // Show the word to draw (re-trigger animation by clone trick)
  dom.promptWord.textContent = word;
  dom.promptWord.style.animation = 'none';
  void dom.promptWord.offsetHeight; // force reflow
  dom.promptWord.style.animation = '';

  // 3-2-1 countdown
  let count = CONFIG.COUNTDOWN_DURATION;
  dom.countdownStart.textContent = count;

  clearInterval(countdownTimer);
  countdownTimer = setInterval(() => {
    count--;

    if (count <= 0) {
      clearInterval(countdownTimer);
      transition(STATE.DRAWING, { word });
      return;
    }

    // Re-trigger pulse animation on each number change
    dom.countdownStart.style.animation = 'none';
    void dom.countdownStart.offsetHeight;
    dom.countdownStart.style.animation = '';
    dom.countdownStart.textContent = count;
  }, 1000);
}

/* ============================================================
   DRAWING — main gameplay: timer + inference + correct check
   ============================================================ */

function _runDrawing(word) {
  // Reset canvas and predictions
  canvas.clear();
  _resetPredictions();

  // Update top bar
  dom.topbarRound.textContent = `Round ${currentRound}/${CONFIG.TOTAL_ROUNDS}`;
  dom.topbarWord.textContent  = word;
  dom.scoreDisplay.textContent = scoring.totalScore;

  // Reset timer visuals
  secondsLeft = CONFIG.ROUND_DURATION;
  _updateTimerDisplay(secondsLeft);

  // Start countdown timer
  clearInterval(roundTimer);
  roundTimer = setInterval(() => {
    secondsLeft--;
    _updateTimerDisplay(secondsLeft);

    if (secondsLeft <= 0) {
      _onTimeUp();
    }
  }, 1000);
}

function _updateTimerDisplay(seconds) {
  dom.timerText.textContent = seconds;

  // Update SVG ring: map seconds to dashoffset
  // 0s left = full offset (empty ring), full time = 0 offset (full ring)
  const progress = seconds / CONFIG.ROUND_DURATION;
  const offset   = CONFIG.TIMER_CIRCUMFERENCE * (1 - progress);
  dom.timerRingFill.style.strokeDashoffset = offset;

  // Color transitions
  dom.timerRingFill.classList.remove('timer-warning', 'timer-danger');
  if (seconds <= 5) {
    dom.timerRingFill.classList.add('timer-danger');
  } else if (seconds <= 10) {
    dom.timerRingFill.classList.add('timer-warning');
  }
}

function _onTimeUp() {
  clearInterval(roundTimer);

  if (currentState !== STATE.DRAWING) return; // guard against race conditions

  const result = scoring.scoreMiss();
  transition(STATE.ROUND_RESULT, {
    correct:    false,
    word:       currentWord,
    roundScore: 0,
    newTotal:   result.newTotal,
    breakdown:  null,
  });
}

function _onCorrect(confidence) {
  clearInterval(roundTimer);

  if (currentState !== STATE.DRAWING) return; // guard: prevent double-trigger

  correctCount++;
  const result = scoring.scoreCorrect(secondsLeft, confidence);
  if (scoring.comboStreak > bestCombo) bestCombo = scoring.comboStreak;

  transition(STATE.ROUND_RESULT, {
    correct:    true,
    word:       currentWord,
    roundScore: result.roundScore,
    newTotal:   result.newTotal,
    breakdown:  result.breakdown,
  });
}

/* ============================================================
   ROUND RESULT — display outcome then auto-advance
   ============================================================ */

function _showRoundResult(payload) {
  if (payload.correct) {
    dom.resultIcon.textContent     = '✅';
    dom.resultTitle.textContent    = 'Correct!';
    dom.resultSubtitle.textContent = `The AI recognized "${payload.word}"`;

    const bd = payload.breakdown;
    dom.bdBase.textContent        = `+${bd.base}`;
    dom.bdTime.textContent        = `+${bd.timeBonus}`;
    dom.bdConfidence.textContent  = `+${bd.confidenceBonus}`;
    dom.bdMultiplier.textContent  = `×${bd.multiplier.toFixed(1)}`;
    dom.bdRoundScore.textContent  = `+${payload.roundScore}`;

    // Show breakdown section
    document.getElementById('result-score-breakdown').classList.remove('hidden');
  } else {
    dom.resultIcon.textContent     = '⏱️';
    dom.resultTitle.textContent    = 'Time\'s Up!';
    dom.resultSubtitle.textContent = `The word was "${payload.word}"`;
    dom.bdRoundScore.textContent   = '+0';

    // Hide breakdown rows (no score to show)
    document.getElementById('result-score-breakdown').classList.add('hidden');
  }

  // Update running total in top bar (visible when we return to drawing)
  dom.scoreDisplay.textContent = payload.newTotal;

  // Auto-advance after delay
  clearTimeout(resultTimer);
  resultTimer = setTimeout(() => {
    if (currentState !== STATE.ROUND_RESULT) return;
    if (currentRound >= CONFIG.TOTAL_ROUNDS) {
      transition(STATE.GAME_OVER);
    } else {
      _startNextRound();
    }
  }, CONFIG.RESULT_DISPLAY_MS);
}

/* ============================================================
   GAME OVER
   ============================================================ */

function _showGameOver() {
  dom.finalScoreDisplay.textContent = scoring.totalScore;
  dom.statCorrect.textContent       = `${correctCount}/${CONFIG.TOTAL_ROUNDS}`;
  dom.statCombo.textContent         = `${bestCombo}x`;
}

/* ============================================================
   ROUND MANAGEMENT
   ============================================================ */

function _startNextRound() {
  currentRound++;
  currentWord = _pickWord();
  transition(STATE.ROUND_START, { word: currentWord, round: currentRound });
}

function _pickWord() {
  // Avoid repeating words within one game
  const available = WORD_POOL.filter(w => !usedWords.includes(w));
  const pool      = available.length > 0 ? available : WORD_POOL;
  const word      = pool[Math.floor(Math.random() * pool.length)];
  usedWords.push(word);
  return word;
}

function _startGame() {
  // Reset all state
  scoring.reset();
  currentRound = 0;
  correctCount = 0;
  bestCombo    = 0;
  usedWords    = [];

  _startNextRound();
}

/* ============================================================
   AI INFERENCE — called by canvas onChange
   ============================================================ */

function runInference() {
  // Only run inference during the drawing phase
  if (currentState !== STATE.DRAWING) return;

  // Skip inference if canvas is blank — avoids creating tensors unnecessarily
  if (!canvas.hasDrawing()) {
    _resetPredictions();
    return;
  }

  const tensor      = canvas.getImageTensor();
  const predictions = model.predict(tensor);
  tensor.dispose();

  _renderPredictions(predictions);

  // Check if AI got it right
  const { correct, confidence } = model.checkCorrect(
    predictions,
    currentWord,
    CONFIG.CORRECT_THRESHOLD
  );

  if (correct) {
    _onCorrect(confidence);
  }
}

/* ============================================================
   PREDICTION UI
   ============================================================ */

function _renderPredictions(predictions) {
  dom.aiIdleMessage.classList.add('hidden');

  dom.predictionList.innerHTML = predictions.map((pred, index) => {
    const pct   = (pred.confidence * 100).toFixed(1);
    const isTop = index === 0;
    return `
      <li class="prediction-item ${isTop ? 'prediction-item--top' : ''}">
        <span class="prediction-label">${pred.displayLabel || pred.label}</span>
        <div class="prediction-bar-track">
          <div class="prediction-bar" style="width: ${pct}%"></div>
        </div>
        <span class="prediction-confidence">${pct}%</span>
      </li>
    `;
  }).join('');
}

function _resetPredictions() {
  dom.predictionList.innerHTML = '';
  dom.aiIdleMessage.classList.remove('hidden');
}

/* ============================================================
   EVENT LISTENERS
   ============================================================ */

dom.btnStart.addEventListener('click', _startGame);

dom.btnPlayAgain.addEventListener('click', _startGame);

dom.btnClear.addEventListener('click', () => {
  if (currentState !== STATE.DRAWING) return;
  canvas.clear();
  _resetPredictions();
});

document.getElementById('btn-exit').addEventListener('click', () => {
  // Clean up timers before leaving to prevent memory leaks
  clearInterval(roundTimer);
  clearInterval(countdownTimer);
  clearTimeout(resultTimer);
});

/* ============================================================
   INIT — load model then show ready screen
   ============================================================ */

async function init() {
  currentState = STATE.LOADING;

  dom.loadingScreen.classList.remove('hidden');
  dom.app.classList.add('hidden');

  try {
    // Load word categories
    const response   = await fetch('assets/words/categories.json');
    const categories = await response.json();

    // Flatten all tiers into one pool for free mode
    WORD_POOL.length = 0;
    WORD_POOL.push(...categories.easy, ...categories.medium, ...categories.hard);

    await model.load((status, msg) => {
      if (status === 'loading') dom.loadingMessage.textContent = 'Loading AI model...';
      if (status === 'error')   dom.loadingMessage.textContent = `Error: ${msg}`;
    });

    canvas = new DrawingCanvas(dom.drawingCanvas, runInference);

    dom.app.classList.remove('hidden');
    dom.loadingScreen.classList.add('hidden');
    transition(STATE.READY);

  } catch (err) {
    dom.loadingMessage.textContent = 'Failed to load model. Please refresh.';
    console.error('[Init]', err);
  }
}

init();