/* ============================================================
   scoring.js
   Responsibilities:
   - Calculate round score based on time, confidence, combo  (M2)
   - Calculate challenge mode round score                    (M3)
   - Track combo streak across rounds
   - Expose a clean API for game-single.js / game-challenge.js to call
   ============================================================ */

// ── Constants ─────────────────────────────────────────────────────────────

const SCORE_BASE          = 1000;
const SCORE_CONFIDENCE_MULTIPLIER = 200; // confidence * 200

// Time bonus thresholds (seconds remaining when correct)
// Key = minimum seconds remaining, Value = bonus points
const TIME_BONUSES = [
  { minSecondsLeft: 15, bonus: 500 }, // guessed within first 5s (20-15=5)
  { minSecondsLeft: 10, bonus: 300 },
  { minSecondsLeft:  5, bonus: 150 },
  { minSecondsLeft:  0, bonus:  50 },
];

// Combo multipliers: index = combo count (capped at 4)
// combo 0 or 1 = no multiplier, 2 = 1.2x, 3 = 1.5x, 4+ = 2.0x
const COMBO_MULTIPLIERS = [1.0, 1.0, 1.2, 1.5, 2.0];

// Challenge mode: points awarded per round = round number × this value
const CHALLENGE_POINTS_PER_ROUND = 100;

// ── ScoringSystem (M2 — Free Mode) ───────────────────────────────────────

class ScoringSystem {
  constructor() {
    this.totalScore  = 0;
    this.comboStreak = 0; // consecutive correct rounds
  }

  /**
   * Reset all scores (call at game start).
   */
  reset() {
    this.totalScore  = 0;
    this.comboStreak = 0;
  }

  /**
   * Calculate and apply the score for a correct round.
   *
   * @param {number} secondsLeft  - how many seconds were left when AI guessed correctly
   * @param {number} confidence   - AI confidence (0 to 1)
   * @returns {{ roundScore: number, breakdown: object, newTotal: number }}
   */
  scoreCorrect(secondsLeft, confidence) {
    // 1. Base score
    const base = SCORE_BASE;

    // 2. Time bonus: find the highest tier the player qualifies for
    const timeBonus = this._getTimeBonus(secondsLeft);

    // 3. Confidence bonus
    const confidenceBonus = Math.round(confidence * SCORE_CONFIDENCE_MULTIPLIER);

    // 4. Combo multiplier (increment streak first)
    this.comboStreak++;
    const multiplier = this._getComboMultiplier(this.comboStreak);

    // 5. Final round score
    const roundScore = Math.round((base + timeBonus + confidenceBonus) * multiplier);

    this.totalScore += roundScore;

    return {
      roundScore,
      newTotal: this.totalScore,
      breakdown: {
        base,
        timeBonus,
        confidenceBonus,
        multiplier,
        comboStreak: this.comboStreak,
      },
    };
  }

  /**
   * Record a missed round (time ran out). Resets combo streak.
   * @returns {{ roundScore: 0, newTotal: number }}
   */
  scoreMiss() {
    this.comboStreak = 0; // break the combo
    return {
      roundScore: 0,
      newTotal: this.totalScore,
    };
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  _getTimeBonus(secondsLeft) {
    for (const tier of TIME_BONUSES) {
      if (secondsLeft >= tier.minSecondsLeft) return tier.bonus;
    }
    return 0;
  }

  _getComboMultiplier(streak) {
    const index = Math.min(streak, COMBO_MULTIPLIERS.length - 1);
    return COMBO_MULTIPLIERS[index];
  }
}

// ── Challenge Mode Scoring (M3) ───────────────────────────────────────────

/**
 * Calculate the score awarded for passing a challenge round.
 *
 * Formula (from handbook §9.2):
 *   round 1 →  100 pts
 *   round 2 →  200 pts
 *   ...
 *   round N →  N × 100 pts
 *
 * Cumulative example: clear rounds 1–5 → 100+200+300+400+500 = 1500 pts
 *
 * This is a pure function — no state, no side effects.
 * game-challenge.js owns the running total; this function only
 * returns the points for a single round.
 *
 * @param {number} round - the round number that was just cleared (1-indexed)
 * @returns {number} points awarded for this round
 */
function calcChallengeScore(round) {
  return round * CHALLENGE_POINTS_PER_ROUND;
}