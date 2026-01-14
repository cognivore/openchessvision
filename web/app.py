#!/usr/bin/env python3
"""
Flask app for chess diagram annotation UI.

Serves pending images extracted from PDFs and allows annotation with FEN.
"""

import sys
import shutil
from pathlib import Path

# Add project src to path for openchessvision imports
PROJECT_ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(PROJECT_ROOT / "src"))

from flask import Flask, jsonify, request, send_file, render_template
from flask_cors import CORS
import chess
import cv2

# Paths (PROJECT_ROOT already defined above for imports)
PENDING_DIR = PROJECT_ROOT / "tests" / "fixtures" / "pending"
SKIPPED_DIR = PROJECT_ROOT / "tests" / "fixtures" / "skipped"
ANNOTATED_DIR = PROJECT_ROOT / "data" / "annotated"

# Ensure directories exist
PENDING_DIR.mkdir(parents=True, exist_ok=True)
SKIPPED_DIR.mkdir(parents=True, exist_ok=True)
ANNOTATED_DIR.mkdir(parents=True, exist_ok=True)

app = Flask(__name__,
            template_folder="templates",
            static_folder="static")
CORS(app)


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


@app.route("/")
def index():
    """Serve the main annotation UI."""
    return render_template("index.html")


@app.route("/api/pending")
def list_pending():
    """List all pending images."""
    images = sorted([f.name for f in PENDING_DIR.glob("*.png")])
    return jsonify({
        "images": images,
        "total": len(images)
    })


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
        return jsonify({
            "fen": "8/8/8/8/8/8/8/8",  # Empty board fallback
            "confidence": 0.0,
            "error": "CNN backend not available"
        })

    try:
        # Load image as numpy array for the backend
        image = cv2.imread(str(image_path))
        if image is None:
            return jsonify({
                "fen": "8/8/8/8/8/8/8/8",
                "confidence": 0.0,
                "error": "Could not load image"
            })

        result = backend.recognize(image)
        return jsonify({
            "fen": result.fen if result.fen else "8/8/8/8/8/8/8/8",
            "confidence": result.overall_confidence
        })
    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({
            "fen": "8/8/8/8/8/8/8/8",
            "confidence": 0.0,
            "error": str(e)
        })


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

    return jsonify({
        "success": True,
        "saved_to": str(dest_image),
        "fen": piece_placement
    })


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

    return jsonify({
        "pending": pending_count,
        "skipped": skipped_count,
        "annotated": annotated_count
    })


if __name__ == "__main__":
    print(f"Pending images: {len(list(PENDING_DIR.glob('*.png')))}", flush=True)
    print(f"Starting annotation server at http://localhost:5050", flush=True)
    app.run(host="0.0.0.0", port=5050, debug=True)
