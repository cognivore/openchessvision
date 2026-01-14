/**
 * Chess Diagram Annotator
 *
 * Uses chessboard.js for visual editing and chess.js for validation.
 */

// State
let images = [];
let currentIndex = 0;
let board = null;
let game = null;
let orientation = 'white';

// DOM elements
const els = {
    sourceImage: document.getElementById('source-image'),
    chessboard: document.getElementById('chessboard'),
    boardContainer: document.getElementById('board-container'),
    fenInput: document.getElementById('fen'),
    progress: document.getElementById('progress'),
    statusBar: document.getElementById('status-bar'),
    imageList: document.getElementById('image-list'),
    opacityNormal: document.getElementById('opacity-normal'),
    opacityHover: document.getElementById('opacity-hover'),
    opacityNormalVal: document.getElementById('opacity-normal-val'),
    opacityHoverVal: document.getElementById('opacity-hover-val'),
    statPending: document.getElementById('stat-pending'),
    statAnnotated: document.getElementById('stat-annotated'),
    statSkipped: document.getElementById('stat-skipped'),
};

// Initialize
document.addEventListener('DOMContentLoaded', init);

async function init() {
    // Initialize chess.js
    game = new Chess();

    // Initialize chessboard.js with drag-and-drop
    board = Chessboard('chessboard', {
        draggable: true,
        dropOffBoard: 'trash',
        sparePieces: false,  // Piece palette moved to sidebar
        pieceTheme: 'https://chessboardjs.com/img/chesspieces/wikipedia/{piece}.png',
        onDrop: onDrop,
        onChange: onBoardChange,
        showNotation: false,  // Hide coordinate labels
        position: 'start'
    });

    // Setup piece palette in sidebar
    setupPiecePalette();

    // Resize board to match container
    board.resize();

    // Bind controls
    bindControls();

    // Load images
    await loadImages();

    // Update opacity from sliders
    updateOpacity();

    // Clear board initially (will be set by prediction)
    board.clear();
    els.fenInput.value = '8/8/8/8/8/8/8/8';

    // Hide squares to show only pieces over the image
    setTimeout(hideSquares, 100);

    status('Ready');
}

function setupPiecePalette() {
    const blackPalette = document.getElementById('piece-palette-black');
    const whitePalette = document.getElementById('piece-palette-white');

    const blackPieces = ['bK', 'bQ', 'bR', 'bB', 'bN', 'bP'];
    const whitePieces = ['wK', 'wQ', 'wR', 'wB', 'wN', 'wP'];
    const pieceTheme = 'https://chessboardjs.com/img/chesspieces/wikipedia/{piece}.png';

    function addPieceToPalette(palette, piece) {
        if (!palette) return;

        const img = document.createElement('img');
        img.src = pieceTheme.replace('{piece}', piece);
        img.setAttribute('data-piece', piece);
        img.draggable = true;
        img.className = 'palette-piece';

        // Drag start - store piece type
        img.addEventListener('dragstart', (e) => {
            e.dataTransfer.setData('piece', piece);
            e.dataTransfer.effectAllowed = 'copy';
        });

        palette.appendChild(img);
    }

    // Black pieces on left, white pieces on right
    blackPieces.forEach(p => addPieceToPalette(blackPalette, p));
    whitePieces.forEach(p => addPieceToPalette(whitePalette, p));

    // Make board squares accept drops from palette
    const boardEl = document.getElementById('chessboard');
    boardEl.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
    });

    boardEl.addEventListener('drop', (e) => {
        e.preventDefault();
        const piece = e.dataTransfer.getData('piece');
        if (!piece) return;

        // Find which square was dropped on
        const rect = boardEl.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        const squareSize = rect.width / 8;

        const file = Math.floor(x / squareSize);
        const rank = 7 - Math.floor(y / squareSize);

        // Adjust for board orientation
        const files = 'abcdefgh';
        let square;
        if (orientation === 'white') {
            square = files[file] + (rank + 1);
        } else {
            square = files[7 - file] + (8 - rank);
        }

        // Get current position and add piece
        const pos = board.position();
        pos[square] = piece;
        board.position(pos);

        // Update FEN
        const fen = Chessboard.objToFen(pos);
        els.fenInput.value = fen;
        setTimeout(hideSquares, 50);
    });
}

