"""
Chess diagram discovery in PDF pages.

This module detects candidate chess diagrams within PDF pages by analyzing
embedded images and looking for square/rectangular patterns with appropriate
aspect ratios.
"""

from typing import Sequence
import io

import numpy as np
from numpy.typing import NDArray
from PIL import Image

from openchessvision.core.models import (
    BoundingBox,
    DiagramCandidate,
    DiagramType,
)
from openchessvision.pdf.reader import PDFReader


# Diagram detection thresholds
MIN_DIAGRAM_SIZE = 50           # Minimum width/height in points
MAX_ASPECT_RATIO_DEVIATION = 0.3  # How far from 1:1 is acceptable
MIN_IMAGE_SIZE_PIXELS = 64      # Minimum image dimension in pixels


class DiagramDiscovery:
    """
    Discovers chess diagram candidates within PDF pages.

    Uses multiple strategies:
    1. Embedded images with approximately square aspect ratio
    2. Regions with chess-like visual patterns (future enhancement)
    """

    def __init__(self, pdf_reader: PDFReader) -> None:
        self._reader = pdf_reader
        self._cache: dict[int, Sequence[DiagramCandidate]] = {}

    def clear_cache(self) -> None:
        """Clear the discovery cache."""
        self._cache.clear()

    def discover_candidates(self, page_index: int) -> Sequence[DiagramCandidate]:
        """
        Find all chess diagram candidates on a page.

        Results are cached for repeated calls.

        Args:
            page_index: 0-indexed page number

        Returns:
            Sequence of DiagramCandidate objects
        """
        if page_index in self._cache:
            return self._cache[page_index]

        candidates: list[DiagramCandidate] = []

        # Get PDF fingerprint for stable IDs
        info = self._reader.info
        if info is None:
            return candidates

        fingerprint = info.fingerprint

        # Strategy 1: Find embedded images that look like chess diagrams
        image_candidates = self._find_image_candidates(page_index, fingerprint)
        candidates.extend(image_candidates)

        # Strategy 2: Analyze page rendering for diagram patterns (future)
        # pattern_candidates = self._find_pattern_candidates(page_index, fingerprint)
        # candidates.extend(pattern_candidates)

        # Sort by position (top-to-bottom, left-to-right)
        candidates.sort(key=lambda c: (c.bbox.y0, c.bbox.x0))

        self._cache[page_index] = candidates
        return candidates

    def discover_all_pages(self) -> dict[int, Sequence[DiagramCandidate]]:
        """
        Find all chess diagram candidates in the entire PDF.

        Returns:
            Dict mapping page index to candidate sequences
        """
        result: dict[int, Sequence[DiagramCandidate]] = {}

        for page_idx in range(self._reader.page_count):
            candidates = self.discover_candidates(page_idx)
            if candidates:
                result[page_idx] = candidates

        return result

    def _find_image_candidates(
        self,
        page_index: int,
        fingerprint: str,
    ) -> list[DiagramCandidate]:
        """Find diagram candidates from embedded images."""
        candidates: list[DiagramCandidate] = []

        try:
            images = self._reader.get_images(page_index)
        except Exception:
            return candidates

        for bbox, image_data in images:
            # Check size constraints
            if bbox.width < MIN_DIAGRAM_SIZE or bbox.height < MIN_DIAGRAM_SIZE:
                continue

            # Check aspect ratio (chess diagrams are approximately square)
            aspect_ratio = bbox.width / bbox.height if bbox.height > 0 else 0
            if abs(aspect_ratio - 1.0) > MAX_ASPECT_RATIO_DEVIATION:
                continue

            # Validate image data
            if not self._is_likely_diagram_image(image_data):
                continue

            # Create candidate
            candidate_id = DiagramCandidate.generate_id(page_index, bbox, fingerprint)
            candidate = DiagramCandidate(
                page_number=page_index,
                bbox=bbox,
                diagram_type=DiagramType.RASTER,
                candidate_id=candidate_id,
            )
            candidates.append(candidate)

        return candidates

    def _is_likely_diagram_image(self, image_data: bytes) -> bool:
        """
        Check if image data is likely a chess diagram.

        Uses heuristics like:
        - Minimum size
        - Not too many colors (diagrams are typically limited palette)
        - Presence of contrast patterns
        """
        try:
            img = Image.open(io.BytesIO(image_data))

            # Check minimum size
            if img.width < MIN_IMAGE_SIZE_PIXELS or img.height < MIN_IMAGE_SIZE_PIXELS:
                return False

            # Convert to numpy for analysis
            img_array = np.array(img.convert("RGB"))

            # Check for reasonable color distribution
            # Chess diagrams typically have limited colors (pieces, squares, maybe some highlights)
            if not self._has_diagram_like_colors(img_array):
                return False

            return True

        except Exception:
            return False

    def _has_diagram_like_colors(self, img: NDArray[np.uint8]) -> bool:
        """
        Check if image has color distribution typical of chess diagrams.

        Diagrams typically have:
        - High contrast between dark and light squares
        - Limited number of distinct colors
        - Significant portions of light and dark areas
        """
        # Convert to grayscale for analysis
        if len(img.shape) == 3:
            gray = np.mean(img, axis=2).astype(np.uint8)
        else:
            gray = img

        # Check for bimodal distribution (light and dark squares)
        hist, _ = np.histogram(gray.flatten(), bins=256, range=(0, 256))

        # Find peaks in histogram
        # A chess diagram should have peaks near light and dark values
        light_region = hist[180:256].sum()
        dark_region = hist[0:80].sum()
        mid_region = hist[80:180].sum()

        total = hist.sum()
        if total == 0:
            return False

        light_fraction = light_region / total
        dark_fraction = dark_region / total

        # Both light and dark regions should be significant
        # This helps filter out photos or gradients
        return light_fraction > 0.1 and dark_fraction > 0.1

    def get_candidate_image(
        self,
        candidate: DiagramCandidate,
        scale: float = 2.0,
    ) -> NDArray[np.uint8]:
        """
        Extract the image for a diagram candidate.

        Args:
            candidate: The diagram candidate
            scale: Scale factor for rendering (higher = more detail)

        Returns:
            RGB image as numpy array
        """
        return self._reader.render_region(
            candidate.page_number,
            candidate.bbox,
            scale=scale,
        )


def select_topmost_visible(
    candidates: Sequence[DiagramCandidate],
    viewport: BoundingBox,
    min_visibility_fraction: float = 0.3,
) -> DiagramCandidate | None:
    """
    Select the topmost visible diagram according to spec §4.4.

    Selection policy:
    1. Filter to candidates intersecting viewport with sufficient visibility
    2. Select candidate with smallest top Y coordinate
    3. Break ties with smallest left X coordinate

    Args:
        candidates: All candidates on the page
        viewport: Current viewport bounding box
        min_visibility_fraction: Minimum fraction visible to be considered

    Returns:
        The topmost visible candidate, or None if none qualify
    """
    visible_candidates = []

    for candidate in candidates:
        visibility = candidate.bbox.visibility_fraction(viewport)
        if visibility >= min_visibility_fraction:
            visible_candidates.append((candidate, visibility))

    if not visible_candidates:
        return None

    # Sort by (y0, x0) - topmost first, then leftmost for ties
    visible_candidates.sort(key=lambda cv: (cv[0].bbox.y0, cv[0].bbox.x0))

    return visible_candidates[0][0]
