from __future__ import annotations

import io
import json
import math
import os
from pathlib import Path
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


def load_openings() -> list[dict[str, Any]]:
    openings_path = Path(__file__).resolve().parents[2] / "frontend" / "public" / "openings.json"
    fallback_openings = [
        {"name": "King's Pawn Game", "eco": "C20", "moves": ["e4", "e5"]},
        {"name": "French Defense", "eco": "C00", "moves": ["e4", "e6"]},
        {"name": "Sicilian Defense", "eco": "B20", "moves": ["e4", "c5"]},
        {"name": "Queen's Pawn Game", "eco": "D00", "moves": ["d4", "d5"]},
        {"name": "London System", "eco": "D02", "moves": ["d4", "d5", "Bf4"]},
        {"name": "Queen's Gambit", "eco": "D06", "moves": ["d4", "d5", "c4"]},
        {"name": "Réti Opening", "eco": "A04", "moves": ["Nf3"]},
        {"name": "English Opening", "eco": "A10", "moves": ["c4"]},
    ]

    try:
        with openings_path.open() as file:
            data = json.load(file)
        openings: list[dict[str, Any]] = []
        for entry in data:
            moves = entry.get("moves")
            name = entry.get("name")
            if not isinstance(moves, str) or not isinstance(name, str):
                continue
            openings.append(
                {
                    "name": name,
                    "eco": entry.get("eco", ""),
                    "moves": moves.split(),
                }
            )
        return openings or fallback_openings
    except Exception:
        return fallback_openings


OPENINGS = load_openings()


def opening_position_key(board: chess.Board) -> str:
    return " ".join(board.fen().split()[:4])


def build_opening_book() -> dict[tuple[str, str], dict[str, str]]:
    book: dict[tuple[str, str], dict[str, str]] = {}

    for opening in OPENINGS:
        board = chess.Board()
        for san in opening["moves"]:
            try:
                move = board.parse_san(san)
            except ValueError:
                break

            key = (opening_position_key(board), move.uci())
            book.setdefault(
                key,
                {
                    "name": str(opening["name"]),
                    "eco": str(opening.get("eco") or ""),
                },
            )
            board.push(move)

    return book


OPENING_BOOK = build_opening_book()


def book_opening_for_move(board: chess.Board, move: chess.Move) -> Optional[dict[str, str]]:
    return OPENING_BOOK.get((opening_position_key(board), move.uci()))


def opening_for_sequence(sans: list[str]) -> dict[str, str]:
    if not sans:
        return {"name": "Starting position", "eco": ""}

    best: Optional[dict[str, Any]] = None
    best_len = 0
    prefix_match: Optional[dict[str, Any]] = None
    prefix_len = 10**9

    for opening in OPENINGS:
        moves = opening["moves"]
        if len(moves) <= len(sans) and sans[: len(moves)] == moves and len(moves) > best_len:
            best = opening
            best_len = len(moves)
        if len(sans) < len(moves) and moves[: len(sans)] == sans and len(moves) < prefix_len:
            prefix_match = opening
            prefix_len = len(moves)

    if best is None and prefix_match is None:
        return {"name": "Unknown", "eco": ""}

    opening = best or prefix_match
    return {
        "name": str(opening["name"]),
        "eco": str(opening.get("eco") or ""),
    }


def material_balance(board: chess.Board) -> int:
    score = 0
    for piece_type, value in MATERIAL_VALUES.items():
        score += len(board.pieces(piece_type, chess.WHITE)) * value
        score -= len(board.pieces(piece_type, chess.BLACK)) * value
    return score


def projected_material_gain(
    board: chess.Board,
    line: list[str],
    color: str,
    baseline_balance: int,
) -> int:
    preview = board.copy(stack=False)

    for uci in line:
        try:
            move = chess.Move.from_uci(uci)
        except ValueError:
            break
        if move not in preview.legal_moves:
            break
        preview.push(move)

    return mover_pov(material_balance(preview) - baseline_balance, color)


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


def player_rating_from_headers(headers: chess.pgn.Headers, color: str) -> Optional[int]:
    value = headers.get("WhiteElo" if color == "white" else "BlackElo", "")
    try:
        rating = int(str(value).strip())
    except ValueError:
        return None
    return rating if rating > 0 else None


