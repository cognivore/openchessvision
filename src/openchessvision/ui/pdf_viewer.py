"""
PDF viewer widget with diagram overlay support.

Provides PDF rendering, scrolling, zooming, and diagram candidate visualization.
"""

from typing import Sequence

from PyQt6.QtWidgets import (
    QWidget,
    QVBoxLayout,
    QHBoxLayout,
    QScrollArea,
    QLabel,
    QPushButton,
    QSpinBox,
    QSlider,
    QFrame,
)
from PyQt6.QtCore import Qt, pyqtSignal, QRect, QPoint
from PyQt6.QtGui import (
    QImage,
    QPixmap,
    QPainter,
    QPen,
    QColor,
    QBrush,
    QWheelEvent,
    QMouseEvent,
)

import numpy as np

from openchessvision.core.models import (
    DiagramCandidate,
    ViewportState,
    BoundingBox,
    PDFInfo,
)
from openchessvision.pdf.reader import PDFReader, compute_viewport_state
from openchessvision.pdf.discovery import DiagramDiscovery


# Color scheme for diagram overlays
OVERLAY_COLOR_NORMAL = QColor(100, 149, 237, 100)      # Cornflower blue, semi-transparent
OVERLAY_COLOR_ACTIVE = QColor(50, 205, 50, 150)        # Lime green, more opaque
OVERLAY_BORDER_NORMAL = QColor(100, 149, 237, 200)
OVERLAY_BORDER_ACTIVE = QColor(50, 205, 50, 255)


class PDFPageWidget(QLabel):
    """
    Widget displaying a single PDF page with diagram overlays.
    """

    diagram_clicked = pyqtSignal(DiagramCandidate)

    def __init__(self, parent=None) -> None:
        super().__init__(parent)

        self._page_image: QPixmap | None = None
        self._scale: float = 1.0
        self._candidates: Sequence[DiagramCandidate] = []
        self._active_candidate: DiagramCandidate | None = None
        self._show_overlays: bool = True
        self._page_size: tuple[float, float] = (0, 0)

        self.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.setMouseTracking(True)

    def set_page_image(
        self,
        image: np.ndarray,
        page_size: tuple[float, float],
        scale: float,
    ) -> None:
        """Set the page image to display."""
        self._page_size = page_size
        self._scale = scale

        # Convert numpy array to QPixmap
        h, w = image.shape[:2]
        if len(image.shape) == 3:
            bytes_per_line = 3 * w
            qimage = QImage(
                image.data,
                w, h,
                bytes_per_line,
                QImage.Format.Format_RGB888,
            )
        else:
            bytes_per_line = w
            qimage = QImage(
                image.data,
                w, h,
                bytes_per_line,
                QImage.Format.Format_Grayscale8,
            )

        self._page_image = QPixmap.fromImage(qimage)
        self._update_display()

    def set_candidates(self, candidates: Sequence[DiagramCandidate]) -> None:
        """Set the diagram candidates to overlay."""
        self._candidates = candidates
        self._update_display()

    def set_active_candidate(self, candidate: DiagramCandidate | None) -> None:
        """Set the currently active (highlighted) candidate."""
        self._active_candidate = candidate
        self._update_display()

    def set_show_overlays(self, show: bool) -> None:
        """Toggle overlay visibility."""
        self._show_overlays = show
        self._update_display()

    def _update_display(self) -> None:
        """Redraw the page with overlays."""
        if self._page_image is None:
            self.clear()
            return

        # Create a copy to draw on
        display = self._page_image.copy()

        if self._show_overlays and self._candidates:
            painter = QPainter(display)
            painter.setRenderHint(QPainter.RenderHint.Antialiasing)

            for candidate in self._candidates:
                is_active = (
                    self._active_candidate is not None and
                    candidate.candidate_id == self._active_candidate.candidate_id
                )

                # Convert page coordinates to image coordinates
                rect = self._bbox_to_rect(candidate.bbox)

                # Draw fill
                fill_color = OVERLAY_COLOR_ACTIVE if is_active else OVERLAY_COLOR_NORMAL
                painter.fillRect(rect, QBrush(fill_color))

                # Draw border
                border_color = OVERLAY_BORDER_ACTIVE if is_active else OVERLAY_BORDER_NORMAL
                pen = QPen(border_color, 3 if is_active else 2)
                painter.setPen(pen)
                painter.drawRect(rect)

            painter.end()

        self.setPixmap(display)

    def _bbox_to_rect(self, bbox: BoundingBox) -> QRect:
        """Convert a page-coordinate bounding box to image-coordinate QRect."""
        return QRect(
            int(bbox.x0 * self._scale),
            int(bbox.y0 * self._scale),
            int(bbox.width * self._scale),
            int(bbox.height * self._scale),
        )

    def _rect_to_bbox(self, rect: QRect) -> BoundingBox:
        """Convert image-coordinate QRect to page-coordinate bounding box."""
        return BoundingBox(
            x0=rect.x() / self._scale,
            y0=rect.y() / self._scale,
            x1=(rect.x() + rect.width()) / self._scale,
            y1=(rect.y() + rect.height()) / self._scale,
        )

    def mousePressEvent(self, event: QMouseEvent) -> None:
        """Handle mouse clicks to select diagrams."""
        if not self._show_overlays or not self._candidates:
            return

        pos = event.pos()

        # Check if click is inside any candidate
        for candidate in self._candidates:
            rect = self._bbox_to_rect(candidate.bbox)
            if rect.contains(pos):
                self.diagram_clicked.emit(candidate)
                return

        super().mousePressEvent(event)


