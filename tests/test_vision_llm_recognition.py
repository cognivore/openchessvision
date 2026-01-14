"""
Test Vision LLM recognition on the Berlin 1937 diagram.

Requires OPENAI_API_KEY environment variable to be set.
Run with: OPENAI_API_KEY='your-key' pytest tests/test_vision_llm_recognition.py -v -s
"""

import os
import pytest
import cv2
from pathlib import Path

from openchessvision.recognition.vision_llm import VisionLLMBackend
from openchessvision.core.fen import fen_to_piece_map, validate_fen


# Expected FEN for Berlin 1937 position
RICHTER_ROGMANN_FEN = "rnb1kb1r/pp2pppp/1qp2n2/3p2B1/3P4/2N2P2/PPP1P1PP/R2QKBNR w KQkq - 0 5"
TEST_IMAGE_PATH = Path(__file__).parent / "fixtures" / "Berlin37.png"


# Skip all tests if no API key
pytestmark = pytest.mark.skipif(
    not os.environ.get("OPENAI_API_KEY"),
    reason="OPENAI_API_KEY not set"
)


class TestVisionLLMRecognition:
    """Test GPT-4V based chess diagram recognition."""

    @pytest.fixture
    def board_image(self):
        """Load and crop to just the chess board."""
        image = cv2.imread(str(TEST_IMAGE_PATH))
        assert image is not None, f"Failed to load {TEST_IMAGE_PATH}"
        # Crop to board region
        board = image[428:928, 126:626]
        return board

    @pytest.fixture
    def vision_backend(self):
        """Create the Vision LLM backend."""
        return VisionLLMBackend(model="gpt-4o")

    def test_vision_llm_recognizes_position(self, board_image, vision_backend):
        """Test that GPT-4V can recognize the chess position."""
        print(f"\nSending image to GPT-4V for analysis...")
        print(f"Board image shape: {board_image.shape}")

        result = vision_backend.recognize(board_image)

        print(f"\nRecognition result:")
        print(f"  FEN: {result.fen}")
        print(f"  Confidence: {result.overall_confidence:.2%}")
        print(f"  Orientation: {result.orientation.name}")
        print(f"  Pieces found: {len(result.piece_placement)}")
        if result.annotation:
            print(f"  Notes: {result.annotation}")

        # Should produce a valid FEN
        assert result.fen is not None, f"Should produce valid FEN. Got annotation: {result.annotation}"

        valid, error = validate_fen(result.fen, strict=False)
        assert valid, f"FEN should be valid: {error}"

    def test_vision_llm_accuracy(self, board_image, vision_backend):
        """Test that GPT-4V produces the correct FEN."""
        result = vision_backend.recognize(board_image)

        assert result.fen is not None, "Should produce FEN"

        # Extract just the piece placement for comparison
        detected_placement = result.fen.split()[0]
        expected_placement = RICHTER_ROGMANN_FEN.split()[0]

        print(f"\nExpected: {expected_placement}")
        print(f"Detected: {detected_placement}")

        # Compare piece maps
        expected_pieces = fen_to_piece_map(RICHTER_ROGMANN_FEN)
        detected_pieces = result.piece_placement

        # Check key squares
        key_squares = {
            "b6": "q",   # Black queen (the last move)
            "f6": "n",   # Black knight (moved from g8)
            "g5": "B",   # White bishop (moved from c1)
            "d4": "P",   # White pawn (moved from d2)
            "c3": "N",   # White knight (moved from b1)
            "f3": "P",   # White pawn (moved from f2)
            "d5": "p",   # Black pawn
            "c6": "p",   # Black pawn
            "e1": "K",   # White king
            "e8": "k",   # Black king
        }

        correct = 0
        errors = []
        for square, expected in key_squares.items():
            actual = detected_pieces.get(square)
            if actual == expected:
                correct += 1
                print(f"  ✓ {square}: {actual}")
            else:
                errors.append(f"{square}: expected {expected}, got {actual}")
                print(f"  ✗ {square}: expected {expected}, got {actual}")

        accuracy = correct / len(key_squares)
        print(f"\nKey square accuracy: {accuracy:.0%} ({correct}/{len(key_squares)})")

        # Should get at least 80% of key squares correct
        assert accuracy >= 0.8, f"Should recognize at least 80% of key squares. Errors: {errors}"

        # Ideally should match exactly
        if detected_placement == expected_placement:
            print("\n✓ PERFECT MATCH!")
        else:
            print(f"\nPiece placement differs from expected")
            # Show detailed diff
            for square in sorted(set(expected_pieces.keys()) | set(detected_pieces.keys())):
                exp = expected_pieces.get(square, ".")
                det = detected_pieces.get(square, ".")
                if exp != det:
                    print(f"  {square}: expected={exp} detected={det}")


class TestVisionLLMIntegration:
    """Test full integration with mock board."""

    @pytest.fixture
    def board_image(self):
        """Load and crop to just the chess board."""
        image = cv2.imread(str(TEST_IMAGE_PATH))
        board = image[428:928, 126:626]
        return board

    @pytest.mark.asyncio
    async def test_recognize_and_send_to_board(self, board_image):
        """Test recognizing diagram and sending to mock board."""
        from openchessvision.recognition.vision_llm import VisionLLMBackend
        from openchessvision.board.mock import MockBoardDriver, MockBoardConfig
        from openchessvision.core.models import ConnectionStatus, SetPositionResultStatus

        # Initialize components
        vision = VisionLLMBackend(model="gpt-4o")
        board = MockBoardDriver(MockBoardConfig(
            connect_delay_ms=10,
            set_position_delay_ms=50,
        ))

        # Step 1: Recognize the diagram
        print("\n1. Recognizing diagram with GPT-4V...")
        result = vision.recognize(board_image)

        assert result.fen is not None, f"Recognition failed: {result.annotation}"
        print(f"   FEN: {result.fen}")
        print(f"   Confidence: {result.overall_confidence:.0%}")

        # Step 2: Connect to board
        print("\n2. Connecting to mock board...")
        status = await board.connect()
        assert status == ConnectionStatus.CONNECTED
        print("   Connected!")

        # Step 3: Send position
        print("\n3. Sending position to board...")
        send_result = await board.set_position(result.fen)

        assert send_result.status == SetPositionResultStatus.SUCCESS, \
            f"Failed to send: {send_result.message}"
        print("   Position sent successfully!")

        # Step 4: Verify
        print("\n4. Verifying board position...")
        board_position = await board.get_position()
        assert board_position == dict(result.piece_placement)
        print(f"   Verified: {len(board_position)} pieces on board")

        # Step 5: Cleanup
        await board.disconnect()
        print("\n✓ Full pipeline test passed!")


if __name__ == "__main__":
    pytest.main([__file__, "-v", "-s"])
