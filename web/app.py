#!/usr/bin/env python3
"""
Flask app for chess book reader and diagram annotation.

Main features:
- PDF chess book reader with diagram detection
- FEN recognition and analysis
- Annotation UI for training data
"""

import sys
import shutil
import uuid
import tempfile
import hashlib
import subprocess
from pathlib import Path
from typing import Optional
from concurrent.futures import ThreadPoolExecutor

# Add project src to path for openchessvision imports
PROJECT_ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(PROJECT_ROOT / "src"))


def get_build_info() -> dict:
    """Get git commit hash and dirty status for build identification."""
    try:
        # Get short commit hash
        commit = subprocess.run(
            ["git", "rev-parse", "--short=8", "HEAD"],
            capture_output=True,
            text=True,
            cwd=PROJECT_ROOT,
        )
        commit_hash = commit.stdout.strip() if commit.returncode == 0 else "unknown"

        # Check if working directory is dirty
        dirty_check = subprocess.run(
            ["git", "diff", "--quiet"],
            capture_output=True,
            cwd=PROJECT_ROOT,
        )
        is_dirty = dirty_check.returncode != 0

        # If dirty, get a hash of the changes
        dirty_hash = ""
        if is_dirty:
            diff_hash = subprocess.run(
                ["sh", "-c", "git diff | git hash-object --stdin"],
                capture_output=True,
                text=True,
                cwd=PROJECT_ROOT,
            )
            if diff_hash.returncode == 0:
                dirty_hash = f"-dirty-{diff_hash.stdout.strip()[:8]}"
            else:
                dirty_hash = "-dirty"

        version = f"{commit_hash}{dirty_hash}"
        return {
            "version": version,
            "commit": commit_hash,
            "dirty": is_dirty,
            "dirty_hash": dirty_hash.replace("-dirty-", "") if dirty_hash else None,
        }
    except Exception as e:
        return {"version": "unknown", "commit": "unknown", "dirty": False, "error": str(e)}


# Cache build info at startup
BUILD_INFO = get_build_info()

from flask import Flask, jsonify, request, send_file, render_template, redirect, url_for
from flask_cors import CORS
import chess
import cv2
import numpy as np
from PIL import Image
import pytesseract

# Paths
PENDING_DIR = PROJECT_ROOT / "tests" / "fixtures" / "pending"
SKIPPED_DIR = PROJECT_ROOT / "tests" / "fixtures" / "skipped"
ANNOTATED_DIR = PROJECT_ROOT / "data" / "annotated"
UPLOADS_DIR = PROJECT_ROOT / "data" / "uploads"
STUDIES_DIR = PROJECT_ROOT / "data" / "studies"

# Ensure directories exist
PENDING_DIR.mkdir(parents=True, exist_ok=True)
SKIPPED_DIR.mkdir(parents=True, exist_ok=True)
ANNOTATED_DIR.mkdir(parents=True, exist_ok=True)
UPLOADS_DIR.mkdir(parents=True, exist_ok=True)
STUDIES_DIR.mkdir(parents=True, exist_ok=True)

app = Flask(__name__, template_folder="templates", static_folder="static")
CORS(app)

# Store uploaded PDFs in memory for quick access
_pdf_cache: dict = {}


# Try to load the CNN model for predictions
_cnn_backend = None


def get_cnn_backend():
    """Lazy-load the CNN backend."""
    global _cnn_backend
    if _cnn_backend is None:
        try:
            from openchessvision.recognition.local_cnn import LocalCNNBackend

            _cnn_backend = LocalCNNBackend()
            print("CNN backend loaded successfully", flush=True)
        except Exception as e:
            print(f"Warning: Could not load CNN backend: {e}", flush=True)
            _cnn_backend = False  # Mark as failed
    return _cnn_backend if _cnn_backend else None


# =============================================================================
# Main Routes
# =============================================================================


@app.route("/")
def index():
    """Redirect to reader as main UI."""
    return redirect(url_for("reader"))


@app.route("/reader")
def reader():
    """Serve the chess book reader UI."""
    return render_template("reader.html", build_info=BUILD_INFO)


