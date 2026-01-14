/**
 * Chess Book Reader
 *
 * PDF viewing with chess diagram detection and analysis.
 */

// Set PDF.js worker
pdfjsLib.GlobalWorkerOptions.workerSrc = '/static/vendor/js/pdf.worker.min.js';

// =============================================================================
// State
// =============================================================================

const state = {
    // PDF state
    pdfDoc: null,
    pdfId: null,
    contentHash: null,  // Content-based hash for persistence
    currentPage: 1,
    totalPages: 0,
    scale: 1.0,
    renderTask: null,  // Track current render task

    // Detected positions: { id, page, bbox, fen, thumbnail }
    positions: [],

    // Active position
    activePositionId: null,

    // Analysis state per position: { positionId: AnalysisTree }
    analyses: {},

    // Current node in the move tree (for navigation)
    currentNode: null,

    // Board instances
    previewBoard: null,
    analysisBoard: null,

    // Engine
    stockfish: null,
    engineRunning: false,

    // PGN viewer
    pgnViewer: null,

    // Auto-save timer
    saveTimer: null,
    isDirty: false,  // Track if there are unsaved changes

    // Selected piece for click-to-place (from palette)
    selectedPiece: null,
};

// =============================================================================
// DOM Elements
// =============================================================================

const els = {
    pdfInput: document.getElementById('pdf-input'),
    btnOpen: document.getElementById('btn-open'),
    pdfInfo: document.getElementById('pdf-info'),
    btnPrevPage: document.getElementById('btn-prev-page'),
    btnNextPage: document.getElementById('btn-next-page'),
    pageInfo: document.getElementById('page-info'),
    zoomSlider: document.getElementById('zoom-slider'),
    zoomValue: document.getElementById('zoom-value'),
    pdfViewport: document.getElementById('pdf-viewport'),
    pdfPageContainer: document.getElementById('pdf-page-container'),
    pdfCanvas: document.getElementById('pdf-canvas'),
    detectionOverlay: document.getElementById('detection-overlay'),
    boardOverlay: document.getElementById('board-overlay'),
    activeBoard: document.getElementById('active-board'),
    noPdfMessage: document.getElementById('no-pdf-message'),
    positionList: document.getElementById('position-list'),
    analysisContainer: document.getElementById('analysis-container'),
    pgnViewer: document.getElementById('pgn-viewer'),
    enginePanel: document.getElementById('engine-panel'),
    engineEval: document.getElementById('engine-eval'),
    engineLine: document.getElementById('engine-line'),
    btnToggleEngine: document.getElementById('btn-toggle-engine'),
    btnAnalyseWhite: document.getElementById('btn-analyse-white'),
    btnAnalyseBlack: document.getElementById('btn-analyse-black'),
    btnCopyFen: document.getElementById('btn-copy-fen'),
    btnCopyPgn: document.getElementById('btn-copy-pgn'),
    statusBar: document.getElementById('status-bar'),
    paletteBlack: document.getElementById('piece-palette-black'),
    paletteWhite: document.getElementById('piece-palette-white'),
};

// =============================================================================
// Move Tree for Variations
// =============================================================================

/**
 * A node in the move tree. Each node represents a position.
 * Children are alternative moves from this position.
 */
class MoveNode {
    constructor(fen, san = null, parent = null) {
        this.fen = fen;           // Position after this move
        this.san = san;           // Move that led here (null for root)
        this.parent = parent;     // Parent node
        this.children = [];       // Child moves (first is main line)
        this.comment = '';        // Optional annotation
    }

    // Add a child move, returns the new node
    addChild(fen, san) {
        // Check if this move already exists as a child
        const existing = this.children.find(c => c.san === san);
        if (existing) return existing;

        const node = new MoveNode(fen, san, this);
        this.children.push(node);
        return node;
    }

    // Remove a child node and all its descendants
    removeChild(child) {
        const index = this.children.indexOf(child);
        if (index !== -1) {
            this.children.splice(index, 1);
            return true;
        }
        return false;
    }

    // Get main line continuation (first child)
    getMainLine() {
        return this.children.length > 0 ? this.children[0] : null;
    }

    // Check if this node has variations (more than one child)
    hasVariations() {
        return this.children.length > 1;
    }

    // Get depth from root
    getDepth() {
        let depth = 0;
        let node = this;
        while (node.parent) {
            depth++;
            node = node.parent;
        }
        return depth;
    }

    // Get path from root to this node
    getPath() {
        const path = [];
        let node = this;
        while (node.parent) {
            path.unshift(node);
            node = node.parent;
        }
        return path;
    }

    // Get the index of this node among its siblings
    getSiblingIndex() {
        if (!this.parent) return 0;
        return this.parent.children.indexOf(this);
    }
}

/**
 * Analysis tree for a position
 */
class AnalysisTree {
    constructor(startFen, turn) {
        this.startFen = startFen;
        this.turn = turn;
        this.root = new MoveNode(startFen, null, null);
        this.currentNode = this.root;
    }

    // Make a move from current position
    makeMove(san, newFen) {
        const newNode = this.currentNode.addChild(newFen, san);
        this.currentNode = newNode;
        return newNode;
    }

    // Go back one move
    goBack() {
        if (this.currentNode.parent) {
            this.currentNode = this.currentNode.parent;
            return true;
        }
        return false;
    }

    // Go forward (follow main line)
    goForward() {
        const next = this.currentNode.getMainLine();
        if (next) {
            this.currentNode = next;
            return true;
        }
        return false;
    }

    // Go to a specific node
    goTo(node) {
        this.currentNode = node;
    }

    // Delete current variation (the branch containing currentNode)
    // Returns true if deleted, false if at root or couldn't delete
    deleteCurrentVariation() {
        // Can't delete if we're at the root
        if (!this.currentNode.parent) {
            return false;
        }

        const parent = this.currentNode.parent;
        const nodeToDelete = this.currentNode;

        // Remove this node from parent's children
        if (parent.removeChild(nodeToDelete)) {
            // Move to parent or sibling
            if (parent.children.length > 0) {
                // Go to first remaining sibling
                this.currentNode = parent.children[0];
            } else {
                // No siblings, go to parent
                this.currentNode = parent;
            }
            return true;
        }
        return false;
    }

    // Get next variation at current position
    getNextVariation() {
        if (!this.currentNode.parent) return null;
        const siblings = this.currentNode.parent.children;
        const idx = this.currentNode.getSiblingIndex();
        if (idx < siblings.length - 1) {
            return siblings[idx + 1];
        }
        return null;
    }

    // Get previous variation at current position
    getPrevVariation() {
        if (!this.currentNode.parent) return null;
        const siblings = this.currentNode.parent.children;
        const idx = this.currentNode.getSiblingIndex();
        if (idx > 0) {
            return siblings[idx - 1];
        }
        return null;
    }

