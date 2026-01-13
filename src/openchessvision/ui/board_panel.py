"""
Board control panel widget.

Provides board connection controls, position preview, and action buttons.
"""

from PyQt6.QtWidgets import (
    QWidget,
    QVBoxLayout,
    QHBoxLayout,
    QLabel,
    QPushButton,
    QFrame,
    QGridLayout,
    QTextEdit,
    QProgressBar,
    QCheckBox,
)
from PyQt6.QtCore import Qt, pyqtSignal
from PyQt6.QtGui import QPainter, QColor, QBrush, QPen, QFont

from openchessvision.core.models import (
    ConnectionStatus,
    RecognizedPosition,
    SetPositionResult,
    SetPositionResultStatus,
)
from openchessvision.core.fen import fen_to_piece_map
from openchessvision.orchestrator.manager import WorkflowManager


# Piece Unicode symbols
PIECE_SYMBOLS = {
    "K": "♔", "Q": "♕", "R": "♖", "B": "♗", "N": "♘", "P": "♙",
    "k": "♚", "q": "♛", "r": "♜", "b": "♝", "n": "♞", "p": "♟",
}

# Colors for the board
LIGHT_SQUARE = QColor("#f0d9b5")
DARK_SQUARE = QColor("#b58863")
WHITE_PIECE = QColor("#ffffff")
BLACK_PIECE = QColor("#000000")


class ChessBoardPreview(QWidget):
    """
    Mini chess board preview widget.

    Displays the current or recognized position.
    """

    def __init__(self, size: int = 200, parent=None) -> None:
        super().__init__(parent)

        self._size = size
        self._piece_map: dict[str, str] = {}

        self.setFixedSize(size, size)

    def set_position(self, piece_map: dict[str, str]) -> None:
        """Set the position to display."""
        self._piece_map = piece_map
        self.update()

    def clear(self) -> None:
        """Clear the board."""
        self._piece_map = {}
        self.update()

    def paintEvent(self, event) -> None:
        """Draw the chess board and pieces."""
        painter = QPainter(self)
        painter.setRenderHint(QPainter.RenderHint.Antialiasing)

        square_size = self._size // 8
        files = "abcdefgh"

        # Draw squares
        for row in range(8):
            for col in range(8):
                x = col * square_size
                y = row * square_size

                is_light = (row + col) % 2 == 0
                color = LIGHT_SQUARE if is_light else DARK_SQUARE

                painter.fillRect(x, y, square_size, square_size, QBrush(color))

        # Draw pieces
        font = QFont("Arial", int(square_size * 0.7))
        painter.setFont(font)

        for row in range(8):
            rank = 8 - row
            for col in range(8):
                file = files[col]
                square = f"{file}{rank}"
                piece = self._piece_map.get(square)

                if piece:
                    x = col * square_size
                    y = row * square_size

                    symbol = PIECE_SYMBOLS.get(piece, "?")

                    # Draw piece with outline for visibility
                    is_white = piece.isupper()

                    # Draw outline
                    painter.setPen(QPen(BLACK_PIECE if is_white else WHITE_PIECE, 2))
                    for dx, dy in [(-1, -1), (-1, 1), (1, -1), (1, 1)]:
                        painter.drawText(
                            x + dx, y + dy,
                            square_size, square_size,
                            Qt.AlignmentFlag.AlignCenter,
                            symbol,
                        )

                    # Draw piece
                    painter.setPen(QPen(WHITE_PIECE if is_white else BLACK_PIECE))
                    painter.drawText(
                        x, y,
                        square_size, square_size,
                        Qt.AlignmentFlag.AlignCenter,
                        symbol,
                    )

        # Draw border
        painter.setPen(QPen(QColor("#45475a"), 2))
        painter.drawRect(0, 0, self._size, self._size)

        painter.end()


