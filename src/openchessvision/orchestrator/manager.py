"""
Workflow orchestration and state management.

This module coordinates the interaction between PDF viewing, diagram recognition,
and board control. It implements the state machine for the application workflow
and handles debouncing, caching, and error recovery.
"""

import asyncio
import logging
from dataclasses import dataclass, field
from enum import Enum, auto
from typing import Callable, Sequence
from datetime import datetime, timedelta

from openchessvision.core.models import (
    DiagramCandidate,
    RecognizedPosition,
    ConnectionStatus,
    SetPositionResult,
    SetPositionResultStatus,
    ViewportState,
    BoundingBox,
)
from openchessvision.core.interfaces import (
    BoardDriver,
    RecognitionBackend,
    WorkflowObserver,
)
from openchessvision.core.fen import positions_equal
from openchessvision.pdf.discovery import select_topmost_visible


logger = logging.getLogger(__name__)


class WorkflowState(Enum):
    """Application workflow states."""
    IDLE = auto()                    # No PDF loaded
    PDF_LOADED = auto()              # PDF loaded, no diagram selected
    DIAGRAM_SELECTED = auto()        # Diagram selected, not recognized
    POSITION_RECOGNIZED = auto()     # Position recognized, ready to send
    SENDING_TO_BOARD = auto()        # Sending position to board
    POSITION_SENT = auto()           # Position successfully sent
    ERROR = auto()                   # Error state


@dataclass
class WorkflowContext:
    """Current workflow context data."""
    # PDF state
    current_pdf_path: str | None = None
    current_page: int = 0
    viewport: ViewportState | None = None

    # Diagram state
    all_candidates: dict[int, Sequence[DiagramCandidate]] = field(default_factory=dict)
    active_candidate: DiagramCandidate | None = None
    active_candidate_changed_at: datetime | None = None

    # Recognition state
    recognized_position: RecognizedPosition | None = None
    recognition_cache: dict[str, RecognizedPosition] = field(default_factory=dict)

    # Board state
    last_sent_fen: str | None = None
    last_send_result: SetPositionResult | None = None

    # Auto-sync settings
    auto_sync_enabled: bool = False
    min_confidence_for_auto: float = 0.85
    debounce_ms: int = 500


