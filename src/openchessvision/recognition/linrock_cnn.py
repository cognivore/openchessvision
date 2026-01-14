"""
Linrock-style CNN recognition backend.

PyTorch implementation of the linrock/chessboard-recognizer CNN architecture
for chess piece recognition from 32x32 tile images.
"""

import os
from pathlib import Path
from typing import Optional

import numpy as np
from numpy.typing import NDArray
import torch
import torch.nn as nn
from PIL import Image

from openchessvision.core.models import (
    RecognizedPosition,
    BoardOrientation,
)
from openchessvision.core.fen import validate_fen, fen_to_piece_map


# FEN characters (class labels)
FEN_CHARS = '1RNBQKPrnbqkp'
NUM_CLASSES = len(FEN_CHARS)

# Default model path
DEFAULT_MODEL_PATH = Path(__file__).parent.parent.parent.parent / 'models' / 'chess_recognizer.pt'


class ChessCNN(nn.Module):
    """CNN for chess piece classification.

    Architecture matches linrock/chessboard-recognizer.
    """

    def __init__(self, num_classes: int = NUM_CLASSES, in_channels: int = 1):
        super().__init__()

        self.features = nn.Sequential(
            nn.Conv2d(in_channels, 32, kernel_size=3, padding=1),
            nn.ReLU(inplace=True),
            nn.MaxPool2d(kernel_size=2, stride=2),

            nn.Conv2d(32, 64, kernel_size=3, padding=1),
            nn.ReLU(inplace=True),
            nn.MaxPool2d(kernel_size=2, stride=2),

            nn.Conv2d(64, 64, kernel_size=3, padding=1),
            nn.ReLU(inplace=True),
            nn.MaxPool2d(kernel_size=2, stride=2),
        )

        self.classifier = nn.Sequential(
            nn.Flatten(),
            nn.Linear(64 * 4 * 4, 64),
            nn.ReLU(inplace=True),
            nn.Dropout(0.5),
            nn.Linear(64, num_classes),
        )

    def forward(self, x):
        x = self.features(x)
        x = self.classifier(x)
        return x


