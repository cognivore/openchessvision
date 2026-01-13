"""
PDF reader implementation using PyMuPDF (fitz).

Provides PDF rendering, viewport tracking, and coordinate transforms
for the chess diagram recognition workflow.
"""

from pathlib import Path
from typing import Sequence
import hashlib

import fitz  # PyMuPDF
import numpy as np
from numpy.typing import NDArray

from openchessvision.core.models import (
    BoundingBox,
    PDFInfo,
    ViewportState,
)


class PDFReader:
    """
    PDF reader with page rendering and viewport tracking.

    Uses PyMuPDF for fast rendering and image extraction.
    """

    def __init__(self) -> None:
        self._doc: fitz.Document | None = None
        self._path: str | None = None
        self._fingerprint: str | None = None
        self._info: PDFInfo | None = None

    @property
    def info(self) -> PDFInfo | None:
        """Information about the currently loaded PDF."""
        return self._info

    @property
    def page_count(self) -> int:
        """Number of pages in the loaded PDF."""
        if self._doc is None:
            return 0
        return len(self._doc)

    @property
    def is_open(self) -> bool:
        """Whether a PDF is currently open."""
        return self._doc is not None

    def open(self, path: str) -> PDFInfo:
        """
        Open a PDF file.

        Args:
            path: Path to the PDF file

        Returns:
            PDFInfo with document metadata

        Raises:
            FileNotFoundError: If the file doesn't exist
            ValueError: If the file is not a valid PDF
        """
        path_obj = Path(path)

        if not path_obj.exists():
            raise FileNotFoundError(f"PDF file not found: {path}")

        # Close any currently open document
        self.close()

        try:
            self._doc = fitz.open(path)
        except Exception as e:
            raise ValueError(f"Failed to open PDF: {e}") from e

        self._path = str(path_obj.absolute())
        self._fingerprint = self._compute_fingerprint(path_obj)

        # Extract metadata
        metadata = self._doc.metadata
        self._info = PDFInfo(
            path=self._path,
            fingerprint=self._fingerprint,
            page_count=len(self._doc),
            title=metadata.get("title") if metadata else None,
            author=metadata.get("author") if metadata else None,
        )

        return self._info

    def close(self) -> None:
        """Close the currently loaded PDF."""
        if self._doc is not None:
            self._doc.close()
            self._doc = None
        self._path = None
        self._fingerprint = None
        self._info = None

    def _compute_fingerprint(self, path: Path) -> str:
        """Compute a stable fingerprint for cache keying."""
        # Use file path + size + mtime for a quick fingerprint
        stat = path.stat()
        data = f"{path.absolute()}:{stat.st_size}:{stat.st_mtime}"
        return hashlib.sha256(data.encode()).hexdigest()[:16]

    def _ensure_open(self) -> fitz.Document:
        """Ensure a document is open, raising if not."""
        if self._doc is None:
            raise RuntimeError("No PDF is currently open")
        return self._doc

    def get_page_size(self, page_index: int) -> tuple[float, float]:
        """
        Get the size of a page in points.

        Args:
            page_index: 0-indexed page number

        Returns:
            (width, height) tuple in points
        """
        doc = self._ensure_open()

        if page_index < 0 or page_index >= len(doc):
            raise IndexError(f"Page index {page_index} out of range [0, {len(doc)})")

        page = doc[page_index]
        rect = page.rect
        return (rect.width, rect.height)

    def render_page(
        self,
        page_index: int,
        scale: float = 1.0,
    ) -> NDArray[np.uint8]:
        """
        Render a page to an RGB image.

        Args:
            page_index: 0-indexed page number
            scale: Scale factor (1.0 = 72 DPI, 2.0 = 144 DPI, etc.)

        Returns:
            RGB image as numpy array with shape (height, width, 3)
        """
        doc = self._ensure_open()

        if page_index < 0 or page_index >= len(doc):
            raise IndexError(f"Page index {page_index} out of range [0, {len(doc)})")

        page = doc[page_index]

        # Create transformation matrix for scaling
        matrix = fitz.Matrix(scale, scale)

        # Render to pixmap
        pixmap = page.get_pixmap(matrix=matrix, alpha=False)

        # Convert to numpy array
        img = np.frombuffer(pixmap.samples, dtype=np.uint8)
        img = img.reshape(pixmap.height, pixmap.width, 3)

        return img

    def render_region(
        self,
        page_index: int,
        bbox: BoundingBox,
        scale: float = 1.0,
    ) -> NDArray[np.uint8]:
        """
        Render a specific region of a page to an RGB image.

        Args:
            page_index: 0-indexed page number
            bbox: Region to render in page coordinates
            scale: Scale factor

        Returns:
            RGB image as numpy array
        """
        doc = self._ensure_open()

        if page_index < 0 or page_index >= len(doc):
            raise IndexError(f"Page index {page_index} out of range [0, {len(doc)})")

        page = doc[page_index]

        # Create clip rectangle
        clip = fitz.Rect(bbox.x0, bbox.y0, bbox.x1, bbox.y1)

        # Create transformation matrix for scaling
        matrix = fitz.Matrix(scale, scale)

        # Render clipped region
        pixmap = page.get_pixmap(matrix=matrix, clip=clip, alpha=False)

        # Convert to numpy array
        img = np.frombuffer(pixmap.samples, dtype=np.uint8)
        img = img.reshape(pixmap.height, pixmap.width, 3)

        return img

    def get_images(self, page_index: int) -> Sequence[tuple[BoundingBox, bytes]]:
        """
        Extract embedded images from a page.

        Args:
            page_index: 0-indexed page number

        Returns:
            List of (bounding_box, raw_image_data) tuples
        """
        doc = self._ensure_open()

        if page_index < 0 or page_index >= len(doc):
            raise IndexError(f"Page index {page_index} out of range [0, {len(doc)})")

        page = doc[page_index]
        images: list[tuple[BoundingBox, bytes]] = []

        # Get image list with position information
        image_list = page.get_images(full=True)

        for img_info in image_list:
            xref = img_info[0]

            try:
                # Get image bounding box
                image_rects = page.get_image_rects(xref)
                if not image_rects:
                    continue

                rect = image_rects[0]
                bbox = BoundingBox(
                    x0=rect.x0,
                    y0=rect.y0,
                    x1=rect.x1,
                    y1=rect.y1,
                )

                # Extract raw image data
                base_image = doc.extract_image(xref)
                if base_image:
                    images.append((bbox, base_image["image"]))

            except Exception:
                # Skip images we can't extract
                continue

        return images

    def get_text_blocks(self, page_index: int) -> Sequence[tuple[BoundingBox, str]]:
        """
        Extract text blocks from a page with their positions.

        Useful for finding "White to move" or similar annotations near diagrams.

        Args:
            page_index: 0-indexed page number

        Returns:
            List of (bounding_box, text) tuples
        """
        doc = self._ensure_open()

        if page_index < 0 or page_index >= len(doc):
            raise IndexError(f"Page index {page_index} out of range [0, {len(doc)})")

        page = doc[page_index]
        blocks: list[tuple[BoundingBox, str]] = []

        # Get text blocks
        text_dict = page.get_text("dict", flags=fitz.TEXT_PRESERVE_WHITESPACE)

        for block in text_dict.get("blocks", []):
            if block.get("type") != 0:  # 0 = text block
                continue

            bbox = BoundingBox(
                x0=block["bbox"][0],
                y0=block["bbox"][1],
                x1=block["bbox"][2],
                y1=block["bbox"][3],
            )

            # Concatenate text from all lines in the block
            text_parts = []
            for line in block.get("lines", []):
                for span in line.get("spans", []):
                    text_parts.append(span.get("text", ""))

            text = " ".join(text_parts).strip()
            if text:
                blocks.append((bbox, text))

        return blocks


def compute_viewport_state(
    page_index: int,
    page_size: tuple[float, float],
    visible_rect: tuple[float, float, float, float],
    zoom_scale: float,
) -> ViewportState:
    """
    Compute the current viewport state from widget geometry.

    Args:
        page_index: Current page index
        page_size: (width, height) of the page in points
        visible_rect: (x, y, width, height) of visible area in page coordinates
        zoom_scale: Current zoom factor

    Returns:
        ViewportState object
    """
    x, y, w, h = visible_rect

    return ViewportState(
        page_index=page_index,
        zoom_scale=zoom_scale,
        viewport_bbox=BoundingBox(x0=x, y0=y, x1=x + w, y1=y + h),
        scroll_position_y=y,
    )
