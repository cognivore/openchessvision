#!/usr/bin/env python3
"""
Generate chess board images from online diagram services.

Downloads random chess positions from multiple online services to create
a diverse training dataset with various board and piece styles.

Based on linrock/chessboard-recognizer approach.
"""

import os
import argparse
import random
import time
from pathlib import Path
from urllib import request
from urllib.error import URLError, HTTPError
from io import BytesIO

import numpy as np
from PIL import Image

# FEN characters representing pieces and empty squares
FEN_CHARS = '1RNBQKPrnbqkp'

# Output directory for downloaded board images
CHESSBOARDS_DIR = Path('./data/chessboards')


def generate_random_fen_array(fen_chars: str = FEN_CHARS) -> np.ndarray:
    """Generate a random 64-square board configuration."""
    chars = list(fen_chars)
    return np.random.choice(chars, 64)


def fen_array_to_filename(fen_arr: np.ndarray) -> str:
    """Convert a 64-element FEN array to a filename-safe string.

    Format: RRqpBnNr-QKPkrQPK-PpbQnNB1-nRRBpNpk-Nqprrpqp-kKKbNBPP-kQnrpkrn-BKRqbbBp.png
    (8 groups of 8 characters separated by dashes)
    """
    # Replace empty square markers with '1' for consistency
    fen_arr = fen_arr.copy()
    fen_arr[fen_arr == '-'] = '1'
    fen_arr[fen_arr == '_'] = '1'

    # Split into 8 ranks and join with dashes
    ranks = np.split(fen_arr, 8)
    return '-'.join(''.join(rank) for rank in ranks)


def download_from_fen_to_image(fen_arr: np.ndarray, output_dir: Path) -> bool:
    """Download a board image from fen-to-image.com."""
    # Format: /image/32/rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR
    fen_param = '/'.join(''.join(rank) for rank in np.split(fen_arr, 8))
    url = f"http://www.fen-to-image.com/image/32/{fen_param}"

    try:
        img_data = request.urlopen(url, timeout=10).read()
        img = Image.open(BytesIO(img_data))

        filename = fen_array_to_filename(fen_arr) + '.png'
        filepath = output_dir / filename
        img.save(filepath)
        return True
    except (URLError, HTTPError, OSError) as e:
        print(f"  Error downloading from fen-to-image: {e}")
        return False


def download_from_jinchess(fen_arr: np.ndarray, output_dir: Path) -> bool:
    """Download a board image from jinchess.com with random theme."""
    board_themes = [
        None, "cold-marble", "gray-tiles", "green-marble",
        "pale-wood", "red-marble", "slate", "winter", "wooden-dark"
    ]
    piece_themes = [
        None, "merida-flat", "smart-flat", "usual-flat", "alpha-flat"
    ]

    # Random theme selection
    board_theme = random.choice(board_themes)
    piece_theme = random.choice(piece_themes)
    use_gradient = random.choice([True, False])

    # jinchess uses - for empty squares
    fen_param = ''.join(fen_arr).replace('1', '-')
    url = f"http://jinchess.com/chessboard/?p={fen_param}"

    if board_theme:
        url += f"&bp={board_theme}"
    if piece_theme:
        url += f"&ps={piece_theme}"
    if use_gradient:
        url += "&gs"

    try:
        img_data = request.urlopen(url, timeout=15).read()
        img = Image.open(BytesIO(img_data))

        # Add theme suffix to filename for variety tracking
        theme_suffix = f"_jin_{board_theme or 'default'}_{piece_theme or 'default'}"
        filename = fen_array_to_filename(fen_arr) + theme_suffix + '.png'
        filepath = output_dir / filename
        img.save(filepath)
        return True
    except (URLError, HTTPError, OSError) as e:
        print(f"  Error downloading from jinchess: {e}")
        return False


