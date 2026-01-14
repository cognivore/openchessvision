#!/usr/bin/env python3
"""
Clean extracted chess diagram images.

Takes raw diagram images extracted from PDFs and transforms them into
perfect 256x256 squares where pixel (0,0) is A8's top-left corner.

Uses BoardDetector for edge detection, line detection, and perspective warp.
"""

import argparse
import shutil
import sys
from pathlib import Path

# Add project root to path for imports
PROJECT_ROOT = Path(__file__).parent.parent.parent
sys.path.insert(0, str(PROJECT_ROOT / "src"))

import cv2
from openchessvision.preprocessing.board_detector import BoardDetector


def clean_diagrams(
    pending_dir: Path,
    unrecognised_dir: Path,
    save_debug: bool = False,
) -> tuple[int, int]:
    """
    Process all PNG images in pending directory.

    Args:
        pending_dir: Directory containing raw extracted PNGs
        unrecognised_dir: Directory to move failed images to
        save_debug: Whether to save debug visualization images

    Returns:
        Tuple of (cleaned_count, failed_count)
    """
    # Ensure directories exist
    pending_dir.mkdir(parents=True, exist_ok=True)
    unrecognised_dir.mkdir(parents=True, exist_ok=True)

    # Initialize detector
    detector = BoardDetector(output_size=256)

    # Find all PNGs (excluding already cleaned ones)
    all_pngs = list(pending_dir.glob("*.png"))
    pngs_to_process = [
        p for p in all_pngs
        if not p.stem.endswith("_cleaned") and not p.stem.endswith("_debug")
    ]

    print(f"Found {len(pngs_to_process)} images to process", flush=True)
    print(f"(Skipping {len(all_pngs) - len(pngs_to_process)} already cleaned/debug images)", flush=True)
    print("", flush=True)

    cleaned_count = 0
    failed_count = 0

    for i, png_path in enumerate(sorted(pngs_to_process), 1):
        print(f"[{i}/{len(pngs_to_process)}] {png_path.name[:60]}...", end=" ", flush=True)

        # Check if already cleaned
        cleaned_path = png_path.with_stem(f"{png_path.stem}_cleaned")
        if cleaned_path.exists():
            print("SKIPPED (already cleaned)", flush=True)
            continue

        # Run detection
        result = detector.detect_from_file(png_path, debug=save_debug)

        if result.success and result.board_image is not None:
            # Save cleaned image
            cv2.imwrite(str(cleaned_path), result.board_image)
            print("OK", flush=True)
            cleaned_count += 1

            # Save debug image if requested
            if save_debug and result.debug_image is not None:
                debug_path = png_path.with_stem(f"{png_path.stem}_debug")
                cv2.imwrite(str(debug_path), result.debug_image)
        else:
            # Move to unrecognised
            dest_path = unrecognised_dir / png_path.name
            shutil.move(str(png_path), str(dest_path))
            error_msg = result.error_message or "Unknown error"
            print(f"FAILED ({error_msg}) -> moved to unrecognised/", flush=True)
            failed_count += 1

    return cleaned_count, failed_count


def main():
    parser = argparse.ArgumentParser(
        description="Clean extracted chess diagrams into perfect 256x256 squares"
    )
    parser.add_argument(
        "--pending", "-p", type=Path,
        default=PROJECT_ROOT / "tests" / "fixtures" / "pending",
        help="Directory containing raw extracted PNGs"
    )
    parser.add_argument(
        "--unrecognised", "-u", type=Path,
        default=None,
        help="Directory for failed images (default: pending/../unrecognised)"
    )
    parser.add_argument(
        "--debug", "-d", action="store_true",
        help="Save debug visualization images"
    )

    args = parser.parse_args()

    if args.unrecognised is None:
        args.unrecognised = args.pending.parent / "unrecognised"

    print("=" * 60, flush=True)
    print("Chess Diagram Cleaner", flush=True)
    print("=" * 60, flush=True)
    print(f"Input directory:  {args.pending}", flush=True)
    print(f"Unrecognised dir: {args.unrecognised}", flush=True)
    print(f"Debug mode:       {args.debug}", flush=True)
    print("=" * 60, flush=True)
    print("", flush=True)

    cleaned, failed = clean_diagrams(
        args.pending,
        args.unrecognised,
        save_debug=args.debug
    )

    print("", flush=True)
    print("=" * 60, flush=True)
    print("Summary", flush=True)
    print("=" * 60, flush=True)
    print(f"  Cleaned:      {cleaned}", flush=True)
    print(f"  Unrecognised: {failed}", flush=True)
    print(f"  Total:        {cleaned + failed}", flush=True)

    if failed > 0:
        print(f"\nFailed images moved to: {args.unrecognised}", flush=True)


if __name__ == "__main__":
    main()