    // Generate PGN string from the tree
    toPGN() {
        const lines = [];
        lines.push(`[FEN "${this.startFen}"]`);
        lines.push('');

        const renderNode = (node, moveNum, isWhite, depth) => {
            let result = '';

            if (node.san) {
                if (isWhite) {
                    result += `${moveNum}. ${node.san}`;
                } else {
                    result += node.san;
                }
            }

            // Render main line first
            if (node.children.length > 0) {
                const mainChild = node.children[0];
                const nextIsWhite = !isWhite;
                const nextMoveNum = isWhite ? moveNum : moveNum + 1;

                if (result) result += ' ';
                result += renderNode(mainChild, nextMoveNum, nextIsWhite, depth);

                // Then render variations
                for (let i = 1; i < node.children.length; i++) {
                    const variation = node.children[i];
                    result += ` (`;
                    if (!isWhite) {
                        result += `${moveNum}... `;
                    }
                    result += renderNode(variation, isWhite ? moveNum : moveNum + 1, !isWhite, depth + 1);
                    result += `)`;
                }
            }

            return result;
        };

        // Determine starting move number from FEN
        const fenParts = this.startFen.split(' ');
        const startMoveNum = parseInt(fenParts[5] || '1', 10);
        const isWhiteToMove = fenParts[1] === 'w';

        const pgn = renderNode(this.root, startMoveNum, isWhiteToMove, 0);
        lines.push(pgn.trim() || '*');

        return lines.join('\n');
    }

    // Get moves on main line from root
    getMainLineMoves() {
        const moves = [];
        let node = this.root;
        while (node.children.length > 0) {
            node = node.children[0];
            moves.push(node.san);
        }
        return moves;
    }

    // Serialize to JSON for persistence
    toJSON() {
        const serializeNode = (node) => ({
            fen: node.fen,
            san: node.san,
            comment: node.comment,
            children: node.children.map(serializeNode),
        });

        return {
            startFen: this.startFen,
            turn: this.turn,
            tree: serializeNode(this.root),
        };
    }

    // Deserialize from JSON
    static fromJSON(json) {
        const tree = new AnalysisTree(json.startFen, json.turn);

        const deserializeNode = (data, parent) => {
            const node = new MoveNode(data.fen, data.san, parent);
            node.comment = data.comment || '';
            node.children = data.children.map(c => deserializeNode(c, node));
            return node;
        };

        tree.root = deserializeNode(json.tree, null);
        tree.currentNode = tree.root;
        return tree;
    }
}

// =============================================================================
// Initialization
// =============================================================================

document.addEventListener('DOMContentLoaded', init);

function init() {
    bindEvents();
    setupPiecePalettes();
    initStockfish();
    status('Ready - Open a PDF to begin');
}

// Debug: Load hardcoded PDF
async function loadDebugPdf() {
    status('Loading debug PDF...');

    try {
        const response = await fetch('/api/debug-load');
        const data = await response.json();

        if (data.error) {
            status(`Error: ${data.error}`);
            return;
        }

        state.pdfId = data.pdf_id;
        state.contentHash = data.content_hash || data.pdf_id;
        state.totalPages = data.pages;

        els.pdfInfo.textContent = `${data.filename} (${data.pages} pages)`;
        els.noPdfMessage.classList.add('hidden');

        // Load PDF for rendering
        const pdfUrl = `/api/pdf/${state.pdfId}`;
        state.pdfDoc = await pdfjsLib.getDocument(pdfUrl).promise;

        // Clear previous state
        state.positions = [];
        state.analyses = {};
        state.activePositionId = null;
        state.isDirty = false;

        // Try to load existing study
        const hasStudy = await loadStudy();
        if (!hasStudy) {
            updatePositionList();
        }

        // Go to first page
        await goToPage(1);

        if (hasStudy) {
            status(`Loaded ${data.filename} with existing study - ${state.positions.length} positions`);
        } else {
            status(`Loaded ${data.filename} - Click on detected diagrams to recognize`);
        }

    } catch (err) {
        console.error(err);
        status(`Error loading debug PDF: ${err.message}`);
    }
}

// Make it globally accessible for debug mode
window.loadDebugPdf = loadDebugPdf;

function bindEvents() {
    // File input
    els.btnOpen.addEventListener('click', () => els.pdfInput.click());
    els.pdfInput.addEventListener('change', handleFileSelect);

    // Page navigation
    els.btnPrevPage.addEventListener('click', () => goToPage(state.currentPage - 1));
    els.btnNextPage.addEventListener('click', () => goToPage(state.currentPage + 1));

    // Go to page
    const pageInput = document.getElementById('page-input');
    const btnGoto = document.getElementById('btn-goto-page');
    if (btnGoto && pageInput) {
        btnGoto.addEventListener('click', () => {
            const pageNum = parseInt(pageInput.value);
            if (pageNum >= 1 && pageNum <= state.totalPages) {
                goToPage(pageNum);
            }
        });
        pageInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                const pageNum = parseInt(pageInput.value);
                if (pageNum >= 1 && pageNum <= state.totalPages) {
                    goToPage(pageNum);
                }
            }
        });
    }

    // Zoom
    els.zoomSlider.addEventListener('input', handleZoom);

    // Analysis buttons - separate for white and black
    els.btnAnalyseWhite.addEventListener('click', () => startAnalysis('w'));
    els.btnAnalyseBlack.addEventListener('click', () => startAnalysis('b'));
    els.btnCopyFen.addEventListener('click', copyFen);
    els.btnCopyPgn.addEventListener('click', copyPgn);
    els.btnToggleEngine.addEventListener('click', toggleEngine);

    // Manual bbox drawing on PDF
    els.detectionOverlay.addEventListener('mousedown', startManualBbox);
    els.detectionOverlay.addEventListener('mousemove', drawManualBbox);
    els.detectionOverlay.addEventListener('mouseup', endManualBbox);
    els.detectionOverlay.addEventListener('mouseleave', endManualBbox);

    // Keyboard shortcuts
    document.addEventListener('keydown', handleKeyboard);
}

// Manual bbox drawing state
let manualBboxState = null;

function startManualBbox(e) {
    if (!state.pdfId) return;

    const rect = els.detectionOverlay.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    manualBboxState = {
        startX: x,
        startY: y,
        rect: null
    };

    // Create drawing rect
    const drawRect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    drawRect.setAttribute('x', x);
    drawRect.setAttribute('y', y);
    drawRect.setAttribute('width', 0);
    drawRect.setAttribute('height', 0);
    drawRect.classList.add('detection-box', 'drawing');
    drawRect.style.strokeDasharray = '5,5';
    els.detectionOverlay.appendChild(drawRect);
    manualBboxState.rect = drawRect;
}

function drawManualBbox(e) {
    if (!manualBboxState || !manualBboxState.rect) return;

    const rect = els.detectionOverlay.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    const startX = manualBboxState.startX;
    const startY = manualBboxState.startY;

    const width = Math.abs(x - startX);
    const height = Math.abs(x - startX); // Force square
    const left = Math.min(startX, x);
    const top = Math.min(startY, startY + (y > startY ? height : -height));

    manualBboxState.rect.setAttribute('x', left);
    manualBboxState.rect.setAttribute('y', top);
    manualBboxState.rect.setAttribute('width', width);
    manualBboxState.rect.setAttribute('height', height);
}