function bindControls() {
    // Opacity sliders
    els.opacityNormal.addEventListener('input', updateOpacity);
    els.opacityHover.addEventListener('input', updateOpacity);

    // FEN input
    els.fenInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') applyFen();
    });
    document.getElementById('btn-apply-fen').addEventListener('click', applyFen);

    // Board controls
    document.getElementById('btn-flip').addEventListener('click', flipBoard);
    document.getElementById('btn-clear').addEventListener('click', clearBoard);
    document.getElementById('btn-start').addEventListener('click', startPosition);

    // Actions
    document.getElementById('btn-save').addEventListener('click', saveAnnotation);
    document.getElementById('btn-skip').addEventListener('click', skipImage);
    document.getElementById('btn-delete').addEventListener('click', deleteImage);

    // Navigation
    document.getElementById('btn-prev').addEventListener('click', prevImage);
    document.getElementById('btn-next').addEventListener('click', nextImage);

    // Keyboard shortcuts
    document.addEventListener('keydown', handleKeyboard);
}

function handleKeyboard(e) {
    // Ignore if typing in input
    if (e.target.tagName === 'INPUT') return;

    switch (e.key) {
        case 'ArrowLeft':
        case 'a':
            prevImage();
            break;
        case 'ArrowRight':
        case 'd':
            nextImage();
            break;
        case 'Enter':
        case 's':
            saveAnnotation();
            break;
        case 'Escape':
        case 'x':
            skipImage();
            break;
        case 'f':
            flipBoard();
            break;
        case 'c':
            clearBoard();
            break;
    }
}

// Opacity control
function updateOpacity() {
    const normal = els.opacityNormal.value / 100;
    const hover = els.opacityHover.value / 100;

    document.documentElement.style.setProperty('--overlay-normal', normal);
    document.documentElement.style.setProperty('--overlay-hover', hover);

    els.opacityNormalVal.textContent = `${els.opacityNormal.value}%`;
    els.opacityHoverVal.textContent = `${els.opacityHover.value}%`;
}

// Image loading
async function loadImages() {
    try {
        const response = await fetch('/api/pending');
        const data = await response.json();
        images = data.images;

        renderImageList();
        updateStats();

        if (images.length > 0) {
            loadImage(0);
        } else {
            status('No pending images');
        }
    } catch (e) {
        status('Error loading images: ' + e.message, 'error');
    }
}

function renderImageList() {
    els.imageList.innerHTML = '';

    images.forEach((name, idx) => {
        const div = document.createElement('div');
        div.className = 'thumb' + (idx === currentIndex ? ' active' : '');
        div.innerHTML = `
            <img src="/api/image/${encodeURIComponent(name)}" alt="">
            <span>${name.substring(0, 30)}...</span>
        `;
        div.addEventListener('click', () => loadImage(idx));
        els.imageList.appendChild(div);
    });
}

async function loadImage(idx) {
    if (idx < 0 || idx >= images.length) return;

    currentIndex = idx;
    const name = images[idx];

    // Update UI
    els.sourceImage.src = `/api/image/${encodeURIComponent(name)}`;
    els.progress.textContent = `${idx + 1} / ${images.length}`;

    // Update sidebar selection
    document.querySelectorAll('.image-list .thumb').forEach((el, i) => {
        el.classList.toggle('active', i === idx);
    });

    // Get CNN prediction
    status('Getting prediction...');
    try {
        const response = await fetch(`/api/predict/${encodeURIComponent(name)}`);
        const data = await response.json();

        if (data.fen) {
            setFen(data.fen);
            const conf = (data.confidence * 100).toFixed(1);
            status(`Prediction loaded (${conf}% confidence)`);
        }
    } catch (e) {
        status('Could not get prediction: ' + e.message, 'error');
        clearBoard();
    }
}

// Board manipulation
function setFen(fen) {
    // Normalize: add move info if missing
    const fullFen = fen.includes(' ') ? fen : `${fen} w - - 0 1`;

    try {
        game.load(fullFen);
        board.position(game.fen());
        els.fenInput.value = fen.split(' ')[0];  // Just piece placement
        setTimeout(hideSquares, 50);
    } catch (e) {
        console.error('Invalid FEN:', fen, e);
        clearBoard();
    }
}

function applyFen() {
    const fen = els.fenInput.value.trim();
    if (fen) {
        setFen(fen);
        status('FEN applied');
    }
}

