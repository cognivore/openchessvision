"""
HuggingFace Vision-Language Model recognition backend.

Uses HuggingFace's Inference API with vision-language models like
Qwen2-VL or LLaVA to analyze chess diagrams.
"""

import base64
import os
import io
import re
from typing import Any

import numpy as np
from numpy.typing import NDArray
import cv2
from PIL import Image

from openchessvision.core.models import (
    RecognizedPosition,
    BoardOrientation,
)
from openchessvision.core.fen import validate_fen, fen_to_piece_map


# Prompt for chess diagram analysis
CHESS_PROMPT = """Analyze this chess diagram and output the position in FEN notation.

Look at each square from a8 (top-left) to h1 (bottom-right).
- White pieces (lighter/outline): K=King, Q=Queen, R=Rook, B=Bishop, N=Knight, P=Pawn
- Black pieces (darker/filled): k=king, q=queen, r=rook, b=bishop, n=knight, p=pawn
- Empty squares: count consecutive empties as numbers 1-8
- Separate ranks with /

Output ONLY the FEN piece placement (e.g., "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR"), nothing else."""


class HuggingFaceVLMBackend:
    """
    HuggingFace Vision-Language Model recognition backend.

    Uses HuggingFace InferenceClient with vision-language models.
    """

    # Models that support image-to-text / VQA
    MODELS = [
        "Salesforce/blip-vqa-base",
        "Salesforce/blip-image-captioning-large",
        "nlpconnect/vit-gpt2-image-captioning",
    ]

    def __init__(
        self,
        model: str | None = None,
        confidence_threshold: float = 0.7,
        api_token: str | None = None,
    ) -> None:
        self._model = model or self.MODELS[0]
        self._confidence_threshold = confidence_threshold
        self._api_token = api_token or os.environ.get("HF_TOKEN") or os.environ.get("HUGGINGFACE_TOKEN")
        self._client = None

    @property
    def name(self) -> str:
        return f"HuggingFace VLM ({self._model.split('/')[-1]})"

    @property
    def confidence_threshold(self) -> float:
        return self._confidence_threshold

    def supports_orientation_detection(self) -> bool:
        return True

    def supports_annotation_extraction(self) -> bool:
        return False

    def _get_client(self):
        """Get or create the HuggingFace InferenceClient."""
        if self._client is None:
            from huggingface_hub import InferenceClient
            self._client = InferenceClient(token=self._api_token)
        return self._client

    def _to_pil_image(self, image: NDArray[np.uint8]) -> Image.Image:
        """Convert numpy array to PIL Image."""
        if len(image.shape) == 3 and image.shape[2] == 3:
            image_rgb = cv2.cvtColor(image, cv2.COLOR_BGR2RGB)
        else:
            image_rgb = image
        return Image.fromarray(image_rgb)

    def recognize(self, image: NDArray[np.uint8]) -> RecognizedPosition:
        """Recognize chess position using HuggingFace VLM."""
        if not self._api_token:
            return RecognizedPosition(
                piece_placement={},
                fen=None,
                orientation=BoardOrientation.UNKNOWN,
                overall_confidence=0.0,
                annotation="HuggingFace API token not set. Set HF_TOKEN environment variable.",
            )

        try:
            client = self._get_client()
            pil_image = self._to_pil_image(image)

            # Try visual question answering
            result = client.visual_question_answering(
                image=pil_image,
                question="What is the chess position in FEN notation? List all pieces on each rank from 8 to 1.",
                model=self._model,
            )

            return self._parse_response(result)

        except Exception as e:
            return RecognizedPosition(
                piece_placement={},
                fen=None,
                orientation=BoardOrientation.UNKNOWN,
                overall_confidence=0.0,
                annotation=f"API error: {str(e)}",
            )

    def _parse_response(self, result: Any) -> RecognizedPosition:
        """Parse API response."""
        try:
            # Response format varies by model
            if isinstance(result, list) and len(result) > 0:
                text = result[0].get("generated_text", str(result[0]))
            elif isinstance(result, dict):
                text = result.get("generated_text", str(result))
            else:
                text = str(result)

            # Try to extract FEN from the response
            fen_match = re.search(
                r'([rnbqkpRNBQKP1-8]+/){7}[rnbqkpRNBQKP1-8]+',
                text
            )

            if fen_match:
                fen_placement = fen_match.group(0)
                full_fen = f"{fen_placement} w KQkq - 0 1"

                valid, error = validate_fen(full_fen, strict=False)

                if valid:
                    piece_map = fen_to_piece_map(full_fen)
                    return RecognizedPosition(
                        piece_placement=piece_map,
                        fen=full_fen,
                        orientation=BoardOrientation.WHITE,
                        overall_confidence=0.7,
                        annotation=f"Extracted from: {text[:100]}",
                    )
                else:
                    return RecognizedPosition(
                        piece_placement={},
                        fen=None,
                        orientation=BoardOrientation.UNKNOWN,
                        overall_confidence=0.3,
                        annotation=f"Invalid FEN: {error}. Raw: {fen_placement}",
                    )
            else:
                return RecognizedPosition(
                    piece_placement={},
                    fen=None,
                    orientation=BoardOrientation.UNKNOWN,
                    overall_confidence=0.0,
                    annotation=f"No FEN found in response: {text[:200]}",
                )

        except Exception as e:
            return RecognizedPosition(
                piece_placement={},
                fen=None,
                orientation=BoardOrientation.UNKNOWN,
                overall_confidence=0.0,
                annotation=f"Parse error: {str(e)}",
            )
