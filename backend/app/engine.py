from __future__ import annotations

import os
import shutil
from dataclasses import dataclass
from typing import Optional

import chess
import chess.engine


MATE_SCORE = 100_000


@dataclass
class EvalScore:
    cp: int
    mate: Optional[int]
    display: str

    def as_dict(self) -> dict:
        return {"cp": self.cp, "mate": self.mate, "display": self.display}


@dataclass
class EngineLine:
    eval: EvalScore
    move: Optional[str]
    line: list[str]


@dataclass
class PositionAnalysis:
    eval: EvalScore
    best_move: Optional[str]
    best_line: list[str]
    top_lines: list[EngineLine]
    source: str


PIECE_VALUES = {
    chess.PAWN: 100,
    chess.KNIGHT: 300,
    chess.BISHOP: 300,
    chess.ROOK: 500,
    chess.QUEEN: 900,
    chess.KING: 0,
}


def find_stockfish() -> Optional[str]:
    configured = os.getenv("STOCKFISH_PATH", "").strip()
    if configured and os.path.exists(configured):
        return configured

    from_path = shutil.which("stockfish")
    if from_path:
        return from_path

    common_paths = [
        "/opt/homebrew/bin/stockfish",
        "/usr/local/bin/stockfish",
        "/usr/bin/stockfish",
    ]
    for path in common_paths:
        if os.path.exists(path):
            return path

    return None


def game_over_eval(board: chess.Board) -> Optional[PositionAnalysis]:
    if board.is_checkmate():
        winner_is_white = board.turn == chess.BLACK
        cp = MATE_SCORE if winner_is_white else -MATE_SCORE
        mate = 0
        return PositionAnalysis(
            eval=EvalScore(cp=cp, mate=mate, display="M0" if winner_is_white else "-M0"),
            best_move=None,
            best_line=[],
            top_lines=[],
            source="terminal",
        )

    if board.is_stalemate() or board.is_insufficient_material() or board.is_seventyfive_moves() or board.is_fivefold_repetition():
        return PositionAnalysis(
            eval=EvalScore(cp=0, mate=None, display="0.00"),
            best_move=None,
            best_line=[],
            top_lines=[],
            source="terminal",
        )

    return None


def score_to_eval(score: chess.engine.PovScore) -> EvalScore:
    white_score = score.pov(chess.WHITE)
    mate = white_score.mate()
    cp = white_score.score(mate_score=MATE_SCORE)
    if cp is None:
        cp = 0

    if mate is not None:
        prefix = "+" if mate > 0 else "-"
        display = f"{prefix}M{abs(mate)}"
    else:
        display = f"{cp / 100:+.2f}"

    return EvalScore(cp=int(cp), mate=mate, display=display)


def material_eval(board: chess.Board) -> EvalScore:
    terminal = game_over_eval(board)
    if terminal:
        return terminal.eval

    score = 0
    for piece_type, value in PIECE_VALUES.items():
        score += len(board.pieces(piece_type, chess.WHITE)) * value
        score -= len(board.pieces(piece_type, chess.BLACK)) * value

    # Tiny mobility term keeps the fallback from feeling completely static.
    turn = board.turn
    board.turn = chess.WHITE
    white_mobility = board.legal_moves.count()
    board.turn = chess.BLACK
    black_mobility = board.legal_moves.count()
    board.turn = turn

    score += (white_mobility - black_mobility) * 2
    return EvalScore(cp=int(score), mate=None, display=f"{score / 100:+.2f}")


def fallback_best_move(board: chess.Board) -> Optional[chess.Move]:
    if board.is_game_over():
        return None

    mover = board.turn
    best_move = None
    best_score = -10**9

    for move in board.legal_moves:
        board.push(move)
        score = material_eval(board).cp
        mover_score = score if mover == chess.WHITE else -score
        if board.is_checkmate():
            mover_score += 50_000
        if mover_score > best_score:
            best_score = mover_score
            best_move = move
        board.pop()

    return best_move


def fallback_top_lines(board: chess.Board, limit: int = 3) -> list[EngineLine]:
    if board.is_game_over():
        return []

    mover = board.turn
    candidates: list[tuple[int, EngineLine]] = []

    for move in board.legal_moves:
        board.push(move)
        eval_score = material_eval(board)
        mover_score = eval_score.cp if mover == chess.WHITE else -eval_score.cp
        if board.is_checkmate():
            mover_score += 50_000
        candidates.append(
            (
                mover_score,
                EngineLine(
                    eval=eval_score,
                    move=move.uci(),
                    line=[move.uci()],
                ),
            )
        )
        board.pop()

    candidates.sort(key=lambda item: item[0], reverse=True)
    return [line for _, line in candidates[:limit]]


def analyze_positions_with_fallback(boards: list[chess.Board]) -> list[PositionAnalysis]:
    analyses: list[PositionAnalysis] = []
    for board in boards:
        terminal = game_over_eval(board)
        if terminal:
            analyses.append(terminal)
            continue

        top_lines = fallback_top_lines(board)
        best_move = top_lines[0].move if top_lines else None
        analyses.append(
            PositionAnalysis(
                eval=material_eval(board),
                best_move=best_move,
                best_line=top_lines[0].line if top_lines else [],
                top_lines=top_lines,
                source="fallback",
            )
        )

    return analyses


def analyze_positions(boards: list[chess.Board], depth: int) -> list[PositionAnalysis]:
    stockfish_path = find_stockfish()
    if not stockfish_path:
        return analyze_positions_with_fallback(boards)

    analyses: list[PositionAnalysis] = []
    engine = chess.engine.SimpleEngine.popen_uci(stockfish_path)
    try:
        for board in boards:
            terminal = game_over_eval(board)
            if terminal:
                analyses.append(terminal)
                continue

            raw_info = engine.analyse(board, chess.engine.Limit(depth=depth), multipv=3)
            info_rows = raw_info if isinstance(raw_info, list) else [raw_info]
            top_lines: list[EngineLine] = []

            for info in info_rows:
                pv = info.get("pv", [])
                top_lines.append(
                    EngineLine(
                        eval=score_to_eval(info["score"]),
                        move=pv[0].uci() if pv else None,
                        line=[move.uci() for move in pv[:6]],
                    )
                )

            primary = top_lines[0] if top_lines else None
            analyses.append(
                PositionAnalysis(
                    eval=primary.eval if primary else material_eval(board),
                    best_move=primary.move if primary else None,
                    best_line=primary.line if primary else [],
                    top_lines=top_lines,
                    source="stockfish",
                )
            )
    finally:
        engine.quit()

    return analyses
