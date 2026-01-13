"""
Main application window.

The primary window containing the PDF viewer and board control panel.
Implements the main UI layout and coordinates user interactions.
"""

import asyncio
import logging
from pathlib import Path

from PyQt6.QtWidgets import (
    QMainWindow,
    QWidget,
    QHBoxLayout,
    QVBoxLayout,
    QSplitter,
    QMenuBar,
    QMenu,
    QToolBar,
    QStatusBar,
    QFileDialog,
    QMessageBox,
)
from PyQt6.QtCore import Qt, QSize
from PyQt6.QtGui import QAction, QKeySequence, QIcon

from openchessvision.core.models import (
    DiagramCandidate,
    RecognizedPosition,
    ConnectionStatus,
    SetPositionResult,
)
from openchessvision.core.interfaces import WorkflowObserver
from openchessvision.pdf.reader import PDFReader
from openchessvision.pdf.discovery import DiagramDiscovery
from openchessvision.recognition.classical import ClassicalRecognitionBackend
from openchessvision.board.mock import MockBoardDriver
from openchessvision.orchestrator.manager import WorkflowManager, WorkflowState
from openchessvision.ui.pdf_viewer import PDFViewerWidget
from openchessvision.ui.board_panel import BoardControlPanel


logger = logging.getLogger(__name__)