class LinrockCNNBackend:
    """
    Linrock-style CNN recognition backend.

    Uses a PyTorch CNN trained on diverse chess diagram styles
    to recognize pieces from 32x32 grayscale tile images.
    """

    def __init__(
        self,
        model_path: Optional[Path] = None,
        confidence_threshold: float = 0.7,
        use_grayscale: bool = True,
        device: Optional[str] = None,
    ) -> None:
        self._model_path = Path(model_path) if model_path else DEFAULT_MODEL_PATH
        self._confidence_threshold = confidence_threshold
        self._use_grayscale = use_grayscale
        self._model: Optional[ChessCNN] = None
        self._fen_chars = FEN_CHARS

        # Set device
        if device:
            self._device = torch.device(device)
        elif torch.cuda.is_available():
            self._device = torch.device('cuda')
        elif torch.backends.mps.is_available():
            self._device = torch.device('mps')
        else:
            self._device = torch.device('cpu')

    @property
    def name(self) -> str:
        return "Linrock CNN (PyTorch)"

    @property
    def confidence_threshold(self) -> float:
        return self._confidence_threshold

    def supports_orientation_detection(self) -> bool:
        return False

    def supports_annotation_extraction(self) -> bool:
        return False

    def _load_model(self) -> None:
        """Load the trained model."""
        if self._model is not None:
            return

        if not self._model_path.exists():
            raise FileNotFoundError(
                f"Model not found at {self._model_path}. "
                "Train a model first using scripts/train_recognizer.py"
            )

        # Load checkpoint
        checkpoint = torch.load(self._model_path, map_location=self._device)

        # Get model config from checkpoint
        use_grayscale = checkpoint.get('use_grayscale', True)
        fen_chars = checkpoint.get('fen_chars', FEN_CHARS)

        self._use_grayscale = use_grayscale
        self._fen_chars = fen_chars

        # Create and load model
        in_channels = 1 if use_grayscale else 3
        self._model = ChessCNN(num_classes=len(fen_chars), in_channels=in_channels)
        self._model.load_state_dict(checkpoint['model_state_dict'])
        self._model.to(self._device)
        self._model.eval()

    def _preprocess_tile(self, tile: NDArray[np.uint8]) -> torch.Tensor:
        """Preprocess a single tile for inference."""
        # Convert to PIL Image
        if len(tile.shape) == 3 and tile.shape[2] == 3:
            pil_img = Image.fromarray(tile, 'RGB')
        elif len(tile.shape) == 2:
            pil_img = Image.fromarray(tile, 'L')
        else:
            pil_img = Image.fromarray(tile)

        # Convert to grayscale if needed
        if self._use_grayscale:
            pil_img = pil_img.convert('L')
        else:
            pil_img = pil_img.convert('RGB')

        # Resize to 32x32
        pil_img = pil_img.resize((32, 32), Image.Resampling.BILINEAR)

        # Convert to tensor and normalize
        arr = np.array(pil_img, dtype=np.float32) / 255.0
        arr = (arr - 0.5) / 0.5  # Normalize to [-1, 1]

        if self._use_grayscale:
            tensor = torch.tensor(arr).unsqueeze(0)  # Add channel dimension
        else:
            tensor = torch.tensor(arr).permute(2, 0, 1)  # HWC -> CHW

        return tensor.unsqueeze(0)  # Add batch dimension

    def _predict_tile(self, tile: NDArray[np.uint8]) -> tuple[str, float]:
        """Predict the piece on a single tile.

        Returns (piece_char, confidence).
        """
        tensor = self._preprocess_tile(tile).to(self._device)

        with torch.no_grad():
            logits = self._model(tensor)
            probs = torch.softmax(logits, dim=1)
            conf, pred_idx = probs.max(dim=1)

        piece_char = self._fen_chars[pred_idx.item()]
        confidence = conf.item()

        return piece_char, confidence

    def recognize(self, image: NDArray[np.uint8]) -> RecognizedPosition:
        """Recognize chess position from a board image.

        The image should be a cropped chess board (just the 8x8 grid).
        """
        try:
            self._load_model()
        except FileNotFoundError as e:
            return RecognizedPosition(
                piece_placement={},
                fen=None,
                orientation=BoardOrientation.UNKNOWN,
                overall_confidence=0.0,
                annotation=str(e),
            )

        # Get image dimensions
        if len(image.shape) == 3:
            height, width = image.shape[:2]
        else:
            height, width = image.shape

        # Calculate tile size
        tile_height = height // 8
        tile_width = width // 8

        # Extract and classify each tile
        predictions = []
        confidences = []

        for rank in range(8):  # 0=rank 8, 7=rank 1
            for file in range(8):  # 0=a, 7=h
                # Extract tile
                top = rank * tile_height
                left = file * tile_width
                bottom = top + tile_height
                right = left + tile_width

                tile = image[top:bottom, left:right]

                # Predict
                piece_char, conf = self._predict_tile(tile)
                predictions.append(piece_char)
                confidences.append(conf)

        # Build FEN string
        def row_to_fen(row: list[str]) -> str:
            """Convert a row of piece characters to FEN rank notation."""
            fen = ""
            empty = 0
            for char in row:
                if char == '1':
                    empty += 1
                else:
                    if empty > 0:
                        fen += str(empty)
                        empty = 0
                    fen += char
            if empty > 0:
                fen += str(empty)
            return fen

        # Split predictions into ranks
        ranks = [predictions[i*8:(i+1)*8] for i in range(8)]
        fen = '/'.join(row_to_fen(rank) for rank in ranks)

        # Calculate overall confidence
        overall_confidence = min(confidences) if confidences else 0.0
        avg_confidence = sum(confidences) / len(confidences) if confidences else 0.0

        # Validate FEN
        is_valid, error = validate_fen(fen, strict=False)

        if not is_valid:
            return RecognizedPosition(
                piece_placement={},
                fen=fen,
                orientation=BoardOrientation.WHITE,
                overall_confidence=overall_confidence,
                annotation=f"FEN validation warning: {error}",
            )

        # Convert to piece map
        piece_map = fen_to_piece_map(fen)

        return RecognizedPosition(
            piece_placement=piece_map,
            fen=fen,
            orientation=BoardOrientation.WHITE,
            overall_confidence=avg_confidence,
            annotation=None,
        )
