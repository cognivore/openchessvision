"""
Tests for the Local CNN recognition backend.

Uses the chessimg2pos library to recognize chess diagrams locally.
"""

import pytest
import cv2
from pathlib import Path

from openchessvision.recognition.local_cnn import LocalCNNBackend
from openchessvision.core.fen import fen_to_piece_map


# Path to test fixture
FIXTURE_PATH = Path(__file__).parent / "fixtures" / "Berlin37.png"

# Expected FEN for the Richter-Rogmann position after 1.d4 Nf6 2.Nc3 d5 3.Bg5 c6 4.f3 Qb6
EXPECTED_FEN = "rnb1kb1r/pp2pppp/1qp2n2/3p2B1/3P4/2N2P2/PPP1P1PP/R2QKBNR"


@pytest.fixture
def cropped_board():
    """Load and crop the board from the test fixture."""
    if not FIXTURE_PATH.exists():
        pytest.skip(f"Test fixture not found: {FIXTURE_PATH}")

    image = cv2.imread(str(FIXTURE_PATH))
    # Crop to the board region (determined empirically)
    board = image[428:928, 126:626]
    return board


@pytest.fixture
def backend():
    """Create a LocalCNNBackend instance."""
    return LocalCNNBackend()


class TestLocalCNNBackend:
    """Tests for the LocalCNNBackend class."""

    def test_backend_name(self, backend):
        """Backend reports correct name."""
        assert "CNN" in backend.name
        assert "chessimg2pos" in backend.name

    def test_recognition_returns_fen(self, backend, cropped_board):
        """Recognition returns a valid FEN string."""
        result = backend.recognize(cropped_board)

        assert result.fen is not None, f"Recognition failed: {result.annotation}"
        assert "/" in result.fen, "FEN should have rank separators"
        assert len(result.fen.split("/")) == 8, "FEN should have 8 ranks"

    def test_recognition_detects_pieces(self, backend, cropped_board):
        """Recognition detects a reasonable number of pieces."""
        result = backend.recognize(cropped_board)

        # The test position has 32 pieces
        # We expect at least 25 to be detected correctly
        assert len(result.piece_placement) >= 25, (
            f"Expected at least 25 pieces, got {len(result.piece_placement)}"
        )

    def test_recognition_has_confidence(self, backend, cropped_board):
        """Recognition returns a confidence score."""
        result = backend.recognize(cropped_board)

        assert result.overall_confidence > 0, "Should have non-zero confidence"
        assert result.overall_confidence <= 1.0, "Confidence should be <= 1.0"

    def test_recognition_accuracy(self, backend, cropped_board):
        """Recognition achieves at least 90% piece accuracy."""
        result = backend.recognize(cropped_board)

        if result.fen is None:
            pytest.skip(f"Recognition failed: {result.annotation}")

        expected_map = fen_to_piece_map(EXPECTED_FEN)
        actual_map = result.piece_placement

        correct = sum(1 for sq in expected_map if actual_map.get(sq) == expected_map[sq])
        total = len(expected_map)
        accuracy = correct / total

        assert accuracy >= 0.90, (
            f"Expected at least 90% accuracy, got {accuracy:.1%} ({correct}/{total})"
        )

    def test_ranks_mostly_correct(self, backend, cropped_board):
        """At least 6/8 ranks should be exactly correct."""
        result = backend.recognize(cropped_board)

        if result.fen is None:
            pytest.skip(f"Recognition failed: {result.annotation}")

        got_ranks = result.fen.split("/")
        exp_ranks = EXPECTED_FEN.split("/")

        correct_ranks = sum(1 for g, e in zip(got_ranks, exp_ranks) if g == e)

        assert correct_ranks >= 6, (
            f"Expected at least 6/8 correct ranks, got {correct_ranks}/8"
        )


class TestFENConsolidation:
    """Tests for the FEN rank consolidation fix."""

    def test_consolidate_empty_squares(self):
        """Consecutive empty squares should be consolidated."""
        from openchessvision.recognition.local_cnn import _consolidate_fen_ranks

        broken = "pp11pppp"
        fixed = _consolidate_fen_ranks(broken)
        assert fixed == "pp2pppp"

    def test_consolidate_multiple_groups(self):
        """Multiple groups of empty squares should be consolidated."""
        from openchessvision.recognition.local_cnn import _consolidate_fen_ranks

        broken = "1qp11n11"
        fixed = _consolidate_fen_ranks(broken)
        assert fixed == "1qp2n2"

    def test_consolidate_full_empty_rank(self):
        """Full empty rank should become 8."""
        from openchessvision.recognition.local_cnn import _consolidate_fen_ranks

        broken = "11111111"
        fixed = _consolidate_fen_ranks(broken)
        assert fixed == "8"

    def test_consolidate_preserves_pieces(self):
        """Piece characters should be preserved."""
        from openchessvision.recognition.local_cnn import _consolidate_fen_ranks

        broken = "rnbqkbnr"  # No empty squares
        fixed = _consolidate_fen_ranks(broken)
        assert fixed == "rnbqkbnr"
