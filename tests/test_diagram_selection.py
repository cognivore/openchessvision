"""Tests for diagram selection policy."""

import pytest
from openchessvision.core.models import BoundingBox, DiagramCandidate, DiagramType
from openchessvision.pdf.discovery import select_topmost_visible


def make_candidate(page: int, x0: float, y0: float, x1: float, y1: float) -> DiagramCandidate:
    """Helper to create a test diagram candidate."""
    bbox = BoundingBox(x0=x0, y0=y0, x1=x1, y1=y1)
    return DiagramCandidate(
        page_number=page,
        bbox=bbox,
        diagram_type=DiagramType.RASTER,
        candidate_id=f"test_{page}_{x0}_{y0}",
    )


class TestSelectTopmostVisible:
    """Tests for the topmost visible diagram selection policy (spec §4.4)."""

    def test_single_fully_visible_candidate(self):
        """Single candidate fully in viewport should be selected."""
        viewport = BoundingBox(x0=0, y0=0, x1=800, y1=600)
        candidates = [make_candidate(0, 100, 100, 300, 300)]

        result = select_topmost_visible(candidates, viewport)

        assert result is not None
        assert result.candidate_id == candidates[0].candidate_id

    def test_topmost_selected_from_multiple(self):
        """The topmost candidate should be selected from multiple visible candidates."""
        viewport = BoundingBox(x0=0, y0=0, x1=800, y1=600)
        candidates = [
            make_candidate(0, 100, 200, 300, 400),  # Middle
            make_candidate(0, 100, 50, 300, 250),   # Top (should be selected)
            make_candidate(0, 100, 350, 300, 550),  # Bottom
        ]

        result = select_topmost_visible(candidates, viewport)

        assert result is not None
        assert result.bbox.y0 == 50  # The topmost one

    def test_leftmost_breaks_tie(self):
        """When Y coordinates are equal, leftmost should be selected."""
        viewport = BoundingBox(x0=0, y0=0, x1=800, y1=600)
        candidates = [
            make_candidate(0, 400, 100, 600, 300),  # Right
            make_candidate(0, 100, 100, 300, 300),  # Left (should be selected)
            make_candidate(0, 250, 100, 450, 300),  # Middle
        ]

        result = select_topmost_visible(candidates, viewport)

        assert result is not None
        assert result.bbox.x0 == 100  # The leftmost one

    def test_no_candidates_returns_none(self):
        """Empty candidate list should return None."""
        viewport = BoundingBox(x0=0, y0=0, x1=800, y1=600)

        result = select_topmost_visible([], viewport)

        assert result is None

    def test_candidate_outside_viewport_excluded(self):
        """Candidates completely outside viewport should not be selected."""
        viewport = BoundingBox(x0=0, y0=0, x1=400, y1=300)
        candidates = [
            make_candidate(0, 500, 100, 700, 300),  # Completely outside
        ]

        result = select_topmost_visible(candidates, viewport)

        assert result is None

    def test_partially_visible_with_sufficient_fraction(self):
        """Partially visible candidate meeting threshold should be selected."""
        viewport = BoundingBox(x0=0, y0=0, x1=200, y1=200)
        # Candidate is 200x200, viewport shows 150x200 of it = 75% visible
        candidates = [make_candidate(0, 50, 0, 250, 200)]

        result = select_topmost_visible(candidates, viewport, min_visibility_fraction=0.5)

        assert result is not None

    def test_partially_visible_below_threshold_excluded(self):
        """Partially visible candidate below threshold should be excluded."""
        viewport = BoundingBox(x0=0, y0=0, x1=100, y1=100)
        # Candidate is 200x200, viewport shows only 50x100 = 12.5% visible
        candidates = [make_candidate(0, 50, 0, 250, 200)]

        result = select_topmost_visible(candidates, viewport, min_visibility_fraction=0.3)

        assert result is None

    def test_multiple_pages_irrelevant(self):
        """Page numbers should not affect selection within a single call."""
        viewport = BoundingBox(x0=0, y0=0, x1=800, y1=600)
        candidates = [
            make_candidate(5, 100, 200, 300, 400),  # Different page number
            make_candidate(5, 100, 50, 300, 250),   # Top (should be selected)
        ]

        result = select_topmost_visible(candidates, viewport)

        assert result is not None
        assert result.bbox.y0 == 50


class TestBoundingBoxIntersection:
    """Tests for bounding box intersection logic."""

    def test_fully_contained(self):
        """Inner box fully contained in outer."""
        outer = BoundingBox(x0=0, y0=0, x1=100, y1=100)
        inner = BoundingBox(x0=25, y0=25, x1=75, y1=75)

        assert inner.intersects(outer)
        assert outer.intersects(inner)
        assert inner.visibility_fraction(outer) == 1.0

    def test_no_intersection(self):
        """Non-overlapping boxes."""
        box1 = BoundingBox(x0=0, y0=0, x1=50, y1=50)
        box2 = BoundingBox(x0=100, y0=100, x1=150, y1=150)

        assert not box1.intersects(box2)
        assert box1.visibility_fraction(box2) == 0.0

    def test_partial_overlap(self):
        """Partially overlapping boxes."""
        box1 = BoundingBox(x0=0, y0=0, x1=100, y1=100)
        box2 = BoundingBox(x0=50, y0=50, x1=150, y1=150)

        assert box1.intersects(box2)
        # Overlap is 50x50 = 2500, box1 area is 10000
        assert box1.visibility_fraction(box2) == pytest.approx(0.25)

    def test_edge_touching(self):
        """Boxes sharing an edge are considered intersecting (inclusive bounds)."""
        box1 = BoundingBox(x0=0, y0=0, x1=50, y1=50)
        box2 = BoundingBox(x0=50, y0=0, x1=100, y1=50)

        # Edge touching - our implementation uses inclusive bounds
        # so boxes sharing an edge ARE considered intersecting
        assert box1.intersects(box2)
