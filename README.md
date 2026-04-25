# Chess Review

A local-first chess game review MVP. Paste a PGN, run engine analysis, and step through the game with an eval bar, best-move suggestion, move labels, and summary stats.

The app is intentionally PGN-first. Account sync and Chess.com import can be added later after the review loop is solid.

It also has a live board mode for quick testing: start from the normal initial position, drag legal moves, see the detected opening, current eval, best move, and then send the moves into the full review flow.

## Stack

- `frontend/`: Next.js App Router, TypeScript, Tailwind CSS, React, `react-chessboard`, `chess.js`
- `backend/`: FastAPI, `python-chess`, Stockfish through the UCI protocol

## Requirements

- Node.js 20+
- Python 3.9+
- Stockfish binary recommended

On macOS, Stockfish can usually be installed with:

```bash
brew install stockfish
```

If Stockfish is not installed, the backend still returns a heuristic fallback analysis so the UI can be tested. Real move quality requires Stockfish.

## Run Locally

Fast path from the project root:

```bash
npm run dev
```

Or double-click `Start Chess Review.command` on macOS. The launcher installs missing dependencies, starts the backend and frontend, and opens [http://localhost:3000](http://localhost:3000).

In Codex Desktop, use the top-right Run/play action. It is configured by `.codex/environments/environment.toml` and runs the same `npm run dev` launcher.

Install frontend dependencies:

```bash
cd frontend
npm install
cp .env.example .env.local
npm run dev
```

Install backend dependencies and start the API:

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
uvicorn app.main:app --reload --port 8000
```

Open the frontend at [http://localhost:3000](http://localhost:3000).

## Environment

Backend:

- `STOCKFISH_PATH`: optional absolute path to a Stockfish binary
- `ENGINE_DEPTH`: optional search depth, default `8`

Frontend:

- `NEXT_PUBLIC_API_URL`: backend URL, default `http://localhost:8000`

## API

### `GET /api/health`

Returns backend health and whether Stockfish was found.

### `POST /api/analyze`

Input:

```json
{
  "pgn": "..."
}
```

Output includes:

- `metadata`
- `moves`
- `summary`
- per-move FEN, SAN, played move, best move, evals, centipawn loss, classification, and explanation

### `POST /api/evaluate`

Input:

```json
{
  "fen": "..."
}
```

Output includes the current eval, best move, best line, side to move, and analysis source.

## Sample PGN

Use `samples/sample.pgn` or the sample button in the app.
