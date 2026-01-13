"""
Protocol definitions for pluggable backends.

This module defines the structural interfaces (Protocols) that allow
different implementations of board drivers, recognition backends, and
PDF backends to be swapped without changing the rest of the application.
"""

from typing import Protocol, runtime_checkable
from collections.abc import Sequence, AsyncIterator
import numpy as np
from numpy.typing import NDArray

from openchessvision.core.models import (
    DiagramCandidate,
    RecognizedPosition,
    ConnectionStatus,
    ConnectionQuality,
    DeviceInfo,
    SetPositionResult,
    ViewportState,
    PDFInfo,
    BoundingBox,
)


@runtime_checkable
class BoardDriver(Protocol):
    """
    Protocol for e-board drivers (Chessnut Move, mock, etc.).

    All methods are async to support non-blocking BLE operations.
    Implementations must handle their own connection state management.
    """

    @property
    def connection_status(self) -> ConnectionStatus:
        """Current connection status."""
        ...

    async def scan_for_devices(self, timeout_seconds: float = 10.0) -> Sequence[DeviceInfo]:
        """
        Scan for available board devices.

        Returns a sequence of discovered devices. Does not connect to any.
        """
        ...

    async def connect(self, device: DeviceInfo | None = None) -> ConnectionStatus:
        """
        Connect to a board device.

        If device is None, connect to the first available device.
        Returns the new connection status.
        """
        ...

    async def disconnect(self) -> None:
        """Disconnect from the currently connected board."""
        ...

    async def get_device_info(self) -> DeviceInfo | None:
        """Get information about the currently connected device."""
        ...

    async def get_connection_quality(self) -> ConnectionQuality:
        """Get connection quality metrics."""
        ...

    async def set_position(self, fen: str) -> SetPositionResult:
        """
        Command the board to set up the given position.

        The FEN string should be validated before calling this method.
        For robotic boards, this initiates physical piece movement.
        """
        ...

    async def get_position(self) -> dict[str, str] | None:
        """
        Read the current physical position from the board.

        Returns a piece map (square -> piece) or None if not supported.
        """
        ...

    async def stop_motion(self) -> None:
        """
        Emergency stop - halt all robotic motion immediately.

        This is a high-priority command that should be processed
        as quickly as possible.
        """
        ...

    async def set_leds(self, squares: Sequence[str], color: str = "green") -> None:
        """
        Set LED indicators on specific squares (if supported).

        Squares are in algebraic notation (e.g., ["e4", "d5"]).
        """
        ...


@runtime_checkable
class RecognitionBackend(Protocol):
    """
    Protocol for chess diagram recognition backends.

    Implementations can use classical CV, deep learning, or hybrid approaches.
    Recognition is synchronous as it's typically CPU/GPU bound.
    """

    @property
    def name(self) -> str:
        """Human-readable name of this backend."""
        ...

    @property
    def confidence_threshold(self) -> float:
        """Minimum confidence for automatic acceptance."""
        ...

    def recognize(self, image: NDArray[np.uint8]) -> RecognizedPosition:
        """
        Recognize a chess position from a diagram image.

        The image should be a numpy array in BGR or RGB format.
        Returns a RecognizedPosition with piece placement and confidence.
        """
        ...

    def supports_orientation_detection(self) -> bool:
        """Whether this backend can detect board orientation."""
        ...

    def supports_annotation_extraction(self) -> bool:
        """Whether this backend can extract annotations (e.g., 'White to move')."""
        ...


@runtime_checkable
class PDFBackend(Protocol):
    """
    Protocol for PDF rendering and access.

    Implementations handle opening PDFs, rendering pages, and
    providing coordinate transforms between page and screen space.
    """

    @property
    def info(self) -> PDFInfo | None:
        """Information about the currently loaded PDF, or None if not loaded."""
        ...

    @property
    def page_count(self) -> int:
        """Number of pages in the loaded PDF."""
        ...

    def open(self, path: str) -> PDFInfo:
        """
        Open a PDF file.

        Returns PDFInfo on success, raises on failure.
        """
        ...

    def close(self) -> None:
        """Close the currently loaded PDF."""
        ...

    def render_page(
        self,
        page_index: int,
        scale: float = 1.0,
    ) -> NDArray[np.uint8]:
        """
        Render a page to an image.

        Returns a numpy array in RGB format.
        Scale factor is relative to 72 DPI base.
        """
        ...

    def render_region(
        self,
        page_index: int,
        bbox: BoundingBox,
        scale: float = 1.0,
    ) -> NDArray[np.uint8]:
        """
        Render a specific region of a page to an image.

        Useful for extracting diagram images for recognition.
        """
        ...

    def get_page_size(self, page_index: int) -> tuple[float, float]:
        """Get the size of a page in points (width, height)."""
        ...

    def get_images(self, page_index: int) -> Sequence[tuple[BoundingBox, bytes]]:
        """
        Extract embedded images from a page.

        Returns a sequence of (bounding_box, image_data) tuples.
        """
        ...


@runtime_checkable
class DiagramDiscoveryBackend(Protocol):
    """
    Protocol for detecting chess diagrams within PDF pages.

    Implementations analyze page content to find candidate diagrams.
    """

    def discover_candidates(
        self,
        pdf: PDFBackend,
        page_index: int,
    ) -> Sequence[DiagramCandidate]:
        """
        Find all chess diagram candidates on a page.

        Returns a sequence of DiagramCandidate objects with bounding boxes.
        """
        ...

    def discover_all_pages(
        self,
        pdf: PDFBackend,
    ) -> dict[int, Sequence[DiagramCandidate]]:
        """
        Find all chess diagram candidates in the entire PDF.

        Returns a dict mapping page index to candidate sequences.
        """
        ...


class WorkflowObserver(Protocol):
    """
    Observer protocol for workflow state changes.

    UI components implement this to receive updates from the orchestrator.
    """

    def on_connection_status_changed(self, status: ConnectionStatus) -> None:
        """Called when board connection status changes."""
        ...

    def on_position_recognized(self, position: RecognizedPosition) -> None:
        """Called when a new position has been recognized."""
        ...

    def on_active_diagram_changed(self, candidate: DiagramCandidate | None) -> None:
        """Called when the active diagram selection changes."""
        ...

    def on_position_sent(self, result: SetPositionResult) -> None:
        """Called when a position has been sent to the board."""
        ...

    def on_error(self, message: str) -> None:
        """Called when an error occurs."""
        ...
