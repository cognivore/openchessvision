"""
Test for the K.Richter vs G.Rogmann (Berlin 1937) position.

Position after: 1.d4 Nf6 2.Nc3 d5 3.Bg5 c6 4.f3 Qb6

Expected FEN: rnb1kb1r/pp2pppp/1qp2n2/3p2B1/3P4/2N2P2/PPP1P1PP/R2QKBNR w KQkq - 0 5
"""

import pytest
import cv2
import numpy as np
from pathlib import Path

from openchessvision.core.fen import (
    validate_fen,
    fen_to_piece_map,
    piece_map_to_fen,
    normalize_fen,
)
from openchessvision.board.mock import MockBoardDriver, MockBoardConfig
from openchessvision.core.models import ConnectionStatus, SetPositionResultStatus
from openchessvision.recognition.classical import ClassicalRecognitionBackend


# The correct FEN for the position after 1.d4 Nf6 2.Nc3 d5 3.Bg5 c6 4.f3 Qb6
RICHTER_ROGMANN_FEN = "rnb1kb1r/pp2pppp/1qp2n2/3p2B1/3P4/2N2P2/PPP1P1PP/R2QKBNR w KQkq - 0 5"

# Path to the test image
TEST_IMAGE_PATH = Path(__file__).parent / "fixtures" / "Berlin37.png"


class TestRichterRogmannPosition:
    """Tests for the Richter-Rogmann 1937 position."""

    def test_fen_is_valid(self):
        """The FEN should pass validation."""
        valid, error = validate_fen(RICHTER_ROGMANN_FEN)
        assert valid is True, f"FEN validation failed: {error}"

    def test_piece_placement_black_pieces(self):
        """Verify black piece positions."""
        piece_map = fen_to_piece_map(RICHTER_ROGMANN_FEN)

        # Black rooks
        assert piece_map.get("a8") == "r", "Black rook should be on a8"
        assert piece_map.get("h8") == "r", "Black rook should be on h8"

        # Black knights - one on b8, one MOVED to f6 (not on g8!)
        assert piece_map.get("b8") == "n", "Black knight should be on b8"
        assert piece_map.get("f6") == "n", "Black knight should be on f6 (moved from g8)"
        assert "g8" not in piece_map, "g8 should be EMPTY (knight moved to f6)"

        # Black bishops
        assert piece_map.get("c8") == "b", "Black bishop should be on c8"
        assert piece_map.get("f8") == "b", "Black bishop should be on f8"

        # Black king and queen
        assert piece_map.get("e8") == "k", "Black king should be on e8"
        assert piece_map.get("b6") == "q", "Black queen should be on b6 (moved from d8)"
        assert "d8" not in piece_map, "d8 should be EMPTY (queen moved to b6)"

        # Black pawns
        assert piece_map.get("a7") == "p", "Black pawn should be on a7"
        assert piece_map.get("b7") == "p", "Black pawn should be on b7"
        assert piece_map.get("c6") == "p", "Black pawn should be on c6 (moved from c7)"
        assert piece_map.get("d5") == "p", "Black pawn should be on d5 (moved from d7)"
        assert piece_map.get("e7") == "p", "Black pawn should be on e7"
        assert piece_map.get("f7") == "p", "Black pawn should be on f7"
        assert piece_map.get("g7") == "p", "Black pawn should be on g7"
        assert piece_map.get("h7") == "p", "Black pawn should be on h7"

        # c7 and d7 should be empty (pawns moved)
        assert "c7" not in piece_map, "c7 should be EMPTY (pawn moved to c6)"
        assert "d7" not in piece_map, "d7 should be EMPTY (pawn moved to d5)"

    def test_piece_placement_white_pieces(self):
        """Verify white piece positions."""
        piece_map = fen_to_piece_map(RICHTER_ROGMANN_FEN)

        # White rooks
        assert piece_map.get("a1") == "R", "White rook should be on a1"
        assert piece_map.get("h1") == "R", "White rook should be on h1"

        # White knights - one MOVED to c3, one on g1
        assert piece_map.get("c3") == "N", "White knight should be on c3 (moved from b1)"
        assert piece_map.get("g1") == "N", "White knight should be on g1"
        assert "b1" not in piece_map, "b1 should be EMPTY (knight moved to c3)"

        # White bishops - one MOVED to g5, one on f1
        assert piece_map.get("g5") == "B", "White bishop should be on g5 (moved from c1)"
        assert piece_map.get("f1") == "B", "White bishop should be on f1"
        assert "c1" not in piece_map, "c1 should be EMPTY (bishop moved to g5)"

        # White king and queen
        assert piece_map.get("e1") == "K", "White king should be on e1"
        assert piece_map.get("d1") == "Q", "White queen should be on d1"

        # White pawns
        assert piece_map.get("a2") == "P", "White pawn should be on a2"
        assert piece_map.get("b2") == "P", "White pawn should be on b2"
        assert piece_map.get("c2") == "P", "White pawn should be on c2"
        assert piece_map.get("d4") == "P", "White pawn should be on d4 (moved from d2)"
        assert piece_map.get("e2") == "P", "White pawn should be on e2"
        assert piece_map.get("f3") == "P", "White pawn should be on f3 (moved from f2)"
        assert piece_map.get("g2") == "P", "White pawn should be on g2"
        assert piece_map.get("h2") == "P", "White pawn should be on h2"

        # d2 and f2 should be empty (pawns moved)
        assert "d2" not in piece_map, "d2 should be EMPTY (pawn moved to d4)"
        assert "f2" not in piece_map, "f2 should be EMPTY (pawn moved to f3)"

    def test_game_state_metadata(self):
        """Verify the game state (side to move, castling, etc.)."""
        parts = RICHTER_ROGMANN_FEN.split()

        # Side to move: White (Black just played Qb6)
        assert parts[1] == "w", "White should be to move"

        # Castling: Both sides can still castle both ways
        assert parts[2] == "KQkq", "All castling rights should be preserved"

        # En passant: None (last move was Qb6, not a pawn advance)
        assert parts[3] == "-", "No en passant square"

        # Halfmove clock
        assert parts[4] == "0", "Halfmove clock should be 0"

        # Fullmove number: Move 5 for White
        assert parts[5] == "5", "Should be move 5"

    def test_total_piece_count(self):
        """Verify the total number of pieces on the board."""
        piece_map = fen_to_piece_map(RICHTER_ROGMANN_FEN)

        # Count pieces by type
        white_pieces = sum(1 for p in piece_map.values() if p.isupper())
        black_pieces = sum(1 for p in piece_map.values() if p.islower())

        # All 32 pieces should still be on the board (no captures yet)
        assert white_pieces == 16, f"White should have 16 pieces, got {white_pieces}"
        assert black_pieces == 16, f"Black should have 16 pieces, got {black_pieces}"
        assert len(piece_map) == 32, f"Total pieces should be 32, got {len(piece_map)}"