def expected_points_from_cp(cp: int, rating: Optional[int] = None) -> float:
    clamped = max(-1200, min(1200, cp))
    # Chess.com's public model is rating-aware, but the exact curve is private.
    # Lower-rated players need a larger eval edge before a position is practically winning.
    rating_value = rating if rating is not None else 1200
    scale = max(260.0, min(430.0, 460.0 - rating_value * 0.07))
    return 1.0 / (1.0 + math.exp(-clamped / scale))


def mover_expected_points(eval_score: EvalScore, color: str, rating: Optional[int] = None) -> float:
    if eval_score.mate is not None:
        white_expected = 1.0 if eval_score.cp > 0 else 0.0
    else:
        white_expected = expected_points_from_cp(eval_score.cp, rating)
    return white_expected if color == "white" else 1.0 - white_expected


def is_outcome_changing_move(after_expected: float, next_best_expected: Optional[float]) -> bool:
    if next_best_expected is None:
        return False

    # Chess.com describes Great moves as critical: the only good move, or a
    # move that changes the practical outcome from losing/equal into equal/win.
    expected_gap = after_expected - next_best_expected
    only_move_avoiding_a_real_drop = expected_gap >= 0.10
    losing_to_equal = next_best_expected <= 0.35 and after_expected >= 0.45
    equal_to_winning = next_best_expected <= 0.58 and after_expected >= 0.70
    return only_move_avoiding_a_real_drop or losing_to_equal or equal_to_winning


def is_routine_best_capture(
    *,
    captured_piece_value: int,
    expected_loss: float,
    played_engine_top: bool,
    is_sacrifice: bool,
    gives_check: bool,
    before_expected: float,
    after_expected: float,
) -> bool:
    if captured_piece_value < MATERIAL_VALUES[chess.BISHOP]:
        return False
    if not played_engine_top or expected_loss > 0.02 or is_sacrifice or gives_check:
        return False

    # Cleanly taking a hanging or forced minor/major piece is usually just the
    # best move. Keep Great for captures that truly rescue or flip the position.
    rescued_position = before_expected <= 0.35 and after_expected >= 0.45
    flipped_position = before_expected <= 0.58 and after_expected >= 0.70
    return not rescued_position and not flipped_position


def classification_for_move(
    *,
    expected_loss: float,
    cp_loss: int,
    move_number: int,
    played_uci: str,
    best_uci: Optional[str],
    is_book: bool,
    is_sacrifice: bool,
    captured_piece_value: int,
    gives_check: bool,
    before_expected: float,
    after_expected: float,
    next_best_expected: Optional[float],
    missed_tactical_gain: int,
) -> str:
    # Opening databases can contain dubious sidelines and traps. A known move
    # should not hide a real tactical error or a large loss in expected score.
    if is_book and expected_loss <= 0.05:
        return "book"

    best_or_nearly_best = expected_loss <= 0.02
    played_engine_top = bool(best_uci and played_uci == best_uci)

    if (
        is_sacrifice
        and best_or_nearly_best
        and after_expected >= 0.45
        and (next_best_expected is None or next_best_expected <= 0.90)
    ):
        return "brilliant"
    missed_existing_advantage = (
        0.35 <= after_expected <= 0.58
        and before_expected >= 0.70
        and expected_loss >= 0.10
        and cp_loss >= 100
    )
    missed_material_tactic = (
        missed_tactical_gain >= MATERIAL_VALUES[chess.KNIGHT]
        and 0.04 <= expected_loss <= 0.10
        and cp_loss >= 75
    )
    if missed_existing_advantage or missed_material_tactic:
        return "miss"
    if is_routine_best_capture(
        captured_piece_value=captured_piece_value,
        expected_loss=expected_loss,
        played_engine_top=played_engine_top,
        is_sacrifice=is_sacrifice,
        gives_check=gives_check,
        before_expected=before_expected,
        after_expected=after_expected,
    ):
        return "best"
    if best_or_nearly_best and is_outcome_changing_move(after_expected, next_best_expected):
        return "great"
    if played_engine_top:
        return "best"
    if expected_loss <= 0.02:
        return "excellent"
    if cp_loss >= MATE_SCORE // 2 and after_expected <= 0.01:
        return "blunder" if before_expected >= 0.45 else "mistake"
    if before_expected <= 0.45 and cp_loss >= 150 and expected_loss >= 0.075:
        return "mistake"
    if move_number <= 3 and expected_loss <= 0.06 and cp_loss <= 100:
        return "good"
    if after_expected >= 0.60 and expected_loss <= 0.08 and cp_loss <= 150:
        return "good"
    if before_expected <= 0.45 and 0.04 <= expected_loss <= 0.10 and cp_loss >= 70:
        return "inaccuracy"
    if expected_loss <= 0.05:
        return "good"
    if before_expected <= 0.45 and expected_loss <= 0.12:
        return "inaccuracy"
    if expected_loss <= 0.095:
        return "inaccuracy"
    if expected_loss <= 0.20:
        return "mistake"
    return "blunder"


