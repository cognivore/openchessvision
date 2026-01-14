#!/usr/bin/env python3
"""
Organize cleaned diagram images.

1. Move raw images to ~/Chess/raw-boards/
2. Rename cleaned images to their file hash
"""

import hashlib
import shutil
from pathlib import Path


def get_file_hash(filepath: Path) -> str:
    """Get MD5 hash of file contents."""
    h = hashlib.md5()
    with open(filepath, 'rb') as f:
        for chunk in iter(lambda: f.read(8192), b''):
            h.update(chunk)
    return h.hexdigest()


def organize(pending_dir: Path, raw_dest: Path):
    """
    Organize files:
    1. Move raw images to raw_dest
    2. Rename cleaned images to their hash
    """
    raw_dest.mkdir(parents=True, exist_ok=True)

    # Find all files
    all_pngs = list(pending_dir.glob("*.png"))

    cleaned = [p for p in all_pngs if p.stem.endswith("_cleaned")]
    raw = [p for p in all_pngs if not p.stem.endswith("_cleaned") and not p.stem.endswith("_debug")]
    debug = [p for p in all_pngs if p.stem.endswith("_debug")]

    print(f"Found {len(cleaned)} cleaned, {len(raw)} raw, {len(debug)} debug images", flush=True)

    # Move raw images
    print(f"\nMoving {len(raw)} raw images to {raw_dest}...", flush=True)
    for i, f in enumerate(raw, 1):
        if i % 500 == 0:
            print(f"  Moved {i}/{len(raw)}", flush=True)
        shutil.move(str(f), str(raw_dest / f.name))
    print(f"  Moved {len(raw)} raw images", flush=True)

    # Delete debug images (optional, they're large)
    if debug:
        print(f"\nDeleting {len(debug)} debug images...", flush=True)
        for f in debug:
            f.unlink()

    # Rename cleaned images to hash
    print(f"\nRenaming {len(cleaned)} cleaned images to hash...", flush=True)
    renamed = 0
    for i, f in enumerate(cleaned, 1):
        if i % 500 == 0:
            print(f"  Renamed {i}/{len(cleaned)}", flush=True)

        file_hash = get_file_hash(f)
        new_name = f"{file_hash}.png"
        new_path = pending_dir / new_name

        # Handle hash collisions (unlikely but possible)
        if new_path.exists():
            # Same hash = same content, just delete duplicate
            f.unlink()
        else:
            f.rename(new_path)
            renamed += 1

    print(f"  Renamed {renamed} images (removed {len(cleaned) - renamed} duplicates)", flush=True)

    print("\nDone!", flush=True)
    print(f"  Raw images: {raw_dest}", flush=True)
    print(f"  Cleaned images: {pending_dir}", flush=True)


if __name__ == "__main__":
    pending = Path("/Users/sweater/Github/openchessvision/tests/fixtures/pending")
    raw_dest = Path.home() / "Chess" / "raw-boards"

    organize(pending, raw_dest)