function endManualBbox(e) {
    if (!manualBboxState || !manualBboxState.rect) return;

    const drawRect = manualBboxState.rect;
    const width = parseFloat(drawRect.getAttribute('width'));
    const height = parseFloat(drawRect.getAttribute('height'));

    // Only keep if large enough (min 50px)
    if (width < 50 || height < 50) {
        drawRect.remove();
        manualBboxState = null;
        return;
    }

    // Finalize the rect
    drawRect.classList.remove('drawing');
    drawRect.style.strokeDasharray = '';

    const diagram = {
        x: parseFloat(drawRect.getAttribute('x')),
        y: parseFloat(drawRect.getAttribute('y')),
        width: width,
        height: height
    };

    drawRect.addEventListener('click', () => handleDiagramClick(drawRect, diagram, state.currentPage));
    addResizeHandles(drawRect, diagram);

    manualBboxState = null;

    status('Click on the box to recognize the position');
}

function handleKeyboard(e) {
    if (e.target.tagName === 'INPUT') return;

    switch (e.key) {
        case 'ArrowLeft':
            if (state.pdfDoc) goToPage(state.currentPage - 1);
            break;
        case 'ArrowRight':
            if (state.pdfDoc) goToPage(state.currentPage + 1);
            break;
        case 'Escape':
            deactivatePosition();
            break;
        // Move navigation (vim-style)
        case 'h':
            moveBack();
            break;
        case 'l':
            moveForward();
            break;
        case 'j':
            // Next variation at current position
            nextVariation();
            break;
        case 'k':
            // Previous variation at current position
            prevVariation();
            break;
        case 'x':
        case 'Delete':
        case 'Backspace':
            // Delete current variation
            if (e.key === 'Backspace' && !e.ctrlKey && !e.metaKey) {
                // Don't interfere with normal backspace, require ctrl/cmd
                break;
            }
            deleteVariation();
            e.preventDefault();
            break;
    }
}

// Move navigation using tree structure
function moveBack() {
    const posId = state.activePositionId;
    const tree = state.analyses[posId];
    if (!posId || !tree || !state.currentNode) return;

    // Go to parent node
    if (state.currentNode.parent) {
        state.currentNode = state.currentNode.parent;
        tree.currentNode = state.currentNode;

        // Update chess.js game
        try {
            analysisGame = new Chess(state.currentNode.fen);

            // Update board
            if (state.previewBoard) {
                state.previewBoard.position(state.currentNode.fen);
            }

            // Update PGN viewer
            updatePgnViewer(posId);

            const depth = state.currentNode.getDepth();
            status(`Move ${depth} - ${analysisGame.turn() === 'w' ? 'White' : 'Black'} to move`);
        } catch (e) {
            console.error('Error going back:', e);
        }
    }
}

function moveForward() {
    const posId = state.activePositionId;
    const tree = state.analyses[posId];
    if (!posId || !tree || !state.currentNode) return;

    // Follow main line (first child)
    const nextNode = state.currentNode.getMainLine();
    if (nextNode) {
        state.currentNode = nextNode;
        tree.currentNode = nextNode;

        try {
            analysisGame = new Chess(state.currentNode.fen);

            // Update board
            if (state.previewBoard) {
                state.previewBoard.position(state.currentNode.fen);
            }

            // Update PGN viewer
            updatePgnViewer(posId);

            const depth = state.currentNode.getDepth();
            const hasVars = state.currentNode.parent?.hasVariations();
            status(`Move ${depth}: ${state.currentNode.san}${hasVars ? ' (has variations)' : ''} - ${analysisGame.turn() === 'w' ? 'White' : 'Black'} to move`);
        } catch (e) {
            console.error('Error going forward:', e);
        }
    }
}

function nextVariation() {
    const posId = state.activePositionId;
    const tree = state.analyses[posId];
    if (!posId || !tree || !state.currentNode) return;

    const nextVar = tree.getNextVariation();
    if (nextVar) {
        state.currentNode = nextVar;
        tree.currentNode = nextVar;

        try {
            analysisGame = new Chess(state.currentNode.fen);
            if (state.previewBoard) {
                state.previewBoard.position(state.currentNode.fen);
            }
            updatePgnViewer(posId);
            const siblingIdx = state.currentNode.getSiblingIndex() + 1;
            const totalSiblings = state.currentNode.parent.children.length;
            status(`Variation ${siblingIdx}/${totalSiblings}: ${state.currentNode.san}`);
        } catch (e) {
            console.error('Error switching variation:', e);
        }
    } else {
        // Standard behavior: just show a message, don't auto-navigate
        status('No more variations at this branch');
    }
}

function prevVariation() {
    const posId = state.activePositionId;
    const tree = state.analyses[posId];
    if (!posId || !tree || !state.currentNode) return;

    const prevVar = tree.getPrevVariation();
    if (prevVar) {
        state.currentNode = prevVar;
        tree.currentNode = prevVar;

        try {
            analysisGame = new Chess(state.currentNode.fen);
            if (state.previewBoard) {
                state.previewBoard.position(state.currentNode.fen);
            }
            updatePgnViewer(posId);
            const siblingIdx = state.currentNode.getSiblingIndex() + 1;
            const totalSiblings = state.currentNode.parent.children.length;
            status(`Variation ${siblingIdx}/${totalSiblings}: ${state.currentNode.san}`);
        } catch (e) {
            console.error('Error switching variation:', e);
        }
    } else {
        // Standard behavior: just show a message, don't auto-navigate
        status('No more variations at this branch');
    }
}

function deleteVariation() {
    const posId = state.activePositionId;
    const tree = state.analyses[posId];
    if (!posId || !tree || !state.currentNode) {
        status('No variation to delete');
        return;
    }

    // Can't delete root
    if (!state.currentNode.parent) {
        status('Cannot delete root position');
        return;
    }

    const deletedSan = state.currentNode.san;
    const wasMainLine = state.currentNode.parent.children[0] === state.currentNode;

    if (tree.deleteCurrentVariation()) {
        // Update state
        state.currentNode = tree.currentNode;

        // Update chess.js game
        try {
            analysisGame = new Chess(state.currentNode.fen);
            if (state.previewBoard) {
                state.previewBoard.position(state.currentNode.fen);
            }
            updatePgnViewer(posId);
            markDirty();

            if (wasMainLine) {
                status(`Deleted main line move: ${deletedSan}`);
            } else {
                status(`Deleted variation: ${deletedSan}`);
            }
        } catch (e) {
            console.error('Error after deleting variation:', e);
        }
    } else {
        status('Could not delete variation');
    }
}

// =============================================================================
// PDF Loading
// =============================================================================

async function handleFileSelect(e) {
    const file = e.target.files[0];
    if (!file) return;

    status(`Uploading ${file.name}...`);

    const formData = new FormData();
    formData.append('file', file);

    try {
        const response = await fetch('/api/upload-pdf', {
            method: 'POST',
            body: formData
        });

        const data = await response.json();

        if (data.error) {
            status(`Error: ${data.error}`);
            return;
        }

        state.pdfId = data.pdf_id;
        state.contentHash = data.content_hash || data.pdf_id;
        state.totalPages = data.pages;

        els.pdfInfo.textContent = `${data.filename} (${data.pages} pages)`;
        els.noPdfMessage.classList.add('hidden');

        // Load PDF for rendering
        const pdfUrl = `/api/pdf/${state.pdfId}`;
        state.pdfDoc = await pdfjsLib.getDocument(pdfUrl).promise;

        // Clear previous state
        state.positions = [];
        state.analyses = {};
        state.activePositionId = null;
        state.isDirty = false;

        // Try to load existing study
        const hasStudy = await loadStudy();
        if (!hasStudy) {
            updatePositionList();
        }

        // Go to first page
        await goToPage(1);

        if (hasStudy) {
            status(`Loaded ${data.filename} with existing study - ${state.positions.length} positions`);
        } else {
            status(`Loaded ${data.filename} - Click on detected diagrams to recognize`);
        }

    } catch (err) {
        console.error(err);
        status(`Error loading PDF: ${err.message}`);
    }
}

