from __future__ import annotations

import io
import math
import os
from typing import Any, Optional

import chess
import chess.pgn

from .engine import EvalScore, MATE_SCORE, analyze_positions


INITIAL_FEN = chess.STARTING_FEN
MATERIAL_VALUES = {
    chess.PAWN: 100,
    chess.KNIGHT: 300,
    chess.BISHOP: 300,
    chess.ROOK: 500,
    chess.QUEEN: 900,
    chess.KING: 0,
}

PIECE_NAMES = {
    chess.PAWN: "pawn",
    chess.KNIGHT: "knight",
    chess.BISHOP: "bishop",
    chess.ROOK: "rook",
    chess.QUEEN: "queen",
}


def material_balance(board: chess.Board) -> int:
    score = 0
    for piece_type, value in MATERIAL_VALUES.items():
        score += len(board.pieces(piece_type, chess.WHITE)) * value
        score -= len(board.pieces(piece_type, chess.BLACK)) * value
    return score


def format_material_balance(balance: int) -> str:
    points = balance / 100.0
    return f"{points:+.1f}"


def captured_piece_info(board: chess.Board, move: chess.Move) -> Optional[dict[str, Any]]:
    if not board.is_capture(move):
        return None

    capture_square = move.to_square
    if board.is_en_passant(move):
        capture_square = move.to_square - 8 if board.turn == chess.WHITE else move.to_square + 8

    piece = board.piece_at(capture_square)
    if piece is None:
        return None

    return {
        "type": PIECE_NAMES.get(piece.piece_type, "piece"),
        "color": "white" if piece.color == chess.WHITE else "black",
        "value": MATERIAL_VALUES.get(piece.piece_type, 0),
    }


def expected_points_from_cp(cp: int) -> float:
    clamped = max(-1200, min(1200, cp))
    return 1.0 / (1.0 + math.exp(-clamped / 300.0))


def mover_expected_points(eval_score: EvalScore, color: str) -> float:
    white_expected = expected_points_from_cp(eval_score.cp)
    return white_expected if color == "white" else 1.0 - white_expected


def classification_for_move(
    *,
    expected_loss: float,
    cp_loss: int,
    played_uci: str,
    best_uci: Optional[str],
    ply: int,
    is_sacrifice: bool,
    before_expected: float,
) -> str:
    if ply <= 10 and expected_loss <= 0.02:
        return "book"
    if is_sacrifice and expected_loss <= 0.02:
        return "brilliant"
    if best_uci and played_uci == best_uci:
        return "best"
    if before_expected >= 0.80 and expected_loss >= 0.10 and cp_loss >= 100:
        return "miss"
    if expected_loss <= 0.02 and cp_loss >= 60:
        return "great"
    if expected_loss <= 0.02:
        return "excellent"
    if expected_loss <= 0.05:
        return "good"
    if expected_loss <= 0.10:
        return "inaccuracy"
    if expected_loss <= 0.20:
        return "mistake"
    return "blunder"


def explanation_for(classification: str, loss: int, expected_loss: float, best_san: Optional[str]) -> str:
    point_loss = f"{expected_loss * 100:.0f}%"
    if classification == "book":
        return "A standard opening move that keeps the game in known territory."
    if classification == "brilliant":
        return f"A strong sacrifice that the engine approves. {best_san or 'The best line'} keeps the compensation."
    if classification == "best":
        return "Matches the engine's top choice."
    if classification == "great":
        return f"A critical move that keeps the position healthy. {best_san or 'The engine move'} was the main comparison."
    if classification == "excellent":
        return f"Keeps the position very close to the best line, changing expected points by about {point_loss}."
    if classification == "good":
        return f"A playable move, though {best_san or 'the engine move'} was a little more precise."
    if classification == "inaccuracy":
        return f"Loses some control of the position. The engine preferred {best_san or 'another move'}."
    if classification == "miss":
        return f"Missed a chance to keep a strong advantage. {best_san or 'Another move'} was the key try."
    if classification == "mistake":
        return f"A significant swing. {best_san or 'The engine move'} would have preserved more of the position."
    return f"A major tactical or positional drop. The engine strongly preferred {best_san or 'another move'}."


