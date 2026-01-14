#!/usr/bin/env python3
"""
Generate training tiles from chess board images.

Splits full board images into 64 labeled 32x32 grayscale tiles
for training the piece recognition CNN.

Based on linrock/chessboard-recognizer approach.
"""

import os
import argparse
from pathlib import Path
from glob import glob

import numpy as np
from PIL import Image

# FEN characters for validation
FEN_CHARS = '1RNBQKPrnbqkp'

# Directory paths
CHESSBOARDS_DIR = Path('./data/chessboards')
TILES_DIR = Path('./data/tiles')

# Chess file letters
FILES = 'abcdefgh'


def get_chessboard_tiles(
    img_path: Path,
    use_grayscale: bool = True,
    target_size: int = 256
) -> list[Image.Image]:
    """Extract 64 tiles from a chessboard image.

    Args:
        img_path: Path to chessboard image
        use_grayscale: Convert tiles to grayscale
        target_size: Resize board to this size before extracting tiles

    Returns:
        List of 64 PIL Images (32x32 each), ordered a8, b8, ..., g1, h1
    """
    img = Image.open(img_path).convert('RGB')

    # Resize to standard size
    img = img.resize((target_size, target_size), Image.Resampling.BILINEAR)

    # Convert to grayscale if requested
    if use_grayscale:
        img = img.convert('L')

    tile_size = target_size // 8
    tiles = []

    for rank in range(8):  # rows (0=rank 8, 7=rank 1)
        for file in range(8):  # columns (0=a, 7=h)
            left = file * tile_size
            upper = rank * tile_size
            right = left + tile_size
            lower = upper + tile_size

            tile = img.crop((left, upper, right, lower))

            # Resize to standard 32x32
            if tile_size != 32:
                tile = tile.resize((32, 32), Image.Resampling.BILINEAR)

            # Convert grayscale back to RGB for consistent saving
            if use_grayscale:
                tile = tile.convert('RGB')

            tiles.append(tile)

    return tiles


def parse_filename_for_fen(filename: str) -> list[str] | None:
    """Extract piece positions from filename.

    Expected format: RRqpBnNr-QKPkrQPK-PpbQnNB1-...-BKRqbbBp[_suffix].png
    Returns list of 64 piece characters, or None if parsing fails.
    """
    # Remove extension and any suffix after the FEN part
    basename = Path(filename).stem

    # Split off any suffix (like _jin_default_default or _cd0)
    parts = basename.split('_')
    fen_part = parts[0]  # The FEN encoding is always first

    # Split by dashes to get 8 ranks
    ranks = fen_part.split('-')
    if len(ranks) != 8:
        return None

    # Validate each rank has 8 characters
    pieces = []
    for rank in ranks:
        if len(rank) != 8:
            return None
        for char in rank:
            if char not in FEN_CHARS:
                return None
            pieces.append(char)

    return pieces


