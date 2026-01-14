"""
Vision LLM recognition backend using OpenAI GPT-4V.

Uses GPT-4 Vision to analyze chess diagrams and extract FEN notation.
This approach works well for printed diagrams where traditional CV fails.
"""

import base64
import os
import json
import re
from typing import Any

import numpy as np
from numpy.typing import NDArray
import cv2

from openchessvision.core.models import (
    RecognizedPosition,
    BoardOrientation,
)
from openchessvision.core.fen import validate_fen, fen_to_piece_map


# System prompt for chess diagram analysis
CHESS_ANALYSIS_PROMPT = """You are a chess position analyzer. Your task is to look at a chess diagram image and extract the exact position in FEN notation.

Instructions:
1. Carefully examine each square of the chess board from a8 to h1
2. Identify each piece by its shape (King, Queen, Rook, Bishop, Knight, Pawn)
3. Determine piece colors (White pieces are usually lighter/unfilled, Black pieces are darker/filled)
4. Note the board orientation (usually White is at the bottom)
5. Output ONLY the piece placement portion of the FEN (the first field)

FEN piece notation:
- White: K=King, Q=Queen, R=Rook, B=Bishop, N=Knight, P=Pawn
- Black: k=king, q=queen, r=rook, b=bishop, n=knight, p=pawn
- Empty squares: use numbers 1-8 to count consecutive empty squares
- Ranks are separated by /
- Start from rank 8 (top) to rank 1 (bottom)

Respond with ONLY a JSON object in this exact format:
{
  "fen_placement": "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR",
  "orientation": "white_bottom",
  "confidence": 0.95,
  "notes": "any observations about the position"
}"""


class VisionLLMBackend:
    """
    Vision LLM recognition backend using OpenAI GPT-4V.

    Requires OPENAI_API_KEY environment variable to be set.
    """

    def __init__(
        self,
        model: str = "gpt-4o",
        confidence_threshold: float = 0.8,
        api_key: str | None = None,
    ) -> None:
        """
        Initialize the Vision LLM backend.

        Args:
            model: OpenAI model to use (gpt-4o, gpt-4-vision-preview, etc.)
            confidence_threshold: Minimum confidence for automatic acceptance
            api_key: OpenAI API key (or uses OPENAI_API_KEY env var)
        """
        self._model = model
        self._confidence_threshold = confidence_threshold
        self._api_key = api_key or os.environ.get("OPENAI_API_KEY")
        self._client: Any = None

    @property
    def name(self) -> str:
        return f"Vision LLM ({self._model})"

    @property
    def confidence_threshold(self) -> float:
        return self._confidence_threshold

    def supports_orientation_detection(self) -> bool:
        return True

    def supports_annotation_extraction(self) -> bool:
        return True

    def _get_client(self) -> Any:
        """Get or create the OpenAI client."""
        if self._client is None:
            if not self._api_key:
                raise RuntimeError(
                    "OpenAI API key not found. Set OPENAI_API_KEY environment variable "
                    "or pass api_key to the constructor."
                )

            try:
                from openai import OpenAI
                self._client = OpenAI(api_key=self._api_key)
            except ImportError:
                raise ImportError(
                    "openai package not installed. Run: pip install openai"
                )

        return self._client

    def _encode_image(self, image: NDArray[np.uint8]) -> str:
        """Encode image to base64 for API."""
        # Convert BGR to RGB if needed
        if len(image.shape) == 3 and image.shape[2] == 3:
            image_rgb = cv2.cvtColor(image, cv2.COLOR_BGR2RGB)
        else:
            image_rgb = image

        # Encode as PNG
        success, buffer = cv2.imencode('.png', image_rgb)
        if not success:
            raise RuntimeError("Failed to encode image")

        return base64.b64encode(buffer).decode('utf-8')

    def recognize(self, image: NDArray[np.uint8]) -> RecognizedPosition:
        """
        Recognize a chess position from a diagram image using GPT-4V.

        Args:
            image: RGB or BGR image as numpy array

        Returns:
            RecognizedPosition with piece placement and confidence
        """
        client = self._get_client()

        # Encode image
        image_b64 = self._encode_image(image)

        # Call GPT-4V
        try:
            response = client.chat.completions.create(
                model=self._model,
                messages=[
                    {
                        "role": "system",
                        "content": CHESS_ANALYSIS_PROMPT,
                    },
                    {
                        "role": "user",
                        "content": [
                            {
                                "type": "text",
                                "text": "Please analyze this chess diagram and extract the position in FEN notation.",
                            },
                            {
                                "type": "image_url",
                                "image_url": {
                                    "url": f"data:image/png;base64,{image_b64}",
                                    "detail": "high",
                                },
                            },
                        ],
                    },
                ],
                max_tokens=500,
                temperature=0.1,  # Low temperature for consistency
            )

            # Parse response
            content = response.choices[0].message.content
            return self._parse_response(content)

        except Exception as e:
            return RecognizedPosition(
                piece_placement={},
                fen=None,
                orientation=BoardOrientation.UNKNOWN,
                overall_confidence=0.0,
                annotation=f"API error: {str(e)}",
            )

    def _parse_response(self, content: str) -> RecognizedPosition:
        """Parse the LLM response into a RecognizedPosition."""
        try:
            # Try to extract JSON from the response
            # Sometimes the model wraps it in markdown code blocks
            json_match = re.search(r'\{[^{}]*\}', content, re.DOTALL)
            if json_match:
                data = json.loads(json_match.group())
            else:
                data = json.loads(content)

            fen_placement = data.get("fen_placement", "")
            confidence = float(data.get("confidence", 0.5))
            orientation_str = data.get("orientation", "white_bottom")
            notes = data.get("notes", "")

            # Determine orientation
            if "black" in orientation_str.lower():
                orientation = BoardOrientation.BLACK
            else:
                orientation = BoardOrientation.WHITE

            # Build full FEN (assume white to move, full castling, no en passant)
            full_fen = f"{fen_placement} w KQkq - 0 1"

            # Validate FEN
            valid, error = validate_fen(full_fen, strict=False)

            if valid:
                piece_map = fen_to_piece_map(full_fen)
                return RecognizedPosition(
                    piece_placement=piece_map,
                    fen=full_fen,
                    orientation=orientation,
                    overall_confidence=confidence,
                    annotation=notes,
                )
            else:
                return RecognizedPosition(
                    piece_placement={},
                    fen=None,
                    orientation=orientation,
                    overall_confidence=confidence * 0.5,
                    annotation=f"FEN validation failed: {error}. Raw: {fen_placement}",
                )

        except (json.JSONDecodeError, KeyError, ValueError) as e:
            return RecognizedPosition(
                piece_placement={},
                fen=None,
                orientation=BoardOrientation.UNKNOWN,
                overall_confidence=0.0,
                annotation=f"Failed to parse response: {e}. Raw: {content[:200]}",
            )


def create_vision_backend(
    api_key: str | None = None,
    model: str = "gpt-4o",
) -> VisionLLMBackend:
    """
    Factory function to create a Vision LLM backend.

    Args:
        api_key: OpenAI API key (or uses OPENAI_API_KEY env var)
        model: Model to use (gpt-4o recommended for best results)

    Returns:
        Configured VisionLLMBackend instance
    """
    return VisionLLMBackend(
        model=model,
        api_key=api_key,
    )