def download_from_chessdiagram(fen_arr: np.ndarray, output_dir: Path, style: int = 0) -> bool:
    """Download a board image from chessdiagram.online."""
    # chessdiagram uses _ for empty squares and has inverted rank order
    fen_param = ''.join(fen_arr).replace('1', '_')

    # Different styles available
    if style == 0:
        url = f"https://chessdiagram.online/stilldiagram.php?d=_{fen_param}&q="
    else:
        url = f"https://chessdiagram.online/stagram.php?d=_{fen_param}&s={style}&q="

    try:
        img_data = request.urlopen(url, timeout=15).read()
        img = Image.open(BytesIO(img_data))

        # chessdiagram has inverted rank order - need to flip the FEN array for filename
        flipped_arr = np.hstack(np.split(fen_arr, 8)[::-1])

        filename = fen_array_to_filename(flipped_arr) + f'_cd{style}.png'
        filepath = output_dir / filename
        img.save(filepath)
        return True
    except (URLError, HTTPError, OSError) as e:
        print(f"  Error downloading from chessdiagram: {e}")
        return False


def download_from_backscattering(fen_arr: np.ndarray, output_dir: Path) -> bool:
    """Download a board image from backscattering.de."""
    # Format standard FEN with / separators
    fen_param = '/'.join(''.join(rank) for rank in np.split(fen_arr, 8))
    url = f"https://backscattering.de/web-boardimage/board.png?fen={fen_param}&size=256"

    try:
        img_data = request.urlopen(url, timeout=15).read()
        img = Image.open(BytesIO(img_data))

        filename = fen_array_to_filename(fen_arr) + '_bs.png'
        filepath = output_dir / filename
        img.save(filepath)
        return True
    except (URLError, HTTPError, OSError) as e:
        print(f"  Error downloading from backscattering: {e}")
        return False


def generate_chessboards(
    count: int,
    output_dir: Path,
    sources: list[str] | None = None,
    delay: float = 0.5
) -> int:
    """Generate random chessboard images from multiple sources.

    Args:
        count: Number of board images to generate per source
        output_dir: Directory to save images
        sources: List of sources to use (default: all)
        delay: Delay between requests to avoid rate limiting

    Returns:
        Total number of images successfully downloaded
    """
    output_dir.mkdir(parents=True, exist_ok=True)

    if sources is None:
        sources = ['fen-to-image', 'jinchess', 'chessdiagram', 'backscattering']

    total_success = 0

    for source in sources:
        print(f"\nDownloading from {source}...")
        source_dir = output_dir / source
        source_dir.mkdir(exist_ok=True)

        success = 0
        for i in range(count):
            fen_arr = generate_random_fen_array()

            if source == 'fen-to-image':
                ok = download_from_fen_to_image(fen_arr, source_dir)
            elif source == 'jinchess':
                ok = download_from_jinchess(fen_arr, source_dir)
            elif source == 'chessdiagram':
                style = random.choice([0, 1, 2])
                ok = download_from_chessdiagram(fen_arr, source_dir, style)
            elif source == 'backscattering':
                ok = download_from_backscattering(fen_arr, source_dir)
            else:
                print(f"  Unknown source: {source}")
                continue

            if ok:
                success += 1
                if (i + 1) % 10 == 0:
                    print(f"  Downloaded {i + 1}/{count} images...")

            time.sleep(delay)

        print(f"  Completed {source}: {success}/{count} successful")
        total_success += success

    return total_success


def main():
    parser = argparse.ArgumentParser(
        description="Generate chess board images from online services"
    )
    parser.add_argument(
        "--count", "-n", type=int, default=100,
        help="Number of images per source (default: 100)"
    )
    parser.add_argument(
        "--output", "-o", type=Path, default=CHESSBOARDS_DIR,
        help=f"Output directory (default: {CHESSBOARDS_DIR})"
    )
    parser.add_argument(
        "--sources", "-s", nargs="+",
        choices=['fen-to-image', 'jinchess', 'chessdiagram', 'backscattering'],
        help="Sources to download from (default: all)"
    )
    parser.add_argument(
        "--delay", "-d", type=float, default=0.5,
        help="Delay between requests in seconds (default: 0.5)"
    )

    args = parser.parse_args()

    print(f"Generating {args.count} chessboard images per source")
    print(f"Output directory: {args.output}")

    total = generate_chessboards(
        count=args.count,
        output_dir=args.output,
        sources=args.sources,
        delay=args.delay
    )

    print(f"\nTotal images downloaded: {total}")


if __name__ == "__main__":
    main()