class TestRichterRogmannMockBoard:
    """Test sending the Richter-Rogmann position to mock board."""

    @pytest.fixture
    def fast_mock_board(self):
        """Create a fast mock board for testing."""
        config = MockBoardConfig(
            scan_delay_ms=10,
            connect_delay_ms=10,
            set_position_delay_ms=50,
        )
        return MockBoardDriver(config)

    @pytest.mark.asyncio
    async def test_connect_and_set_position(self, fast_mock_board):
        """Test the full flow: connect to board and set position."""
        board = fast_mock_board

        # Step 1: Scan for devices
        devices = await board.scan_for_devices(timeout_seconds=1.0)
        assert len(devices) == 1, "Should find mock device"
        print(f"Found device: {devices[0].model}")

        # Step 2: Connect
        status = await board.connect()
        assert status == ConnectionStatus.CONNECTED, "Should connect successfully"
        print(f"Connection status: {status.name}")

        # Step 3: Get device info
        info = await board.get_device_info()
        assert info is not None, "Should get device info"
        print(f"Device: {info.model}, FW: {info.firmware_version}")

        # Step 4: Send the Richter-Rogmann position
        print(f"\nSending position: {RICHTER_ROGMANN_FEN}")
        result = await board.set_position(RICHTER_ROGMANN_FEN)

        assert result.status == SetPositionResultStatus.SUCCESS, \
            f"Position send failed: {result.message}"
        print(f"Set position result: {result.status.name} - {result.message}")

        # Step 5: Verify the position was set
        current_position = await board.get_position()
        assert current_position is not None, "Should be able to read position"

        expected_position = fen_to_piece_map(RICHTER_ROGMANN_FEN)
        assert current_position == expected_position, \
            "Board position should match the FEN"
        print(f"Position verified: {len(current_position)} pieces on board")

        # Step 6: Check command log
        log = board.command_log
        print(f"\nCommand log ({len(log)} entries):")
        for entry in log:
            print(f"  [{entry.timestamp.strftime('%H:%M:%S')}] {entry.command}: {entry.result}")

        # Step 7: Disconnect
        await board.disconnect()
        assert board.connection_status == ConnectionStatus.DISCONNECTED
        print("\nDisconnected from board")

    @pytest.mark.asyncio
    async def test_position_key_squares(self, fast_mock_board):
        """Verify key squares after setting position on board."""
        board = fast_mock_board

        await board.connect()
        await board.set_position(RICHTER_ROGMANN_FEN)

        position = await board.get_position()

        # Key squares that define this position
        key_squares = {
            "b6": "q",   # Black queen (the last move!)
            "f6": "n",   # Black knight (moved from g8)
            "g5": "B",   # White bishop (moved from c1)
            "d4": "P",   # White pawn (moved from d2)
            "c3": "N",   # White knight (moved from b1)
            "f3": "P",   # White pawn (moved from f2)
            "d5": "p",   # Black pawn (moved from d7)
            "c6": "p",   # Black pawn (moved from c7)
        }

        print("Verifying key squares:")
        for square, expected_piece in key_squares.items():
            actual_piece = position.get(square)
            assert actual_piece == expected_piece, \
                f"Square {square}: expected {expected_piece}, got {actual_piece}"
            print(f"  {square}: {actual_piece} ✓")

        # Verify empty squares (where pieces moved FROM)
        empty_squares = ["g8", "d8", "b1", "c1", "d2", "f2", "c7", "d7"]
        print("\nVerifying empty squares:")
        for square in empty_squares:
            assert square not in position, f"Square {square} should be empty"
            print(f"  {square}: empty ✓")

        await board.disconnect()


