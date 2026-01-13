"""
FEN (Forsyth-Edwards Notation) validation and utilities.

This module provides functions for validating, normalizing, and converting
FEN strings and piece maps. It ensures that recognized positions can be
safely sent to the e-board.
"""

from typing import Mapping
import re


class FENValidationError(Exception):
    """Raised when FEN validation fails."""

    def __init__(self, message: str, field: str | None = None):
        super().__init__(message)
        self.field = field
        self.message = message


# Valid piece characters
VALID_PIECES = set("KQRBNPkqrbnp")

# Starting position FEN
STARTING_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"

# Maximum piece counts (accounting for promotions)
MAX_PIECE_COUNTS: dict[str, int] = {
    "K": 1, "k": 1,  # Exactly one king each
    "Q": 9, "q": 9,  # Original + 8 promoted pawns
    "R": 10, "r": 10,
    "B": 10, "b": 10,
    "N": 10, "n": 10,
    "P": 8, "p": 8,  # No pawns on promotion ranks
}

# Squares in algebraic notation
FILES = "abcdefgh"
RANKS = "12345678"
ALL_SQUARES = [f + r for r in RANKS for f in FILES]


def validate_fen(fen: str, strict: bool = True) -> tuple[bool, str | None]:
    """
    Validate a FEN string.

    Args:
        fen: The FEN string to validate
        strict: If True, validate all 6 FEN fields; if False, only validate piece placement

    Returns:
        A tuple of (is_valid, error_message). If valid, error_message is None.
    """
    if not fen or not isinstance(fen, str):
        return False, "FEN must be a non-empty string"

    parts = fen.strip().split()

    if strict and len(parts) != 6:
        return False, f"FEN must have 6 fields, got {len(parts)}"

    if len(parts) < 1:
        return False, "FEN must have at least piece placement field"

    # Validate piece placement (field 1)
    valid, error = _validate_piece_placement(parts[0])
    if not valid:
        return False, error

    if not strict or len(parts) == 1:
        return True, None

    # Validate side to move (field 2)
    if parts[1] not in ("w", "b"):
        return False, f"Side to move must be 'w' or 'b', got '{parts[1]}'"

    # Validate castling rights (field 3)
    valid, error = _validate_castling(parts[2])
    if not valid:
        return False, error

    # Validate en passant square (field 4)
    valid, error = _validate_en_passant(parts[3], parts[1])
    if not valid:
        return False, error

    # Validate halfmove clock (field 5)
    try:
        halfmove = int(parts[4])
        if halfmove < 0:
            return False, f"Halfmove clock must be non-negative, got {halfmove}"
    except ValueError:
        return False, f"Halfmove clock must be an integer, got '{parts[4]}'"

    # Validate fullmove number (field 6)
    try:
        fullmove = int(parts[5])
        if fullmove < 1:
            return False, f"Fullmove number must be at least 1, got {fullmove}"
    except ValueError:
        return False, f"Fullmove number must be an integer, got '{parts[5]}'"

    return True, None


def _validate_piece_placement(placement: str) -> tuple[bool, str | None]:
    """Validate the piece placement field of a FEN."""
    ranks = placement.split("/")

    if len(ranks) != 8:
        return False, f"Piece placement must have 8 ranks, got {len(ranks)}"

    piece_counts: dict[str, int] = {}

    for rank_idx, rank in enumerate(ranks):
        file_count = 0

        for char in rank:
            if char.isdigit():
                file_count += int(char)
            elif char in VALID_PIECES:
                file_count += 1
                piece_counts[char] = piece_counts.get(char, 0) + 1
            else:
                return False, f"Invalid character '{char}' in rank {8 - rank_idx}"

        if file_count != 8:
            return False, f"Rank {8 - rank_idx} has {file_count} squares, expected 8"

    # Check king counts
    white_kings = piece_counts.get("K", 0)
    black_kings = piece_counts.get("k", 0)

    if white_kings != 1:
        return False, f"Must have exactly 1 white king, got {white_kings}"
    if black_kings != 1:
        return False, f"Must have exactly 1 black king, got {black_kings}"

    # Check maximum piece counts
    for piece, max_count in MAX_PIECE_COUNTS.items():
        actual = piece_counts.get(piece, 0)
        if actual > max_count:
            return False, f"Too many {piece} pieces: {actual} > {max_count}"

    # Check no pawns on promotion ranks
    first_rank = ranks[0]  # 8th rank (Black's back rank)
    last_rank = ranks[7]   # 1st rank (White's back rank)

    for char in first_rank + last_rank:
        if char in "Pp":
            return False, "Pawns cannot be on the 1st or 8th rank"

    return True, None