def save_tiles(
    tiles: list[Image.Image],
    pieces: list[str],
    output_dir: Path,
    prefix: str
) -> int:
    """Save tiles with piece labels.

    Saves tiles with naming convention: prefix_a8_R.png

    Returns number of tiles saved.
    """
    output_dir.mkdir(parents=True, exist_ok=True)

    saved = 0
    for i, (tile, piece) in enumerate(zip(tiles, pieces)):
        rank = 8 - (i // 8)  # 8, 8, 8, ..., 1, 1, 1
        file = FILES[i % 8]   # a, b, c, ..., h
        square = f"{file}{rank}"

        filename = f"{prefix}_{square}_{piece}.png"
        filepath = output_dir / filename
        tile.save(filepath, format='PNG')
        saved += 1

    return saved


def generate_tiles_from_chessboards(
    chessboards_dir: Path,
    tiles_dir: Path,
    use_grayscale: bool = True,
    overwrite: bool = False
) -> tuple[int, int, int]:
    """Generate tiles from all chessboard images.

    Returns tuple of (success, skipped, failed) counts.
    """
    # Find all PNG images in subdirectories
    patterns = [
        str(chessboards_dir / '*.png'),
        str(chessboards_dir / '*/*.png'),
        str(chessboards_dir / '*/*/*.png'),
    ]

    all_images = []
    for pattern in patterns:
        all_images.extend(glob(pattern))

    if not all_images:
        print(f"No images found in {chessboards_dir}")
        return 0, 0, 0

    print(f"Found {len(all_images)} chessboard images")

    success = 0
    skipped = 0
    failed = 0

    for i, img_path in enumerate(sorted(all_images)):
        img_path = Path(img_path)

        if (i + 1) % 50 == 0:
            print(f"Processing {i + 1}/{len(all_images)}...")

        # Parse FEN from filename
        pieces = parse_filename_for_fen(img_path.name)
        if pieces is None:
            print(f"  Skipping {img_path.name}: cannot parse FEN from filename")
            failed += 1
            continue

        # Determine output directory based on source
        source = img_path.parent.name
        output_dir = tiles_dir / source / img_path.stem

        # Check if already processed
        if output_dir.exists() and not overwrite:
            skipped += 1
            continue

        # Extract tiles
        try:
            tiles = get_chessboard_tiles(img_path, use_grayscale=use_grayscale)

            if len(tiles) != 64:
                print(f"  Error {img_path.name}: expected 64 tiles, got {len(tiles)}")
                failed += 1
                continue

            # Save tiles
            prefix = img_path.stem.split('_')[0][:20]  # Truncate prefix
            save_tiles(tiles, pieces, output_dir, prefix)
            success += 1

        except Exception as e:
            print(f"  Error processing {img_path.name}: {e}")
            failed += 1

    return success, skipped, failed


def organize_tiles_by_class(tiles_dir: Path, class_dir: Path) -> dict[str, int]:
    """Reorganize tiles into class directories for easier training.

    Creates structure: class_dir/1/, class_dir/R/, class_dir/N/, etc.
    with symlinks or copies of all tiles.

    Returns dict of class -> count.
    """
    class_counts = {char: 0 for char in FEN_CHARS}

    # Create class directories
    for char in FEN_CHARS:
        (class_dir / char).mkdir(parents=True, exist_ok=True)

    # Find all tile images
    tile_files = glob(str(tiles_dir / '*/*/*.png'))

    for tile_path in tile_files:
        tile_path = Path(tile_path)

        # Extract piece from filename (e.g., "prefix_a8_R.png" -> "R")
        piece = tile_path.stem.split('_')[-1]

        if piece not in FEN_CHARS:
            continue

        # Copy to class directory with unique name
        dest = class_dir / piece / tile_path.name
        if not dest.exists():
            # Use copy to avoid symlink issues
            Image.open(tile_path).save(dest)
            class_counts[piece] += 1

    return class_counts


def main():
    parser = argparse.ArgumentParser(
        description="Generate training tiles from chessboard images"
    )
    parser.add_argument(
        "--input", "-i", type=Path, default=CHESSBOARDS_DIR,
        help=f"Input directory with chessboard images (default: {CHESSBOARDS_DIR})"
    )
    parser.add_argument(
        "--output", "-o", type=Path, default=TILES_DIR,
        help=f"Output directory for tiles (default: {TILES_DIR})"
    )
    parser.add_argument(
        "--grayscale", "-g", action="store_true", default=True,
        help="Convert tiles to grayscale (default: True)"
    )
    parser.add_argument(
        "--color", "-c", action="store_true",
        help="Keep tiles in color (overrides --grayscale)"
    )
    parser.add_argument(
        "--overwrite", action="store_true",
        help="Overwrite existing tiles"
    )
    parser.add_argument(
        "--organize", action="store_true",
        help="Also organize tiles into class directories"
    )

    args = parser.parse_args()

    use_grayscale = not args.color

    print(f"Generating tiles from {args.input}")
    print(f"Output directory: {args.output}")
    print(f"Grayscale: {use_grayscale}")

    success, skipped, failed = generate_tiles_from_chessboards(
        chessboards_dir=args.input,
        tiles_dir=args.output,
        use_grayscale=use_grayscale,
        overwrite=args.overwrite
    )

    print(f"\nResults: {success} successful, {skipped} skipped, {failed} failed")
    print(f"Total tiles generated: {success * 64}")

    if args.organize:
        print("\nOrganizing tiles by class...")
        class_dir = args.output / 'by_class'
        counts = organize_tiles_by_class(args.output, class_dir)
        print("Class distribution:")
        for char, count in sorted(counts.items(), key=lambda x: -x[1]):
            piece_name = {
                '1': 'empty', 'R': 'white rook', 'N': 'white knight',
                'B': 'white bishop', 'Q': 'white queen', 'K': 'white king',
                'P': 'white pawn', 'r': 'black rook', 'n': 'black knight',
                'b': 'black bishop', 'q': 'black queen', 'k': 'black king',
                'p': 'black pawn'
            }.get(char, char)
            print(f"  {char} ({piece_name}): {count}")


if __name__ == "__main__":
    main()
