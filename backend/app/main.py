from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from dotenv import load_dotenv

from .analyzer import analyze_pgn, evaluate_fen
from .engine import find_stockfish

load_dotenv(Path(__file__).resolve().parents[1] / ".env")


class AnalyzeRequest(BaseModel):
    pgn: str = Field(..., min_length=1)


class EvaluateRequest(BaseModel):
    fen: str = Field(..., min_length=1)


app = FastAPI(title="Chess Review API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:3000",
        "http://127.0.0.1:3000",
    ],
    allow_origin_regex=r"http://(localhost|127\.0\.0\.1)(:\d+)?",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/health")
def health() -> dict:
    stockfish_path = find_stockfish()
    return {
        "ok": True,
        "stockfish": bool(stockfish_path),
        "stockfish_path": stockfish_path,
    }


@app.post("/api/analyze")
def analyze(request: AnalyzeRequest) -> dict:
    try:
        return analyze_pgn(request.pgn)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Analysis failed: {exc}") from exc


@app.post("/api/evaluate")
def evaluate(request: EvaluateRequest) -> dict:
    try:
        return evaluate_fen(request.fen)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Evaluation failed: {exc}") from exc