class PDFViewerWidget(QWidget):
    """
    PDF viewer with zoom, scroll, and diagram overlay support.
    """

    diagram_selected = pyqtSignal(DiagramCandidate)
    viewport_changed = pyqtSignal(ViewportState)

    def __init__(
        self,
        pdf_reader: PDFReader,
        discovery: DiagramDiscovery,
        parent=None,
    ) -> None:
        super().__init__(parent)

        self._reader = pdf_reader
        self._discovery = discovery

        self._current_page: int = 0
        self._zoom_scale: float = 1.0
        self._pdf_info: PDFInfo | None = None

        self._setup_ui()
        self._apply_styles()

    def _setup_ui(self) -> None:
        """Set up the viewer UI."""
        layout = QVBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(0)

        # Toolbar
        toolbar = QFrame()
        toolbar.setFixedHeight(40)
        toolbar_layout = QHBoxLayout(toolbar)
        toolbar_layout.setContentsMargins(8, 4, 8, 4)

        # Page navigation
        self._prev_btn = QPushButton("◀")
        self._prev_btn.setFixedWidth(30)
        self._prev_btn.clicked.connect(self._prev_page)
        toolbar_layout.addWidget(self._prev_btn)

        self._page_spin = QSpinBox()
        self._page_spin.setMinimum(1)
        self._page_spin.setMaximum(1)
        self._page_spin.valueChanged.connect(self._on_page_changed)
        toolbar_layout.addWidget(self._page_spin)

        self._page_count_label = QLabel("/ 1")
        toolbar_layout.addWidget(self._page_count_label)

        self._next_btn = QPushButton("▶")
        self._next_btn.setFixedWidth(30)
        self._next_btn.clicked.connect(self._next_page)
        toolbar_layout.addWidget(self._next_btn)

        toolbar_layout.addStretch()

        # Zoom controls
        self._zoom_out_btn = QPushButton("−")
        self._zoom_out_btn.setFixedWidth(30)
        self._zoom_out_btn.clicked.connect(self.zoom_out)
        toolbar_layout.addWidget(self._zoom_out_btn)

        self._zoom_slider = QSlider(Qt.Orientation.Horizontal)
        self._zoom_slider.setMinimum(25)
        self._zoom_slider.setMaximum(400)
        self._zoom_slider.setValue(100)
        self._zoom_slider.setFixedWidth(120)
        self._zoom_slider.valueChanged.connect(self._on_zoom_changed)
        toolbar_layout.addWidget(self._zoom_slider)

        self._zoom_in_btn = QPushButton("+")
        self._zoom_in_btn.setFixedWidth(30)
        self._zoom_in_btn.clicked.connect(self.zoom_in)
        toolbar_layout.addWidget(self._zoom_in_btn)

        self._zoom_label = QLabel("100%")
        self._zoom_label.setFixedWidth(50)
        toolbar_layout.addWidget(self._zoom_label)

        layout.addWidget(toolbar)

        # Scroll area for page
        self._scroll_area = QScrollArea()
        self._scroll_area.setWidgetResizable(True)
        self._scroll_area.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self._scroll_area.horizontalScrollBar().valueChanged.connect(self._on_scroll)
        self._scroll_area.verticalScrollBar().valueChanged.connect(self._on_scroll)

        # Page widget
        self._page_widget = PDFPageWidget()
        self._page_widget.diagram_clicked.connect(self._on_diagram_clicked)
        self._scroll_area.setWidget(self._page_widget)

        layout.addWidget(self._scroll_area)

        # Placeholder text
        self._placeholder = QLabel("Open a PDF file to begin")
        self._placeholder.setAlignment(Qt.AlignmentFlag.AlignCenter)
        layout.addWidget(self._placeholder)

        self._scroll_area.hide()

    def _apply_styles(self) -> None:
        """Apply widget styles."""
        self.setStyleSheet("""
            QFrame {
                background-color: #1e1e2e;
                border-bottom: 1px solid #45475a;
            }
            QPushButton {
                background-color: #45475a;
                color: #cdd6f4;
                border: none;
                border-radius: 4px;
                padding: 4px;
            }
            QPushButton:hover {
                background-color: #585b70;
            }
            QPushButton:pressed {
                background-color: #313244;
            }
            QSpinBox {
                background-color: #313244;
                color: #cdd6f4;
                border: 1px solid #45475a;
                border-radius: 4px;
                padding: 2px 8px;
            }
            QLabel {
                color: #cdd6f4;
            }
            QSlider::groove:horizontal {
                background: #45475a;
                height: 4px;
                border-radius: 2px;
            }
            QSlider::handle:horizontal {
                background: #89b4fa;
                width: 12px;
                height: 12px;
                margin: -4px 0;
                border-radius: 6px;
            }
            QScrollArea {
                background-color: #181825;
                border: none;
            }
            PDFPageWidget {
                background-color: #181825;
            }
        """)

    def load_pdf(self, info: PDFInfo) -> None:
        """Load a PDF and display the first page."""
        self._pdf_info = info
        self._current_page = 0

        # Update controls
        self._page_spin.setMaximum(info.page_count)
        self._page_spin.setValue(1)
        self._page_count_label.setText(f"/ {info.page_count}")

        # Show viewer, hide placeholder
        self._placeholder.hide()
        self._scroll_area.show()

        # Render first page
        self._render_current_page()

    def clear(self) -> None:
        """Clear the viewer."""
        self._pdf_info = None
        self._page_widget.clear()
        self._scroll_area.hide()
        self._placeholder.show()

    def _render_current_page(self) -> None:
        """Render the current page at the current zoom level."""
        if not self._reader.is_open:
            return

        # Get page size
        page_size = self._reader.get_page_size(self._current_page)

        # Render page
        image = self._reader.render_page(self._current_page, scale=self._zoom_scale)

        # Get candidates for this page
        candidates = self._discovery.discover_candidates(self._current_page)

        # Update page widget
        self._page_widget.set_page_image(image, page_size, self._zoom_scale)
        self._page_widget.set_candidates(candidates)

        # Emit viewport changed
        self._emit_viewport_state()

    def _emit_viewport_state(self) -> None:
        """Emit the current viewport state."""
        if not self._reader.is_open:
            return

        page_size = self._reader.get_page_size(self._current_page)

        # Get visible region in page coordinates
        viewport = self._scroll_area.viewport()
        scroll_x = self._scroll_area.horizontalScrollBar().value()
        scroll_y = self._scroll_area.verticalScrollBar().value()

        visible_rect = (
            scroll_x / self._zoom_scale,
            scroll_y / self._zoom_scale,
            viewport.width() / self._zoom_scale,
            viewport.height() / self._zoom_scale,
        )

        state = compute_viewport_state(
            self._current_page,
            page_size,
            visible_rect,
            self._zoom_scale,
        )

        self.viewport_changed.emit(state)

    def _prev_page(self) -> None:
        """Go to previous page."""
        if self._current_page > 0:
            self._current_page -= 1
            self._page_spin.setValue(self._current_page + 1)
            self._render_current_page()

    def _next_page(self) -> None:
        """Go to next page."""
        if self._pdf_info and self._current_page < self._pdf_info.page_count - 1:
            self._current_page += 1
            self._page_spin.setValue(self._current_page + 1)
            self._render_current_page()

    def _on_page_changed(self, value: int) -> None:
        """Handle page spinner changes."""
        new_page = value - 1
        if new_page != self._current_page:
            self._current_page = new_page
            self._render_current_page()

    def _on_zoom_changed(self, value: int) -> None:
        """Handle zoom slider changes."""
        self._zoom_scale = value / 100.0
        self._zoom_label.setText(f"{value}%")
        self._render_current_page()

    def zoom_in(self) -> None:
        """Increase zoom level."""
        new_value = min(400, self._zoom_slider.value() + 25)
        self._zoom_slider.setValue(new_value)

    def zoom_out(self) -> None:
        """Decrease zoom level."""
        new_value = max(25, self._zoom_slider.value() - 25)
        self._zoom_slider.setValue(new_value)

    def _on_scroll(self, value: int) -> None:
        """Handle scroll events."""
        self._emit_viewport_state()

    def _on_diagram_clicked(self, candidate: DiagramCandidate) -> None:
        """Handle diagram selection."""
        self._page_widget.set_active_candidate(candidate)
        self.diagram_selected.emit(candidate)

    def highlight_diagram(self, candidate: DiagramCandidate | None) -> None:
        """Highlight a specific diagram."""
        self._page_widget.set_active_candidate(candidate)

    def set_show_overlays(self, show: bool) -> None:
        """Toggle overlay visibility."""
        self._page_widget.set_show_overlays(show)

    def wheelEvent(self, event: QWheelEvent) -> None:
        """Handle mouse wheel for zooming with Ctrl."""
        if event.modifiers() & Qt.KeyboardModifier.ControlModifier:
            delta = event.angleDelta().y()
            if delta > 0:
                self.zoom_in()
            else:
                self.zoom_out()
            event.accept()
        else:
            super().wheelEvent(event)
