#!/usr/bin/env python3
"""
Scan PDFs in fixtures/ and extract potential chess diagram images.

Saves square-ish images to fixtures/pending/ for annotation.
"""

import argparse
import hashlib
from pathlib import Path
from typing import Optional
import fitz  # PyMuPDF
from PIL import Image
import io


def get_image_hash(image_bytes: bytes) -> str:
    """Get short hash of image for deduplication."""
    return hashlib.md5(image_bytes).hexdigest()[:12]


def is_square_ish(width: int, height: int, tolerance: float = 0.25) -> bool:
    """Check if dimensions are roughly square."""
    if width == 0 or height == 0:
        return False
    aspect = max(width, height) / min(width, height)
    return aspect < (1 + tolerance)


def extract_diagrams_from_pdf(
    pdf_path: Path,
    output_dir: Path,
    min_size: int = 100,
    max_size: int = 2000,
    aspect_tolerance: float = 0.25
) -> list[Path]:
    """
    Extract potential chess diagram images from a PDF.

    Args:
        pdf_path: Path to PDF file
        output_dir: Directory to save extracted images
        min_size: Minimum dimension in pixels
        max_size: Maximum dimension in pixels
        aspect_tolerance: How close to square (0.25 = 1.25:1 ratio max)

    Returns:
        List of saved image paths
    """
    saved = []
    seen_hashes = set()

    try:
        doc = fitz.open(pdf_path)
    except Exception as e:
        print(f"  Error opening PDF: {e}")
        return saved

    pdf_name = pdf_path.stem[:30]  # Truncate long names

    for page_num in range(len(doc)):
        page = doc[page_num]
        image_list = page.get_images()

        for img_idx, img_info in enumerate(image_list):
            xref = img_info[0]

            try:
                base_image = doc.extract_image(xref)
                image_bytes = base_image["image"]

                # Skip duplicates
                img_hash = get_image_hash(image_bytes)
                if img_hash in seen_hashes:
                    continue
                seen_hashes.add(img_hash)

                # Load image
                img = Image.open(io.BytesIO(image_bytes))
                width, height = img.size

                # Filter by size
                if width < min_size or height < min_size:
                    continue
                if width > max_size or height > max_size:
                    continue

                # Filter by aspect ratio (must be square-ish)
                if not is_square_ish(width, height, aspect_tolerance):
                    continue

                # Convert to RGB if necessary
                if img.mode != 'RGB':
                    img = img.convert('RGB')

                # Save
                filename = f"{pdf_name}_p{page_num+1:03d}_i{img_idx:02d}_{img_hash}.png"
                output_path = output_dir / filename
                img.save(output_path)
                saved.append(output_path)

            except Exception as e:
                continue  # Skip problematic images

    doc.close()
    return saved


def scan_fixtures(
    fixtures_dir: Path,
    output_dir: Path,
    min_size: int = 100,
    aspect_tolerance: float = 0.25
) -> dict[str, int]:
    """
    Scan all PDFs in fixtures directory.

    Returns:
        Dict of pdf_name -> count of extracted images
    """
    output_dir.mkdir(parents=True, exist_ok=True)

    results = {}
    pdf_files = list(fixtures_dir.glob("*.pdf"))

    print(f"Found {len(pdf_files)} PDF files", flush=True)

    for pdf_path in sorted(pdf_files):
        print(f"\nScanning: {pdf_path.name[:60]}...", flush=True)

        saved = extract_diagrams_from_pdf(
            pdf_path, output_dir,
            min_size=min_size,
            aspect_tolerance=aspect_tolerance
        )

        results[pdf_path.name] = len(saved)
        print(f"  Extracted {len(saved)} diagram candidates", flush=True)

    return results


def main():
    parser = argparse.ArgumentParser(
        description="Extract chess diagram candidates from PDFs"
    )
    parser.add_argument(
        "--fixtures", "-f", type=Path,
        default=Path(__file__).parent.parent.parent / "tests" / "fixtures",
        help="Directory containing PDFs"
    )
    parser.add_argument(
        "--output", "-o", type=Path,
        default=None,
        help="Output directory (default: fixtures/pending)"
    )
    parser.add_argument(
        "--min-size", type=int, default=100,
        help="Minimum image dimension in pixels"
    )
    parser.add_argument(
        "--aspect-tolerance", type=float, default=0.25,
        help="Aspect ratio tolerance (0.25 = allow up to 1.25:1)"
    )

    args = parser.parse_args()

    if args.output is None:
        args.output = args.fixtures / "pending"

    print(f"Scanning PDFs in: {args.fixtures}", flush=True)
    print(f"Output directory: {args.output}", flush=True)

    results = scan_fixtures(
        args.fixtures, args.output,
        min_size=args.min_size,
        aspect_tolerance=args.aspect_tolerance
    )

    total = sum(results.values())
    print(f"\n=== Summary ===", flush=True)
    print(f"PDFs scanned: {len(results)}", flush=True)
    print(f"Total diagram candidates: {total}", flush=True)
    print(f"Saved to: {args.output}", flush=True)


if __name__ == "__main__":
    main()