@app.route("/api/build-info")
def build_info():
    """Return build/version information."""
    return jsonify(BUILD_INFO)


@app.route("/api/js-error", methods=["POST"])
def js_error():
    """Log JavaScript errors from the frontend for debugging."""
    data = request.get_json(silent=True) or {}
    print(f"[JS ERROR] {data.get('message', 'Unknown error')}")
    print(f"           Source: {data.get('source', '?')}:{data.get('line', '?')}:{data.get('column', '?')}")
    if data.get('stack'):
        print(f"           Stack: {data.get('stack')[:500]}")
    return jsonify({"ok": True})


@app.route("/debug")
def debug():
    """Debug endpoint that auto-loads a hardcoded PDF."""
    return render_template("reader.html", debug_mode=True)


@app.route("/api/debug-load")
def debug_load():
    """Load the debug PDF file directly."""
    import fitz

    # Use the modern-benoni.pdf from data folder
    debug_pdf_path = PROJECT_ROOT / "data" / "modern-benoni.pdf"

    if not debug_pdf_path.exists():
        return jsonify({"error": f"Debug PDF not found: {debug_pdf_path}"}), 404

    # Calculate content hash for persistence
    with open(debug_pdf_path, "rb") as f:
        content_hash = hashlib.sha256(f.read()).hexdigest()[:16]

    # Use content hash as ID (enables study persistence)
    pdf_id = content_hash
    dest_path = UPLOADS_DIR / f"{pdf_id}.pdf"

    # Copy file if not already there
    if not dest_path.exists():
        shutil.copy(str(debug_pdf_path), str(dest_path))

    # Get page count
    doc = fitz.open(str(dest_path))
    page_count = len(doc)
    doc.close()

    # Check for existing study
    study_path = STUDIES_DIR / f"{pdf_id}.json"
    has_study = study_path.exists()

    return jsonify(
        {
            "pdf_id": pdf_id,
            "content_hash": content_hash,
            "filename": debug_pdf_path.name,
            "pages": page_count,
            "has_study": has_study,
        }
    )


@app.route("/annotation")
def annotation():
    """Serve the annotation UI (for training data creation)."""
    return render_template("index.html")


# =============================================================================
# PDF Upload & Management APIs
# =============================================================================


@app.route("/api/check-pdf/<content_hash>")
def check_pdf(content_hash: str):
    """
    Check if a PDF with the given content hash already exists.
    Returns PDF info if found, 404 if not.
    """
    import fitz

    # Validate hash format (8 or 16 hex chars for legacy/new support)
    if not content_hash or len(content_hash) not in (8, 16):
        return jsonify({"error": "Invalid hash format"}), 400

    pdf_path = UPLOADS_DIR / f"{content_hash}.pdf"
    if not pdf_path.exists():
        return jsonify({"exists": False}), 404

    # Get page count
    try:
        doc = fitz.open(str(pdf_path))
        page_count = len(doc)
        doc.close()
    except Exception as e:
        return jsonify({"error": f"Could not read PDF: {e}"}), 500

    # Check for existing study
    study_path = STUDIES_DIR / f"{content_hash}.json"
    has_study = study_path.exists()

    return jsonify(
        {
            "exists": True,
            "pdf_id": content_hash,
            "content_hash": content_hash,
            "pages": page_count,
            "has_study": has_study,
        }
    )