def opening_from_headers(headers: chess.pgn.Headers) -> str:
    opening = headers.get("Opening", "").strip()
    variation = headers.get("Variation", "").strip()
    eco = headers.get("ECO", "").strip()

    if opening and variation:
        return f"{opening}: {variation}"
    if opening:
        return opening
    if eco:
        return eco
    return "Unknown"


def mover_pov(cp: int, color: str) -> int:
    return cp if color == "white" else -cp


def best_move_san(board: chess.Board, best_uci: Optional[str]) -> Optional[str]:
    if not best_uci:
        return None
    try:
        move = chess.Move.from_uci(best_uci)
    except ValueError:
        return best_uci

    if move not in board.legal_moves:
        return best_uci
    return board.san(move)


def line_to_san(board: chess.Board, line: list[str]) -> list[str]:
    preview = board.copy(stack=False)
    san_moves: list[str] = []

    for uci in line:
        try:
            move = chess.Move.from_uci(uci)
        except ValueError:
            break

        if move not in preview.legal_moves:
            break

        san_moves.append(preview.san(move))
        preview.push(move)

    return san_moves


def engine_lines_payload(board: chess.Board, analysis: Any) -> list[dict[str, Any]]:
    payload: list[dict[str, Any]] = []

    for rank, line in enumerate(getattr(analysis, "top_lines", []), start=1):
        payload.append(
            {
                "rank": rank,
                "move": line.move,
                "move_san": best_move_san(board, line.move),
                "line": line_to_san(board, line.line),
                "eval": line.eval.as_dict(),
            }
        )

    return payload


def accuracy_for(losses: list[int]) -> float:
    if not losses:
        return 0.0
    capped_average_loss = sum(min(loss, 1000) for loss in losses) / len(losses)
    return round(max(0.0, min(100.0, 100.0 - capped_average_loss / 10.0)), 1)


def parse_game(pgn: str) -> chess.pgn.Game:
    game = chess.pgn.read_game(io.StringIO(pgn.strip()))
    if game is None:
        raise ValueError("Could not parse PGN. Paste a complete game in PGN format.")
    return game


