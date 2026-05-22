# Quick Draw

A browser-based AI drawing game powered by TensorFlow.js. Draw a sketch — a CNN model watches every stroke and tries to name it in real time. Supports single-player modes and multiplayer via WebSocket.

<img width="1919" height="920" alt="image" src="https://github.com/user-attachments/assets/0a43e73b-7bc7-4cad-9164-d33d25d6ba80" />


---

## Features

- **Free Mode** — 6 rounds, 20 seconds each. Let the AI guess your drawing.
- **Challenge Mode** — Hit the confidence threshold to pass. Clock gets tighter every round.
- **Versus Mode** — 2–6 players, same prompt, AI scores everyone. Scores hidden until time's up.

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | Vanilla HTML / CSS / JavaScript |
| ML Inference | TensorFlow.js 4.x (runs entirely in-browser) |
| Real-time | Socket.io 4.x |
| Backend | Node.js + Express |
| Model | Custom CNN trained on Google Quick Draw! dataset |

> The server never does ML inference — all AI runs client-side, zero latency.

---

## Getting Started

### Prerequisites

- Node.js 18+
- npm

### Installation

```bash
# Clone the repo
git clone https://github.com/YOUR_USERNAME/quick-draw-game.git
cd quick-draw-game/quickdraw

# Install dependencies
npm install

# Start the dev server
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

---

## Project Structure

```
quickdraw/
├── frontend/
│   ├── index.html          # Main menu
│   ├── game.html           # Free mode
│   ├── challenge.html      # Challenge mode
│   ├── lobby.html          # Multiplayer lobby
│   ├── room.html           # Room waiting screen
│   ├── game-multi.html     # Multiplayer game
│   ├── css/
│   │   ├── reset.css
│   │   ├── room-game.css   # Shared design tokens + components
│   │   ├── game.css        # Free mode + Challenge mode styles
│   │   ├── game-multi.css  # Multiplayer game styles
│   │   ├── lobby.css       # Lobby page styles
│   │   └── index.css       # Main menu styles
│   ├── js/
│   │   ├── canvas.js       # Mouse & touch drawing, tensor export
│   │   ├── model.js        # TF.js model loading + inference
│   │   ├── scoring.js      # Score calculation (free mode + challenge)
│   │   ├── game-single.js  # Free mode controller
│   │   ├── game-challenge.js # Challenge mode controller
│   │   ├── game-multi.js   # Multiplayer game controller
│   │   ├── socket-client.js # Socket.io singleton wrapper
│   │   ├── lobby.js        # Lobby controller
│   │   └── room.js         # Room controller
│   └── assets/
│       ├── model/          # TF.js model (model.json + weights.bin)
│       └── words/
│           └── categories.json
├── backend/
│   ├── server.js           # Express + Socket.io entry point
│   ├── room-manager.js     # In-memory room state (pure data layer)
│   └── routes/
│       └── rooms.js        # REST: GET/POST /api/rooms
├── scripts/
│   ├── train_model.py      # CNN training script (Python / Keras)
│   └── convert_model.py    # Keras .h5 → TF.js format converter
└── package.json
```

---

## Model

- **Architecture**: Custom CNN trained with Keras / TensorFlow
- **Dataset**: [Google Quick Draw!](https://github.com/googlecreativelab/quickdraw-dataset) `.npy` files
- **Categories**: 20 classes — cat, dog, house, sun, tree, fish, star, car, airplane, umbrella, guitar, clock, flower, bicycle, elephant, penguin, crown, lighthouse, snowflake, cactus
- **Validation accuracy**: 88.4%
- **Format**: Keras `.h5` converted to TF.js `LayersModel` via a custom script (see `scripts/convert_model.py`)

### Pixel polarity

The model was trained on white-background / black-stroke images, normalized with `pixel / 255` (no inversion). The canvas pipeline mirrors this exactly.

---

## Multiplayer Architecture

```
Browser (client)                    Node.js server
─────────────────                   ──────────────
Canvas drawing
    ↓
TF.js inference (local)  ←── AI never touches the server
    ↓
submit_score ──────────────────────→ store latest score
                                           ↓
                         timer expires → endRound()
                                           ↓
round_end ←────────────────────── broadcast rankings
```

Key design decision: scores are only broadcast **after** the round ends, so players can't see each other's scores mid-round.

---

## Development Milestones

| Milestone | Description |
|---|---|
| M1 | Canvas drawing + TF.js model loading and inference |
| M2 | Single-player free mode (timer, scoring, combo) |
| M3 | Challenge mode (difficulty tiers, confidence threshold) |
| M4 | Multiplayer lobby (REST API + Socket.io room management) |
| M5 | Multiplayer game loop (server-side timer, round sync, rankings) |
| M6 | UI polish (topbar, screen transitions, game-over card) |

---

## License

MIT