@app.route("/api/upload-pdf", methods=["POST"])
def upload_pdf():
    """Upload a PDF file for reading."""
    if "file" not in request.files:
        return jsonify({"error": "No file provided"}), 400

    file = request.files["file"]
    if file.filename == "" or not file.filename.lower().endswith(".pdf"):
        return jsonify({"error": "Invalid PDF file"}), 400

    # Read file content to calculate hash
    content = file.read()
    content_hash = hashlib.sha256(content).hexdigest()[:16]
    file.seek(0)  # Reset for saving

    # Use content hash as ID (enables deduplication and study persistence)
    pdf_id = content_hash

    # Save to uploads directory (only if not already exists)
    pdf_path = UPLOADS_DIR / f"{pdf_id}.pdf"
    if not pdf_path.exists():
        file.save(str(pdf_path))

    # Get page count using PyMuPDF
    try:
        import fitz

        doc = fitz.open(str(pdf_path))
        page_count = len(doc)
        doc.close()
    except Exception as e:
        return jsonify({"error": f"Could not read PDF: {e}"}), 400

    # Check if there's an existing study for this PDF
    study_path = STUDIES_DIR / f"{pdf_id}.json"
    has_study = study_path.exists()

    return jsonify(
        {
            "pdf_id": pdf_id,
            "content_hash": content_hash,
            "filename": file.filename,
            "pages": page_count,
            "has_study": has_study,
        }
    )


@app.route("/api/pdf/<pdf_id>")
def get_pdf(pdf_id: str):
    """Serve a PDF file."""
    pdf_path = UPLOADS_DIR / f"{pdf_id}.pdf"
    if not pdf_path.exists():
        return jsonify({"error": "PDF not found"}), 404
    return send_file(pdf_path, mimetype="application/pdf")


@app.route("/api/pdf/<pdf_id>/page/<int:page>")
def get_pdf_page(pdf_id: str, page: int):
    """Render a single PDF page as PNG image."""
    pdf_path = UPLOADS_DIR / f"{pdf_id}.pdf"
    if not pdf_path.exists():
        return jsonify({"error": "PDF not found"}), 404

    try:
        import fitz

        doc = fitz.open(str(pdf_path))
        if page < 0 or page >= len(doc):
            return jsonify({"error": "Page out of range"}), 400

        # Render at 2x resolution for clarity
        mat = fitz.Matrix(2.0, 2.0)
        pix = doc[page].get_pixmap(matrix=mat)

        # Convert to PNG bytes
        png_bytes = pix.tobytes("png")
        doc.close()

        from io import BytesIO

        return send_file(BytesIO(png_bytes), mimetype="image/png")
    except Exception as e:
        return jsonify({"error": f"Could not render page: {e}"}), 500


# =============================================================================
# Diagram Detection APIs
# =============================================================================

_board_detector = None


def get_board_detector():
    """Lazy-load the board detector."""
    global _board_detector
    if _board_detector is None:
        try:
            from openchessvision.preprocessing.board_detector import BoardDetector

            _board_detector = BoardDetector(output_size=256)
            print("Board detector loaded successfully", flush=True)
        except Exception as e:
            print(f"Warning: Could not load board detector: {e}", flush=True)
            _board_detector = False
    return _board_detector if _board_detector else None


@app.route("/api/detect-diagrams/<pdf_id>/<int:page>")
def detect_diagrams(pdf_id: str, page: int):
    """Detect chess diagrams on a PDF page."""
    pdf_path = UPLOADS_DIR / f"{pdf_id}.pdf"
    if not pdf_path.exists():
        return jsonify({"error": "PDF not found"}), 404

    try:
        import fitz

        doc = fitz.open(str(pdf_path))
        if page < 0 or page >= len(doc):
            return jsonify({"error": "Page out of range"}), 400

        # Render page at high resolution
        mat = fitz.Matrix(2.0, 2.0)
        pix = doc[page].get_pixmap(matrix=mat)

        # Convert to numpy array
        img_data = np.frombuffer(pix.samples, dtype=np.uint8)
        img = img_data.reshape(pix.height, pix.width, pix.n)

        if pix.n == 4:  # RGBA
            img = cv2.cvtColor(img, cv2.COLOR_RGBA2BGR)
        elif pix.n == 3:  # RGB
            img = cv2.cvtColor(img, cv2.COLOR_RGB2BGR)

        doc.close()

        # Detect potential chess diagrams using contour detection
        diagrams = detect_squares_in_image(img)

        return jsonify(
            {
                "page": page,
                "width": pix.width,
                "height": pix.height,
                "diagrams": diagrams,
            }
        )
    except Exception as e:
        import traceback

        traceback.print_exc()
        return jsonify({"error": f"Detection failed: {e}"}), 500


