"""
OpenChessVision - Application entry point.

This module initializes the PyQt6 application with asyncio support
and launches the main window.
"""

import sys
import asyncio
from typing import NoReturn

from PyQt6.QtWidgets import QApplication
from PyQt6.QtCore import Qt
from qasync import QEventLoop

from openchessvision.ui.main_window import MainWindow


def main() -> NoReturn:
    """Application entry point."""
    # Enable high DPI scaling
    QApplication.setHighDpiScaleFactorRoundingPolicy(
        Qt.HighDpiScaleFactorRoundingPolicy.PassThrough
    )

    app = QApplication(sys.argv)
    app.setApplicationName("OpenChessVision")
    app.setApplicationVersion("0.1.0")
    app.setOrganizationName("OpenChessVision")

    # Set up asyncio event loop integration with Qt
    loop = QEventLoop(app)
    asyncio.set_event_loop(loop)

    # Create and show main window
    window = MainWindow()
    window.show()

    # Run the event loop
    with loop:
        sys.exit(loop.run_forever())


if __name__ == "__main__":
    main()