class WorkflowManager:
    """
    Orchestrates the PDF → Recognition → Board workflow.

    Responsibilities:
    - Manage workflow state transitions
    - Coordinate diagram selection and recognition
    - Handle board commands with debouncing
    - Notify observers of state changes
    - Cache recognition results
    """

    def __init__(
        self,
        board_driver: BoardDriver,
        recognition_backend: RecognitionBackend,
    ) -> None:
        self._board = board_driver
        self._recognition = recognition_backend

        self._state = WorkflowState.IDLE
        self._context = WorkflowContext()
        self._observers: list[WorkflowObserver] = []

        self._recognition_lock = asyncio.Lock()
        self._send_lock = asyncio.Lock()
        self._debounce_task: asyncio.Task | None = None

        self._last_recognition_time: datetime | None = None

    @property
    def state(self) -> WorkflowState:
        return self._state

    @property
    def context(self) -> WorkflowContext:
        return self._context

    @property
    def board_driver(self) -> BoardDriver:
        return self._board

    @property
    def recognition_backend(self) -> RecognitionBackend:
        return self._recognition

    # Observer pattern

    def add_observer(self, observer: WorkflowObserver) -> None:
        """Add an observer for workflow events."""
        if observer not in self._observers:
            self._observers.append(observer)

    def remove_observer(self, observer: WorkflowObserver) -> None:
        """Remove an observer."""
        if observer in self._observers:
            self._observers.remove(observer)

    def _notify_connection_status(self, status: ConnectionStatus) -> None:
        for observer in self._observers:
            try:
                observer.on_connection_status_changed(status)
            except Exception as e:
                logger.error(f"Observer error: {e}")

    def _notify_position_recognized(self, position: RecognizedPosition) -> None:
        for observer in self._observers:
            try:
                observer.on_position_recognized(position)
            except Exception as e:
                logger.error(f"Observer error: {e}")

    def _notify_active_diagram(self, candidate: DiagramCandidate | None) -> None:
        for observer in self._observers:
            try:
                observer.on_active_diagram_changed(candidate)
            except Exception as e:
                logger.error(f"Observer error: {e}")

    def _notify_position_sent(self, result: SetPositionResult) -> None:
        for observer in self._observers:
            try:
                observer.on_position_sent(result)
            except Exception as e:
                logger.error(f"Observer error: {e}")

    def _notify_error(self, message: str) -> None:
        for observer in self._observers:
            try:
                observer.on_error(message)
            except Exception as e:
                logger.error(f"Observer error: {e}")

    # State transitions

    def _set_state(self, new_state: WorkflowState) -> None:
        """Update workflow state."""
        if new_state != self._state:
            logger.info(f"Workflow state: {self._state.name} -> {new_state.name}")
            self._state = new_state

    # PDF operations

    def on_pdf_opened(
        self,
        path: str,
        candidates: dict[int, Sequence[DiagramCandidate]],
    ) -> None:
        """Called when a PDF is opened."""
        self._context.current_pdf_path = path
        self._context.all_candidates = candidates
        self._context.current_page = 0
        self._context.active_candidate = None
        self._context.recognized_position = None
        self._set_state(WorkflowState.PDF_LOADED)

    def on_pdf_closed(self) -> None:
        """Called when a PDF is closed."""
        self._context = WorkflowContext()
        self._set_state(WorkflowState.IDLE)

    def on_viewport_changed(
        self,
        viewport: ViewportState,
        page_candidates: Sequence[DiagramCandidate],
    ) -> None:
        """
        Called when the PDF viewport changes (scroll/zoom).

        Updates the active diagram based on topmost-visible policy.
        """
        self._context.viewport = viewport
        self._context.current_page = viewport.page_index

        # Select topmost visible diagram
        new_active = select_topmost_visible(
            page_candidates,
            viewport.viewport_bbox,
        )

        if new_active != self._context.active_candidate:
            self._context.active_candidate = new_active
            self._context.active_candidate_changed_at = datetime.now()
            self._notify_active_diagram(new_active)

            if new_active is not None:
                self._set_state(WorkflowState.DIAGRAM_SELECTED)

                # Trigger debounced recognition if auto-sync enabled
                if self._context.auto_sync_enabled:
                    self._schedule_recognition(new_active)
            else:
                self._set_state(WorkflowState.PDF_LOADED)

    def _schedule_recognition(self, candidate: DiagramCandidate) -> None:
        """Schedule debounced recognition for a diagram."""
        if self._debounce_task is not None:
            self._debounce_task.cancel()

        async def debounced_recognize() -> None:
            await asyncio.sleep(self._context.debounce_ms / 1000)
            await self.recognize_diagram(candidate)

            # Auto-send if high confidence
            if (self._context.recognized_position is not None and
                self._context.recognized_position.is_high_confidence):
                await self.send_to_board()

        self._debounce_task = asyncio.create_task(debounced_recognize())

    # Diagram operations

    def select_diagram(self, candidate: DiagramCandidate) -> None:
        """Manually select a diagram candidate."""
        self._context.active_candidate = candidate
        self._context.active_candidate_changed_at = datetime.now()
        self._notify_active_diagram(candidate)
        self._set_state(WorkflowState.DIAGRAM_SELECTED)

    async def recognize_diagram(
        self,
        candidate: DiagramCandidate | None = None,
        image_getter: Callable[[DiagramCandidate], any] | None = None,
    ) -> RecognizedPosition | None:
        """
        Recognize the position in a diagram.

        Uses cached result if available.
        """
        if candidate is None:
            candidate = self._context.active_candidate

        if candidate is None:
            return None

        async with self._recognition_lock:
            # Check cache
            cached = self._context.recognition_cache.get(candidate.candidate_id)
            if cached is not None:
                self._context.recognized_position = cached
                self._notify_position_recognized(cached)
                self._set_state(WorkflowState.POSITION_RECOGNIZED)
                return cached

            # Get image for recognition
            if image_getter is None:
                logger.error("No image getter provided for recognition")
                return None

            try:
                image = image_getter(candidate)

                # Run recognition (may be CPU-intensive)
                position = await asyncio.get_event_loop().run_in_executor(
                    None,
                    self._recognition.recognize,
                    image,
                )

                # Add source tracking
                position = RecognizedPosition(
                    piece_placement=position.piece_placement,
                    fen=position.fen,
                    orientation=position.orientation,
                    overall_confidence=position.overall_confidence,
                    square_confidences=position.square_confidences,
                    source_candidate_id=candidate.candidate_id,
                    side_to_move=position.side_to_move,
                    annotation=position.annotation,
                )

                # Cache result
                self._context.recognition_cache[candidate.candidate_id] = position
                self._context.recognized_position = position
                self._last_recognition_time = datetime.now()

                self._notify_position_recognized(position)
                self._set_state(WorkflowState.POSITION_RECOGNIZED)

                return position

            except Exception as e:
                logger.error(f"Recognition error: {e}")
                self._notify_error(f"Recognition failed: {e}")
                self._set_state(WorkflowState.ERROR)
                return None

    # Board operations

    async def connect_board(self) -> ConnectionStatus:
        """Connect to the chess board."""
        self._notify_connection_status(ConnectionStatus.CONNECTING)

        try:
            status = await self._board.connect()
            self._notify_connection_status(status)
            return status
        except Exception as e:
            logger.error(f"Connection error: {e}")
            self._notify_error(f"Connection failed: {e}")
            self._notify_connection_status(ConnectionStatus.ERROR)
            return ConnectionStatus.ERROR

    async def disconnect_board(self) -> None:
        """Disconnect from the chess board."""
        await self._board.disconnect()
        self._notify_connection_status(ConnectionStatus.DISCONNECTED)

    async def send_to_board(
        self,
        fen: str | None = None,
        require_confirmation: bool = False,
    ) -> SetPositionResult:
        """
        Send the recognized position to the board.

        Args:
            fen: FEN to send, or use the last recognized position
            require_confirmation: If True, always require user confirmation
        """
        async with self._send_lock:
            # Determine FEN to send
            if fen is None:
                if self._context.recognized_position is None:
                    return SetPositionResult(
                        status=SetPositionResultStatus.FAILED,
                        message="No position recognized",
                    )
                fen = self._context.recognized_position.fen

                if fen is None:
                    return SetPositionResult(
                        status=SetPositionResultStatus.FAILED,
                        message="Recognition did not produce a valid FEN",
                    )

            # Check if same position already sent
            if (self._context.last_sent_fen is not None and
                positions_equal(fen, self._context.last_sent_fen)):
                return SetPositionResult(
                    status=SetPositionResultStatus.SUCCESS,
                    message="Position already set",
                )

            # Check board connection
            if self._board.connection_status != ConnectionStatus.CONNECTED:
                return SetPositionResult(
                    status=SetPositionResultStatus.FAILED,
                    message="Board not connected",
                )

            # Check confidence for auto-send
            if (not require_confirmation and
                self._context.recognized_position is not None and
                not self._context.recognized_position.is_high_confidence):
                return SetPositionResult(
                    status=SetPositionResultStatus.FAILED,
                    message="Low confidence - confirmation required",
                )

            # Send to board
            self._set_state(WorkflowState.SENDING_TO_BOARD)

            try:
                result = await self._board.set_position(fen)

                if result.status == SetPositionResultStatus.SUCCESS:
                    self._context.last_sent_fen = fen
                    self._set_state(WorkflowState.POSITION_SENT)
                else:
                    self._set_state(WorkflowState.ERROR)

                self._context.last_send_result = result
                self._notify_position_sent(result)

                return result

            except Exception as e:
                logger.error(f"Send error: {e}")
                self._notify_error(f"Failed to send position: {e}")
                self._set_state(WorkflowState.ERROR)
                return SetPositionResult(
                    status=SetPositionResultStatus.FAILED,
                    message=str(e),
                )

    async def emergency_stop(self) -> None:
        """Trigger emergency stop on the board."""
        logger.warning("Emergency stop triggered")
        await self._board.stop_motion()

    # Auto-sync control

    def set_auto_sync(self, enabled: bool) -> None:
        """Enable or disable auto-sync mode."""
        self._context.auto_sync_enabled = enabled
        logger.info(f"Auto-sync {'enabled' if enabled else 'disabled'}")

    def set_min_confidence(self, confidence: float) -> None:
        """Set the minimum confidence for auto-sync."""
        self._context.min_confidence_for_auto = max(0.0, min(1.0, confidence))

    # Utility methods

    def clear_cache(self) -> None:
        """Clear the recognition cache."""
        self._context.recognition_cache.clear()

    def get_candidates_for_page(self, page_index: int) -> Sequence[DiagramCandidate]:
        """Get all diagram candidates for a page."""
        return self._context.all_candidates.get(page_index, [])
