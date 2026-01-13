"""Core abstractions, data models, and utilities."""

from openchessvision.core.models import (
    DiagramCandidate,
    DiagramType,
    RecognizedPosition,
    SquareConfidence,
    ConnectionStatus,
    DeviceInfo,
    SetPositionResult,
    BoardOrientation,
    ViewportState,
)
from openchessvision.core.interfaces import (
    BoardDriver,
    RecognitionBackend,
    PDFBackend,
)
from openchessvision.core.fen import (
    validate_fen,
    normalize_fen,
    fen_to_piece_map,
    piece_map_to_fen,
    FENValidationError,
)

__all__ = [
    # Models
    "DiagramCandidate",
    "DiagramType",
    "RecognizedPosition",
    "SquareConfidence",
    "ConnectionStatus",
    "DeviceInfo",
    "SetPositionResult",
    "BoardOrientation",
    "ViewportState",
    # Interfaces
    "BoardDriver",
    "RecognitionBackend",
    "PDFBackend",
    # FEN utilities
    "validate_fen",
    "normalize_fen",
    "fen_to_piece_map",
    "piece_map_to_fen",
    "FENValidationError",
]
