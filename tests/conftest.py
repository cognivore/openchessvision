"""
Pytest configuration and fixtures for OpenChessVision tests.
"""

import pytest
import asyncio
import numpy as np
from typing import Generator

from openchessvision.board.mock import MockBoardDriver, MockBoardConfig
from openchessvision.recognition.classical import ClassicalRecognitionBackend


@pytest.fixture
def event_loop() -> Generator[asyncio.AbstractEventLoop, None, None]:
    """Create an event loop for async tests."""
    loop = asyncio.new_event_loop()
    yield loop
    loop.close()


@pytest.fixture
def mock_board() -> MockBoardDriver:
    """Create a mock board driver for testing."""
    return MockBoardDriver(MockBoardConfig(
        scan_delay_ms=10,
        connect_delay_ms=10,
        set_position_delay_ms=50,
    ))


@pytest.fixture
def recognition_backend() -> ClassicalRecognitionBackend:
    """Create a classical recognition backend for testing."""
    return ClassicalRecognitionBackend(confidence_threshold=0.7)


@pytest.fixture
def sample_chessboard_image() -> np.ndarray:
    """Create a simple test chessboard image."""
    # Create an 8x8 checkerboard pattern
    size = 400
    square_size = size // 8

    image = np.zeros((size, size, 3), dtype=np.uint8)

    for row in range(8):
        for col in range(8):
            x0 = col * square_size
            y0 = row * square_size

            is_light = (row + col) % 2 == 0
            color = (240, 217, 181) if is_light else (181, 136, 99)

            image[y0:y0+square_size, x0:x0+square_size] = color

    return image


@pytest.fixture
def starting_position_fen() -> str:
    """The standard chess starting position FEN."""
    return "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"


@pytest.fixture
def empty_board_fen() -> str:
    """An empty board with just kings (minimal legal position)."""
    return "4k3/8/8/8/8/8/8/4K3 w - - 0 1"