def explanation_for(
    classification: str,
    loss: int,
    expected_loss: float,
    best_san: Optional[str],
    missed_tactical_gain: int,
) -> str:
    point_loss = f"{expected_loss * 100:.0f}%"
    if classification == "book":
        return "A standard opening move that keeps the game in known territory."
    if classification == "brilliant":
        return f"A strong sacrifice that the engine approves. {best_san or 'The best line'} keeps the compensation."
    if classification == "best":
        return "Matches the engine's top choice."
    if classification == "great":
        return f"A critical move, often the only move that keeps or changes the practical result. {best_san or 'The engine move'} was the main comparison."
    if classification == "excellent":
        return f"A solid move very close to the best line, changing expected points by about {point_loss}."
    if classification == "good":
        return f"A sensible move, though {best_san or 'the engine move'} was a little more precise."
    if classification == "inaccuracy":
        return f"Loses some control of the position. The engine preferred {best_san or 'another move'}."
    if classification == "miss":
        if missed_tactical_gain >= MATERIAL_VALUES[chess.KNIGHT]:
            return f"Missed a tactical chance to win material. {best_san or 'Another move'} was the key move."
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


def opening_from_moves(moves: list[dict[str, Any]], headers: chess.pgn.Headers) -> str:
    for move in reversed(moves):
        opening = str(move.get("opening") or "").strip()
        if opening and opening not in {"Unknown", "Starting position"}:
            return opening

    return opening_from_headers(headers)


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


def accuracy_from_expected_loss(expected_loss: float) -> float:
    bounded_loss = max(0.0, min(expected_loss, 1.0))
    return 103.1668 * math.exp(-10.0 * bounded_loss) - 3.1669


def accuracy_for(expected_losses: list[float]) -> float:
    if not expected_losses:
        return 0.0

    bounded_losses = [max(0.0, min(loss, 1.0)) for loss in expected_losses]
    average_loss = sum(bounded_losses) / len(bounded_losses)
    whole_game_score = accuracy_from_expected_loss(average_loss)
    per_move_score = sum(accuracy_from_expected_loss(loss) for loss in bounded_losses) / len(bounded_losses)

    # Blending the whole-game curve with per-move scores keeps a single tactical
    # collapse from depressing the entire review more than comparable services do.
    score = whole_game_score * 0.75 + per_move_score * 0.25
    return round(max(0.0, min(100.0, score)), 1)


