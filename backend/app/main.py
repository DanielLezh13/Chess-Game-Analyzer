from __future__ import annotations

import logging
import os
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from dotenv import load_dotenv

from .analyzer import analyze_pgn, evaluate_fen
from .engine import find_stockfish

load_dotenv(Path(__file__).resolve().parents[1] / ".env")

logger = logging.getLogger(__name__)


def configured_origins() -> list[str]:
    configured = [
        origin.strip().rstrip("/")
        for origin in os.getenv("ALLOWED_ORIGINS", "").split(",")
        if origin.strip()
    ]
    return configured or [
        "http://localhost:3000",
        "http://127.0.0.1:3000",
    ]


def configured_origin_regex() -> str:
    return os.getenv(
        "ALLOWED_ORIGIN_REGEX",
        r"https://[-a-z0-9]+\.vercel\.app|http://(localhost|127\.0\.0\.1)(:\d+)?",
    )


class AnalyzeRequest(BaseModel):
    pgn: str = Field(..., min_length=1, max_length=200_000)


class EvaluateRequest(BaseModel):
    fen: str = Field(..., min_length=1, max_length=200)


app = FastAPI(title="Chess Review API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=configured_origins(),
    allow_origin_regex=configured_origin_regex(),
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Content-Type"],
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
        logger.exception("PGN analysis failed")
        raise HTTPException(status_code=500, detail="Analysis failed.") from exc


@app.post("/api/evaluate")
def evaluate(request: EvaluateRequest) -> dict:
    try:
        return evaluate_fen(request.fen)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        logger.exception("FEN evaluation failed")
        raise HTTPException(status_code=500, detail="Evaluation failed.") from exc
