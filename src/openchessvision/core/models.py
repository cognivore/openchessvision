"""
Data models for OpenChessVision.

This module defines all the core data structures used throughout the application,
following immutable/frozen dataclass patterns for safety and clarity.
"""

from dataclasses import dataclass, field
from enum import Enum, auto
from typing import Mapping
import hashlib


class DiagramType(Enum):
    """Classification of how a diagram is embedded in the PDF."""
    RASTER = auto()    # Embedded bitmap image
    VECTOR = auto()    # Vector drawing (paths/glyphs)
    UNKNOWN = auto()   # Could not determine


class BoardOrientation(Enum):
    """Which side of the board is at the bottom of the diagram."""
    WHITE = auto()     # White pieces at bottom (standard)
    BLACK = auto()     # Black pieces at bottom (flipped)
    UNKNOWN = auto()   # Could not determine


class ConnectionStatus(Enum):
    """Board driver connection states."""
    DISCONNECTED = auto()
    SCANNING = auto()
    CONNECTING = auto()
    CONNECTED = auto()
    ERROR = auto()


class SetPositionResultStatus(Enum):
    """Result status for set_position command."""
    SUCCESS = auto()
    IN_PROGRESS = auto()
    FAILED = auto()
    CANCELLED = auto()


@dataclass(frozen=True)
class BoundingBox:
    """Axis-aligned bounding box in page coordinates."""
    x0: float  # Left edge
    y0: float  # Top edge
    x1: float  # Right edge
    y1: float  # Bottom edge

    @property
    def width(self) -> float:
        return self.x1 - self.x0

    @property
    def height(self) -> float:
        return self.y1 - self.y0

    @property
    def center_x(self) -> float:
        return (self.x0 + self.x1) / 2

    @property
    def center_y(self) -> float:
        return (self.y0 + self.y1) / 2

    @property
    def area(self) -> float:
        return self.width * self.height

    def intersects(self, other: "BoundingBox") -> bool:
        """Check if this box intersects with another."""
        return not (
            self.x1 < other.x0 or
            self.x0 > other.x1 or
            self.y1 < other.y0 or
            self.y0 > other.y1
        )

    def intersection_area(self, other: "BoundingBox") -> float:
        """Calculate the area of intersection with another box."""
        if not self.intersects(other):
            return 0.0

        ix0 = max(self.x0, other.x0)
        iy0 = max(self.y0, other.y0)
        ix1 = min(self.x1, other.x1)
        iy1 = min(self.y1, other.y1)

        return (ix1 - ix0) * (iy1 - iy0)

    def visibility_fraction(self, viewport: "BoundingBox") -> float:
        """Calculate what fraction of this box is visible in the viewport."""
        if self.area == 0:
            return 0.0
        return self.intersection_area(viewport) / self.area


@dataclass(frozen=True)
class DiagramCandidate:
    """
    A detected chess diagram candidate within a PDF page.

    The candidate_id is stable across sessions for the same diagram,
    allowing for caching of recognition results.
    """
    page_number: int           # 0-indexed page number
    bbox: BoundingBox          # Bounding box in page coordinates
    diagram_type: DiagramType  # How the diagram is embedded
    candidate_id: str          # Stable hash-based identifier

    @staticmethod
    def generate_id(page: int, bbox: BoundingBox, pdf_fingerprint: str) -> str:
        """Generate a stable candidate ID from page, bbox, and PDF fingerprint."""
        data = f"{pdf_fingerprint}:{page}:{bbox.x0:.2f},{bbox.y0:.2f},{bbox.x1:.2f},{bbox.y1:.2f}"
        return hashlib.sha256(data.encode()).hexdigest()[:16]


@dataclass(frozen=True)
class SquareConfidence:
    """Per-square recognition confidence."""
    square: str           # e.g., "e4"
    piece: str | None     # Piece symbol or None for empty
    confidence: float     # 0.0 to 1.0


@dataclass(frozen=True)
class RecognizedPosition:
    """
    The result of recognizing a chess position from a diagram.

    Contains the piece placement, optional FEN, orientation detection,
    and confidence metrics.
    """
    # Core position data
    piece_placement: Mapping[str, str]  # square -> piece (e.g., {"e1": "K", "e8": "k"})
    fen: str | None                      # Full FEN string if determinable
    orientation: BoardOrientation        # Detected board orientation

    # Confidence metrics
    overall_confidence: float            # 0.0 to 1.0
    square_confidences: tuple[SquareConfidence, ...] = field(default_factory=tuple)

    # Source tracking
    source_candidate_id: str | None = None

    # Detected annotations (optional)
    side_to_move: str | None = None      # "w" or "b" if detected
    annotation: str | None = None        # e.g., "Mate in 3"

    @property
    def is_high_confidence(self) -> bool:
        """Check if recognition confidence is high enough for auto-sync."""
        return self.overall_confidence >= 0.85

    @property
    def piece_count(self) -> int:
        """Total number of pieces on the board."""
        return len(self.piece_placement)


@dataclass(frozen=True)
class DeviceInfo:
    """Information about a connected board device."""
    model: str
    firmware_version: str | None = None
    serial_number: str | None = None
    bluetooth_address: str | None = None


@dataclass(frozen=True)
class ConnectionQuality:
    """Connection quality metrics for the board."""
    rssi: int | None = None           # Signal strength in dBm
    last_seen_ms: int = 0             # Milliseconds since last communication
    error_rate: float = 0.0           # Fraction of failed commands


@dataclass(frozen=True)
class SetPositionResult:
    """Result of a set_position command to the board."""
    status: SetPositionResultStatus
    message: str | None = None
    estimated_time_ms: int | None = None


@dataclass(frozen=True)
class ViewportState:
    """Current viewport state of the PDF reader."""
    page_index: int           # 0-indexed current/dominant page
    zoom_scale: float         # Zoom factor (1.0 = 100%)
    viewport_bbox: BoundingBox  # Visible area in page coordinates
    scroll_position_y: float  # Vertical scroll position


@dataclass(frozen=True)
class PDFInfo:
    """Metadata about an opened PDF file."""
    path: str
    fingerprint: str          # Hash for cache keying
    page_count: int
    title: str | None = None
    author: str | None = None