def analyze_pgn(pgn: str) -> dict[str, Any]:
    if not pgn.strip():
        raise ValueError("PGN is empty.")

    game = parse_game(pgn)
    headers = game.headers
    board = game.board()

    positions = [board.copy(stack=False)]
    raw_moves: list[dict[str, Any]] = []
    captured_by_white: list[dict[str, Any]] = []
    captured_by_black: list[dict[str, Any]] = []

    for ply, move in enumerate(game.mainline_moves(), start=1):
        fen_before = board.fen()
        san = board.san(move)
        color = "white" if board.turn == chess.WHITE else "black"
        move_number = board.fullmove_number
        uci = move.uci()
        capture = captured_piece_info(board, move)

        board.push(move)
        fen_after = board.fen()
        material_after = material_balance(board)
        if capture is not None:
            if color == "white":
                captured_by_white.append(capture)
            else:
                captured_by_black.append(capture)
        raw_moves.append(
            {
                "ply": ply,
                "move_number": move_number,
                "color": color,
                "san": san,
                "uci": uci,
                "fen_before": fen_before,
                "fen_after": fen_after,
                "captured_piece": capture,
                "material_balance_cp": material_after,
                "material_balance_display": format_material_balance(material_after),
            }
        )
        positions.append(board.copy(stack=False))

    depth = int(os.getenv("ENGINE_DEPTH", "8") or "8")
    analyses = analyze_positions(positions, depth=depth)
    analysis_source = analyses[0].source if analyses else "unknown"

    moves: list[dict[str, Any]] = []
    losses_by_side = {"white": [], "black": []}
    counts = {
        "white": {"inaccuracy": 0, "mistake": 0, "blunder": 0},
        "black": {"inaccuracy": 0, "mistake": 0, "blunder": 0},
    }
    biggest_turning_point: Optional[dict[str, Any]] = None

    for idx, raw in enumerate(raw_moves):
        before = analyses[idx]
        after = analyses[idx + 1]
        color = raw["color"]
        before_engine_lines = engine_lines_payload(positions[idx], before)
        after_engine_lines = engine_lines_payload(positions[idx + 1], after)

        best_san = before_engine_lines[0]["move_san"] if before_engine_lines else best_move_san(positions[idx], before.best_move)
        before_cp = before.eval.cp
        after_cp = after.eval.cp
        loss = max(0, mover_pov(before_cp, color) - mover_pov(after_cp, color))
        before_expected = mover_expected_points(before.eval, color)
        after_expected = mover_expected_points(after.eval, color)
        expected_loss = max(0.0, before_expected - after_expected)
        material_before = material_balance(positions[idx])
        material_after = material_balance(positions[idx + 1])
        material_delta_for_mover = mover_pov(material_after - material_before, color)
        is_sacrifice = material_delta_for_mover <= -250

        # Mate scores are useful for classification but too large for summary math.
        summary_loss = min(loss, MATE_SCORE)
        classification = classification_for_move(
            expected_loss=expected_loss,
            cp_loss=summary_loss,
            played_uci=raw["uci"],
            best_uci=before.best_move,
            ply=raw["ply"],
            is_sacrifice=is_sacrifice,
            before_expected=before_expected,
        )
        explanation = explanation_for(classification, summary_loss, expected_loss, best_san)

        if classification in counts[color]:
            counts[color][classification] += 1
        losses_by_side[color].append(summary_loss)

        move_result = {
            **raw,
            "eval_before": before.eval.as_dict(),
            "eval_after": after.eval.as_dict(),
            "best_move": before.best_move,
            "best_move_san": best_san,
            "best_line": before_engine_lines[0]["line"] if before_engine_lines else line_to_san(positions[idx], before.best_line),
            "engine_lines": before_engine_lines,
            "reply_engine_lines": after_engine_lines,
            "centipawn_loss": summary_loss,
            "expected_points_loss": round(expected_loss, 4),
            "classification": classification,
            "explanation": explanation,
        }
        moves.append(move_result)

        if biggest_turning_point is None or summary_loss > biggest_turning_point["centipawn_loss"]:
            biggest_turning_point = {
                "ply": raw["ply"],
                "move_number": raw["move_number"],
                "color": color,
                "san": raw["san"],
                "centipawn_loss": summary_loss,
                "classification": classification,
            }

    metadata = {
        "event": headers.get("Event", "Unknown"),
        "site": headers.get("Site", "Unknown"),
        "date": headers.get("Date", "Unknown"),
        "white": headers.get("White", "White"),
        "black": headers.get("Black", "Black"),
        "result": headers.get("Result", "*"),
        "opening": opening_from_headers(headers),
        "initial_fen": positions[0].fen() if positions else INITIAL_FEN,
        "analysis_source": analysis_source,
        "engine_depth": depth,
    }

    summary = {
        "white": {
            **counts["white"],
            "accuracy": accuracy_for(losses_by_side["white"]),
        },
        "black": {
            **counts["black"],
            "accuracy": accuracy_for(losses_by_side["black"]),
        },
        "material_balance_cp": material_balance(positions[-1]) if positions else 0,
        "material_balance_display": format_material_balance(material_balance(positions[-1])) if positions else "+0.0",
        "captured": {
            "white": captured_by_white,
            "black": captured_by_black,
        },
        "biggest_turning_point": biggest_turning_point,
        "total_plies": len(moves),
    }

    return {"metadata": metadata, "moves": moves, "summary": summary}


def evaluate_fen(fen: str) -> dict[str, Any]:
    try:
        board = chess.Board(fen)
    except ValueError as exc:
        raise ValueError("Invalid FEN.") from exc

    depth = int(os.getenv("ENGINE_DEPTH", "8") or "8")
    analysis = analyze_positions([board.copy(stack=False)], depth=depth)[0]
    lines = engine_lines_payload(board, analysis)

    return {
        "fen": board.fen(),
        "turn": "white" if board.turn == chess.WHITE else "black",
        "eval": analysis.eval.as_dict(),
        "best_move": analysis.best_move,
        "best_move_san": lines[0]["move_san"] if lines else best_move_san(board, analysis.best_move),
        "best_line": lines[0]["line"] if lines else line_to_san(board, analysis.best_line),
        "engine_lines": lines,
        "source": analysis.source,
        "engine_depth": depth,
        "material_balance_cp": material_balance(board),
        "material_balance_display": format_material_balance(material_balance(board)),
        "is_check": board.is_check(),
        "is_checkmate": board.is_checkmate(),
        "is_draw": board.is_stalemate()
        or board.is_insufficient_material()
        or board.is_seventyfive_moves()
        or board.is_fivefold_repetition(),
    }
