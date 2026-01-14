#!/usr/bin/env python3
"""
Generate training data for chess piece recognition.

Creates PNG images of individual chess squares (32x32) from randomly
generated chess positions rendered with python-chess SVG.
"""

import os
import random
import argparse
from pathlib import Path
from io import BytesIO

import chess
import chess.svg
from PIL import Image
import cairosvg  # For SVG to PNG conversion


# Class labels matching chess-cv convention
CLASS_LABELS = {
    'r': 'bR', 'n': 'bN', 'b': 'bB', 'q': 'bQ', 'k': 'bK', 'p': 'bP',
    'R': 'wR', 'N': 'wN', 'B': 'wB', 'Q': 'wQ', 'K': 'wK', 'P': 'wP',
    None: 'xx'
}

FILES = 'abcdefgh'


def generate_random_position() -> chess.Board:
    """Generate a random legal-ish chess position."""
    board = chess.Board.empty()

    # Always place kings
    white_king_sq = random.choice(list(chess.SQUARES))
    board.set_piece_at(white_king_sq, chess.Piece(chess.KING, chess.WHITE))

    # Place black king not adjacent to white king
    black_king_candidates = [
        sq for sq in chess.SQUARES
        if sq != white_king_sq and chess.square_distance(sq, white_king_sq) > 1
    ]
    black_king_sq = random.choice(black_king_candidates)
    board.set_piece_at(black_king_sq, chess.Piece(chess.KING, chess.BLACK))

    # Randomly place other pieces
    available_squares = [
        sq for sq in chess.SQUARES
        if sq != white_king_sq and sq != black_king_sq
    ]

    # Piece types (excluding kings) and max counts
    pieces = [
        (chess.QUEEN, 2), (chess.ROOK, 4), (chess.BISHOP, 4),
        (chess.KNIGHT, 4), (chess.PAWN, 8)
    ]

    for piece_type, max_count in pieces:
        for color in [chess.WHITE, chess.BLACK]:
            count = random.randint(0, min(max_count, len(available_squares) // 4))
            for _ in range(count):
                if not available_squares:
                    break

                # Pawns can't be on 1st or 8th rank
                if piece_type == chess.PAWN:
                    valid_squares = [
                        sq for sq in available_squares
                        if chess.square_rank(sq) not in [0, 7]
                    ]
                    if not valid_squares:
                        continue
                    sq = random.choice(valid_squares)
                else:
                    sq = random.choice(available_squares)

                board.set_piece_at(sq, chess.Piece(piece_type, color))
                available_squares.remove(sq)

    return board


def render_board_to_png(board: chess.Board, size: int = 256) -> Image.Image:
    """Render a chess board to a PNG image."""
    svg_data = chess.svg.board(board, size=size, coordinates=False)
    png_data = cairosvg.svg2png(bytestring=svg_data.encode())
    return Image.open(BytesIO(png_data))


def extract_tiles(board_img: Image.Image, board: chess.Board,
                  tile_size: int = 32) -> list[tuple[Image.Image, str, str]]:
    """Extract 64 tiles from a board image with labels."""
    tiles = []
    img_size = board_img.size[0]
    square_size = img_size // 8

    for rank in range(8):
        for file in range(8):
            # Chess coordinates
            sq_name = FILES[file] + str(8 - rank)
            sq = chess.parse_square(sq_name)
            piece = board.piece_at(sq)

            # Extract tile
            left = file * square_size
            upper = rank * square_size
            tile = board_img.crop((left, upper, left + square_size, upper + square_size))

            # Resize to target size
            tile = tile.resize((tile_size, tile_size), Image.Resampling.LANCZOS)

            # Get label
            piece_char = piece.symbol() if piece else None
            label = CLASS_LABELS[piece_char]

            tiles.append((tile, label, sq_name))

    return tiles


def generate_dataset(output_dir: Path, num_positions: int = 1000,
                     board_size: int = 256, tile_size: int = 32):
    """Generate a training dataset."""
    output_dir = Path(output_dir)

    # Create class directories
    for label in set(CLASS_LABELS.values()):
        (output_dir / label).mkdir(parents=True, exist_ok=True)

    total_tiles = 0
    for i in range(num_positions):
        if i % 100 == 0:
            print(f"Generating position {i+1}/{num_positions}...")

        board = generate_random_position()
        board_img = render_board_to_png(board, size=board_size)
        tiles = extract_tiles(board_img, board, tile_size=tile_size)

        for tile_img, label, sq_name in tiles:
            filename = f"{i:05d}_{sq_name}.png"
            tile_img.save(output_dir / label / filename)
            total_tiles += 1

    print(f"\nGenerated {total_tiles} tiles from {num_positions} positions")
    print(f"Output directory: {output_dir}")


def main():
    parser = argparse.ArgumentParser(description="Generate chess training data")
    parser.add_argument("--output", "-o", type=Path, default=Path("data/tiles"),
                        help="Output directory for tiles")
    parser.add_argument("--num-positions", "-n", type=int, default=1000,
                        help="Number of positions to generate")
    parser.add_argument("--board-size", type=int, default=256,
                        help="Board rendering size in pixels")
    parser.add_argument("--tile-size", type=int, default=32,
                        help="Output tile size in pixels")

    args = parser.parse_args()
    generate_dataset(args.output, args.num_positions, args.board_size, args.tile_size)


if __name__ == "__main__":
    main()