class MainWindow(QMainWindow, WorkflowObserver):
    """
    Main application window for OpenChessVision.

    Layout:
    - Menu bar with File, Board, View menus
    - Toolbar with quick actions
    - Central splitter with PDF viewer (left) and board panel (right)
    - Status bar with connection status and messages
    """

    def __init__(self) -> None:
        super().__init__()

        # Initialize components
        self._pdf_reader = PDFReader()
        self._discovery = DiagramDiscovery(self._pdf_reader)
        self._recognition = ClassicalRecognitionBackend()
        self._board_driver = MockBoardDriver()  # Default to mock

        self._workflow = WorkflowManager(
            board_driver=self._board_driver,
            recognition_backend=self._recognition,
        )
        self._workflow.add_observer(self)

        # Set up UI
        self._setup_window()
        self._setup_menu_bar()
        self._setup_toolbar()
        self._setup_central_widget()
        self._setup_status_bar()

        # Apply styles
        self._apply_styles()

    def _setup_window(self) -> None:
        """Configure the main window."""
        self.setWindowTitle("OpenChessVision")
        self.setMinimumSize(1200, 800)
        self.resize(1400, 900)

        # Center on screen
        screen = self.screen().availableGeometry()
        x = (screen.width() - self.width()) // 2
        y = (screen.height() - self.height()) // 2
        self.move(x, y)

    def _setup_menu_bar(self) -> None:
        """Create the menu bar."""
        menubar = self.menuBar()

        # File menu
        file_menu = menubar.addMenu("&File")

        open_action = QAction("&Open PDF...", self)
        open_action.setShortcut(QKeySequence.StandardKey.Open)
        open_action.triggered.connect(self._on_open_pdf)
        file_menu.addAction(open_action)

        close_action = QAction("&Close PDF", self)
        close_action.setShortcut(QKeySequence.StandardKey.Close)
        close_action.triggered.connect(self._on_close_pdf)
        file_menu.addAction(close_action)

        file_menu.addSeparator()

        quit_action = QAction("&Quit", self)
        quit_action.setShortcut(QKeySequence.StandardKey.Quit)
        quit_action.triggered.connect(self.close)
        file_menu.addAction(quit_action)

        # Board menu
        board_menu = menubar.addMenu("&Board")

        self._connect_action = QAction("&Connect", self)
        self._connect_action.triggered.connect(self._on_connect_board)
        board_menu.addAction(self._connect_action)

        self._disconnect_action = QAction("&Disconnect", self)
        self._disconnect_action.triggered.connect(self._on_disconnect_board)
        self._disconnect_action.setEnabled(False)
        board_menu.addAction(self._disconnect_action)

        board_menu.addSeparator()

        self._send_action = QAction("&Send Position", self)
        self._send_action.setShortcut(QKeySequence("Ctrl+Return"))
        self._send_action.triggered.connect(self._on_send_position)
        self._send_action.setEnabled(False)
        board_menu.addAction(self._send_action)

        board_menu.addSeparator()

        self._stop_action = QAction("⚠ Emergency &Stop", self)
        self._stop_action.setShortcut(QKeySequence("Escape"))
        self._stop_action.triggered.connect(self._on_emergency_stop)
        board_menu.addAction(self._stop_action)

        # View menu
        view_menu = menubar.addMenu("&View")

        self._show_overlays_action = QAction("Show Diagram &Overlays", self)
        self._show_overlays_action.setCheckable(True)
        self._show_overlays_action.setChecked(True)
        self._show_overlays_action.triggered.connect(self._on_toggle_overlays)
        view_menu.addAction(self._show_overlays_action)

        view_menu.addSeparator()

        zoom_in_action = QAction("Zoom &In", self)
        zoom_in_action.setShortcut(QKeySequence.StandardKey.ZoomIn)
        zoom_in_action.triggered.connect(self._on_zoom_in)
        view_menu.addAction(zoom_in_action)

        zoom_out_action = QAction("Zoom &Out", self)
        zoom_out_action.setShortcut(QKeySequence.StandardKey.ZoomOut)
        zoom_out_action.triggered.connect(self._on_zoom_out)
        view_menu.addAction(zoom_out_action)

        # Help menu
        help_menu = menubar.addMenu("&Help")

        about_action = QAction("&About", self)
        about_action.triggered.connect(self._on_about)
        help_menu.addAction(about_action)

    def _setup_toolbar(self) -> None:
        """Create the toolbar."""
        toolbar = QToolBar("Main Toolbar")
        toolbar.setMovable(False)
        toolbar.setIconSize(QSize(24, 24))
        self.addToolBar(toolbar)

        # Open button
        open_btn = QAction("Open", self)
        open_btn.setToolTip("Open PDF (Ctrl+O)")
        open_btn.triggered.connect(self._on_open_pdf)
        toolbar.addAction(open_btn)

        toolbar.addSeparator()

        # Connect button
        self._toolbar_connect = QAction("Connect", self)
        self._toolbar_connect.setToolTip("Connect to Chessnut Move")
        self._toolbar_connect.triggered.connect(self._on_connect_board)
        toolbar.addAction(self._toolbar_connect)

        # Send button
        self._toolbar_send = QAction("Send", self)
        self._toolbar_send.setToolTip("Send position to board (Ctrl+Enter)")
        self._toolbar_send.triggered.connect(self._on_send_position)
        self._toolbar_send.setEnabled(False)
        toolbar.addAction(self._toolbar_send)

        toolbar.addSeparator()

        # Stop button (always visible for safety)
        self._toolbar_stop = QAction("⚠ STOP", self)
        self._toolbar_stop.setToolTip("Emergency Stop (Escape)")
        self._toolbar_stop.triggered.connect(self._on_emergency_stop)
        toolbar.addAction(self._toolbar_stop)

    def _setup_central_widget(self) -> None:
        """Create the central widget with splitter layout."""
        central = QWidget()
        self.setCentralWidget(central)

        layout = QHBoxLayout(central)
        layout.setContentsMargins(0, 0, 0, 0)

        # Splitter for resizable panels
        splitter = QSplitter(Qt.Orientation.Horizontal)

        # PDF viewer (left panel)
        self._pdf_viewer = PDFViewerWidget(
            pdf_reader=self._pdf_reader,
            discovery=self._discovery,
        )
        self._pdf_viewer.diagram_selected.connect(self._on_diagram_selected)
        self._pdf_viewer.viewport_changed.connect(self._on_viewport_changed)
        splitter.addWidget(self._pdf_viewer)

        # Board control panel (right panel)
        self._board_panel = BoardControlPanel(
            workflow_manager=self._workflow,
        )
        self._board_panel.connect_requested.connect(self._on_connect_board)
        self._board_panel.disconnect_requested.connect(self._on_disconnect_board)
        self._board_panel.send_requested.connect(self._on_send_position)
        self._board_panel.stop_requested.connect(self._on_emergency_stop)
        splitter.addWidget(self._board_panel)

        # Set initial sizes (70% PDF, 30% panel)
        splitter.setSizes([700, 300])
        splitter.setStretchFactor(0, 7)
        splitter.setStretchFactor(1, 3)

        layout.addWidget(splitter)

    def _setup_status_bar(self) -> None:
        """Create the status bar."""
        self._statusbar = QStatusBar()
        self.setStatusBar(self._statusbar)

        self._status_label = self._statusbar.addWidget(QWidget())
        self._statusbar.showMessage("Ready")

    def _apply_styles(self) -> None:
        """Apply application-wide styles."""
        self.setStyleSheet("""
            QMainWindow {
                background-color: #1e1e2e;
            }
            QMenuBar {
                background-color: #313244;
                color: #cdd6f4;
                padding: 4px;
            }
            QMenuBar::item:selected {
                background-color: #45475a;
            }
            QMenu {
                background-color: #313244;
                color: #cdd6f4;
                border: 1px solid #45475a;
            }
            QMenu::item:selected {
                background-color: #45475a;
            }
            QToolBar {
                background-color: #313244;
                border: none;
                spacing: 8px;
                padding: 4px;
            }
            QToolBar QToolButton {
                background-color: transparent;
                color: #cdd6f4;
                padding: 6px 12px;
                border-radius: 4px;
            }
            QToolBar QToolButton:hover {
                background-color: #45475a;
            }
            QStatusBar {
                background-color: #313244;
                color: #a6adc8;
            }
            QSplitter::handle {
                background-color: #45475a;
                width: 2px;
            }
        """)

    # File operations

    def _on_open_pdf(self) -> None:
        """Open a PDF file."""
        file_path, _ = QFileDialog.getOpenFileName(
            self,
            "Open PDF",
            "",
            "PDF Files (*.pdf);;All Files (*)",
        )

        if file_path:
            self._load_pdf(file_path)

    def _load_pdf(self, path: str) -> None:
        """Load a PDF file."""
        try:
            info = self._pdf_reader.open(path)
            self._discovery.clear_cache()

            # Discover all diagrams
            all_candidates = self._discovery.discover_all_pages()

            # Update workflow
            self._workflow.on_pdf_opened(path, all_candidates)

            # Update viewer
            self._pdf_viewer.load_pdf(info)

            # Update status
            diagram_count = sum(len(c) for c in all_candidates.values())
            self._statusbar.showMessage(
                f"Loaded: {Path(path).name} - {info.page_count} pages, "
                f"{diagram_count} diagrams found"
            )

        except Exception as e:
            logger.error(f"Failed to load PDF: {e}")
            QMessageBox.critical(
                self,
                "Error",
                f"Failed to open PDF:\n{e}",
            )

    def _on_close_pdf(self) -> None:
        """Close the current PDF."""
        self._pdf_reader.close()
        self._pdf_viewer.clear()
        self._workflow.on_pdf_closed()
        self._statusbar.showMessage("Ready")

    # Board operations

    def _on_connect_board(self) -> None:
        """Connect to the chess board."""
        asyncio.create_task(self._connect_board_async())

    async def _connect_board_async(self) -> None:
        """Async board connection."""
        self._statusbar.showMessage("Connecting to board...")
        status = await self._workflow.connect_board()

        if status == ConnectionStatus.CONNECTED:
            self._statusbar.showMessage("Connected to Chessnut Move")
        else:
            self._statusbar.showMessage("Connection failed")

    def _on_disconnect_board(self) -> None:
        """Disconnect from the chess board."""
        asyncio.create_task(self._workflow.disconnect_board())
        self._statusbar.showMessage("Disconnected")

    def _on_send_position(self) -> None:
        """Send the current position to the board."""
        asyncio.create_task(self._send_position_async())

    async def _send_position_async(self) -> None:
        """Async position send."""
        self._statusbar.showMessage("Sending position...")
        result = await self._workflow.send_to_board(require_confirmation=True)

        if result.status.name == "SUCCESS":
            self._statusbar.showMessage("Position sent successfully")
        else:
            self._statusbar.showMessage(f"Send failed: {result.message}")

    def _on_emergency_stop(self) -> None:
        """Trigger emergency stop."""
        asyncio.create_task(self._workflow.emergency_stop())
        self._statusbar.showMessage("⚠ EMERGENCY STOP")

    # View operations

    def _on_toggle_overlays(self, checked: bool) -> None:
        """Toggle diagram overlay visibility."""
        self._pdf_viewer.set_show_overlays(checked)

    def _on_zoom_in(self) -> None:
        """Zoom in on PDF."""
        self._pdf_viewer.zoom_in()

    def _on_zoom_out(self) -> None:
        """Zoom out on PDF."""
        self._pdf_viewer.zoom_out()

    # Diagram operations

    def _on_diagram_selected(self, candidate: DiagramCandidate) -> None:
        """Handle diagram selection from viewer."""
        self._workflow.select_diagram(candidate)

        # Trigger recognition
        asyncio.create_task(self._recognize_selected())

    async def _recognize_selected(self) -> None:
        """Recognize the selected diagram."""
        candidate = self._workflow.context.active_candidate
        if candidate is None:
            return

        self._statusbar.showMessage("Recognizing position...")

        def get_image(c: DiagramCandidate):
            return self._discovery.get_candidate_image(c, scale=2.0)

        position = await self._workflow.recognize_diagram(
            candidate=candidate,
            image_getter=get_image,
        )

        if position is not None:
            conf = position.overall_confidence * 100
            self._statusbar.showMessage(
                f"Recognized: {position.fen or 'partial'} ({conf:.0f}% confidence)"
            )

    def _on_viewport_changed(self, viewport) -> None:
        """Handle viewport changes from PDF viewer."""
        page_candidates = self._workflow.get_candidates_for_page(viewport.page_index)
        self._workflow.on_viewport_changed(viewport, page_candidates)

    # Help

    def _on_about(self) -> None:
        """Show about dialog."""
        QMessageBox.about(
            self,
            "About OpenChessVision",
            "OpenChessVision v0.1.0\n\n"
            "AI PDF Chess Book Reader with Chessnut Move Bluetooth Position Relay\n\n"
            "Recognizes chess diagrams in PDF books and sets up positions "
            "on your Chessnut Move robotic e-board.",
        )

    # WorkflowObserver implementation

    def on_connection_status_changed(self, status: ConnectionStatus) -> None:
        """Handle connection status changes."""
        connected = status == ConnectionStatus.CONNECTED

        self._connect_action.setEnabled(not connected)
        self._disconnect_action.setEnabled(connected)
        self._toolbar_connect.setEnabled(not connected)

        self._board_panel.update_connection_status(status)

    def on_position_recognized(self, position: RecognizedPosition) -> None:
        """Handle position recognition."""
        self._send_action.setEnabled(position.fen is not None)
        self._toolbar_send.setEnabled(position.fen is not None)
        self._board_panel.update_position(position)

    def on_active_diagram_changed(self, candidate: DiagramCandidate | None) -> None:
        """Handle active diagram changes."""
        self._pdf_viewer.highlight_diagram(candidate)

    def on_position_sent(self, result: SetPositionResult) -> None:
        """Handle position send results."""
        self._board_panel.update_send_result(result)

    def on_error(self, message: str) -> None:
        """Handle errors."""
        self._statusbar.showMessage(f"Error: {message}")
        logger.error(message)

    # Window events

    def closeEvent(self, event) -> None:
        """Handle window close."""
        # Disconnect from board
        if self._workflow.board_driver.connection_status == ConnectionStatus.CONNECTED:
            asyncio.create_task(self._workflow.disconnect_board())

        # Close PDF
        self._pdf_reader.close()

        event.accept()