def engine_depth() -> int:
    configured_depth = int(os.getenv("ENGINE_DEPTH", "12") or "12")
    return max(12, configured_depth)


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
    sans_played: list[str] = []
    captured_by_white: list[dict[str, Any]] = []
    captured_by_black: list[dict[str, Any]] = []

    for ply, move in enumerate(game.mainline_moves(), start=1):
        fen_before = board.fen()
        san = board.san(move)
        sans_played.append(san)
        color = "white" if board.turn == chess.WHITE else "black"
        move_number = board.fullmove_number
        uci = move.uci()
        capture = captured_piece_info(board, move)
        book_opening = book_opening_for_move(board, move)

        board.push(move)
        fen_after = board.fen()
        material_after = material_balance(board)
        opening = opening_for_sequence(sans_played)
        if opening["name"] == "Unknown" and book_opening is not None:
            opening = book_opening
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
                "is_book": book_opening is not None,
                "opening": opening["name"],
                "eco": opening["eco"],
            }
        )
        positions.append(board.copy(stack=False))

    if not raw_moves:
        raise ValueError("The PGN does not contain any moves.")

    depth = engine_depth()
    analyses = analyze_positions(positions, depth=depth)
    analysis_source = analyses[0].source if analyses else "unknown"

    moves: list[dict[str, Any]] = []
    expected_losses_by_side = {"white": [], "black": []}
    player_ratings = {
        "white": player_rating_from_headers(headers, "white"),
        "black": player_rating_from_headers(headers, "black"),
    }
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
        before_expected = mover_expected_points(before.eval, color, player_ratings[color])
        after_expected = mover_expected_points(after.eval, color, player_ratings[color])
        next_best_expected = (
            mover_expected_points(before.top_lines[1].eval, color, player_ratings[color])
            if len(before.top_lines) > 1
            else None
        )
        expected_loss = max(0.0, before_expected - after_expected)
        material_before = material_balance(positions[idx])
        material_after = material_balance(positions[idx + 1])
        material_delta_for_mover = mover_pov(material_after - material_before, color)
        best_line_material_gain = projected_material_gain(
            positions[idx],
            before.best_line,
            color,
            material_before,
        )
        played_line_material_gain = projected_material_gain(
            positions[idx + 1],
            after.best_line,
            color,
            material_before,
        )
        missed_tactical_gain = max(0, best_line_material_gain - played_line_material_gain)
        is_sacrifice = material_delta_for_mover <= -250
        captured_piece = raw.get("captured_piece")
        captured_piece_value = (
            int(captured_piece.get("value") or 0)
            if isinstance(captured_piece, dict)
            else 0
        )
        # Mate scores are useful for classification but too large for summary math.
        summary_loss = min(loss, MATE_SCORE)
        classification = classification_for_move(
            expected_loss=expected_loss,
            cp_loss=summary_loss,
            move_number=raw["move_number"],
            played_uci=raw["uci"],
            best_uci=before.best_move,
            is_book=bool(raw.get("is_book")),
            is_sacrifice=is_sacrifice,
            captured_piece_value=captured_piece_value,
            gives_check="+" in str(raw["san"]) or "#" in str(raw["san"]),
            before_expected=before_expected,
            after_expected=after_expected,
            next_best_expected=next_best_expected,
            missed_tactical_gain=missed_tactical_gain,
        )
        explanation = explanation_for(
            classification,
            summary_loss,
            expected_loss,
            best_san,
            missed_tactical_gain,
        )

        if classification in counts[color]:
            counts[color][classification] += 1
        expected_losses_by_side[color].append(expected_loss)

        move_result = {
            **raw,
            "is_book": classification == "book",
            "eval_before": before.eval.as_dict(),
            "eval_after": after.eval.as_dict(),
            "best_move": before.best_move,
            "best_move_san": best_san,
            "best_line": before_engine_lines[0]["line"] if before_engine_lines else line_to_san(positions[idx], before.best_line),
            "engine_lines": before_engine_lines,
            "reply_engine_lines": after_engine_lines,
            "centipawn_loss": summary_loss,
            "expected_points_loss": round(expected_loss, 4),
            "missed_tactical_gain_cp": missed_tactical_gain,
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
        "white_elo": headers.get("WhiteElo", ""),
        "black_elo": headers.get("BlackElo", ""),
        "result": headers.get("Result", "*"),
        "termination": headers.get("Termination", ""),
        "opening": opening_from_moves(moves, headers),
        "initial_fen": positions[0].fen() if positions else INITIAL_FEN,
        "analysis_source": analysis_source,
        "engine_depth": depth,
    }

    summary = {
        "white": {
            **counts["white"],
            "accuracy": accuracy_for(expected_losses_by_side["white"]),
        },
        "black": {
            **counts["black"],
            "accuracy": accuracy_for(expected_losses_by_side["black"]),
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

    depth = engine_depth()
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