// =============================================================================
// Page Rendering
// =============================================================================

async function goToPage(pageNum) {
    if (!state.pdfDoc) return;
    if (pageNum < 1 || pageNum > state.totalPages) return;

    state.currentPage = pageNum;

    // Update UI
    els.btnPrevPage.disabled = pageNum <= 1;
    els.btnNextPage.disabled = pageNum >= state.totalPages;
    els.pageInfo.textContent = `Page ${pageNum} / ${state.totalPages}`;

    // Render page
    await renderPage(pageNum);

    // Detect diagrams on this page
    await detectDiagrams(pageNum);
}

async function renderPage(pageNum) {
    // Cancel any existing render task
    if (state.renderTask) {
        try {
            state.renderTask.cancel();
        } catch (e) {
            // Ignore
        }
        state.renderTask = null;
    }

    const page = await state.pdfDoc.getPage(pageNum);

    // Calculate scale to fit viewport width if first load
    if (!state.initialScaleSet) {
        const viewportContainer = els.pdfViewport;
        const containerWidth = viewportContainer.clientWidth - 40; // padding
        const defaultViewport = page.getViewport({ scale: 1.0 });
        const fitWidthScale = containerWidth / defaultViewport.width;
        state.scale = Math.min(fitWidthScale, 1.5); // Cap at 150%
        state.initialScaleSet = true;

        // Update slider
        const zoomPercent = Math.round(state.scale * 100);
        els.zoomSlider.value = zoomPercent;
        els.zoomValue.textContent = `${zoomPercent}%`;
    }

    const viewport = page.getViewport({ scale: state.scale * 2 }); // 2x for retina

    const canvas = els.pdfCanvas;
    const ctx = canvas.getContext('2d');

    canvas.width = viewport.width;
    canvas.height = viewport.height;
    canvas.style.width = `${viewport.width / 2}px`;
    canvas.style.height = `${viewport.height / 2}px`;

    // Update overlay size
    els.detectionOverlay.setAttribute('width', viewport.width / 2);
    els.detectionOverlay.setAttribute('height', viewport.height / 2);
    els.detectionOverlay.style.width = `${viewport.width / 2}px`;
    els.detectionOverlay.style.height = `${viewport.height / 2}px`;

    // Start render and track it
    state.renderTask = page.render({
        canvasContext: ctx,
        viewport: viewport
    });

    try {
        await state.renderTask.promise;
    } catch (e) {
        if (e.name !== 'RenderingCancelledException') {
            console.error('Render error:', e);
        }
        return;
    }

    state.renderTask = null;

    // Clear detection overlay
    els.detectionOverlay.innerHTML = '';

    // Hide board overlay
    els.boardOverlay.classList.add('hidden');
}

function handleZoom() {
    const zoomPercent = parseInt(els.zoomSlider.value);
    state.scale = zoomPercent / 100;
    els.zoomValue.textContent = `${zoomPercent}%`;

    if (state.pdfDoc) {
        renderPage(state.currentPage);
    }
}

// =============================================================================
// Diagram Detection
// =============================================================================

async function detectDiagrams(pageNum) {
    if (!state.pdfId) return;

    status(`Detecting diagrams on page ${pageNum}...`);

    try {
        const response = await fetch(`/api/detect-diagrams/${state.pdfId}/${pageNum - 1}`);
        const data = await response.json();

        if (data.error) {
            status(`Detection error: ${data.error}`);
            return;
        }

        // Scale factor for display (API returns 2x coords)
        const scaleFactor = state.scale;

        // Draw detection boxes
        data.diagrams.forEach((diagram, idx) => {
            const x = diagram.x * scaleFactor / 2;
            const y = diagram.y * scaleFactor / 2;
            const w = diagram.width * scaleFactor / 2;
            const h = diagram.height * scaleFactor / 2;

            // Create SVG rect
            const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
            rect.setAttribute('x', x);
            rect.setAttribute('y', y);
            rect.setAttribute('width', w);
            rect.setAttribute('height', h);
            rect.classList.add('detection-box');
            rect.dataset.idx = idx;
            rect.dataset.page = pageNum;
            rect.dataset.bbox = JSON.stringify(diagram);

            rect.addEventListener('click', () => handleDiagramClick(rect, diagram, pageNum));

            els.detectionOverlay.appendChild(rect);

            // Add resize handles
            addResizeHandles(rect, diagram);
        });

        status(`Found ${data.diagrams.length} potential diagrams on page ${pageNum}`);

    } catch (err) {
        console.error(err);
        status(`Detection failed: ${err.message}`);
    }
}

function addResizeHandles(rect, diagram) {
    // Add corner handles for resizing
    const corners = ['nw', 'ne', 'sw', 'se'];
    const x = parseFloat(rect.getAttribute('x'));
    const y = parseFloat(rect.getAttribute('y'));
    const w = parseFloat(rect.getAttribute('width'));
    const h = parseFloat(rect.getAttribute('height'));

    corners.forEach(corner => {
        const handle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        handle.setAttribute('r', 5);
        handle.classList.add('resize-handle');
        handle.dataset.corner = corner;

        let cx, cy;
        switch (corner) {
            case 'nw': cx = x; cy = y; break;
            case 'ne': cx = x + w; cy = y; break;
            case 'sw': cx = x; cy = y + h; break;
            case 'se': cx = x + w; cy = y + h; break;
        }

        handle.setAttribute('cx', cx);
        handle.setAttribute('cy', cy);

        // Make draggable
        handle.addEventListener('mousedown', (e) => startResize(e, rect, corner));

        els.detectionOverlay.appendChild(handle);
    });
}

let resizeState = null;

function startResize(e, rect, corner) {
    e.stopPropagation();

    resizeState = {
        rect,
        corner,
        startX: e.clientX,
        startY: e.clientY,
        origX: parseFloat(rect.getAttribute('x')),
        origY: parseFloat(rect.getAttribute('y')),
        origW: parseFloat(rect.getAttribute('width')),
        origH: parseFloat(rect.getAttribute('height')),
    };

    document.addEventListener('mousemove', doResize);
    document.addEventListener('mouseup', endResize);
}

function doResize(e) {
    if (!resizeState) return;

    const dx = e.clientX - resizeState.startX;
    const dy = e.clientY - resizeState.startY;

    let { origX, origY, origW, origH } = resizeState;

    switch (resizeState.corner) {
        case 'nw':
            resizeState.rect.setAttribute('x', origX + dx);
            resizeState.rect.setAttribute('y', origY + dy);
            resizeState.rect.setAttribute('width', origW - dx);
            resizeState.rect.setAttribute('height', origH - dy);
            break;
        case 'ne':
            resizeState.rect.setAttribute('y', origY + dy);
            resizeState.rect.setAttribute('width', origW + dx);
            resizeState.rect.setAttribute('height', origH - dy);
            break;
        case 'sw':
            resizeState.rect.setAttribute('x', origX + dx);
            resizeState.rect.setAttribute('width', origW - dx);
            resizeState.rect.setAttribute('height', origH + dy);
            break;
        case 'se':
            resizeState.rect.setAttribute('width', origW + dx);
            resizeState.rect.setAttribute('height', origH + dy);
            break;
    }
}