def _validate_castling(castling: str) -> tuple[bool, str | None]:
    """Validate the castling rights field."""
    if castling == "-":
        return True, None

    valid_chars = set("KQkq")
    seen = set()

    for char in castling:
        if char not in valid_chars:
            return False, f"Invalid castling character: '{char}'"
        if char in seen:
            return False, f"Duplicate castling character: '{char}'"
        seen.add(char)

    return True, None


def _validate_en_passant(ep_square: str, side_to_move: str) -> tuple[bool, str | None]:
    """Validate the en passant square field."""
    if ep_square == "-":
        return True, None

    if len(ep_square) != 2:
        return False, f"Invalid en passant square: '{ep_square}'"

    file, rank = ep_square[0], ep_square[1]

    if file not in FILES:
        return False, f"Invalid en passant file: '{file}'"

    # En passant rank must be 3 or 6 depending on side to move
    if side_to_move == "w" and rank != "6":
        return False, "White's en passant square must be on rank 6"
    if side_to_move == "b" and rank != "3":
        return False, "Black's en passant square must be on rank 3"

    return True, None


def normalize_fen(fen: str) -> str:
    """
    Normalize a FEN string to a canonical form.

    - Ensures consistent spacing
    - Fills in missing fields with defaults
    - Does NOT validate (call validate_fen first)
    """
    parts = fen.strip().split()

    if len(parts) == 1:
        # Only piece placement, add defaults
        parts.extend(["w", "-", "-", "0", "1"])
    elif len(parts) == 2:
        parts.extend(["-", "-", "0", "1"])
    elif len(parts) == 3:
        parts.extend(["-", "0", "1"])
    elif len(parts) == 4:
        parts.extend(["0", "1"])
    elif len(parts) == 5:
        parts.append("1")

    return " ".join(parts)


def fen_to_piece_map(fen: str) -> dict[str, str]:
    """
    Convert a FEN string to a piece map.

    Args:
        fen: A FEN string (only the piece placement field is used)

    Returns:
        A dict mapping square names to piece symbols (e.g., {"e1": "K", "e8": "k"})
    """
    placement = fen.split()[0]
    piece_map: dict[str, str] = {}

    ranks = placement.split("/")

    for rank_idx, rank_str in enumerate(ranks):
        file_idx = 0
        rank_num = 8 - rank_idx  # FEN ranks go from 8 to 1

        for char in rank_str:
            if char.isdigit():
                file_idx += int(char)
            else:
                square = FILES[file_idx] + str(rank_num)
                piece_map[square] = char
                file_idx += 1

    return piece_map


def piece_map_to_fen(
    piece_map: Mapping[str, str],
    side_to_move: str = "w",
    castling: str = "-",
    en_passant: str = "-",
    halfmove: int = 0,
    fullmove: int = 1,
) -> str:
    """
    Convert a piece map to a full FEN string.

    Args:
        piece_map: Dict mapping square names to piece symbols
        side_to_move: "w" or "b"
        castling: Castling rights (e.g., "KQkq" or "-")
        en_passant: En passant square (e.g., "e3" or "-")
        halfmove: Halfmove clock
        fullmove: Fullmove number

    Returns:
        A complete FEN string
    """
    ranks = []

    for rank_num in range(8, 0, -1):
        rank_str = ""
        empty_count = 0

        for file in FILES:
            square = file + str(rank_num)
            piece = piece_map.get(square)

            if piece:
                if empty_count > 0:
                    rank_str += str(empty_count)
                    empty_count = 0
                rank_str += piece
            else:
                empty_count += 1

        if empty_count > 0:
            rank_str += str(empty_count)

        ranks.append(rank_str)

    placement = "/".join(ranks)

    return f"{placement} {side_to_move} {castling} {en_passant} {halfmove} {fullmove}"


def get_piece_placement_only(fen: str) -> str:
    """Extract just the piece placement field from a FEN string."""
    return fen.split()[0]


def positions_equal(fen1: str, fen2: str) -> bool:
    """
    Check if two FEN strings represent the same piece placement.

    Only compares the piece placement field, ignoring game state.
    """
    return get_piece_placement_only(fen1) == get_piece_placement_only(fen2)
