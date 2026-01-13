"""Tests for FEN validation and utilities."""

import pytest
from openchessvision.core.fen import (
    validate_fen,
    normalize_fen,
    fen_to_piece_map,
    piece_map_to_fen,
    positions_equal,
    STARTING_FEN,
    FENValidationError,
)


class TestValidateFEN:
    """Tests for FEN validation."""

    def test_valid_starting_position(self):
        valid, error = validate_fen(STARTING_FEN)
        assert valid is True
        assert error is None

    def test_valid_midgame_position(self):
        fen = "r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4"
        valid, error = validate_fen(fen)
        assert valid is True
        assert error is None

    def test_valid_endgame_position(self):
        fen = "8/8/8/4k3/8/8/4K3/4R3 w - - 0 1"
        valid, error = validate_fen(fen)
        assert valid is True
        assert error is None

    def test_invalid_missing_king(self):
        # Missing black king
        fen = "rnbq1bnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"
        valid, error = validate_fen(fen)
        assert valid is False
        assert "black king" in error.lower()

    def test_invalid_two_white_kings(self):
        fen = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBKKBNR w KQkq - 0 1"
        valid, error = validate_fen(fen)
        assert valid is False
        assert "white king" in error.lower()

    def test_invalid_wrong_rank_count(self):
        fen = "rnbqkbnr/pppppppp/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"
        valid, error = validate_fen(fen)
        assert valid is False
        assert "8 ranks" in error

    def test_invalid_wrong_file_count(self):
        fen = "rnbqkbnr/ppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"
        valid, error = validate_fen(fen)
        assert valid is False
        assert "squares" in error

    def test_invalid_side_to_move(self):
        fen = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR x KQkq - 0 1"
        valid, error = validate_fen(fen)
        assert valid is False
        assert "Side to move" in error

    def test_invalid_character(self):
        fen = "rnbqkbnr/ppppppXp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"
        valid, error = validate_fen(fen)
        assert valid is False
        assert "Invalid character" in error

    def test_pawn_on_first_rank(self):
        fen = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/PNBQKBNR w KQkq - 0 1"
        valid, error = validate_fen(fen)
        assert valid is False
        # Error could be about pawn count or pawn position
        assert "P" in error or "Pawn" in error or "pawn" in error

    def test_pawn_on_eighth_rank(self):
        fen = "pnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"
        valid, error = validate_fen(fen)
        assert valid is False
        # Error could be about pawn count or pawn position
        assert "p" in error or "Pawn" in error or "pawn" in error

    def test_non_strict_piece_placement_only(self):
        fen = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR"
        valid, error = validate_fen(fen, strict=False)
        assert valid is True
        assert error is None

    def test_invalid_castling_duplicate(self):
        fen = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KKkq - 0 1"
        valid, error = validate_fen(fen)
        assert valid is False
        assert "Duplicate" in error

    def test_valid_no_castling(self):
        fen = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w - - 0 1"
        valid, error = validate_fen(fen)
        assert valid is True

    def test_invalid_en_passant_wrong_rank_for_white(self):
        fen = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq e3 0 1"
        valid, error = validate_fen(fen)
        assert valid is False
        assert "rank 6" in error

    def test_valid_en_passant(self):
        fen = "rnbqkbnr/pppp1ppp/8/4pP2/8/8/PPPPP1PP/RNBQKBNR w KQkq e6 0 1"
        valid, error = validate_fen(fen)
        assert valid is True


class TestNormalizeFEN:
    """Tests for FEN normalization."""

    def test_normalize_full_fen(self):
        fen = "  rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR  w  KQkq  -  0  1  "
        normalized = normalize_fen(fen)
        assert normalized == "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"

    def test_normalize_piece_placement_only(self):
        fen = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR"
        normalized = normalize_fen(fen)
        assert normalized == "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w - - 0 1"

    def test_normalize_partial_fen(self):
        fen = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR b"
        normalized = normalize_fen(fen)
        assert normalized == "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR b - - 0 1"


class TestFENConversion:
    """Tests for FEN to/from piece map conversion."""

    def test_fen_to_piece_map_starting(self):
        piece_map = fen_to_piece_map(STARTING_FEN)

        # Check some key squares
        assert piece_map["e1"] == "K"
        assert piece_map["e8"] == "k"
        assert piece_map["a1"] == "R"
        assert piece_map["h8"] == "r"
        assert piece_map["d1"] == "Q"
        assert piece_map["d8"] == "q"

        # Check pawns
        for file in "abcdefgh":
            assert piece_map[f"{file}2"] == "P"
            assert piece_map[f"{file}7"] == "p"

        # Check empty squares
        assert "e4" not in piece_map
        assert "d5" not in piece_map

    def test_piece_map_to_fen_starting(self):
        piece_map = fen_to_piece_map(STARTING_FEN)
        fen = piece_map_to_fen(piece_map, "w", "KQkq", "-", 0, 1)
        assert fen == STARTING_FEN

    def test_piece_map_to_fen_endgame(self):
        piece_map = {"e1": "K", "e8": "k", "h1": "R"}
        fen = piece_map_to_fen(piece_map)
        expected_placement = "4k3/8/8/8/8/8/8/4K2R"
        assert fen.startswith(expected_placement)

    def test_roundtrip_conversion(self):
        original_fen = "r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4"
        piece_map = fen_to_piece_map(original_fen)
        reconstructed = piece_map_to_fen(piece_map, "w", "KQkq", "-", 4, 4)

        # Piece placement should match
        assert original_fen.split()[0] == reconstructed.split()[0]


class TestPositionsEqual:
    """Tests for position comparison."""

    def test_same_position_different_state(self):
        fen1 = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"
        fen2 = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR b - - 50 100"
        assert positions_equal(fen1, fen2) is True

    def test_different_positions(self):
        fen1 = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"
        fen2 = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1"
        assert positions_equal(fen1, fen2) is False