function endResize() {
    resizeState = null;
    document.removeEventListener('mousemove', doResize);
    document.removeEventListener('mouseup', endResize);
}

// =============================================================================
// Position Handling
// =============================================================================

async function handleDiagramClick(rect, diagram, pageNum) {
    status('Recognizing position...');

    // Remove active class from all boxes
    document.querySelectorAll('.detection-box').forEach(r => r.classList.remove('active'));
    rect.classList.add('active');

    // Get current bbox from rect (may have been resized)
    const scaleFactor = state.scale;
    const bbox = {
        x: Math.round(parseFloat(rect.getAttribute('x')) * 2 / scaleFactor),
        y: Math.round(parseFloat(rect.getAttribute('y')) * 2 / scaleFactor),
        width: Math.round(parseFloat(rect.getAttribute('width')) * 2 / scaleFactor),
        height: Math.round(parseFloat(rect.getAttribute('height')) * 2 / scaleFactor),
    };

    try {
        const response = await fetch('/api/recognize-region', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                pdf_id: state.pdfId,
                page: pageNum - 1,
                bbox: bbox
            })
        });

        const data = await response.json();

        if (data.error) {
            status(`Recognition error: ${data.error}`);
            return;
        }

        // Create position ID
        const posId = `p${pageNum}_${Date.now()}`;

        // Create or update position
        const position = {
            id: posId,
            page: pageNum,
            bbox: bbox,
            fen: data.fen,
            confidence: data.confidence
        };

        // Add to positions list
        state.positions.push(position);
        updatePositionList();

        // Mark for auto-save
        markDirty();

        // Activate this position
        activatePosition(posId, rect);

        status(`Recognized: ${data.fen} (${Math.round(data.confidence * 100)}% confidence)`);

    } catch (err) {
        console.error(err);
        status(`Recognition failed: ${err.message}`);
    }
}

function activatePosition(posId, rect) {
    const position = state.positions.find(p => p.id === posId);
    if (!position) return;

    state.activePositionId = posId;

    // Update position list highlighting
    document.querySelectorAll('.position-item').forEach(item => {
        item.classList.toggle('active', item.dataset.id === posId);
    });

    // Mark detection box as active
    document.querySelectorAll('.detection-box').forEach(r => r.classList.remove('active'));
    if (rect) {
        rect.classList.add('active');
    }

    // Calculate overlay position from rect or stored bbox
    let x, y, w, h;

    if (rect) {
        x = parseFloat(rect.getAttribute('x'));
        y = parseFloat(rect.getAttribute('y'));
        w = parseFloat(rect.getAttribute('width'));
        h = parseFloat(rect.getAttribute('height'));

        // Store display coordinates for later
        position.displayBbox = { x, y, width: w, height: h };
    } else if (position.displayBbox) {
        // Use stored display coordinates
        x = position.displayBbox.x;
        y = position.displayBbox.y;
        w = position.displayBbox.width;
        h = position.displayBbox.height;
    } else if (position.bbox) {
        // Calculate from original bbox and scale
        const scaleFactor = state.scale;
        x = position.bbox.x * scaleFactor / 2;
        y = position.bbox.y * scaleFactor / 2;
        w = position.bbox.width * scaleFactor / 2;
        h = position.bbox.height * scaleFactor / 2;
    } else {
        // Fallback - hide overlay if no position info
        els.boardOverlay.classList.add('hidden');
        return;
    }

    // Set overlay position
    els.boardOverlay.style.left = `${x}px`;
    els.boardOverlay.style.top = `${y}px`;
    els.boardOverlay.style.width = `${w}px`;
    els.boardOverlay.style.height = `${h}px`;

    els.boardOverlay.classList.remove('hidden');
    els.boardOverlay.classList.add('transparent');
    els.boardOverlay.classList.remove('solid');

    // Create/update board
    if (state.previewBoard) {
        state.previewBoard.destroy();
    }

    state.previewBoard = Chessboard('active-board', {
        position: position.fen,
        draggable: true,
        dropOffBoard: 'trash',
        sparePieces: false,
        pieceTheme: '/static/vendor/img/chesspieces/wikipedia/{piece}.png',
        showNotation: false,
        onDrop: onPreviewBoardDrop,
    });

    // Update analysis buttons
    els.btnAnalyseWhite.disabled = false;
    els.btnAnalyseBlack.disabled = false;
    els.btnCopyFen.disabled = false;

    // Check if we have existing analysis for this position
    const tree = state.analyses[posId];
    if (tree) {
        // Restore analysis mode - switch to solid overlay
        els.boardOverlay.classList.remove('transparent');
        els.boardOverlay.classList.add('solid');

        // Center the 300px board over the original position
        const newSize = 300;
        const centerX = x + w / 2;
        const centerY = y + h / 2;
        els.boardOverlay.style.left = `${centerX - newSize / 2}px`;
        els.boardOverlay.style.top = `${centerY - newSize / 2}px`;
        els.boardOverlay.style.width = `${newSize}px`;
        els.boardOverlay.style.height = `${newSize}px`;

        // Restore the analysis game state from tree
        try {
            // Go to current node in tree (or root if not set)
            state.currentNode = tree.currentNode || tree.root;
            analysisGame = new Chess(state.currentNode.fen);

            // Destroy preview board and recreate with analysis handlers
            if (state.previewBoard) {
                state.previewBoard.destroy();
            }

            state.previewBoard = Chessboard('active-board', {
                position: state.currentNode.fen,
                draggable: true,
                pieceTheme: '/static/vendor/img/chesspieces/wikipedia/{piece}.png',
                showNotation: true,
                onDragStart: onAnalysisDragStart,
                onDrop: onAnalysisDrop,
                onSnapEnd: onAnalysisSnapEnd,
            });
        } catch (e) {
            console.error('Error restoring analysis:', e);
        }

        showAnalysis(posId);
        const moveCount = tree.root.children.length > 0 ? countMoves(tree.root) : 0;
        status(`Restored analysis - ${moveCount} moves`);
    } else {
        // Only make squares transparent when NOT in analysis mode
        // This allows pieces to float over the PDF diagram
        setTimeout(hideSquares, 50);
        hideAnalysis();
    }
}

// Count total moves in tree
function countMoves(node) {
    let count = node.san ? 1 : 0;
    for (const child of node.children) {
        count += countMoves(child);
    }
    return count;
}

function deactivatePosition() {
    state.activePositionId = null;

    els.boardOverlay.classList.add('hidden');

    document.querySelectorAll('.detection-box').forEach(r => r.classList.remove('active'));
    document.querySelectorAll('.position-item').forEach(item => item.classList.remove('active'));

    els.btnAnalyseWhite.disabled = true;
    els.btnAnalyseBlack.disabled = true;
    els.btnCopyFen.disabled = true;
    els.btnCopyPgn.disabled = true;

    hideAnalysis();
}

