"""
OpenChessVision - AI PDF Chess Book Reader with Chessnut Move Bluetooth Position Relay

This package provides:
- PDF reading with chess diagram detection
- Position recognition from diagram images
- Chessnut Move e-board control over Bluetooth LE
"""

__version__ = "0.1.0"
__author__ = "OpenChessVision Contributors"

from openchessvision.core.models import (
    DiagramCandidate,
    RecognizedPosition,
    ConnectionStatus,
    BoardOrientation,
)

__all__ = [
    "DiagramCandidate",
    "RecognizedPosition",
    "ConnectionStatus",
    "BoardOrientation",
    "__version__",
]