def detect_squares_in_image(img: np.ndarray) -> list:
    """
    Detect square-ish regions that might be chess diagrams.
    Returns list of bounding boxes: [{x, y, width, height, confidence}]
    """
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)

    # Apply adaptive threshold
    thresh = cv2.adaptiveThreshold(
        gray, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY_INV, 11, 2
    )

    # Find contours
    contours, _ = cv2.findContours(thresh, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

    diagrams = []
    min_size = 100  # Minimum diagram size

    for contour in contours:
        x, y, w, h = cv2.boundingRect(contour)

        # Check if roughly square and large enough
        aspect_ratio = w / h if h > 0 else 0
        if w > min_size and h > min_size and 0.7 < aspect_ratio < 1.4:
            # Calculate confidence based on squareness
            confidence = 1.0 - abs(1.0 - aspect_ratio)

            diagrams.append(
                {
                    "x": int(x),
                    "y": int(y),
                    "width": int(w),
                    "height": int(h),
                    "confidence": round(confidence, 2),
                }
            )

    # Sort by area (largest first) and limit
    diagrams.sort(key=lambda d: d["width"] * d["height"], reverse=True)
    return diagrams[:10]  # Max 10 diagrams per page


@app.route("/api/recognize-region", methods=["POST"])
def recognize_region():
    """
    Recognize chess position from a specific region of a PDF page.
    Expects JSON: {pdf_id, page, bbox: {x, y, width, height}}
    """
    data = request.get_json()

    pdf_id = data.get("pdf_id")
    page = data.get("page")
    bbox = data.get("bbox")

    if not all([pdf_id, page is not None, bbox]):
        return jsonify({"error": "Missing pdf_id, page, or bbox"}), 400

    pdf_path = UPLOADS_DIR / f"{pdf_id}.pdf"
    if not pdf_path.exists():
        return jsonify({"error": "PDF not found"}), 404

    try:
        import fitz

        doc = fitz.open(str(pdf_path))

        # Render page
        mat = fitz.Matrix(2.0, 2.0)
        pix = doc[page].get_pixmap(matrix=mat)

        # Convert to numpy
        img_data = np.frombuffer(pix.samples, dtype=np.uint8)
        img = img_data.reshape(pix.height, pix.width, pix.n)

        if pix.n == 4:
            img = cv2.cvtColor(img, cv2.COLOR_RGBA2BGR)
        elif pix.n == 3:
            img = cv2.cvtColor(img, cv2.COLOR_RGB2BGR)

        doc.close()

        # Extract region
        x, y, w, h = bbox["x"], bbox["y"], bbox["width"], bbox["height"]
        region = img[y : y + h, x : x + w]

        # Try to clean/detect the board
        detector = get_board_detector()
        if detector:
            result = detector.detect(region)
            if result.success and result.board_image is not None:
                region = result.board_image

        # Recognize with CNN
        backend = get_cnn_backend()
        if backend is None:
            return jsonify(
                {
                    "fen": "8/8/8/8/8/8/8/8",
                    "confidence": 0.0,
                    "error": "CNN backend not available",
                }
            )

        recognition = backend.recognize(region)

        return jsonify(
            {
                "fen": recognition.fen if recognition.fen else "8/8/8/8/8/8/8/8",
                "confidence": recognition.overall_confidence,
            }
        )

    except Exception as e:
        import traceback

        traceback.print_exc()
        return jsonify({"error": f"Recognition failed: {e}"}), 500


# =============================================================================
# Move Text Extraction (PDF text + OCR)
# =============================================================================


@app.route("/api/extract-moves", methods=["POST"])
def extract_moves():
    """
    Extract move text from a PDF region using both PDF text extraction and OCR.
    Expects JSON: {pdf_id, page, bbox: {x, y, width, height}}
    Returns: {pdf_text, ocr_text}
    """
    import json
    import time
    import fitz

    data = request.get_json()
    pdf_id = data.get("pdf_id")
    page = data.get("page")
    bbox = data.get("bbox")

    if not all([pdf_id, page is not None, bbox]):
        return jsonify({"error": "Missing pdf_id, page, or bbox"}), 400

    pdf_path = UPLOADS_DIR / f"{pdf_id}.pdf"
    if not pdf_path.exists():
        return jsonify({"error": "PDF not found"}), 404

    x, y, w, h = bbox["x"], bbox["y"], bbox["width"], bbox["height"]

    def extract_pdf_text() -> str:
        with fitz.open(str(pdf_path)) as doc:
            rect = fitz.Rect(x, y, x + w, y + h)
            return doc[page].get_text("text", clip=rect) or ""

    def extract_ocr_text() -> str:
        with fitz.open(str(pdf_path)) as doc:
            mat = fitz.Matrix(2.0, 2.0)
            pix = doc[page].get_pixmap(matrix=mat)
            img_data = np.frombuffer(pix.samples, dtype=np.uint8)
            img = img_data.reshape(pix.height, pix.width, pix.n)

            if pix.n == 4:
                img = cv2.cvtColor(img, cv2.COLOR_RGBA2BGR)
            elif pix.n == 3:
                img = cv2.cvtColor(img, cv2.COLOR_RGB2BGR)

            region = img[y : y + h, x : x + w]
            if region.size == 0:
                return ""

            rgb = cv2.cvtColor(region, cv2.COLOR_BGR2RGB)
            pil_img = Image.fromarray(rgb)
            return pytesseract.image_to_string(pil_img, config="--psm 6")

    # #region agent log
    try:
        with open(PROJECT_ROOT / ".cursor" / "debug.log", "a", encoding="utf-8") as f:
            f.write(
                json.dumps(
                    {
                        "location": "app.py:extract_moves:entry",
                        "message": "Extract moves entry",
                        "data": {"pdf_id": pdf_id, "page": page, "bbox": bbox},
                        "timestamp": int(time.time() * 1000),
                        "sessionId": "debug-session",
                        "hypothesisId": "H10",
                    }
                )
                + "\n"
            )
    except Exception:
        pass
    # #endregion

    start_time = time.time()
    try:
        with ThreadPoolExecutor(max_workers=2) as executor:
            future_pdf = executor.submit(extract_pdf_text)
            future_ocr = executor.submit(extract_ocr_text)
            pdf_text = future_pdf.result()
            ocr_text = future_ocr.result()

        # #region agent log
        try:
            with open(PROJECT_ROOT / ".cursor" / "debug.log", "a", encoding="utf-8") as f:
                f.write(
                    json.dumps(
                        {
                            "location": "app.py:extract_moves:done",
                            "message": "Extract moves done",
                            "data": {
                                "pdf_text_len": len(pdf_text or ""),
                                "ocr_text_len": len(ocr_text or ""),
                                "elapsed_ms": int((time.time() - start_time) * 1000),
                            },
                            "timestamp": int(time.time() * 1000),
                            "sessionId": "debug-session",
                            "hypothesisId": "H10",
                        }
                    )
                    + "\n"
                )
        except Exception:
            pass
        # #endregion

        return jsonify({"pdf_text": pdf_text, "ocr_text": ocr_text})
    except Exception as e:
        return jsonify({"error": f"Extraction failed: {e}"}), 500


# =============================================================================
# Study Persistence APIs
# =============================================================================


@app.route("/api/save-study", methods=["POST"])
def save_study():
    """
    Save study data to disk, keyed by PDF content hash.
    Expects JSON: {pdf_id, study: {...analysis data...}}
    """
    import json

    data = request.get_json()
    pdf_id = data.get("pdf_id")
    study = data.get("study")

    if not pdf_id or not study:
        return jsonify({"error": "Missing pdf_id or study data"}), 400

    study_path = STUDIES_DIR / f"{pdf_id}.json"

    try:
        with open(study_path, "w") as f:
            json.dump(study, f, indent=2)
        return jsonify({"success": True, "path": str(study_path)})
    except Exception as e:
        return jsonify({"error": f"Failed to save study: {e}"}), 500


@app.route("/api/load-study/<pdf_id>")
def load_study(pdf_id: str):
    """
    Load study data from disk by PDF content hash.
    """
    import json

    study_path = STUDIES_DIR / f"{pdf_id}.json"

    if not study_path.exists():
        return jsonify({"error": "No study found", "exists": False}), 404

    try:
        with open(study_path, "r") as f:
            study = json.load(f)
        return jsonify({"exists": True, "study": study})
    except Exception as e:
        return jsonify({"error": f"Failed to load study: {e}"}), 500


@app.route("/api/delete-study/<pdf_id>", methods=["DELETE"])
def delete_study(pdf_id: str):
    """Delete a study from disk."""
    study_path = STUDIES_DIR / f"{pdf_id}.json"

    if not study_path.exists():
        return jsonify({"error": "Study not found"}), 404

    try:
        study_path.unlink()
        return jsonify({"success": True})
    except Exception as e:
        return jsonify({"error": f"Failed to delete study: {e}"}), 500


# =============================================================================
# Annotation APIs (existing)
# =============================================================================


@app.route("/api/pending")
def list_pending():
    """List all pending images."""
    images = sorted([f.name for f in PENDING_DIR.glob("*.png")])
    return jsonify({"images": images, "total": len(images)})


@app.route("/api/image/<path:filename>")
def get_image(filename: str):
    """Serve a pending image."""
    image_path = PENDING_DIR / filename
    if not image_path.exists():
        return jsonify({"error": "Image not found"}), 404
    return send_file(image_path, mimetype="image/png")


@app.route("/api/predict/<path:filename>")
def predict_fen(filename: str):
    """Get CNN prediction for an image."""
    image_path = PENDING_DIR / filename
    if not image_path.exists():
        return jsonify({"error": "Image not found"}), 404

    backend = get_cnn_backend()
    if backend is None:
        return jsonify(
            {
                "fen": "8/8/8/8/8/8/8/8",  # Empty board fallback
                "confidence": 0.0,
                "error": "CNN backend not available",
            }
        )

    try:
        # Load image as numpy array for the backend
        image = cv2.imread(str(image_path))
        if image is None:
            return jsonify(
                {
                    "fen": "8/8/8/8/8/8/8/8",
                    "confidence": 0.0,
                    "error": "Could not load image",
                }
            )

        result = backend.recognize(image)
        return jsonify(
            {
                "fen": result.fen if result.fen else "8/8/8/8/8/8/8/8",
                "confidence": result.overall_confidence,
            }
        )
    except Exception as e:
        import traceback

        traceback.print_exc()
        return jsonify({"fen": "8/8/8/8/8/8/8/8", "confidence": 0.0, "error": str(e)})


@app.route("/api/save", methods=["POST"])
def save_annotation():
    """Save annotated FEN and move image to annotated folder."""
    data = request.get_json()

    filename = data.get("filename")
    fen = data.get("fen")

    if not filename or not fen:
        return jsonify({"error": "Missing filename or fen"}), 400

    # Validate FEN using python-chess
    try:
        # Add minimal FEN suffix for validation if only piece placement
        test_fen = fen if " " in fen else f"{fen} w - - 0 1"
        board = chess.Board(test_fen)
    except Exception as e:
        return jsonify({"error": f"Invalid FEN: {e}"}), 400

    # Ensure piece placement only (no move info)
    piece_placement = fen.split()[0]

    source_path = PENDING_DIR / filename
    if not source_path.exists():
        return jsonify({"error": "Image not found"}), 404

    # Create unique filename based on FEN hash
    import hashlib

    fen_hash = hashlib.md5(piece_placement.encode()).hexdigest()[:8]
    base_name = source_path.stem

    # Save image and FEN
    dest_image = ANNOTATED_DIR / f"{base_name}_{fen_hash}.png"
    dest_fen = ANNOTATED_DIR / f"{base_name}_{fen_hash}.fen"

    shutil.move(str(source_path), str(dest_image))
    dest_fen.write_text(piece_placement)

    return jsonify(
        {"success": True, "saved_to": str(dest_image), "fen": piece_placement}
    )


@app.route("/api/skip/<path:filename>", methods=["POST"])
def skip_image(filename: str):
    """Move image to skipped folder."""
    source_path = PENDING_DIR / filename
    if not source_path.exists():
        return jsonify({"error": "Image not found"}), 404

    dest_path = SKIPPED_DIR / filename
    shutil.move(str(source_path), str(dest_path))

    return jsonify({"success": True, "skipped": filename})


@app.route("/api/delete/<path:filename>", methods=["POST"])
def delete_image(filename: str):
    """Permanently delete an image."""
    image_path = PENDING_DIR / filename
    if not image_path.exists():
        return jsonify({"error": "Image not found"}), 404

    image_path.unlink()
    return jsonify({"success": True, "deleted": filename})


@app.route("/api/stats")
def get_stats():
    """Get annotation statistics."""
    pending_count = len(list(PENDING_DIR.glob("*.png")))
    skipped_count = len(list(SKIPPED_DIR.glob("*.png")))
    annotated_count = len(list(ANNOTATED_DIR.glob("*.png")))

    return jsonify(
        {
            "pending": pending_count,
            "skipped": skipped_count,
            "annotated": annotated_count,
        }
    )


# =============================================================================
# Chessnut Move Board Sync APIs
# =============================================================================


@app.route("/api/board/set-fen", methods=["POST"])
def board_set_fen():
    """
    Sync a FEN position to the Chessnut Move board service.

    Expects JSON: {fen: string, force?: boolean}
    Returns: {synced: boolean, error?: string, fen?: string, driver_synced?: boolean}

    This endpoint is designed to be non-blocking for recognition flow:
    if the board service is unavailable, it returns synced=false with an error
    message but does not raise an exception.
    """
    data = request.get_json()

    fen = data.get("fen")
    if not fen:
        return jsonify({"synced": False, "error": "Missing fen"}), 400

    # Validate FEN using python-chess
    try:
        test_fen = fen if " " in fen else f"{fen} w - - 0 1"
        chess.Board(test_fen)
    except Exception as e:
        return jsonify({"synced": False, "error": f"Invalid FEN: {e}"}), 400

    force = data.get("force", True)

    # Import here to avoid circular imports and keep startup fast
    try:
        from openchessvision.integrations.chessnut_service import sync_fen, get_config

        config = get_config()
        result = sync_fen(fen, config=config, force=force)

        return jsonify(
            {
                "synced": result.synced,
                "error": result.error,
                "fen": result.fen,
                "driver_synced": result.driver_synced,
            }
        )

    except Exception as e:
        # Catch-all to ensure recognition flow is never blocked
        return jsonify({"synced": False, "error": str(e)})


@app.route("/api/board/status")
def board_status():
    """
    Get the current status of the Chessnut Move board service.

    Returns connection and driver status from the board service,
    or an error if the service is unreachable.
    """
    try:
        from openchessvision.integrations.chessnut_service import get_config
        import urllib.request
        import json as json_module

        config = get_config()
        url = f"{config.base_url}/api/driver/status"

        with urllib.request.urlopen(url, timeout=config.timeout) as response:
            data = json_module.loads(response.read().decode("utf-8"))
            return jsonify({"available": True, **data})

    except Exception as e:
        return jsonify({"available": False, "error": str(e)})


@app.route("/api/board/fen")
def board_fen():
    """
    Get the current board FEN from the Chessnut Move service.
    Returns: {fen: string} or {error: string}
    """
    try:
        from openchessvision.integrations.chessnut_service import get_config
        import urllib.request
        import json as json_module

        config = get_config()
        url = f"{config.base_url}/api/state/fen"

        with urllib.request.urlopen(url, timeout=config.timeout) as response:
            data = json_module.loads(response.read().decode("utf-8"))
            return jsonify({"fen": data.get("fen")})

    except Exception as e:
        return jsonify({"error": str(e)}), 500


if __name__ == "__main__":
    print(f"Pending images: {len(list(PENDING_DIR.glob('*.png')))}", flush=True)
    print(f"Starting annotation server at http://localhost:5050", flush=True)
    app.run(host="0.0.0.0", port=5050, debug=True)
