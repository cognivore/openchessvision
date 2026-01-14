"""
Automatic chessboard detection and extraction from book photos.

Detects chessboard boundaries in images with margins, text, and skew,
then extracts a clean, axis-aligned board image.
"""

from dataclasses import dataclass
from pathlib import Path
from typing import Optional, Tuple, List
import numpy as np
import cv2


@dataclass
class DetectionResult:
    """Result of board detection."""
    success: bool
    board_image: Optional[np.ndarray]  # Extracted 256x256 board
    corners: Optional[np.ndarray]  # 4x2 array of corner points
    debug_image: Optional[np.ndarray]  # Visualization for debugging
    error_message: Optional[str] = None


class BoardDetector:
    """
    Detects and extracts chessboards from book photos.

    Pipeline:
    1. Edge detection (Canny)
    2. Line detection (Hough Transform)
    3. Line clustering to find grid
    4. Corner extraction
    5. Perspective warp to 256x256
    """

    def __init__(
        self,
        output_size: int = 256,
        canny_low: int = 50,
        canny_high: int = 150,
        hough_threshold: int = 100,
        line_gap: int = 10,
        angle_tolerance: float = 10.0,  # degrees
    ):
        self.output_size = output_size
        self.canny_low = canny_low
        self.canny_high = canny_high
        self.hough_threshold = hough_threshold
        self.line_gap = line_gap
        self.angle_tolerance = angle_tolerance

    def detect(self, image: np.ndarray, debug: bool = False) -> DetectionResult:
        """
        Detect and extract chessboard from image.

        Args:
            image: Input image (BGR or grayscale)
            debug: Whether to generate debug visualization

        Returns:
            DetectionResult with extracted board or error info
        """
        # Convert to grayscale if needed
        if len(image.shape) == 3:
            gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
        else:
            gray = image.copy()

        debug_img = image.copy() if debug and len(image.shape) == 3 else None
        if debug and len(image.shape) == 2:
            debug_img = cv2.cvtColor(image, cv2.COLOR_GRAY2BGR)

        # Try multiple detection strategies
        corners = None

        # Strategy 1: Hough lines for grid-based boards
        corners = self._detect_via_lines(gray, debug_img)

        # Strategy 2: Contour detection fallback
        if corners is None:
            corners = self._detect_via_contours(gray, debug_img)

        # Strategy 3: Square detection fallback
        if corners is None:
            corners = self._detect_via_squares(gray, debug_img)

        if corners is None:
            return DetectionResult(
                success=False,
                board_image=None,
                corners=None,
                debug_image=debug_img,
                error_message="Could not detect board corners"
            )

        # Order corners: top-left, top-right, bottom-right, bottom-left
        corners = self._order_corners(corners)

        # Perspective transform
        board_image = self._extract_board(image, corners)

        if debug and debug_img is not None:
            # Draw final corners
            for i, corner in enumerate(corners):
                cv2.circle(debug_img, tuple(corner.astype(int)), 10, (0, 255, 0), -1)
                cv2.putText(debug_img, str(i), tuple(corner.astype(int) + 15),
                           cv2.FONT_HERSHEY_SIMPLEX, 1, (0, 255, 0), 2)
            # Draw board outline
            cv2.polylines(debug_img, [corners.astype(int)], True, (0, 255, 0), 3)

        return DetectionResult(
            success=True,
            board_image=board_image,
            corners=corners,
            debug_image=debug_img,
            error_message=None
        )

    def _detect_via_lines(
        self, gray: np.ndarray, debug_img: Optional[np.ndarray]
    ) -> Optional[np.ndarray]:
        """Detect board corners using Hough line detection."""
        # Edge detection
        blurred = cv2.GaussianBlur(gray, (5, 5), 0)
        edges = cv2.Canny(blurred, self.canny_low, self.canny_high)

        # Dilate to connect nearby edges
        kernel = np.ones((3, 3), np.uint8)
        edges = cv2.dilate(edges, kernel, iterations=1)

        # Detect lines
        lines = cv2.HoughLinesP(
            edges,
            rho=1,
            theta=np.pi / 180,
            threshold=self.hough_threshold,
            minLineLength=min(gray.shape) // 8,
            maxLineGap=self.line_gap
        )

        if lines is None or len(lines) < 4:
            return None

        # Separate into horizontal and vertical lines
        h_lines, v_lines = self._classify_lines(lines)

        if debug_img is not None:
            for line in h_lines:
                x1, y1, x2, y2 = line
                cv2.line(debug_img, (x1, y1), (x2, y2), (255, 0, 0), 1)
            for line in v_lines:
                x1, y1, x2, y2 = line
                cv2.line(debug_img, (x1, y1), (x2, y2), (0, 0, 255), 1)

        if len(h_lines) < 2 or len(v_lines) < 2:
            return None

        # Cluster lines and find outer boundaries
        h_clusters = self._cluster_lines(h_lines, axis='h')
        v_clusters = self._cluster_lines(v_lines, axis='v')

        if len(h_clusters) < 2 or len(v_clusters) < 2:
            return None

        # Get outermost lines
        top_line = min(h_clusters, key=lambda c: c['pos'])
        bottom_line = max(h_clusters, key=lambda c: c['pos'])
        left_line = min(v_clusters, key=lambda c: c['pos'])
        right_line = max(v_clusters, key=lambda c: c['pos'])

        # Find intersections
        corners = np.array([
            self._line_intersection(top_line['line'], left_line['line']),
            self._line_intersection(top_line['line'], right_line['line']),
            self._line_intersection(bottom_line['line'], right_line['line']),
            self._line_intersection(bottom_line['line'], left_line['line']),
        ], dtype=np.float32)

        # Validate corners are within image
        h, w = gray.shape
        if not all(0 <= c[0] < w and 0 <= c[1] < h for c in corners):
            return None

        return corners

    def _detect_via_contours(
        self, gray: np.ndarray, debug_img: Optional[np.ndarray]
    ) -> Optional[np.ndarray]:
        """Detect board via contour detection."""
        # Adaptive threshold for varying lighting
        binary = cv2.adaptiveThreshold(
            gray, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
            cv2.THRESH_BINARY, 11, 2
        )

        # Find contours
        contours, _ = cv2.findContours(
            binary, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE
        )

        if not contours:
            return None

        # Find largest square-ish contour
        h, w = gray.shape
        min_area = (min(h, w) * 0.3) ** 2  # At least 30% of image

        best_contour = None
        best_score = 0

        for contour in contours:
            area = cv2.contourArea(contour)
            if area < min_area:
                continue

            # Approximate to polygon
            peri = cv2.arcLength(contour, True)
            approx = cv2.approxPolyDP(contour, 0.02 * peri, True)

            if len(approx) == 4:
                # Check if roughly square
                rect = cv2.minAreaRect(contour)
                w_rect, h_rect = rect[1]
                if w_rect > 0 and h_rect > 0:
                    aspect = max(w_rect, h_rect) / min(w_rect, h_rect)
                    if aspect < 1.3:  # Roughly square
                        score = area
                        if score > best_score:
                            best_score = score
                            best_contour = approx

        if best_contour is None:
            return None

        corners = best_contour.reshape(4, 2).astype(np.float32)

        if debug_img is not None:
            cv2.drawContours(debug_img, [best_contour], -1, (0, 255, 255), 2)

        return corners

    def _detect_via_squares(
        self, gray: np.ndarray, debug_img: Optional[np.ndarray]
    ) -> Optional[np.ndarray]:
        """Detect board by finding the checkerboard pattern."""
        # Try to find checkerboard corners (internal corners)
        # A standard chessboard has 7x7 internal corners
        for board_size in [(7, 7), (8, 8), (9, 9)]:
            found, corners = cv2.findChessboardCorners(
                gray, board_size,
                cv2.CALIB_CB_ADAPTIVE_THRESH + cv2.CALIB_CB_NORMALIZE_IMAGE
            )
            if found:
                # Get outer corners from internal corners
                corners = corners.reshape(-1, 2)
                min_x, min_y = corners.min(axis=0)
                max_x, max_y = corners.max(axis=0)

                # Expand slightly to include full squares
                step_x = (max_x - min_x) / (board_size[0] - 1)
                step_y = (max_y - min_y) / (board_size[1] - 1)

                outer_corners = np.array([
                    [min_x - step_x/2, min_y - step_y/2],
                    [max_x + step_x/2, min_y - step_y/2],
                    [max_x + step_x/2, max_y + step_y/2],
                    [min_x - step_x/2, max_y + step_y/2],
                ], dtype=np.float32)

                if debug_img is not None:
                    cv2.drawChessboardCorners(debug_img, board_size,
                                             corners.reshape(-1, 1, 2), True)

                return outer_corners

        return None

    def _classify_lines(
        self, lines: np.ndarray
    ) -> Tuple[List[np.ndarray], List[np.ndarray]]:
        """Separate lines into horizontal and vertical."""
        h_lines = []
        v_lines = []

        for line in lines:
            x1, y1, x2, y2 = line[0]
            angle = np.degrees(np.arctan2(y2 - y1, x2 - x1))

            # Normalize angle to 0-180
            angle = angle % 180

            if angle < self.angle_tolerance or angle > 180 - self.angle_tolerance:
                h_lines.append([x1, y1, x2, y2])
            elif abs(angle - 90) < self.angle_tolerance:
                v_lines.append([x1, y1, x2, y2])

        return h_lines, v_lines

    def _cluster_lines(
        self, lines: List, axis: str, min_gap: int = 20
    ) -> List[dict]:
        """Cluster nearby parallel lines."""
        if not lines:
            return []

        # Get position (y for horizontal, x for vertical)
        if axis == 'h':
            positions = [(l[1] + l[3]) / 2 for l in lines]
        else:
            positions = [(l[0] + l[2]) / 2 for l in lines]

        # Sort by position
        sorted_indices = np.argsort(positions)
        sorted_positions = [positions[i] for i in sorted_indices]
        sorted_lines = [lines[i] for i in sorted_indices]

        # Cluster
        clusters = []
        current_cluster = [0]

        for i in range(1, len(sorted_positions)):
            if sorted_positions[i] - sorted_positions[current_cluster[-1]] < min_gap:
                current_cluster.append(i)
            else:
                # Finalize cluster
                cluster_lines = [sorted_lines[j] for j in current_cluster]
                avg_pos = np.mean([sorted_positions[j] for j in current_cluster])
                # Use the longest line as representative
                rep_line = max(cluster_lines,
                              key=lambda l: np.hypot(l[2]-l[0], l[3]-l[1]))
                clusters.append({'pos': avg_pos, 'line': rep_line})
                current_cluster = [i]

        # Don't forget last cluster
        if current_cluster:
            cluster_lines = [sorted_lines[j] for j in current_cluster]
            avg_pos = np.mean([sorted_positions[j] for j in current_cluster])
            rep_line = max(cluster_lines,
                          key=lambda l: np.hypot(l[2]-l[0], l[3]-l[1]))
            clusters.append({'pos': avg_pos, 'line': rep_line})

        return clusters

    def _line_intersection(
        self, line1: List[int], line2: List[int]
    ) -> np.ndarray:
        """Find intersection of two lines."""
        x1, y1, x2, y2 = line1
        x3, y3, x4, y4 = line2

        denom = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4)
        if abs(denom) < 1e-10:
            # Lines are parallel, return midpoint
            return np.array([(x1 + x3) / 2, (y1 + y3) / 2])

        t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / denom

        x = x1 + t * (x2 - x1)
        y = y1 + t * (y2 - y1)

        return np.array([x, y])

    def _order_corners(self, corners: np.ndarray) -> np.ndarray:
        """Order corners: top-left, top-right, bottom-right, bottom-left."""
        # Sort by sum of coordinates (top-left has smallest sum)
        s = corners.sum(axis=1)
        tl_idx = np.argmin(s)
        br_idx = np.argmax(s)

        # Sort by difference (top-right has smallest diff y-x)
        d = np.diff(corners, axis=1).flatten()
        tr_idx = np.argmin(d)
        bl_idx = np.argmax(d)

        return np.array([
            corners[tl_idx],
            corners[tr_idx],
            corners[br_idx],
            corners[bl_idx]
        ], dtype=np.float32)

    def _extract_board(
        self, image: np.ndarray, corners: np.ndarray
    ) -> np.ndarray:
        """Extract and warp board to standard size."""
        dst = np.array([
            [0, 0],
            [self.output_size - 1, 0],
            [self.output_size - 1, self.output_size - 1],
            [0, self.output_size - 1]
        ], dtype=np.float32)

        M = cv2.getPerspectiveTransform(corners, dst)
        warped = cv2.warpPerspective(image, M, (self.output_size, self.output_size))

        return warped

    def detect_from_file(self, path: Path, debug: bool = False) -> DetectionResult:
        """Load image from file and detect board."""
        image = cv2.imread(str(path))
        if image is None:
            return DetectionResult(
                success=False,
                board_image=None,
                corners=None,
                debug_image=None,
                error_message=f"Could not load image: {path}"
            )
        return self.detect(image, debug=debug)