function onPreviewBoardDrop(source, target, piece, newPos, oldPos, orientation) {
    // If in analysis mode, don't use this handler (analysis has its own)
    if (state.analyses[state.activePositionId] && state.currentNode) {
        return 'snapback'; // Let analysis mode handle it
    }

    // Update FEN in current position after a short delay to let chessboard.js settle
    setTimeout(() => {
        updateCurrentPositionFen();
        hideSquares(); // Keep squares transparent after move
    }, 50);
}

function updateCurrentPositionFen() {
    if (!state.activePositionId || !state.previewBoard) return;

    const position = state.positions.find(p => p.id === state.activePositionId);
    if (position) {
        const newFen = Chessboard.objToFen(state.previewBoard.position());
        position.fen = newFen;

        // Update the sidebar display
        updatePositionList();

        status(`Updated FEN: ${newFen}`);
    }
}

function updatePositionList() {
    els.positionList.innerHTML = '';

    state.positions.forEach(pos => {
        const item = document.createElement('div');
        item.className = 'position-item';
        item.dataset.id = pos.id;

        if (pos.id === state.activePositionId) {
            item.classList.add('active');
        }

        if (state.analyses[pos.id]) {
            item.classList.add('analysed');
        }

        item.innerHTML = `
            <div class="thumb">
                <div id="thumb-${pos.id}" style="width:48px;height:48px;"></div>
            </div>
            <div class="info">
                <div class="page-num">Page ${pos.page}</div>
                <div class="fen-preview">${pos.fen}</div>
            </div>
        `;

        item.addEventListener('click', async () => {
            // Go to page if different
            if (state.currentPage !== pos.page) {
                await goToPage(pos.page);
            }

            // Find the detection box closest to our stored position
            // or create a temporary one for the overlay
            const rects = document.querySelectorAll('.detection-box');
            let bestRect = null;
            let bestDist = Infinity;

            rects.forEach(rect => {
                const x = parseFloat(rect.getAttribute('x'));
                const y = parseFloat(rect.getAttribute('y'));
                const bx = pos.bbox.x * state.scale / 2;
                const by = pos.bbox.y * state.scale / 2;
                const dist = Math.abs(x - bx) + Math.abs(y - by);
                if (dist < bestDist) {
                    bestDist = dist;
                    bestRect = rect;
                }
            });

            // Activate the position (pass the rect for positioning)
            activatePosition(pos.id, bestRect);
        });

        els.positionList.appendChild(item);

        // Create mini board for thumbnail
        setTimeout(() => {
            Chessboard(`thumb-${pos.id}`, {
                position: pos.fen,
                draggable: false,
                showNotation: false,
                pieceTheme: '/static/vendor/img/chesspieces/wikipedia/{piece}.png',
            });
        }, 10);
    });
}

// =============================================================================
// Analysis Mode
// =============================================================================

// Chess.js game for current analysis
let analysisGame = null;

function startAnalysis(turn) {
    const posId = state.activePositionId;
    if (!posId) return;

    const position = state.positions.find(p => p.id === posId);
    if (!position) return;

    // Turn is now passed directly from button click
    if (!turn || (turn !== 'w' && turn !== 'b')) {
        status('Invalid turn');
        return;
    }

    // Switch to solid board overlay - make it larger for analysis
    els.boardOverlay.classList.remove('transparent');
    els.boardOverlay.classList.add('solid');

    // Expand board to a usable size (300px) for analysis, centered on original position
    const oldLeft = parseFloat(els.boardOverlay.style.left) || 0;
    const oldTop = parseFloat(els.boardOverlay.style.top) || 0;
    const oldWidth = parseFloat(els.boardOverlay.style.width) || 200;
    const oldHeight = parseFloat(els.boardOverlay.style.height) || 200;

    const newSize = 300;
    const centerX = oldLeft + oldWidth / 2;
    const centerY = oldTop + oldHeight / 2;

    els.boardOverlay.style.left = `${centerX - newSize / 2}px`;
    els.boardOverlay.style.top = `${centerY - newSize / 2}px`;
    els.boardOverlay.style.width = `${newSize}px`;
    els.boardOverlay.style.height = `${newSize}px`;

    // Create full FEN with turn info
    const fullFen = `${position.fen} ${turn} KQkq - 0 1`;

    // Initialize analysis state with tree structure
    if (!state.analyses[posId]) {
        state.analyses[posId] = new AnalysisTree(fullFen, turn);
        markDirty();  // New analysis created
    }

    // Set current node to root
    state.currentNode = state.analyses[posId].root;

    // Initialize chess.js game for move validation
    try {
        analysisGame = new Chess(fullFen);
    } catch (e) {
        console.error('Invalid FEN for chess.js:', e);
        // Try without castling rights
        const simpleFen = `${position.fen} ${turn} - - 0 1`;
        analysisGame = new Chess(simpleFen);
        state.analyses[posId].startFen = simpleFen;
        state.analyses[posId].currentFen = simpleFen;
    }

    // Recreate board with move validation
    if (state.previewBoard) {
        state.previewBoard.destroy();
    }

    state.previewBoard = Chessboard('active-board', {
        position: position.fen,
        draggable: true,
        pieceTheme: '/static/vendor/img/chesspieces/wikipedia/{piece}.png',
        showNotation: true,
        onDragStart: onAnalysisDragStart,
        onDrop: onAnalysisDrop,
        onSnapEnd: onAnalysisSnapEnd,
    });

    // Show analysis panel
    showAnalysis(posId);

    // Mark position as analysed
    const item = document.querySelector(`.position-item[data-id="${posId}"]`);
    if (item) item.classList.add('analysed');

    els.btnCopyPgn.disabled = false;

    status('Analysis mode - make moves on the board');
}

// Analysis move handlers
function onAnalysisDragStart(source, piece, position, orientation) {
    if (!analysisGame) return false;

    // Only allow dragging pieces of the side to move
    if (analysisGame.game_over()) return false;

    const turn = analysisGame.turn();
    if ((turn === 'w' && piece.search(/^b/) !== -1) ||
        (turn === 'b' && piece.search(/^w/) !== -1)) {
        return false;
    }

    return true;
}

function onAnalysisDrop(source, target) {
    if (!analysisGame) return 'snapback';

    // Try to make the move
    const move = analysisGame.move({
        from: source,
        to: target,
        promotion: 'q' // Always promote to queen for simplicity
    });

    // If illegal move, snap back
    if (move === null) return 'snapback';

    // Update analysis tree
    const posId = state.activePositionId;
    const tree = state.analyses[posId];
    if (posId && tree) {
        // Add move to tree (creates variation if not on main line)
        const newNode = tree.makeMove(move.san, analysisGame.fen());
        state.currentNode = newNode;

        // Refresh PGN viewer
        updatePgnViewer(posId);

        // Update engine
        if (state.engineRunning) {
            analyzePosition(analysisGame.fen());
        }

        // Mark for auto-save
        markDirty();
    }

    const depth = state.currentNode ? state.currentNode.getDepth() : 0;
    const hasVars = state.currentNode?.parent?.hasVariations();
    status(`Move ${depth}: ${move.san}${hasVars ? ' (variation)' : ''} - ${analysisGame.turn() === 'w' ? 'White' : 'Black'} to move`);
}

function onAnalysisSnapEnd() {
    if (!analysisGame || !state.previewBoard) return;
    state.previewBoard.position(analysisGame.fen());
}

