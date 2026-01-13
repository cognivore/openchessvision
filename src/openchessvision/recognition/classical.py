"""
Classical computer vision recognition backend.

Uses traditional CV techniques (edge detection, contour analysis, template matching)
to recognize chess positions from diagram images.
"""

from dataclasses import dataclass
from typing import Sequence
import numpy as np
from numpy.typing import NDArray
import cv2

from openchessvision.core.models import (
    RecognizedPosition,
    SquareConfidence,
    BoardOrientation,
)
from openchessvision.core.fen import piece_map_to_fen, validate_fen


# Piece classification thresholds
EMPTY_SQUARE_THRESHOLD = 0.15  # Max complexity for empty square
PIECE_CONFIDENCE_MIN = 0.5     # Minimum confidence to report a piece


@dataclass
class SquareAnalysis:
    """Analysis result for a single square."""
    file_idx: int      # 0-7 (a-h)
    rank_idx: int      # 0-7 (1-8 from bottom)
    piece: str | None  # Piece symbol or None for empty
    confidence: float  # 0.0 to 1.0
    is_light_square: bool
    mean_intensity: float
    edge_density: float


class ClassicalRecognitionBackend:
    """
    Classical CV-based chess diagram recognition.

    Pipeline:
    1. Preprocess image (grayscale, normalize)
    2. Detect board boundaries
    3. Segment into 64 squares
    4. Classify each square
    5. Determine orientation
    6. Build FEN
    """

    def __init__(self, confidence_threshold: float = 0.7) -> None:
        self._confidence_threshold = confidence_threshold

    @property
    def name(self) -> str:
        return "Classical CV"

    @property
    def confidence_threshold(self) -> float:
        return self._confidence_threshold

    def supports_orientation_detection(self) -> bool:
        return True

    def supports_annotation_extraction(self) -> bool:
        return False

    def recognize(self, image: NDArray[np.uint8]) -> RecognizedPosition:
        """
        Recognize a chess position from a diagram image.

        Args:
            image: RGB or BGR image as numpy array

        Returns:
            RecognizedPosition with piece placement and confidence
        """
        # Convert to grayscale
        if len(image.shape) == 3:
            gray = cv2.cvtColor(image, cv2.COLOR_RGB2GRAY)
        else:
            gray = image.copy()

        # Normalize and enhance
        gray = self._preprocess(gray)

        # Detect board region
        board_region = self._detect_board(gray)
        if board_region is None:
            return self._empty_result("Could not detect board")

        # Segment into squares
        squares = self._segment_squares(board_region)

        # Analyze each square
        analyses = [self._analyze_square(sq, i, j)
                    for i, row in enumerate(squares)
                    for j, sq in enumerate(row)]

        # Determine board orientation
        orientation = self._detect_orientation(analyses)

        # Build piece map
        piece_map, square_confidences = self._build_piece_map(analyses, orientation)

        # Calculate overall confidence
        confidences = [a.confidence for a in analyses]
        overall_confidence = float(np.mean(confidences)) if confidences else 0.0

        # Generate FEN
        fen = self._build_fen(piece_map, orientation)

        return RecognizedPosition(
            piece_placement=piece_map,
            fen=fen,
            orientation=orientation,
            overall_confidence=overall_confidence,
            square_confidences=tuple(square_confidences),
        )

    def _preprocess(self, gray: NDArray[np.uint8]) -> NDArray[np.uint8]:
        """Preprocess image for analysis."""
        # Normalize histogram
        normalized = cv2.equalizeHist(gray)

        # Light Gaussian blur to reduce noise
        blurred = cv2.GaussianBlur(normalized, (3, 3), 0)

        return blurred

    def _detect_board(self, gray: NDArray[np.uint8]) -> NDArray[np.uint8] | None:
        """
        Detect and extract the chessboard region.

        For now, assumes the input is already a cropped board image.
        Future enhancement: detect board boundaries via line detection.
        """
        # Simple approach: assume the image IS the board
        # Crop a small margin if present
        h, w = gray.shape
        margin = int(min(h, w) * 0.02)

        if margin > 0:
            cropped = gray[margin:h-margin, margin:w-margin]
        else:
            cropped = gray

        # Resize to standard size for consistent analysis
        target_size = 400
        resized = cv2.resize(cropped, (target_size, target_size),
                            interpolation=cv2.INTER_AREA)

        return resized

    def _segment_squares(
        self,
        board: NDArray[np.uint8]
    ) -> list[list[NDArray[np.uint8]]]:
        """
        Segment the board into 64 individual square images.

        Returns an 8x8 grid of square images.
        Row 0 is the top of the image (8th rank if white on bottom).
        """
        h, w = board.shape
        square_h = h // 8
        square_w = w // 8

        squares: list[list[NDArray[np.uint8]]] = []

        for row in range(8):
            row_squares: list[NDArray[np.uint8]] = []
            for col in range(8):
                y0 = row * square_h
                y1 = (row + 1) * square_h
                x0 = col * square_w
                x1 = (col + 1) * square_w

                square = board[y0:y1, x0:x1]
                row_squares.append(square)

            squares.append(row_squares)

        return squares

    def _analyze_square(
        self,
        square: NDArray[np.uint8],
        row: int,
        col: int,
    ) -> SquareAnalysis:
        """
        Analyze a single square to determine its contents.

        Uses multiple features:
        - Mean intensity (helps distinguish pieces from squares)
        - Edge density (pieces have more edges than empty squares)
        - Central region analysis (pieces are typically centered)
        """
        # Determine expected square color (light/dark checkerboard pattern)
        is_light_square = (row + col) % 2 == 0

        # Calculate mean intensity
        mean_intensity = float(np.mean(square))

        # Calculate edge density using Canny
        edges = cv2.Canny(square, 50, 150)
        edge_density = float(np.sum(edges > 0)) / edges.size

        # Analyze central region (where pieces typically are)
        h, w = square.shape
        margin = int(min(h, w) * 0.15)
        center = square[margin:h-margin, margin:w-margin]
        center_mean = float(np.mean(center))
        center_std = float(np.std(center))

        # Determine if square is empty or has a piece
        # Empty squares have low edge density and uniform color
        is_empty = edge_density < EMPTY_SQUARE_THRESHOLD and center_std < 30

        if is_empty:
            piece = None
            confidence = min(1.0, 1.0 - edge_density * 3)
        else:
            # Classify piece based on intensity patterns
            piece, confidence = self._classify_piece(
                square,
                is_light_square,
                mean_intensity,
                center_mean,
                edge_density,
            )

        return SquareAnalysis(
            file_idx=col,
            rank_idx=7 - row,  # Convert from image row to chess rank
            piece=piece,
            confidence=confidence,
            is_light_square=is_light_square,
            mean_intensity=mean_intensity,
            edge_density=edge_density,
        )

    def _classify_piece(
        self,
        square: NDArray[np.uint8],
        is_light_square: bool,
        mean_intensity: float,
        center_mean: float,
        edge_density: float,
    ) -> tuple[str | None, float]:
        """
        Classify what piece is on the square.

        This is a simplified classifier based on intensity patterns.
        A more sophisticated approach would use template matching or ML.
        """
        # Determine piece color based on contrast with square
        # Dark pieces are darker than expected, light pieces are lighter

        h, w = square.shape
        margin = int(min(h, w) * 0.1)

        # Get corner intensities (typically square color without piece)
        corners = [
            square[0:margin, 0:margin],
            square[0:margin, w-margin:w],
            square[h-margin:h, 0:margin],
            square[h-margin:h, w-margin:w],
        ]
        corner_mean = float(np.mean([np.mean(c) for c in corners]))

        # Piece region is center
        piece_region = square[margin:h-margin, margin:w-margin]
        piece_mean = float(np.mean(piece_region))

        # Determine piece color
        intensity_diff = corner_mean - piece_mean

        if abs(intensity_diff) < 15:
            # Not enough contrast - might be empty or very faded
            return None, 0.3

        is_white_piece = intensity_diff > 0  # Piece darker than corners = dark piece
        # Actually, if corner (square) is lighter than piece center, piece is dark
        is_white_piece = piece_mean > corner_mean

        # For now, default to pawn (most common piece)
        # A real implementation would analyze shape/contours
        piece_type = self._guess_piece_type(square, edge_density)

        if is_white_piece:
            piece = piece_type.upper()
        else:
            piece = piece_type.lower()

        # Confidence based on edge density and contrast
        contrast_confidence = min(1.0, abs(intensity_diff) / 50)
        edge_confidence = min(1.0, edge_density * 5)
        confidence = (contrast_confidence + edge_confidence) / 2

        return piece, max(PIECE_CONFIDENCE_MIN, confidence)

    def _guess_piece_type(
        self,
        square: NDArray[np.uint8],
        edge_density: float,
    ) -> str:
        """
        Guess the piece type based on image features.

        This is a placeholder - real implementation would use
        template matching, contour analysis, or ML.
        """
        # Very rough heuristics based on edge complexity
        h, w = square.shape

        # Get vertical and horizontal edge profiles
        sobel_x = cv2.Sobel(square, cv2.CV_64F, 1, 0, ksize=3)
        sobel_y = cv2.Sobel(square, cv2.CV_64F, 0, 1, ksize=3)

        # Analyze shape characteristics
        vertical_energy = float(np.sum(np.abs(sobel_x)))
        horizontal_energy = float(np.sum(np.abs(sobel_y)))

        total_energy = vertical_energy + horizontal_energy
        if total_energy == 0:
            return "p"  # Default to pawn

        # Aspect ratio of edge energy can hint at piece type
        vh_ratio = vertical_energy / (horizontal_energy + 1e-6)

        # These are rough heuristics - not reliable without proper training
        if edge_density > 0.4:
            # High edge density - likely queen or king
            if vh_ratio > 1.2:
                return "q"
            else:
                return "k"
        elif edge_density > 0.3:
            # Medium-high - rook or bishop
            if vh_ratio > 1.0:
                return "r"
            else:
                return "b"
        elif edge_density > 0.2:
            # Medium - knight or bishop
            return "n"
        else:
            # Low edge density - pawn
            return "p"

    def _detect_orientation(
        self,
        analyses: list[SquareAnalysis],
    ) -> BoardOrientation:
        """
        Detect board orientation (White or Black at bottom).

        Heuristic: Starting position has pawns on ranks 2 and 7.
        If we detect more pieces on the expected back ranks, that
        suggests the orientation.
        """
        # Count pieces on each half of the board
        top_half_count = sum(1 for a in analyses if a.piece and a.rank_idx >= 4)
        bottom_half_count = sum(1 for a in analyses if a.piece and a.rank_idx < 4)

        # In a typical game, pieces start concentrated at the back ranks
        # This is not reliable for arbitrary positions

        # For now, assume white on bottom (standard orientation)
        return BoardOrientation.WHITE

    def _build_piece_map(
        self,
        analyses: list[SquareAnalysis],
        orientation: BoardOrientation,
    ) -> tuple[dict[str, str], list[SquareConfidence]]:
        """Build piece map from square analyses."""
        piece_map: dict[str, str] = {}
        confidences: list[SquareConfidence] = []

        files = "abcdefgh"

        for analysis in analyses:
            file_idx = analysis.file_idx
            rank_idx = analysis.rank_idx

            # Adjust for orientation
            if orientation == BoardOrientation.BLACK:
                file_idx = 7 - file_idx
                rank_idx = 7 - rank_idx

            square_name = files[file_idx] + str(rank_idx + 1)

            if analysis.piece:
                piece_map[square_name] = analysis.piece

            confidences.append(SquareConfidence(
                square=square_name,
                piece=analysis.piece,
                confidence=analysis.confidence,
            ))

        return piece_map, confidences

    def _build_fen(
        self,
        piece_map: dict[str, str],
        orientation: BoardOrientation,
    ) -> str | None:
        """Generate FEN from piece map, or None if invalid."""
        try:
            fen = piece_map_to_fen(piece_map)
            valid, _ = validate_fen(fen, strict=False)
            if valid:
                return fen
        except Exception:
            pass

        return None

    def _empty_result(self, error: str) -> RecognizedPosition:
        """Create an empty result for failed recognition."""
        return RecognizedPosition(
            piece_placement={},
            fen=None,
            orientation=BoardOrientation.UNKNOWN,
            overall_confidence=0.0,
            annotation=error,
        )