function onDrop(source, target, piece, newPos, oldPos, orientation) {
    // Chessboard.js handles the visual update
    // We just sync with chess.js
    setTimeout(() => {
        const fen = Chessboard.objToFen(board.position());
        els.fenInput.value = fen;
    }, 0);
}

function onBoardChange(oldPos, newPos) {
    const fen = Chessboard.objToFen(newPos);
    els.fenInput.value = fen;
    // Force transparent squares after any change
    hideSquares();
}

function hideSquares() {
    // Remove chessboard.js square colors to show only pieces
    document.querySelectorAll('#chessboard [class*="square-"]').forEach(sq => {
        sq.style.background = 'transparent';
        sq.style.backgroundColor = 'transparent';
    });
}

function flipBoard() {
    orientation = orientation === 'white' ? 'black' : 'white';
    board.orientation(orientation);
    setTimeout(hideSquares, 50);
    status(`Board flipped to ${orientation}'s perspective`);
}

function clearBoard() {
    board.clear();
    els.fenInput.value = '8/8/8/8/8/8/8/8';
    setTimeout(hideSquares, 50);
    status('Board cleared');
}

function startPosition() {
    board.start();
    els.fenInput.value = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR';
    setTimeout(hideSquares, 50);
    status('Starting position set');
}

// Actions
async function saveAnnotation() {
    if (images.length === 0) return;

    const filename = images[currentIndex];
    const fen = els.fenInput.value.trim();

    if (!fen) {
        status('No FEN to save', 'error');
        return;
    }

    // Validate FEN
    try {
        const testFen = fen.includes(' ') ? fen : `${fen} w - - 0 1`;
        new Chess(testFen);
    } catch (e) {
        status('Invalid FEN: ' + e.message, 'error');
        return;
    }

    status('Saving...');
    try {
        const response = await fetch('/api/save', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ filename, fen })
        });

        const data = await response.json();

        if (data.success) {
            status('Saved successfully!', 'success');
            // Remove from list and load next
            images.splice(currentIndex, 1);
            renderImageList();
            updateStats();

            if (images.length > 0) {
                loadImage(Math.min(currentIndex, images.length - 1));
            } else {
                els.sourceImage.src = '';
                clearBoard();
                status('All images annotated!', 'success');
            }
        } else {
            status('Error: ' + data.error, 'error');
        }
    } catch (e) {
        status('Save failed: ' + e.message, 'error');
    }
}

async function skipImage() {
    if (images.length === 0) return;

    const filename = images[currentIndex];

    try {
        const response = await fetch(`/api/skip/${encodeURIComponent(filename)}`, {
            method: 'POST'
        });

        const data = await response.json();

        if (data.success) {
            status('Skipped');
            images.splice(currentIndex, 1);
            renderImageList();
            updateStats();

            if (images.length > 0) {
                loadImage(Math.min(currentIndex, images.length - 1));
            } else {
                els.sourceImage.src = '';
                clearBoard();
            }
        }
    } catch (e) {
        status('Skip failed: ' + e.message, 'error');
    }
}

async function deleteImage() {
    if (images.length === 0) return;

    const filename = images[currentIndex];

    if (!confirm(`Delete ${filename}? This cannot be undone.`)) return;

    try {
        const response = await fetch(`/api/delete/${encodeURIComponent(filename)}`, {
            method: 'POST'
        });

        const data = await response.json();

        if (data.success) {
            status('Deleted');
            images.splice(currentIndex, 1);
            renderImageList();
            updateStats();

            if (images.length > 0) {
                loadImage(Math.min(currentIndex, images.length - 1));
            } else {
                els.sourceImage.src = '';
                clearBoard();
            }
        }
    } catch (e) {
        status('Delete failed: ' + e.message, 'error');
    }
}

function prevImage() {
    if (currentIndex > 0) {
        loadImage(currentIndex - 1);
    }
}

function nextImage() {
    if (currentIndex < images.length - 1) {
        loadImage(currentIndex + 1);
    }
}

// Stats
async function updateStats() {
    try {
        const response = await fetch('/api/stats');
        const data = await response.json();

        els.statPending.textContent = data.pending;
        els.statAnnotated.textContent = data.annotated;
        els.statSkipped.textContent = data.skipped;
    } catch (e) {
        console.error('Could not update stats:', e);
    }
}

// Status
function status(message, type = '') {
    els.statusBar.textContent = message;
    els.statusBar.className = 'status-bar' + (type ? ' ' + type : '');
}
