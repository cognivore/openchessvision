#!/usr/bin/env python3
"""
Process book fixture images into labeled training tiles.

Reads images with .fen sidecar files, detects and extracts the board,
then slices into 64 labeled tiles for CNN training.
"""

import argparse
from pathlib import Path
from typing import Optional
import numpy as np
import cv2
from PIL import Image

# Add parent to path for imports
import sys
sys.path.insert(0, str(Path(__file__).parent.parent / "src"))

from openchessvision.preprocessing import BoardDetector

# FEN characters
FEN_CHARS = '1RNBQKPrnbqkp'
FILES = 'abcdefgh'


def expand_fen(fen: str) -> list[str]:
    """Expand FEN piece placement to 64 characters."""
    result = []
    for char in fen.replace('/', ''):
        if char.isdigit():
            result.extend(['1'] * int(char))
        else:
            result.append(char)
    return result


def extract_tiles(
    board_image: np.ndarray,
    use_grayscale: bool = True
) -> list[np.ndarray]:
    """Extract 64 tiles from a 256x256 board image."""
    tiles = []
    tile_size = board_image.shape[0] // 8

    for rank in range(8):  # 0=rank 8, 7=rank 1
        for file in range(8):  # 0=a, 7=h
            top = rank * tile_size
            left = file * tile_size

            tile = board_image[top:top+tile_size, left:left+tile_size]

            # Resize to 32x32
            tile = cv2.resize(tile, (32, 32), interpolation=cv2.INTER_AREA)

            # Convert to grayscale if requested
            if use_grayscale and len(tile.shape) == 3:
                tile = cv2.cvtColor(tile, cv2.COLOR_BGR2GRAY)
                tile = cv2.cvtColor(tile, cv2.COLOR_GRAY2BGR)  # Back to 3 channel for saving

            tiles.append(tile)

    return tiles


def save_tiles(
    tiles: list[np.ndarray],
    pieces: list[str],
    output_dir: Path,
    prefix: str
) -> int:
    """Save tiles with piece labels."""
    output_dir.mkdir(parents=True, exist_ok=True)

    saved = 0
    for i, (tile, piece) in enumerate(zip(tiles, pieces)):
        rank = 8 - (i // 8)
        file = FILES[i % 8]
        square = f"{file}{rank}"

        filename = f"{prefix}_{square}_{piece}.png"
        filepath = output_dir / filename
        cv2.imwrite(str(filepath), tile)
        saved += 1

    return saved


def process_fixture(
    image_path: Path,
    fen_path: Path,
    output_dir: Path,
    detector: BoardDetector,
    use_grayscale: bool = True,
    save_debug: bool = False
) -> tuple[bool, str]:
    """Process a single fixture image."""
    # Load FEN
    fen = fen_path.read_text().strip().split()[0]  # Only piece placement
    pieces = expand_fen(fen)

    if len(pieces) != 64:
        return False, f"Invalid FEN: expected 64 squares, got {len(pieces)}"

    # Detect board
    result = detector.detect_from_file(image_path, debug=save_debug)

    if not result.success:
        return False, f"Board detection failed: {result.error_message}"

    # Save debug image if requested
    if save_debug and result.debug_image is not None:
        debug_path = output_dir / "debug" / f"{image_path.stem}_debug.png"
        debug_path.parent.mkdir(parents=True, exist_ok=True)
        cv2.imwrite(str(debug_path), result.debug_image)

    # Extract tiles
    tiles = extract_tiles(result.board_image, use_grayscale=use_grayscale)

    if len(tiles) != 64:
        return False, f"Tile extraction failed: got {len(tiles)} tiles"

    # Save tiles
    prefix = image_path.stem
    board_output_dir = output_dir / prefix
    saved = save_tiles(tiles, pieces, board_output_dir, prefix)

    return True, f"Saved {saved} tiles to {board_output_dir}"


def process_fixtures(
    input_dir: Path,
    output_dir: Path,
    use_grayscale: bool = True,
    save_debug: bool = False
) -> tuple[int, int]:
    """Process all fixtures in a directory."""
    detector = BoardDetector()

    success_count = 0
    fail_count = 0

    # Find all images with .fen files
    for image_path in sorted(input_dir.glob("*.png")):
        fen_path = image_path.with_suffix(".fen")

        if not fen_path.exists():
            print(f"Skipping {image_path.name}: no .fen file")
            continue

        print(f"\nProcessing {image_path.name}...")
        success, message = process_fixture(
            image_path, fen_path, output_dir, detector,
            use_grayscale=use_grayscale, save_debug=save_debug
        )

        if success:
            print(f"  ✓ {message}")
            success_count += 1
        else:
            print(f"  ✗ {message}")
            fail_count += 1

    return success_count, fail_count


def main():
    parser = argparse.ArgumentParser(
        description="Process book fixtures into training tiles"
    )
    parser.add_argument(
        "--input", "-i", type=Path, default=Path("tests/fixtures"),
        help="Input directory with images and .fen files"
    )
    parser.add_argument(
        "--output", "-o", type=Path, default=Path("data/tiles/book"),
        help="Output directory for tiles"
    )
    parser.add_argument(
        "--color", "-c", action="store_true",
        help="Keep tiles in color (default: grayscale)"
    )
    parser.add_argument(
        "--debug", "-d", action="store_true",
        help="Save debug visualizations"
    )

    args = parser.parse_args()

    print(f"Processing fixtures from {args.input}")
    print(f"Output directory: {args.output}")
    print(f"Grayscale: {not args.color}")

    success, failed = process_fixtures(
        args.input, args.output,
        use_grayscale=not args.color,
        save_debug=args.debug
    )

    print(f"\n=== Results ===")
    print(f"Success: {success}")
    print(f"Failed: {failed}")
    print(f"Total tiles: {success * 64}")


if __name__ == "__main__":
    main()
