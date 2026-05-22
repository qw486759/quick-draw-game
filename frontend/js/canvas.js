/* ============================================================
   canvas.js
   Responsibilities:
   - Mouse & touch drawing on <canvas>
   - Expose getImageTensor() for AI inference
   - Expose clear() and onChange callback
   - Dispatch 'strokeend' CustomEvent after each stroke so that
     controllers (game-single.js, game-challenge.js) can listen
     without needing a callback reference at construction time.
     Debounce is intentionally NOT done here — each controller
     manages its own debounce to avoid double-delay.
   ============================================================ */

class DrawingCanvas {
  /**
   * @param {HTMLCanvasElement} canvasEl
   * @param {function} onChangeCallback - called after each stroke ends
   *   (kept for backwards compatibility with game-single.js)
   */
  constructor(canvasEl, onChangeCallback) {
    this.canvas    = canvasEl;
    this.ctx       = canvasEl.getContext('2d');
    this.isDrawing = false;
    this.lastX     = 0;
    this.lastY     = 0;
    this.onChange  = onChangeCallback || null;

    this._setupContext();
    this._setupEvents();
  }

  /* ── Setup ──────────────────────────────────────────────── */

  _setupContext() {
    this.ctx.strokeStyle = '#000000';
    this.ctx.lineWidth   = 8;
    this.ctx.lineCap     = 'round';  // rounded ends look more natural
    this.ctx.lineJoin    = 'round';  // rounded corners at direction changes
  }

  _setupEvents() {
    // Mouse events
    this.canvas.addEventListener('mousedown',  (e) => this._startDraw(e));
    this.canvas.addEventListener('mousemove',  (e) => this._draw(e));
    this.canvas.addEventListener('mouseup',    ()  => this._endDraw());
    this.canvas.addEventListener('mouseleave', ()  => this._endDraw());

    // Touch events (mobile support)
    this.canvas.addEventListener('touchstart', (e) => {
      e.preventDefault(); // prevent page scroll while drawing
      this._startDraw(e.touches[0]);
    }, { passive: false });

    this.canvas.addEventListener('touchmove', (e) => {
      e.preventDefault();
      this._draw(e.touches[0]);
    }, { passive: false });

    this.canvas.addEventListener('touchend', () => this._endDraw());
  }

  /* ── Drawing ────────────────────────────────────────────── */

  _getPosition(e) {
    // getBoundingClientRect gives canvas position relative to viewport
    // We subtract it to get coordinates relative to the canvas itself
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
    };
  }

  _startDraw(e) {
    this.isDrawing = true;
    const { x, y } = this._getPosition(e);
    this.lastX = x;
    this.lastY = y;

    // Draw a dot for single clicks (no movement)
    this.ctx.beginPath();
    this.ctx.arc(x, y, this.ctx.lineWidth / 2, 0, Math.PI * 2);
    this.ctx.fillStyle = '#000000';
    this.ctx.fill();
  }

  _draw(e) {
    if (!this.isDrawing) return;

    const { x, y } = this._getPosition(e);

    this.ctx.beginPath();
    this.ctx.moveTo(this.lastX, this.lastY);
    this.ctx.lineTo(x, y);
    this.ctx.stroke();

    this.lastX = x;
    this.lastY = y;
  }

  _endDraw() {
    if (!this.isDrawing) return;
    this.isDrawing = false;

    // Notify via CustomEvent — controllers listen for 'strokeend'
    // and apply their own debounce. No debounce here to avoid
    // stacking delays (canvas 200ms + controller 200ms = 400ms lag).
    this.canvas.dispatchEvent(new CustomEvent('strokeend'));

    // Also call legacy onChange callback for backwards compatibility
    // (game-single.js passes a callback at construction time)
    if (this.onChange) this.onChange();
  }

  /* ── Public API ─────────────────────────────────────────── */

  clear() {
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    if (this.onChange) this.onChange();
  }

  /**
   * Converts canvas content to a tensor for AI inference.
   * Output shape: [1, 28, 28, 1]
   *   - 1     = batch size
   *   - 28x28 = model input size
   *   - 1     = grayscale channel
   *
   * @returns {tf.Tensor4D}
   */
  getImageTensor() {
    const WIDTH  = this.canvas.width;
    const HEIGHT = this.canvas.height;

    // Step 1: get full canvas pixel data
    const full    = this.ctx.getImageData(0, 0, WIDTH, HEIGHT);
    const data    = full.data;

    // Step 2: find bounding box of all drawn pixels (non-white alpha > 0)
    let minX = WIDTH, maxX = 0, minY = HEIGHT, maxY = 0;
    for (let y = 0; y < HEIGHT; y++) {
      for (let x = 0; x < WIDTH; x++) {
        const a = data[(y * WIDTH + x) * 4 + 3]; // alpha channel
        if (a > 0) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }

    // Step 3: if canvas is blank, return all-zeros tensor
    if (minX > maxX || minY > maxY) {
      return tf.zeros([1, 28, 28, 1]);
    }

    // Step 4: add padding (10% of bounding box size) around the drawing
    const pad  = Math.max(Math.round((maxX - minX) * 0.1), 4);
    minX = Math.max(0, minX - pad);
    minY = Math.max(0, minY - pad);
    maxX = Math.min(WIDTH  - 1, maxX + pad);
    maxY = Math.min(HEIGHT - 1, maxY + pad);

    // Step 5: crop the bounding box into a temp offscreen canvas
    const cropW = maxX - minX + 1;
    const cropH = maxY - minY + 1;
    const crop  = document.createElement('canvas');
    crop.width  = cropW;
    crop.height = cropH;
    const cropCtx = crop.getContext('2d');

    // White background
    cropCtx.fillStyle = '#ffffff';
    cropCtx.fillRect(0, 0, cropW, cropH);
    cropCtx.drawImage(this.canvas, minX, minY, cropW, cropH, 0, 0, cropW, cropH);

    // Step 6: scale cropped image down to 28x28
    const offscreen = document.createElement('canvas');
    offscreen.width  = 28;
    offscreen.height = 28;
    const offCtx = offscreen.getContext('2d');
    offCtx.fillStyle = '#ffffff';
    offCtx.fillRect(0, 0, 28, 28);
    offCtx.drawImage(crop, 0, 0, 28, 28);

    // Step 7: convert to grayscale tensor
    // Model input: black stroke = 0, white background = 1
    const imageData = offCtx.getImageData(0, 0, 28, 28);
    const grayscale = [];
    for (let i = 0; i < imageData.data.length; i += 4) {
      const r = imageData.data[i];
      grayscale.push(r / 255); // white bg = 1.0, black stroke ≈ 0
    }

    return tf.tensor4d(grayscale, [1, 28, 28, 1]);
  }
}