class BoardControlPanel(QWidget):
    """
    Control panel for board operations.

    Contains:
    - Connection status and controls
    - Position preview board
    - FEN display
    - Confidence indicator
    - Send/Stop buttons
    """

    connect_requested = pyqtSignal()
    disconnect_requested = pyqtSignal()
    send_requested = pyqtSignal()
    stop_requested = pyqtSignal()

    def __init__(
        self,
        workflow_manager: WorkflowManager,
        parent=None,
    ) -> None:
        super().__init__(parent)

        self._workflow = workflow_manager
        self._setup_ui()
        self._apply_styles()

    def _setup_ui(self) -> None:
        """Set up the panel UI."""
        layout = QVBoxLayout(self)
        layout.setContentsMargins(16, 16, 16, 16)
        layout.setSpacing(16)

        # Connection section
        conn_frame = QFrame()
        conn_frame.setObjectName("section")
        conn_layout = QVBoxLayout(conn_frame)

        conn_header = QLabel("Board Connection")
        conn_header.setObjectName("header")
        conn_layout.addWidget(conn_header)

        self._status_indicator = QLabel("● Disconnected")
        self._status_indicator.setObjectName("status_disconnected")
        conn_layout.addWidget(self._status_indicator)

        conn_buttons = QHBoxLayout()

        self._connect_btn = QPushButton("Connect")
        self._connect_btn.clicked.connect(self.connect_requested.emit)
        conn_buttons.addWidget(self._connect_btn)

        self._disconnect_btn = QPushButton("Disconnect")
        self._disconnect_btn.clicked.connect(self.disconnect_requested.emit)
        self._disconnect_btn.setEnabled(False)
        conn_buttons.addWidget(self._disconnect_btn)

        conn_layout.addLayout(conn_buttons)
        layout.addWidget(conn_frame)

        # Position preview section
        preview_frame = QFrame()
        preview_frame.setObjectName("section")
        preview_layout = QVBoxLayout(preview_frame)

        preview_header = QLabel("Position Preview")
        preview_header.setObjectName("header")
        preview_layout.addWidget(preview_header)

        # Center the board
        board_container = QHBoxLayout()
        board_container.addStretch()
        self._board_preview = ChessBoardPreview(size=200)
        board_container.addWidget(self._board_preview)
        board_container.addStretch()
        preview_layout.addLayout(board_container)

        # Confidence bar
        conf_layout = QHBoxLayout()
        conf_layout.addWidget(QLabel("Confidence:"))
        self._confidence_bar = QProgressBar()
        self._confidence_bar.setMinimum(0)
        self._confidence_bar.setMaximum(100)
        self._confidence_bar.setValue(0)
        conf_layout.addWidget(self._confidence_bar)
        self._confidence_label = QLabel("0%")
        self._confidence_label.setFixedWidth(40)
        conf_layout.addWidget(self._confidence_label)
        preview_layout.addLayout(conf_layout)

        layout.addWidget(preview_frame)

        # FEN section
        fen_frame = QFrame()
        fen_frame.setObjectName("section")
        fen_layout = QVBoxLayout(fen_frame)

        fen_header = QLabel("FEN")
        fen_header.setObjectName("header")
        fen_layout.addWidget(fen_header)

        self._fen_display = QTextEdit()
        self._fen_display.setReadOnly(True)
        self._fen_display.setMaximumHeight(60)
        self._fen_display.setPlaceholderText("No position recognized")
        fen_layout.addWidget(self._fen_display)

        layout.addWidget(fen_frame)

        # Settings section
        settings_frame = QFrame()
        settings_frame.setObjectName("section")
        settings_layout = QVBoxLayout(settings_frame)

        settings_header = QLabel("Settings")
        settings_header.setObjectName("header")
        settings_layout.addWidget(settings_header)

        self._auto_sync_check = QCheckBox("Auto-sync to topmost diagram")
        self._auto_sync_check.stateChanged.connect(self._on_auto_sync_changed)
        settings_layout.addWidget(self._auto_sync_check)

        self._confirm_check = QCheckBox("Confirm before moving pieces")
        self._confirm_check.setChecked(True)
        settings_layout.addWidget(self._confirm_check)

        layout.addWidget(settings_frame)

        layout.addStretch()

        # Action buttons
        action_frame = QFrame()
        action_frame.setObjectName("actions")
        action_layout = QVBoxLayout(action_frame)

        self._send_btn = QPushButton("Send to Board")
        self._send_btn.setObjectName("primary")
        self._send_btn.clicked.connect(self.send_requested.emit)
        self._send_btn.setEnabled(False)
        action_layout.addWidget(self._send_btn)

        self._stop_btn = QPushButton("⚠ EMERGENCY STOP")
        self._stop_btn.setObjectName("danger")
        self._stop_btn.clicked.connect(self.stop_requested.emit)
        action_layout.addWidget(self._stop_btn)

        layout.addWidget(action_frame)

    def _apply_styles(self) -> None:
        """Apply widget styles."""
        self.setStyleSheet("""
            BoardControlPanel {
                background-color: #1e1e2e;
            }
            QFrame#section {
                background-color: #313244;
                border-radius: 8px;
                padding: 8px;
            }
            QFrame#actions {
                background-color: transparent;
            }
            QLabel#header {
                color: #89b4fa;
                font-weight: bold;
                font-size: 14px;
                margin-bottom: 8px;
            }
            QLabel {
                color: #cdd6f4;
            }
            QLabel#status_disconnected {
                color: #f38ba8;
            }
            QLabel#status_connecting {
                color: #f9e2af;
            }
            QLabel#status_connected {
                color: #a6e3a1;
            }
            QPushButton {
                background-color: #45475a;
                color: #cdd6f4;
                border: none;
                border-radius: 6px;
                padding: 8px 16px;
                font-size: 13px;
            }
            QPushButton:hover {
                background-color: #585b70;
            }
            QPushButton:pressed {
                background-color: #313244;
            }
            QPushButton:disabled {
                background-color: #313244;
                color: #6c7086;
            }
            QPushButton#primary {
                background-color: #89b4fa;
                color: #1e1e2e;
                font-weight: bold;
            }
            QPushButton#primary:hover {
                background-color: #b4befe;
            }
            QPushButton#primary:disabled {
                background-color: #45475a;
                color: #6c7086;
            }
            QPushButton#danger {
                background-color: #f38ba8;
                color: #1e1e2e;
                font-weight: bold;
            }
            QPushButton#danger:hover {
                background-color: #eba0ac;
            }
            QTextEdit {
                background-color: #181825;
                color: #cdd6f4;
                border: 1px solid #45475a;
                border-radius: 4px;
                padding: 4px;
                font-family: monospace;
            }
            QProgressBar {
                background-color: #181825;
                border: 1px solid #45475a;
                border-radius: 4px;
                height: 16px;
                text-align: center;
            }
            QProgressBar::chunk {
                background-color: #89b4fa;
                border-radius: 3px;
            }
            QCheckBox {
                color: #cdd6f4;
            }
            QCheckBox::indicator {
                width: 16px;
                height: 16px;
                border-radius: 4px;
                border: 1px solid #45475a;
                background-color: #181825;
            }
            QCheckBox::indicator:checked {
                background-color: #89b4fa;
                border-color: #89b4fa;
            }
        """)

    def update_connection_status(self, status: ConnectionStatus) -> None:
        """Update the connection status display."""
        status_text = {
            ConnectionStatus.DISCONNECTED: "● Disconnected",
            ConnectionStatus.SCANNING: "◐ Scanning...",
            ConnectionStatus.CONNECTING: "◐ Connecting...",
            ConnectionStatus.CONNECTED: "● Connected",
            ConnectionStatus.ERROR: "● Error",
        }

        style_name = {
            ConnectionStatus.DISCONNECTED: "status_disconnected",
            ConnectionStatus.SCANNING: "status_connecting",
            ConnectionStatus.CONNECTING: "status_connecting",
            ConnectionStatus.CONNECTED: "status_connected",
            ConnectionStatus.ERROR: "status_disconnected",
        }

        self._status_indicator.setText(status_text.get(status, "Unknown"))
        self._status_indicator.setObjectName(style_name.get(status, "status_disconnected"))
        self._status_indicator.style().unpolish(self._status_indicator)
        self._status_indicator.style().polish(self._status_indicator)

        connected = status == ConnectionStatus.CONNECTED
        self._connect_btn.setEnabled(not connected)
        self._disconnect_btn.setEnabled(connected)

    def update_position(self, position: RecognizedPosition) -> None:
        """Update the position preview."""
        # Update board
        self._board_preview.set_position(dict(position.piece_placement))

        # Update FEN
        if position.fen:
            self._fen_display.setText(position.fen)
        else:
            self._fen_display.clear()

        # Update confidence
        confidence_pct = int(position.overall_confidence * 100)
        self._confidence_bar.setValue(confidence_pct)
        self._confidence_label.setText(f"{confidence_pct}%")

        # Enable send button if we have a valid position
        can_send = (
            position.fen is not None and
            self._workflow.board_driver.connection_status == ConnectionStatus.CONNECTED
        )
        self._send_btn.setEnabled(can_send)

    def update_send_result(self, result: SetPositionResult) -> None:
        """Update UI after sending a position."""
        if result.status == SetPositionResultStatus.SUCCESS:
            self._send_btn.setText("✓ Position Sent")
            # Reset after a delay (would need a timer in production)
        else:
            self._send_btn.setText("Send to Board")

    def _on_auto_sync_changed(self, state: int) -> None:
        """Handle auto-sync checkbox changes."""
        enabled = state == Qt.CheckState.Checked.value
        self._workflow.set_auto_sync(enabled)
