/**
 * model.js
 * Handles TF.js model loading and inference.
 *
 * IMPORTANT: CATEGORIES order must exactly match the training order used in train-model.js.
 * Training order: see CATEGORIES array below (20 classes)
 */

// ── Category list (must match training order) ─────────────────────────────
const CATEGORIES = [
  "cat", "dog", "house", "sun", "tree", "fish", "star",
  "car", "airplane", "umbrella", "guitar", "clock", "flower", "bicycle",
  "elephant", "penguin", "crown", "lighthouse", "snowflake", "cactus",
];

// Capitalize first letter for display
function toDisplayLabel(label) {
  return label.charAt(0).toUpperCase() + label.slice(1);
}

// ── Model path ────────────────────────────────────────────────────────────
const MODEL_PATH = './assets/model/model.json';

// ── QuickDrawModel ────────────────────────────────────────────────────────
class QuickDrawModel {
  constructor() {
    this.model     = null;
    this.isLoading = false;
    this.isReady   = false;
  }

  /**
   * Load the TF.js model asynchronously.
   * @param {Function} onProgress - callback(status: 'loading'|'ready'|'error', message?)
   */
  async load(onProgress) {
    if (this.isLoading || this.isReady) return;
    this.isLoading = true;

    try {
      console.log('[Model] Loading model...');
      if (onProgress) onProgress('loading');

      this.model = await tf.loadLayersModel(MODEL_PATH);

      // Warm-up run: prevents first-inference lag
      const dummy  = tf.zeros([1, 28, 28, 1]);
      const warmup = this.model.predict(dummy);
      warmup.dispose();
      dummy.dispose();

      this.isReady   = true;
      this.isLoading = false;
      console.log('[Model] Model ready');
      if (onProgress) onProgress('ready');

    } catch (err) {
      this.isLoading = false;
      console.error('[Model] Load failed:', err.message);
      if (onProgress) onProgress('error', err.message);
      throw err;
    }
  }

  /**
   * Run inference on a canvas tensor.
   * @param {tf.Tensor4D} tensor - shape [1, 28, 28, 1], values in [0, 1]
   * @returns {Array<{label: string, displayLabel: string, confidence: number}>} Top-5 sorted by confidence
   */
  predict(tensor) {
    if (!this.isReady) {
      console.warn('[Model] Model not ready');
      return [];
    }

    const results = tf.tidy(() => {
      const output = this.model.predict(tensor); // shape: [1, 20]
      const values = output.dataSync();

      return Array.from(values).map((confidence, i) => ({
        label:        CATEGORIES[i],
        displayLabel: toDisplayLabel(CATEGORIES[i]),
        confidence:   confidence,
      }));
    });

    // Sort by confidence descending
    results.sort((a, b) => b.confidence - a.confidence);
    return results.slice(0, 5); // return Top-5 only
  }

  /**
   * Check whether the model's top prediction matches the target word.
   * @param {Array}  predictions - output from predict()
   * @param {string} targetWord  - category label to check (e.g. 'cat')
   * @param {number} threshold   - minimum confidence to count as correct (0–1), default 0.5
   * @returns {{ correct: boolean, confidence: number }}
   */
  checkCorrect(predictions, targetWord, threshold = 0.5) {
    if (!predictions || predictions.length === 0) {
      return { correct: false, confidence: 0 };
    }

    const top1      = predictions[0];
    const correct   = top1.label === targetWord && top1.confidence >= threshold;
    const target    = predictions.find(p => p.label === targetWord);
    const confidence = target ? target.confidence : 0;

    return { correct, confidence };
  }
}

// ── Singleton instance ────────────────────────────────────────────────────
const quickDrawModel = new QuickDrawModel();