function updatePgnViewer(posId) {
    const tree = state.analyses[posId];
    if (!tree) return;

    // Render tree as HTML with variations
    const renderTree = (node, moveNum, isWhite, depth) => {
        let html = '';
        const currentPath = state.currentNode?.getPath() || [];

        for (let i = 0; i < node.children.length; i++) {
            const child = node.children[i];
            const isOnPath = currentPath.includes(child);
            const isCurrent = child === state.currentNode;
            const isVariation = i > 0;

            // Start variation in parentheses
            if (isVariation && depth === 0) {
                html += ' <span class="variation">(';
                if (!isWhite) {
                    html += `<span class="move-number">${moveNum}...</span> `;
                }
            }

            // Move number
            if (isWhite && (i === 0 || isVariation)) {
                html += `<span class="move-number">${moveNum}.</span> `;
            }

            // Move
            const moveClass = `move-item${isCurrent ? ' current' : ''}${isOnPath ? ' on-path' : ''}`;
            html += `<span class="${moveClass}" data-node-id="${nodeIdCounter}">${child.san}</span>`;
            nodeMap.set(nodeIdCounter, child);
            nodeIdCounter++;

            // Recurse to children
            const nextIsWhite = !isWhite;
            const nextMoveNum = isWhite ? moveNum : moveNum + 1;
            html += ' ' + renderTree(child, nextMoveNum, nextIsWhite, isVariation ? depth + 1 : depth);

            // End variation
            if (isVariation && depth === 0) {
                html += ')</span>';
            }
        }

        return html;
    };

    // Reset node mapping for click handlers
    nodeMap.clear();
    nodeIdCounter = 0;

    // Determine starting move number from FEN
    const fenParts = tree.startFen.split(' ');
    const startMoveNum = parseInt(fenParts[5] || '1', 10);
    const isWhiteToMove = fenParts[1] === 'w';

    const movesHtml = renderTree(tree.root, startMoveNum, isWhiteToMove, 0);
    els.pgnViewer.innerHTML = `<div class="move-list">${movesHtml || '<em>No moves yet</em>'}</div>`;

    // Add click handlers to moves
    els.pgnViewer.querySelectorAll('.move-item').forEach(el => {
        el.addEventListener('click', () => {
            const nodeId = parseInt(el.dataset.nodeId, 10);
            const node = nodeMap.get(nodeId);
            if (node) goToNode(node);
        });
    });
}

// Node mapping for click handlers
const nodeMap = new Map();
let nodeIdCounter = 0;

function goToNode(node) {
    const posId = state.activePositionId;
    const tree = state.analyses[posId];
    if (!posId || !tree || !node) return;

    state.currentNode = node;
    tree.currentNode = node;

    try {
        analysisGame = new Chess(node.fen);

        // Update board
        if (state.previewBoard) {
            state.previewBoard.position(node.fen);
        }

        // Update PGN viewer
        updatePgnViewer(posId);

        const depth = node.getDepth();
        status(`Move ${depth}${node.san ? ': ' + node.san : ''} - ${analysisGame.turn() === 'w' ? 'White' : 'Black'} to move`);
    } catch (e) {
        console.error('Error going to node:', e);
    }
}

function analyzePosition(fen) {
    if (!state.stockfish) return;

    state.stockfish.postMessage('stop');
    state.stockfish.postMessage(`position fen ${fen}`);
    state.stockfish.postMessage('go depth 20');
}

function showAnalysis(posId) {
    const tree = state.analyses[posId];
    if (!tree) return;

    els.analysisContainer.querySelector('.no-analysis').classList.add('hidden');
    els.pgnViewer.classList.remove('hidden');
    els.enginePanel.classList.remove('hidden');

    // Update PGN viewer with tree
    updatePgnViewer(posId);

    // Start engine if not running
    if (state.stockfish && !state.engineRunning) {
        startEngine();
    }
}

function hideAnalysis() {
    els.analysisContainer.querySelector('.no-analysis').classList.remove('hidden');
    els.pgnViewer.classList.add('hidden');
    els.enginePanel.classList.add('hidden');
    els.pgnViewer.innerHTML = '';
    state.pgnViewer = null;
}

// =============================================================================
// Stockfish Engine
// =============================================================================

function initStockfish() {
    try {
        state.stockfish = new Worker('/static/js/stockfish-worker.js');

        state.stockfish.onmessage = (e) => {
            const line = e.data;

            if (line.startsWith('info') && line.includes('score')) {
                parseEngineInfo(line);
            } else if (line.startsWith('bestmove')) {
                // Engine finished thinking
            }
        };

        // Initialize engine
        state.stockfish.postMessage('uci');
        state.stockfish.postMessage('isready');

        console.log('Stockfish initialized');
    } catch (e) {
        console.error('Could not initialize Stockfish:', e);
    }
}

function startEngine() {
    if (!state.stockfish) return;

    state.engineRunning = true;
    els.btnToggleEngine.textContent = '⏹ Stop';

    const posId = state.activePositionId;
    const analysis = state.analyses[posId];
    const fen = analysis ? analysis.currentFen : null;

    if (fen) {
        state.stockfish.postMessage(`position fen ${fen}`);
        state.stockfish.postMessage('go infinite');
    }
}

function stopEngine() {
    if (!state.stockfish) return;

    state.stockfish.postMessage('stop');
    state.engineRunning = false;
    els.btnToggleEngine.textContent = '▶ Start';
}

function toggleEngine() {
    if (state.engineRunning) {
        stopEngine();
    } else {
        startEngine();
    }
}

function parseEngineInfo(line) {
    // Parse score
    const scoreMatch = line.match(/score (cp|mate) (-?\d+)/);
    if (scoreMatch) {
        const type = scoreMatch[1];
        const value = parseInt(scoreMatch[2]);

        if (type === 'cp') {
            const eval_ = (value / 100).toFixed(2);
            els.engineEval.textContent = value >= 0 ? `+${eval_}` : eval_;
        } else {
            els.engineEval.textContent = value >= 0 ? `M${value}` : `-M${Math.abs(value)}`;
        }
    }

    // Parse PV (principal variation)
    const pvMatch = line.match(/pv (.+)/);
    if (pvMatch) {
        els.engineLine.textContent = pvMatch[1].split(' ').slice(0, 8).join(' ');
    }
}

// =============================================================================
// Piece Palettes
// =============================================================================

function setupPiecePalettes() {
    const blackPieces = ['bK', 'bQ', 'bR', 'bB', 'bN', 'bP'];
    const whitePieces = ['wK', 'wQ', 'wR', 'wB', 'wN', 'wP'];
    const pieceTheme = '/static/vendor/img/chesspieces/wikipedia/{piece}.png';

    function createPieceImg(piece) {
        const img = document.createElement('img');
        img.src = pieceTheme.replace('{piece}', piece);
        img.draggable = true;
        img.dataset.piece = piece;
        img.className = 'palette-piece';

        // Drag support
        img.addEventListener('dragstart', (e) => {
            e.dataTransfer.setData('piece', piece);
            e.dataTransfer.effectAllowed = 'copy';
        });

        // Click to select for click-to-place
        img.addEventListener('click', () => {
            // Deselect all pieces first
            document.querySelectorAll('.palette-piece.selected').forEach(el => {
                el.classList.remove('selected');
            });

            if (state.selectedPiece === piece) {
                // Clicking same piece deselects
                state.selectedPiece = null;
                status('Piece deselected');
            } else {
                state.selectedPiece = piece;
                img.classList.add('selected');
                status(`Selected ${piece} - click on board to place, or click piece again to deselect`);
            }
        });

        return img;
    }

    blackPieces.forEach(piece => {
        els.paletteBlack.appendChild(createPieceImg(piece));
    });

    whitePieces.forEach(piece => {
        els.paletteWhite.appendChild(createPieceImg(piece));
    });

    // Setup drop handling on the board overlay for pieces from palettes
    setupBoardDropHandling();
}