class TestImageRecognition:
    """
    Test actual image recognition on the Berlin 1937 diagram.

    NOTE: The classical CV backend is a basic placeholder implementation.
    These tests document the CURRENT (poor) state of recognition and serve
    as a baseline for improvement. Real recognition requires either:
    - Piece template matching with known piece fonts
    - A trained ML model (MLX backend)
    - More sophisticated CV pipeline
    """

    @pytest.fixture
    def diagram_image(self):
        """Load the test diagram image."""
        assert TEST_IMAGE_PATH.exists(), f"Test image not found: {TEST_IMAGE_PATH}"
        image = cv2.imread(str(TEST_IMAGE_PATH))
        assert image is not None, "Failed to load test image"
        return image

    @pytest.fixture
    def board_image(self, diagram_image):
        """Extract just the chess board from the full page image."""
        h, w = diagram_image.shape[:2]

        # The board in Berlin37.png is at approximately these coordinates
        # (determined by inspection: board starts at y~428, x~126, size ~500px)
        board_top = 428
        board_left = 126
        board_size = 500

        board = diagram_image[board_top:board_top+board_size, board_left:board_left+board_size]
        return board

    @pytest.fixture
    def recognition_backend(self):
        """Create the classical recognition backend."""
        return ClassicalRecognitionBackend(confidence_threshold=0.5)

    def test_image_loads(self, diagram_image):
        """Verify the test image loads correctly."""
        print(f"\nImage shape: {diagram_image.shape}")
        print(f"Image dtype: {diagram_image.dtype}")
        assert len(diagram_image.shape) == 3, "Image should be color (3 channels)"
        assert diagram_image.shape[2] == 3, "Image should have 3 color channels"
        # Berlin37.png is 770x988
        assert diagram_image.shape[0] == 988, "Expected height 988"
        assert diagram_image.shape[1] == 770, "Expected width 770"

    def test_board_extraction(self, board_image):
        """Verify board region is extracted correctly."""
        print(f"\nExtracted board shape: {board_image.shape}")
        h, w = board_image.shape[:2]

        # Board should be roughly square
        aspect_ratio = w / h
        assert 0.9 < aspect_ratio < 1.1, f"Board should be square, got aspect ratio {aspect_ratio}"

        # Board should be reasonably sized (at least 400px for good recognition)
        assert min(h, w) >= 400, f"Board too small: {w}x{h}"

    def test_recognition_runs_without_crash(self, board_image, recognition_backend):
        """Test that recognition runs without crashing (baseline test)."""
        result = recognition_backend.recognize(board_image)

        # Should return a RecognizedPosition object
        assert result is not None
        assert hasattr(result, 'piece_placement')
        assert hasattr(result, 'fen')
        assert hasattr(result, 'overall_confidence')

        print(f"\nRecognition output:")
        print(f"  Pieces detected: {len(result.piece_placement)}")
        print(f"  Confidence: {result.overall_confidence:.2%}")
        print(f"  FEN valid: {result.fen is not None}")

    @pytest.mark.xfail(reason="Classical CV backend is placeholder - needs real implementation")
    def test_recognition_accuracy(self, board_image, recognition_backend):
        """
        Test that recognition produces the correct FEN.

        EXPECTED TO FAIL until we implement proper recognition:
        - Template matching with piece fonts, OR
        - Trained ML model
        """
        result = recognition_backend.recognize(board_image)

        expected_piece_map = fen_to_piece_map(RICHTER_ROGMANN_FEN)

        print(f"\nExpected pieces: {len(expected_piece_map)}")
        print(f"Detected pieces: {len(result.piece_placement)}")

        # Check key squares
        key_squares = {
            "b6": "q",   # Black queen
            "f6": "n",   # Black knight
            "g5": "B",   # White bishop
            "d4": "P",   # White pawn
            "c3": "N",   # White knight
            "f3": "P",   # White pawn
        }

        errors = []
        for square, expected in key_squares.items():
            actual = result.piece_placement.get(square)
            if actual != expected:
                errors.append(f"{square}: expected {expected}, got {actual}")

        if errors:
            print(f"\nMismatches on key squares:")
            for e in errors:
                print(f"  {e}")

        # This assertion documents what SHOULD work
        assert result.fen is not None, "Should produce valid FEN"
        assert len(result.piece_placement) == 32, f"Should find 32 pieces, found {len(result.piece_placement)}"

        # Compare piece placements
        for square, expected_piece in expected_piece_map.items():
            actual_piece = result.piece_placement.get(square)
            assert actual_piece == expected_piece, \
                f"Square {square}: expected {expected_piece}, got {actual_piece}"


if __name__ == "__main__":
    pytest.main([__file__, "-v", "-s"])
