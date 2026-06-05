import unittest

import chess

from backend.app.analyzer import (
    EvalScore,
    analyze_pgn,
    book_opening_for_move,
    classification_for_move,
    mover_expected_points,
)


def classify(
    *,
    expected_loss: float,
    cp_loss: int,
    before_expected: float,
    after_expected: float,
    missed_tactical_gain: int = 0,
    move_number: int = 10,
) -> str:
    return classification_for_move(
        expected_loss=expected_loss,
        cp_loss=cp_loss,
        move_number=move_number,
        played_uci="e5e4",
        best_uci="d8c7",
        is_book=False,
        is_sacrifice=False,
        captured_piece_value=0,
        gives_check=False,
        before_expected=before_expected,
        after_expected=after_expected,
        next_best_expected=after_expected,
        missed_tactical_gain=missed_tactical_gain,
    )


class ClassificationTests(unittest.TestCase):
    def test_pgn_without_moves_is_rejected(self) -> None:
        with self.assertRaisesRegex(ValueError, "does not contain any moves"):
            analyze_pgn("not a game")

    def test_known_modern_defense_bishop_move_is_book(self) -> None:
        board = chess.Board()
        for san in ("d4", "g6"):
            board.push_san(san)

        move = board.parse_san("Bf4")
        opening = book_opening_for_move(board, move)

        self.assertIsNotNone(opening)
        self.assertEqual(opening["name"], "Queen's Pawn Game: Modern Defense")

    def test_forced_mate_has_exact_expected_points(self) -> None:
        white_mates = EvalScore(cp=100_000, mate=1, display="+M1")
        self.assertEqual(mover_expected_points(white_mates, "white", 1000), 1.0)
        self.assertEqual(mover_expected_points(white_mates, "black", 1000), 0.0)

    def test_missed_material_tactic_is_a_miss(self) -> None:
        self.assertEqual(
            classify(
                expected_loss=0.0614,
                cp_loss=101,
                before_expected=0.648,
                after_expected=0.587,
                missed_tactical_gain=300,
            ),
            "miss",
        )

    def test_compounding_a_worse_position_is_an_inaccuracy(self) -> None:
        self.assertEqual(
            classify(
                expected_loss=0.0478,
                cp_loss=78,
                before_expected=0.413,
                after_expected=0.365,
            ),
            "inaccuracy",
        )

    def test_larger_tactical_drop_remains_a_mistake(self) -> None:
        self.assertEqual(
            classify(
                expected_loss=0.1109,
                cp_loss=179,
                before_expected=0.462,
                after_expected=0.351,
                missed_tactical_gain=400,
            ),
            "mistake",
        )

    def test_allowing_forced_mate_from_a_lost_position_is_a_mistake(self) -> None:
        self.assertEqual(
            classify(
                expected_loss=0.1454,
                cp_loss=99_310,
                before_expected=0.1454,
                after_expected=0.0,
            ),
            "mistake",
        )

    def test_allowing_forced_mate_from_an_even_position_is_a_blunder(self) -> None:
        self.assertEqual(
            classify(
                expected_loss=0.50,
                cp_loss=100_000,
                before_expected=0.50,
                after_expected=0.0,
            ),
            "blunder",
        )

    def test_large_worsening_in_a_lost_position_is_a_mistake(self) -> None:
        self.assertEqual(
            classify(
                expected_loss=0.0795,
                cp_loss=174,
                before_expected=0.27,
                after_expected=0.19,
            ),
            "mistake",
        )

    def test_modest_early_opening_loss_can_remain_good(self) -> None:
        self.assertEqual(
            classify(
                expected_loss=0.0524,
                cp_loss=82,
                before_expected=0.49,
                after_expected=0.44,
                move_number=2,
            ),
            "good",
        )

    def test_limited_loss_while_still_winning_can_remain_good(self) -> None:
        self.assertEqual(
            classify(
                expected_loss=0.0684,
                cp_loss=119,
                before_expected=0.70,
                after_expected=0.63,
                move_number=22,
            ),
            "good",
        )

    def test_similar_loss_in_an_even_position_can_remain_good(self) -> None:
        self.assertEqual(
            classify(
                expected_loss=0.0482,
                cp_loss=76,
                before_expected=0.586,
                after_expected=0.538,
            ),
            "good",
        )


if __name__ == "__main__":
    unittest.main()
