# OpenChessVision

**AI PDF Chess Book Reader with Chessnut Move Bluetooth Position Relay**

OpenChessVision reads chess diagrams from PDF books and sets up positions on your Chessnut Move robotic e-board via Bluetooth LE.

## Features

- **PDF Reader**: Open and navigate chess books with smooth scrolling and zooming
- **Diagram Discovery**: Automatically detects chess diagrams in PDF pages
- **Position Recognition**: Classical CV pipeline recognizes positions from diagrams
- **Board Control**: Send recognized positions to Chessnut Move over Bluetooth
- **Safety First**: Emergency stop button always accessible when connected

## Requirements

- macOS on Apple Silicon (M1/M2/M3/M4)
- Python 3.12+
- Chessnut Move e-board (optional for development)

## Quick Start

### With Nix (Recommended)

```bash
# Enter the development environment
direnv allow
# or
nix develop

# The venv is created automatically
# Install Python dependencies
pip install -e ".[dev]"

# Run the application
openchessvision
```

### Without Nix

```bash
# Create virtual environment
python3.12 -m venv .venv
source .venv/bin/activate

# Install dependencies
pip install -e ".[dev]"

# Run the application
openchessvision
```

## Development

### Project Structure

```
openchessvision/
├── src/openchessvision/
│   ├── core/           # Data models, interfaces, FEN utilities
│   ├── pdf/            # PDF rendering and diagram discovery
│   ├── recognition/    # Position recognition backends
│   ├── board/          # E-board drivers (mock, Chessnut)
│   ├── orchestrator/   # Workflow state machine
│   └── ui/             # PyQt6 user interface
└── tests/              # Unit and integration tests
```

### Running Tests

```bash
pytest
```

### Linting

```bash
ruff check .
mypy src/
```

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     UI Layer (PyQt6)                        │
│  ┌─────────────────────┐  ┌──────────────────────────────┐ │
│  │    PDF Viewer       │  │     Board Control Panel      │ │
│  └─────────────────────┘  └──────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                    Workflow Manager                          │
│         (State Machine, Debouncing, Caching)                │
└─────────────────────────────────────────────────────────────┘
          │                    │                    │
          ▼                    ▼                    ▼
┌─────────────────┐ ┌─────────────────┐ ┌─────────────────────┐
│  PDF Backend    │ │  Recognition    │ │   Board Driver      │
│  (PyMuPDF)      │ │  (Classical/ML) │ │   (Mock/Chessnut)   │
└─────────────────┘ └─────────────────┘ └─────────────────────┘
```

## License

MIT

## Acknowledgments

- [Chessnut](https://chessnutech.com/) for the Chessnut Move e-board
- [python-chess](https://python-chess.readthedocs.io/) for chess logic
- [PyMuPDF](https://pymupdf.readthedocs.io/) for PDF rendering
- [Bleak](https://bleak.readthedocs.io/) for Bluetooth LE support
