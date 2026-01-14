"""
Local CNN-based chess diagram recognition backend.

Uses the chessimg2pos library which provides a pre-trained CNN model
for recognizing chess pieces in diagram images.
"""

import os
import tempfile
from pathlib import Path
from typing import Optional

import numpy as np
from numpy.typing import NDArray
import cv2

from openchessvision.core.models import (
    RecognizedPosition,
    BoardOrientation,
)
from openchessvision.core.fen import validate_fen, fen_to_piece_map


def _consolidate_fen_ranks(broken_fen: str) -> str:
    """
    Fix chessimg2pos output which uses '1' for each empty square
    instead of properly consolidating consecutive empty squares.

    Example: "pp11pppp" -> "pp2pppp"
    """
    def consolidate_rank(rank: str) -> str:
        result = []
        count = 0
        for c in rank:
            if c == '1':
                count += 1
            else:
                if count > 0:
                    result.append(str(count))
                    count = 0
                result.append(c)
        if count > 0:
            result.append(str(count))
        return ''.join(result)

    ranks = broken_fen.split('/')
    return '/'.join(consolidate_rank(r) for r in ranks)


class LocalCNNBackend:
    """
    Local CNN-based recognition backend using chessimg2pos.

    This runs entirely locally on CPU - no API calls required.
    The model is downloaded once and cached locally.
    """

    def __init__(
        self,
        confidence_threshold: float = 0.7,
        use_grayscale: bool = False,
    ) -> None:
        self._confidence_threshold = confidence_threshold
        self._use_grayscale = use_grayscale
        self._predictor = None
        self._model_downloaded = False

    @property
    def name(self) -> str:
        return "Local CNN (chessimg2pos)"

    @property
    def confidence_threshold(self) -> float:
        return self._confidence_threshold

    def supports_orientation_detection(self) -> bool:
        # The CNN model assumes white at bottom
        return False

    def supports_annotation_extraction(self) -> bool:
        return False

    def _ensure_model(self) -> None:
        """Ensure the pre-trained model is downloaded."""
        if not self._model_downloaded:
            from chessimg2pos import download_pretrained_model
            download_pretrained_model()
            self._model_downloaded = True

    def recognize(self, image: NDArray[np.uint8]) -> RecognizedPosition:
        """
        Recognize chess position from image using local CNN.

        The image should be a cropped chess board (just the 8x8 grid).
        """
        try:
            from chessimg2pos import predict_fen

            self._ensure_model()

            # chessimg2pos expects a file path, not numpy array
            # Write to temp file
            with tempfile.NamedTemporaryFile(suffix='.png', delete=False) as f:
                temp_path = f.name
                cv2.imwrite(temp_path, image)

            try:
                # Use the simple predict_fen function
                raw_fen = predict_fen(temp_path)

                if not raw_fen:
                    return RecognizedPosition(
                        piece_placement={},
                        fen=None,
                        orientation=BoardOrientation.WHITE,
                        overall_confidence=0.0,
                        annotation="CNN model returned no prediction",
                    )

                # Fix the FEN format issue (consecutive 1s not consolidated)
                fixed_fen = _consolidate_fen_ranks(raw_fen)

                # Validate the FEN (piece placement only)
                is_valid, error = validate_fen(fixed_fen, strict=False)

                if not is_valid:
                    return RecognizedPosition(
                        piece_placement={},
                        fen=fixed_fen,
                        orientation=BoardOrientation.WHITE,
                        overall_confidence=0.3,
                        annotation=f"FEN validation warning: {error}",
                    )

                # Convert to piece map
                piece_map = fen_to_piece_map(fixed_fen)

                # Estimate confidence based on piece count
                # A reasonable position has 16-32 pieces
                piece_count = len(piece_map)
                if 16 <= piece_count <= 32:
                    confidence = 0.85
                elif 10 <= piece_count < 16 or 32 < piece_count <= 40:
                    confidence = 0.6
                else:
                    confidence = 0.3

                return RecognizedPosition(
                    piece_placement=piece_map,
                    fen=fixed_fen,
                    orientation=BoardOrientation.WHITE,
                    overall_confidence=confidence,
                    annotation=None,
                )

            finally:
                # Clean up temp file
                if os.path.exists(temp_path):
                    os.unlink(temp_path)

        except Exception as e:
            return RecognizedPosition(
                piece_placement={},
                fen=None,
                orientation=BoardOrientation.UNKNOWN,
                overall_confidence=0.0,
                annotation=f"Recognition error: {str(e)}",
            )