function setupBoardDropHandling() {
    const boardOverlay = els.boardOverlay;

    // Allow dropping on the board overlay
    boardOverlay.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
    });

    // Handle drop from palette
    boardOverlay.addEventListener('drop', (e) => {
        e.preventDefault();
        const piece = e.dataTransfer.getData('piece');
        if (!piece || !state.previewBoard) return;

        // Don't allow during analysis mode
        if (state.analyses[state.activePositionId] && state.currentNode) {
            status('Cannot edit board during analysis - start fresh analysis first');
            return;
        }

        const square = getSquareFromEvent(e);
        if (!square) return;

        placePieceOnSquare(piece, square);
    });

    // Handle click-to-place
    boardOverlay.addEventListener('click', (e) => {
        // Only handle if a piece is selected
        if (!state.selectedPiece || !state.previewBoard) return;

        // Don't allow during analysis mode
        if (state.analyses[state.activePositionId] && state.currentNode) {
            status('Cannot edit board during analysis');
            return;
        }

        const square = getSquareFromEvent(e);
        if (!square) return;

        placePieceOnSquare(state.selectedPiece, square);

        // Deselect piece after placing
        state.selectedPiece = null;
        document.querySelectorAll('.palette-piece.selected').forEach(el => {
            el.classList.remove('selected');
        });
    });

    // Handle right-click to remove pieces
    boardOverlay.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        if (!state.previewBoard) return;

        // Don't allow during analysis mode
        if (state.analyses[state.activePositionId] && state.currentNode) {
            status('Cannot edit board during analysis');
            return;
        }

        const square = getSquareFromEvent(e);
        if (!square) return;

        removePieceFromSquare(square);
    });
}

function getSquareFromEvent(e) {
    const boardEl = document.getElementById('active-board');
    if (!boardEl) return null;

    const rect = boardEl.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    // Ensure within the board
    if (x < 0 || y < 0 || x > rect.width || y > rect.height) return null;

    const squareSize = rect.width / 8;
    const file = Math.floor(x / squareSize);
    const rank = 7 - Math.floor(y / squareSize);

    if (file < 0 || file > 7 || rank < 0 || rank > 7) return null;

    const files = 'abcdefgh';
    return files[file] + (rank + 1);
}

function placePieceOnSquare(piece, square) {
    if (!state.previewBoard) return;

    // Get current position and add/update the piece
    const currentPos = state.previewBoard.position();
    currentPos[square] = piece;
    state.previewBoard.position(currentPos, false);

    // Keep squares transparent
    setTimeout(hideSquares, 50);

    // Update position's FEN
    updateCurrentPositionFen();

    status(`Placed ${piece} on ${square}`);
}

function removePieceFromSquare(square) {
    if (!state.previewBoard) return;

    // Get current position
    const currentPos = state.previewBoard.position();

    // Check if there's a piece on this square
    if (!currentPos[square]) {
        status(`No piece on ${square}`);
        return;
    }

    const piece = currentPos[square];
    delete currentPos[square];
    state.previewBoard.position(currentPos, false);

    // Keep squares transparent
    setTimeout(hideSquares, 50);

    // Update position's FEN
    updateCurrentPositionFen();

    status(`Removed ${piece} from ${square}`);
}

// =============================================================================
// Board Display Helpers
// =============================================================================

function hideSquares() {
    // Don't hide squares in analysis mode - we want to see the actual board
    if (els.boardOverlay.classList.contains('solid')) {
        return;
    }

    // Make chessboard.js squares transparent to show only pieces
    // This allows the board overlay to show the PDF diagram underneath
    document.querySelectorAll('#active-board [class*="square-"]').forEach(sq => {
        sq.style.background = 'transparent';
        sq.style.backgroundColor = 'transparent';
    });
}

// =============================================================================
// Clipboard
// =============================================================================

function copyFen() {
    // Use current node's FEN if in analysis, otherwise use position's FEN
    let fen;
    if (state.currentNode) {
        fen = state.currentNode.fen;
    } else {
        const position = state.positions.find(p => p.id === state.activePositionId);
        if (!position) return;
        fen = position.fen;
    }

    navigator.clipboard.writeText(fen).then(() => {
        status('FEN copied to clipboard');
    });
}

function copyPgn() {
    const tree = state.analyses[state.activePositionId];
    if (!tree) return;

    const pgn = tree.toPGN();

    navigator.clipboard.writeText(pgn).then(() => {
        status('PGN copied to clipboard');
    });
}

// =============================================================================
// Study Persistence
// =============================================================================

// Mark study as dirty (needs saving)
function markDirty() {
    state.isDirty = true;

    // Debounced auto-save after 2 seconds of no changes
    if (state.saveTimer) {
        clearTimeout(state.saveTimer);
    }
    state.saveTimer = setTimeout(saveStudy, 2000);
}

// Save study to server
async function saveStudy() {
    if (!state.pdfId || !state.isDirty) return;

    // Build study data from state
    const study = {
        positions: state.positions.map(p => ({
            id: p.id,
            page: p.page,
            bbox: p.bbox,
            fen: p.fen,
        })),
        analyses: {},
    };

    // Serialize analysis trees
    for (const [posId, tree] of Object.entries(state.analyses)) {
        if (tree instanceof AnalysisTree) {
            study.analyses[posId] = tree.toJSON();
        }
    }

    try {
        const response = await fetch('/api/save-study', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                pdf_id: state.pdfId,
                study: study
            })
        });

        if (response.ok) {
            state.isDirty = false;
            console.log('[Reader] Study saved');
        }
    } catch (e) {
        console.error('Failed to save study:', e);
    }
}

// Load study from server
async function loadStudy() {
    if (!state.pdfId) return false;

    try {
        const response = await fetch(`/api/load-study/${state.pdfId}`);
        if (!response.ok) return false;

        const data = await response.json();
        if (!data.exists || !data.study) return false;

        const study = data.study;

        // Restore positions
        if (study.positions) {
            state.positions = study.positions;
            updatePositionList();
        }

        // Restore analysis trees
        if (study.analyses) {
            for (const [posId, treeData] of Object.entries(study.analyses)) {
                state.analyses[posId] = AnalysisTree.fromJSON(treeData);
            }
        }

        console.log(`[Reader] Loaded study with ${state.positions.length} positions`);
        return true;
    } catch (e) {
        console.error('Failed to load study:', e);
        return false;
    }
}

// Save before unload
window.addEventListener('beforeunload', (e) => {
    if (state.isDirty) {
        saveStudy();
        // Note: Modern browsers may not show custom messages
        e.preventDefault();
        e.returnValue = '';
    }
});

// =============================================================================
// Utility
// =============================================================================

function status(msg) {
    els.statusBar.textContent = msg;
    console.log('[Reader]', msg);
}
