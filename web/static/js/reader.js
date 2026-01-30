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

    // Detected games: { id, page, bbox, fen, thumbnail }
    games: [],

    // Active game
    activeGameId: null,

    // Analysis state per game: { gameId: AnalysisTree }
    analyses: {},

    // Continuation links: posId → { analysisId, nodePath: [san, san, ...] }
    // Links a position to a node in another position's analysis tree
    continuations: {},

    // Pending continuation candidate (shown in prompt)
    pendingContinuation: null,

    // Workflow state for UX steps
    pendingGameId: null,
    pendingTargetFen: null,
    pendingCandidates: [],
    selectedCandidateId: null,
    pendingBaseGameId: null,
    reachMode: null, // 'manual' | 'otb'
    otbMonitorInterval: null,

    // Reach Position Modal state (page-switch resilient)
    reachSession: null, // { targetFen, startFen, startNode, baseAnalysisId, gameId, moves, game, turn }

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
    textOverlay: document.getElementById('text-overlay'),
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
    btnSelectText: document.getElementById('btn-select-text'),
    statusBar: document.getElementById('status-bar'),
    paletteBlack: document.getElementById('piece-palette-black'),
    paletteWhite: document.getElementById('piece-palette-white'),
    // Workflow panels
    workflowPanel: document.getElementById('workflow-panel'),
    confirmPanel: document.getElementById('confirm-panel'),
    btnConfirmPieces: document.getElementById('btn-confirm-pieces'),
    btnEditPieces: document.getElementById('btn-edit-pieces'),
    gameMatchPanel: document.getElementById('game-match-panel'),
    gameMatchList: document.getElementById('game-match-list'),
    btnContinueGame: document.getElementById('btn-continue-game'),
    btnNewGame: document.getElementById('btn-new-game'),
    reachPanel: document.getElementById('reach-panel'),
    btnReachOtb: document.getElementById('btn-reach-otb'),
    btnReachOcr: document.getElementById('btn-reach-ocr'),
    otbPanel: document.getElementById('otb-panel'),
    otbStatus: document.getElementById('otb-status'),
    btnStopOtb: document.getElementById('btn-stop-otb'),
    ocrPanel: document.getElementById('ocr-panel'),
    btnStartTextSelect: document.getElementById('btn-start-text-select'),
    ocrStatus: document.getElementById('ocr-status'),
    // Continuation prompt elements
    continuationPrompt: document.getElementById('continuation-prompt'),
    continuationInfo: document.getElementById('continuation-info'),
    btnAcceptContinuation: document.getElementById('btn-accept-continuation'),
    btnDismissContinuation: document.getElementById('btn-dismiss-continuation'),
    // Opening moves input elements
    openingInputPanel: document.getElementById('opening-input-panel'),
    openingMovesInput: document.getElementById('opening-moves-input'),
    btnSetOpening: document.getElementById('btn-set-opening'),
    btnApplyOpening: document.getElementById('btn-apply-opening'),
    btnCancelOpening: document.getElementById('btn-cancel-opening'),
    // Reach Position Modal elements
    reachModal: document.getElementById('reach-modal'),
    reachModalClose: document.getElementById('reach-modal-close'),
    reachStartBoard: document.getElementById('reach-start-board'),
    reachEntryBoard: document.getElementById('reach-entry-board'),
    reachTargetBoard: document.getElementById('reach-target-board'),
    reachStartLabel: document.getElementById('reach-start-label'),
    reachMoveList: document.getElementById('reach-move-list'),
    reachStatus: document.getElementById('reach-status'),
    reachIndicator: document.getElementById('reach-indicator'),
    reachBtnUndo: document.getElementById('reach-btn-undo'),
    reachBtnReset: document.getElementById('reach-btn-reset'),
    reachBtnDone: document.getElementById('reach-btn-done'),
    reachBtnCancel: document.getElementById('reach-btn-cancel'),
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
// Continuation Helpers
// =============================================================================

/**
 * Get the analysis context for a position, following continuation links if needed.
 * Returns { tree, node, isLinked, analysisId } or null if no analysis exists.
 */
function getAnalysisContext(posId) {
    // Check for direct analysis
    if (state.analyses[posId]) {
        return {
            tree: state.analyses[posId],
            node: state.analyses[posId].currentNode,
            isLinked: false,
            analysisId: posId,
        };
    }

    // Check for continuation link
    const link = state.continuations[posId];
    if (link && state.analyses[link.analysisId]) {
        const tree = state.analyses[link.analysisId];
        const node = resolveNodePath(tree.root, link.nodePath);
        if (node) {
            return {
                tree,
                node,
                isLinked: true,
                analysisId: link.analysisId,
            };
        }
    }

    return null;
}

/**
 * Resolve a node path (array of SAN moves) to a MoveNode in the tree.
 */
function resolveNodePath(root, nodePath) {
    if (!nodePath || nodePath.length === 0) return root;

    let current = root;
    for (const san of nodePath) {
        const child = current.children.find(c => c.san === san);
        if (!child) return null;
        current = child;
    }
    return current;
}

/**
 * Get the path (array of SAN moves) from root to a node.
 */
function getNodePath(node) {
    const path = [];
    let current = node;
    while (current && current.parent) {
        path.unshift(current.san);
        current = current.parent;
    }
    return path;
}

/**
 * Convert FEN piece placement to a normalized map (square -> piece).
 */
function fenToPlacementMap(fen) {
    const placement = fen.split(' ')[0];
    const map = {};
    const ranks = placement.split('/');
    const files = 'abcdefgh';

    for (let r = 0; r < 8; r++) {
        const rank = 8 - r;
        let file = 0;
        for (const char of ranks[r]) {
            if (char >= '1' && char <= '8') {
                file += parseInt(char, 10);
            } else {
                const square = files[file] + rank;
                map[square] = char;
                file++;
            }
        }
    }
    return map;
}

/**
 * Compare two placement maps for equality.
 */
function placementsEqual(map1, map2) {
    const keys1 = Object.keys(map1).sort();
    const keys2 = Object.keys(map2).sort();
    if (keys1.length !== keys2.length) return false;
    for (let i = 0; i < keys1.length; i++) {
        if (keys1[i] !== keys2[i]) return false;
        if (map1[keys1[i]] !== map2[keys2[i]]) return false;
    }
    return true;
}

/**
 * Check if a position has any analysis (direct or linked).
 */
function hasAnalysis(posId) {
    return state.analyses[posId] || state.continuations[posId];
}

/**
 * Search all analysis trees for a node with the given FEN (piece placement).
 * Returns { analysisId, node, sourcePage } or null if not found.
 */
function findFenInAllAnalyses(targetFen) {
    const targetPlacement = fenToPlacementMap(targetFen);

    for (const [posId, tree] of Object.entries(state.analyses)) {
        const matchNode = findNodeByPlacement(tree.root, targetPlacement);
        if (matchNode) {
            const sourcePos = state.games.find(p => p.id === posId);
            return {
                analysisId: posId,
                node: matchNode,
                sourcePage: sourcePos?.page || 0,
            };
        }
    }
    return null;
}

/**
 * Sort games by page order (page, then bbox.y, then bbox.x).
 * Returns a new sorted array.
 */
function sortGamesByPageOrder(games) {
    return [...games].sort((a, b) => {
        if (a.page !== b.page) return a.page - b.page;
        if (a.bbox.y !== b.bbox.y) return a.bbox.y - b.bbox.y;
        return a.bbox.x - b.bbox.x;
    });
}

/**
 * Find the nearest earlier position with an analysis tree.
 * Searches backward from the given position in page order.
 */
function findPreviousAnalysisPosition(posId) {
    const sorted = sortGamesByPageOrder(state.games);
    const idx = sorted.findIndex(p => p.id === posId);
    if (idx <= 0) return null;

    // Search backward for a position with direct analysis
    for (let i = idx - 1; i >= 0; i--) {
        if (state.analyses[sorted[i].id]) {
            return sorted[i];
        }
    }
    return null;
}

/**
 * Search a tree for a node matching the target placement.
 * Uses BFS, returns the first matching node or null.
 */
function findNodeByPlacement(root, targetPlacement) {
    // #region agent log
    fetch('http://127.0.0.1:7249/ingest/42c8e2b2-2791-4085-836e-044c16902ae2', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ location: 'reader.js:findNodeByPlacement:entry', message: 'findNodeByPlacement entry', data: { rootFen: root?.fen }, timestamp: Date.now(), sessionId: 'debug-session', hypothesisId: 'H1a' }) }).catch(() => { });
    // #endregion
    const queue = [root];
    let iterations = 0;
    while (queue.length > 0) {
        iterations++;
        if (iterations > 1000) {
            // #region agent log
            fetch('http://127.0.0.1:7249/ingest/42c8e2b2-2791-4085-836e-044c16902ae2', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ location: 'reader.js:findNodeByPlacement:tooManyIterations', message: 'BFS exceeded 1000 iterations', data: { iterations, queueLen: queue.length }, timestamp: Date.now(), sessionId: 'debug-session', hypothesisId: 'H1a' }) }).catch(() => { });
            // #endregion
            return null; // Safety break
        }
        const node = queue.shift();
        const nodePlacement = fenToPlacementMap(node.fen);
        if (placementsEqual(nodePlacement, targetPlacement)) {
            // #region agent log
            fetch('http://127.0.0.1:7249/ingest/42c8e2b2-2791-4085-836e-044c16902ae2', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ location: 'reader.js:findNodeByPlacement:found', message: 'Found matching node', data: { iterations }, timestamp: Date.now(), sessionId: 'debug-session', hypothesisId: 'H1a' }) }).catch(() => { });
            // #endregion
            return node;
        }
        queue.push(...node.children);
    }
    // #region agent log
    fetch('http://127.0.0.1:7249/ingest/42c8e2b2-2791-4085-836e-044c16902ae2', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ location: 'reader.js:findNodeByPlacement:notFound', message: 'No match found', data: { iterations }, timestamp: Date.now(), sessionId: 'debug-session', hypothesisId: 'H1a' }) }).catch(() => { });
    // #endregion
    return null;
}

/**
 * This function is DISABLED - BFS move generation is too expensive for real chess.
 * Positions in books can be 20+ moves apart, making BFS impractical.
 * Instead, we only check if the target position already exists in the analysis tree.
 */
function findMoveSequenceToPlacement(tree, startNode, targetPlacement, maxDepth = 6) {
    // #region agent log
    fetch('http://127.0.0.1:7249/ingest/42c8e2b2-2791-4085-836e-044c16902ae2', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ location: 'reader.js:findMoveSequence:disabled', message: 'BFS disabled - too expensive', data: {}, timestamp: Date.now(), sessionId: 'debug-session', hypothesisId: 'H1b' }) }).catch(() => { });
    // #endregion
    // BFS is disabled - return null immediately
    // Continuation detection now relies solely on findNodeByPlacement
    return null;
}

/**
 * Attempt to detect a continuation from the current position to a previous analysis.
 * Returns { prevPos, tree, matchNode, moveSequence } or null if no continuation found.
 */
/**
 * Detect continuation is now handled earlier via findFenInAllAnalyses.
 * This function is kept for backwards compatibility but just returns null.
 * The main FEN matching logic is in handleDiagramClick.
 */
function detectContinuation(posId, targetFen) {
    // #region agent log
    fetch('http://127.0.0.1:7249/ingest/42c8e2b2-2791-4085-836e-044c16902ae2', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ location: 'reader.js:detectContinuation:deprecated', message: 'detectContinuation deprecated - FEN matching done earlier', data: { posId }, timestamp: Date.now(), sessionId: 'debug-session', hypothesisId: 'H1' }) }).catch(() => { });
    // #endregion
    // Continuation detection is now handled in handleDiagramClick via findFenInAllAnalyses
    return null;
}

/**
 * Apply a continuation by inserting moves into the tree and creating a link.
 */
function applyContinuation(posId, continuation) {
    const { tree, matchNode, moveSequence } = continuation;

    // Navigate to the match node
    tree.currentNode = matchNode;

    // Insert moves into the tree
    let currentNode = matchNode;
    try {
        const game = new Chess(matchNode.fen);

        for (const san of moveSequence) {
            const move = game.move(san);
            if (!move) {
                console.error(`Invalid move in continuation: ${san}`);
                break;
            }
            currentNode = tree.makeMove(san, game.fen());
        }
    } catch (e) {
        console.error('Error applying continuation moves:', e);
    }

    // Create the continuation link
    const nodePath = getNodePath(currentNode);
    state.continuations[posId] = {
        analysisId: continuation.prevPos.id,
        nodePath,
    };

    markDirty();

    return currentNode;
}

/**
 * Show the continuation prompt with candidate info.
 * @param {Object} analysisMatch - { analysisId, node, sourcePage }
 */
function showContinuationPrompt(analysisMatch) {
    // #region agent log
    fetch('http://127.0.0.1:7249/ingest/42c8e2b2-2791-4085-836e-044c16902ae2', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ location: 'reader.js:showContinuationPrompt:entry', message: 'showContinuationPrompt entry', data: { hasContinuationInfo: !!els.continuationInfo, hasContinuationPrompt: !!els.continuationPrompt, sourcePage: analysisMatch?.sourcePage }, timestamp: Date.now(), sessionId: 'debug-session', hypothesisId: 'H3' }) }).catch(() => { });
    // #endregion

    if (!els.continuationInfo || !els.continuationPrompt) {
        // #region agent log
        fetch('http://127.0.0.1:7249/ingest/42c8e2b2-2791-4085-836e-044c16902ae2', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ location: 'reader.js:showContinuationPrompt:nullEls', message: 'Continuation DOM elements are null!', data: { continuationInfo: !!els.continuationInfo, continuationPrompt: !!els.continuationPrompt }, timestamp: Date.now(), sessionId: 'debug-session', hypothesisId: 'H3' }) }).catch(() => { });
        // #endregion
        console.error('[Reader] Continuation DOM elements not found');
        return;
    }

    const { sourcePage, node } = analysisMatch;

    // Build description of where the position exists
    let infoHtml = `<strong>Page ${sourcePage}</strong>`;
    if (node && node.san) {
        infoHtml += ` at move <code>${node.san}</code>`;
    }
    infoHtml += `<br><span class="hint">Link this diagram to that analysis?</span>`;

    els.continuationInfo.innerHTML = infoHtml;
    els.continuationPrompt.classList.remove('hidden');

    // #region agent log
    fetch('http://127.0.0.1:7249/ingest/42c8e2b2-2791-4085-836e-044c16902ae2', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ location: 'reader.js:showContinuationPrompt:shown', message: 'Continuation prompt shown', data: { infoHtml }, timestamp: Date.now(), sessionId: 'debug-session', hypothesisId: 'H3' }) }).catch(() => { });
    // #endregion
}

/**
 * Hide the continuation prompt.
 */
function hideContinuationPrompt() {
    state.pendingContinuation = null;
    els.continuationPrompt.classList.add('hidden');
}

/**
 * Accept the pending continuation and link the position.
 */
function acceptContinuation() {
    const pending = state.pendingContinuation;
    if (!pending || !pending.posId || !pending.analysisMatch) {
        // #region agent log
        fetch('http://127.0.0.1:7249/ingest/42c8e2b2-2791-4085-836e-044c16902ae2', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ location: 'reader.js:acceptContinuation:noPending', message: 'No pending continuation', data: {}, timestamp: Date.now(), sessionId: 'debug-session', hypothesisId: 'H7' }) }).catch(() => { });
        // #endregion
        return;
    }

    const { posId, analysisMatch } = pending;
    const { analysisId, node, sourcePage } = analysisMatch;
    const tree = state.analyses[analysisId];

    if (!tree) {
        console.error('[Reader] Analysis tree not found:', analysisId);
        hideContinuationPrompt();
        return;
    }

    // #region agent log
    fetch('http://127.0.0.1:7249/ingest/42c8e2b2-2791-4085-836e-044c16902ae2', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ location: 'reader.js:acceptContinuation:linking', message: 'Linking position to analysis', data: { posId, analysisId, sourcePage }, timestamp: Date.now(), sessionId: 'debug-session', hypothesisId: 'H7' }) }).catch(() => { });
    // #endregion

    // Create the continuation link
    const nodePath = getNodePath(node);
    state.continuations[posId] = {
        analysisId,
        nodePath,
    };

    // Set up the analysis state to use the linked tree
    const position = state.games.find(p => p.id === posId);
    if (position) {
        // Determine turn from the node's FEN
        const fenParts = node.fen.split(' ');
        const turn = fenParts[1] || 'w';

        // Set up analysis game from the node
        try {
            analysisGame = new Chess(node.fen);
        } catch (e) {
            console.error('Error setting up analysis game:', e);
        }

        // Update state
        state.currentNode = node;
        tree.currentNode = node;

        // Switch to analysis mode UI
        enterAnalysisModeUI(posId, tree, turn);

        status(`Linked to analysis from Page ${sourcePage}`);
    }

    hideContinuationPrompt();
    updatePositionList();
    markDirty();
}

/**
 * Dismiss the continuation prompt and allow starting fresh analysis.
 */
function dismissContinuation() {
    hideContinuationPrompt();
    state.pendingContinuation = null;
    status('Ready for fresh analysis - click Play as White/Black');
}

// =============================================================================
// Workflow: Confirm -> Match Game -> Reach Position
// =============================================================================

function resetWorkflowPanels() {
    if (els.confirmPanel) els.confirmPanel.classList.add('hidden');
    if (els.gameMatchPanel) els.gameMatchPanel.classList.add('hidden');
    if (els.reachPanel) els.reachPanel.classList.add('hidden');
    if (els.otbPanel) els.otbPanel.classList.add('hidden');
    if (els.ocrPanel) els.ocrPanel.classList.add('hidden');
}

function showConfirmPanel() {
    resetWorkflowPanels();
    if (els.confirmPanel) {
        els.confirmPanel.classList.remove('hidden');
    }
    // Ensure board is transparent so user can see PDF diagram underneath
    els.boardOverlay.classList.add('transparent');
    els.boardOverlay.classList.remove('solid');
    setTimeout(hideSquares, 50);
}

function confirmPieces() {
    if (!state.pendingGameId || !state.pendingTargetFen) {
        status('No pending game to confirm');
        return;
    }

    if (state.previewBoard) {
        const updatedFen = Chessboard.objToFen(state.previewBoard.position());
        const pendingGame = state.games.find(g => g.id === state.pendingGameId);
        if (pendingGame) {
            pendingGame.fen = updatedFen;
        }
        state.pendingTargetFen = updatedFen;
        updatePositionList();
    }

    const analyzedGames = state.games.filter(g => state.analyses[g.id]);
    state.pendingCandidates = analyzedGames;
    state.selectedCandidateId = analyzedGames.length > 0 ? analyzedGames[0].id : null;

    renderGameMatchList(analyzedGames);
    if (els.gameMatchPanel) {
        els.gameMatchPanel.classList.remove('hidden');
    }
    if (els.confirmPanel) {
        els.confirmPanel.classList.add('hidden');
    }
}

function startEditPieces() {
    status('Edit pieces using the palette, then confirm');
}

function renderGameMatchList(games) {
    if (!els.gameMatchList) return;
    els.gameMatchList.innerHTML = '';

    if (games.length === 0) {
        els.gameMatchList.innerHTML = '<div class="workflow-text">No analyzed games found.</div>';
        if (els.btnContinueGame) els.btnContinueGame.disabled = true;
        return;
    }

    if (els.btnContinueGame) els.btnContinueGame.disabled = false;

    games.forEach(game => {
        const item = document.createElement('div');
        item.className = 'game-match-item';
        if (state.selectedCandidateId === game.id) {
            item.classList.add('selected');
        }
        item.textContent = `Game from Page ${game.page}`;
        item.addEventListener('click', () => {
            state.selectedCandidateId = game.id;
            renderGameMatchList(games);
        });
        els.gameMatchList.appendChild(item);
    });
}

function finalizePendingGame() {
    if (!state.pendingGameId) return;
    const game = state.games.find(g => g.id === state.pendingGameId);
    if (!game) return;
    game.pending = false;
    updatePositionList();
    markDirty();
}

function continueFromSelectedGame() {
    if (!state.pendingGameId) return;
    if (!state.selectedCandidateId) {
        status('No game selected');
        return;
    }

    state.pendingBaseGameId = state.selectedCandidateId;
    finalizePendingGame();
    showReachPanel();
}

function startNewGameFlow() {
    if (!state.pendingGameId) return;
    state.pendingBaseGameId = null;
    finalizePendingGame();
    showReachPanel();
}

function showReachPanel() {
    // Instead of showing the old panel, open the new modal
    showReachModal();
}

/**
 * Open the Reach Position modal with the current workflow state.
 */
function showReachModal() {
    if (!state.pendingTargetFen || !state.pendingGameId) {
        status('No target position to reach');
        return;
    }

    // Determine starting position
    let startFen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR'; // Default start
    let baseAnalysisId = null;

    if (state.pendingBaseGameId && state.analyses[state.pendingBaseGameId]) {
        // Continue from an existing game's main line
        const tree = state.analyses[state.pendingBaseGameId];
        const leafNode = getMainLineLeaf(tree);
        startFen = leafNode.fen.split(' ')[0]; // Piece placement only
        baseAnalysisId = state.pendingBaseGameId;
    }

    // Hide old workflow panels
    resetWorkflowPanels();

    // Open the new modal
    openReachModal(state.pendingTargetFen, startFen, baseAnalysisId, state.pendingGameId);
}

// =============================================================================
// Step 2: OTB Monitoring
// =============================================================================

function getMainLineLeaf(tree) {
    let node = tree.root;
    while (node.children.length > 0) {
        node = node.children[0];
    }
    return node;
}

function startOtbMonitoring() {
    state.reachMode = 'otb';
    if (els.reachPanel) els.reachPanel.classList.add('hidden');
    if (els.otbPanel) els.otbPanel.classList.remove('hidden');
    if (els.otbStatus) els.otbStatus.textContent = 'Waiting for board...';

    if (state.otbMonitorInterval) {
        clearInterval(state.otbMonitorInterval);
    }

    state.otbMonitorInterval = setInterval(async () => {
        try {
            const response = await fetch('/api/board/fen');
            if (!response.ok) return;
            const data = await response.json();
            if (!data.fen) return;

            handleOtbFenUpdate(data.fen);
        } catch (e) {
            // ignore polling errors
        }
    }, 1000);
}

function stopOtbMonitoring() {
    if (state.otbMonitorInterval) {
        clearInterval(state.otbMonitorInterval);
        state.otbMonitorInterval = null;
    }
    state.otbState = null;
    if (els.otbPanel) els.otbPanel.classList.add('hidden');
    if (els.reachPanel) els.reachPanel.classList.remove('hidden');
    status('OTB monitoring stopped');
}

function handleOtbFenUpdate(newFen) {
    const targetFen = state.pendingTargetFen;
    if (!targetFen) return;

    if (!state.otbState) {
        const baseFen = getWorkflowBaseFen();
        state.otbState = {
            lastFen: baseFen,
            moves: [],
        };
    }

    if (newFen === state.otbState.lastFen) return;

    const prevGame = new Chess(state.otbState.lastFen);
    const legalMoves = prevGame.moves({ verbose: true });
    let foundMove = null;

    for (const move of legalMoves) {
        prevGame.move(move);
        if (placementsEqual(fenToPlacementMap(prevGame.fen()), fenToPlacementMap(newFen))) {
            foundMove = move.san;
            break;
        }
        prevGame.undo();
    }

    if (foundMove) {
        state.otbState.moves.push(foundMove);
        state.otbState.lastFen = newFen;
        if (els.otbStatus) {
            els.otbStatus.textContent = `Moves: ${state.otbState.moves.join(' ')}`;
        }
    }

    if (placementsEqual(fenToPlacementMap(newFen), fenToPlacementMap(targetFen))) {
        finalizeMovesToTarget(state.otbState.moves, newFen);
        stopOtbMonitoring();
        state.otbState = null;
    }
}

// =============================================================================
// Reach Position Modal (page-switch resilient)
// =============================================================================

// Board instances for the modal (separate from main preview board)
let reachStartBoardInstance = null;
let reachEntryBoardInstance = null;
let reachTargetBoardInstance = null;
let reachGame = null; // Chess.js instance for move validation

/**
 * Open the Reach Position modal.
 * @param {string} targetFen - The FEN position we want to reach (piece placement only)
 * @param {string} startFen - The FEN position we're starting from
 * @param {string|null} baseAnalysisId - ID of existing analysis to continue from
 * @param {string} gameId - The pending game ID
 */
function openReachModal(targetFen, startFen, baseAnalysisId, gameId) {
    // Preserve turn if it was already set (from handleAnalyseClick)
    const existingTurn = state.reachSession?.turn;

    // Initialize session state
    state.reachSession = {
        targetFen,
        startFen,
        baseAnalysisId,
        gameId,
        moves: [],
        mode: null, // 'manual' | 'otb'
        turn: existingTurn || 'w', // Default to white if not specified
    };

    // Initialize boards (destroy old ones first)
    destroyReachBoards();

    // Build full FEN for chess.js (assume white to move, full castling)
    const fullStartFen = `${startFen} w KQkq - 0 1`;
    reachGame = new Chess(fullStartFen);

    reachStartBoardInstance = Chessboard('reach-start-board', {
        position: startFen,
        draggable: false,
        showNotation: false,
        pieceTheme: '/static/vendor/img/chesspieces/wikipedia/{piece}.png',
    });

    reachEntryBoardInstance = Chessboard('reach-entry-board', {
        position: startFen,
        draggable: true,
        showNotation: true,
        pieceTheme: '/static/vendor/img/chesspieces/wikipedia/{piece}.png',
        onDragStart: onReachDragStart,
        onDrop: onReachDrop,
        onSnapEnd: onReachSnapEnd,
    });

    reachTargetBoardInstance = Chessboard('reach-target-board', {
        position: targetFen,
        draggable: false,
        showNotation: false,
        pieceTheme: '/static/vendor/img/chesspieces/wikipedia/{piece}.png',
    });

    // Update labels
    if (els.reachStartLabel) {
        els.reachStartLabel.textContent = baseAnalysisId ? 'Continue from game' : 'Starting position';
    }

    // Reset UI
    updateReachMoveList();
    updateReachIndicator();
    if (els.reachBtnUndo) els.reachBtnUndo.disabled = true;
    if (els.reachBtnDone) els.reachBtnDone.disabled = true;

    // Show modal
    els.reachModal.classList.remove('hidden');

    // Resize boards after modal is visible
    setTimeout(() => {
        if (reachStartBoardInstance) reachStartBoardInstance.resize();
        if (reachEntryBoardInstance) reachEntryBoardInstance.resize();
        if (reachTargetBoardInstance) reachTargetBoardInstance.resize();
    }, 50);

    // Start automatic board sync (opportunistic - no user action needed)
    startReachBoardSync();

    status('Enter moves to reach the target position');
}

function closeReachModal() {
    els.reachModal.classList.add('hidden');
    destroyReachBoards();
    stopReachBoardSync();
    state.reachSession = null;
}

function destroyReachBoards() {
    if (reachStartBoardInstance) {
        reachStartBoardInstance.destroy();
        reachStartBoardInstance = null;
    }
    if (reachEntryBoardInstance) {
        reachEntryBoardInstance.destroy();
        reachEntryBoardInstance = null;
    }
    if (reachTargetBoardInstance) {
        reachTargetBoardInstance.destroy();
        reachTargetBoardInstance = null;
    }
    reachGame = null;
}

// Automatic bidirectional board sync - no user mode selection needed
let lastSyncedBoardFen = null;

function startReachBoardSync() {
    stopReachBoardSync();

    // Sync physical board to current position
    if (reachGame) {
        syncToBoard(reachGame.fen().split(' ')[0]);
        lastSyncedBoardFen = reachGame.fen().split(' ')[0];
    }

    // Poll physical board for changes
    state.otbMonitorInterval = setInterval(async () => {
        try {
            const response = await fetch('/api/board/fen');
            if (!response.ok) return;
            const data = await response.json();
            if (!data.fen) return;

            const boardFen = data.fen.split(' ')[0];
            if (boardFen === lastSyncedBoardFen) return;

            // Physical board changed - try to match a legal move
            handlePhysicalBoardUpdate(boardFen);
        } catch (e) {
            // Ignore polling errors - board might not be connected
        }
    }, 500);
}

function stopReachBoardSync() {
    if (state.otbMonitorInterval) {
        clearInterval(state.otbMonitorInterval);
        state.otbMonitorInterval = null;
    }
}

function handlePhysicalBoardUpdate(newFen) {
    if (!reachGame || !state.reachSession) return;

    // Try all legal moves to see if any leads to newFen
    const legalMoves = reachGame.moves({ verbose: true });
    for (const move of legalMoves) {
        const testGame = new Chess(reachGame.fen());
        testGame.move(move);
        const resultFen = testGame.fen().split(' ')[0];

        if (resultFen === newFen) {
            // Found the move!
            reachGame.move(move);
            state.reachSession.moves.push(move.san);
            lastSyncedBoardFen = newFen;

            // Update UI
            if (reachEntryBoardInstance) {
                reachEntryBoardInstance.position(reachGame.fen());
            }
            updateReachMoveList();
            updateReachIndicator();

            if (els.reachBtnUndo) els.reachBtnUndo.disabled = false;
            return;
        }
    }

    // No matching move found - ignore (board might be mid-move or reset)
}

// Move validation for manual entry
function onReachDragStart(source, piece, position, orientation) {
    if (!reachGame) return false;
    if (reachGame.game_over()) return false;

    // Only allow dragging pieces of the side to move
    const turn = reachGame.turn();
    if ((turn === 'w' && piece.search(/^b/) !== -1) ||
        (turn === 'b' && piece.search(/^w/) !== -1)) {
        return false;
    }

    return true;
}

function onReachDrop(source, target) {
    if (!reachGame || !state.reachSession) return 'snapback';

    // Try to make the move
    const move = reachGame.move({
        from: source,
        to: target,
        promotion: 'q' // Always promote to queen for simplicity
    });

    if (move === null) return 'snapback';

    // Record the move
    state.reachSession.moves.push(move.san);

    // Sync to physical board
    const newFen = reachGame.fen().split(' ')[0];
    lastSyncedBoardFen = newFen;
    syncToBoard(newFen);

    // Update UI
    updateReachMoveList();
    updateReachIndicator();
    if (els.reachBtnUndo) els.reachBtnUndo.disabled = false;

    const turn = reachGame.turn() === 'w' ? 'White' : 'Black';
    if (els.reachStatus) els.reachStatus.textContent = `${turn} to move`;
}

function onReachSnapEnd() {
    if (!reachGame || !reachEntryBoardInstance) return;
    reachEntryBoardInstance.position(reachGame.fen());
}

function updateReachMoveList() {
    if (!state.reachSession || !els.reachMoveList) return;

    const moves = state.reachSession.moves;
    if (moves.length === 0) {
        els.reachMoveList.innerHTML = '<em>Make moves on the board above</em>';
        return;
    }

    // Format moves with move numbers
    let html = '';
    for (let i = 0; i < moves.length; i++) {
        const moveNum = Math.floor(i / 2) + 1;
        if (i % 2 === 0) {
            html += `<span class="move-number">${moveNum}.</span> `;
        }
        html += `<span class="move">${moves[i]}</span> `;
    }

    els.reachMoveList.innerHTML = html;
}

function updateReachIndicator() {
    if (!state.reachSession || !reachGame || !els.reachIndicator) return;

    const currentFen = reachGame.fen().split(' ')[0];
    const targetFen = state.reachSession.targetFen;

    if (placementsEqual(fenToPlacementMap(currentFen), fenToPlacementMap(targetFen))) {
        els.reachIndicator.innerHTML = '<span class="reach-reached">✓ Target reached!</span>';
        els.reachBtnDone.disabled = false;
    } else {
        els.reachIndicator.innerHTML = '<span class="reach-not-reached">Not yet reached</span>';
        els.reachBtnDone.disabled = true;
    }
}

function reachUndo() {
    if (!reachGame || !state.reachSession || state.reachSession.moves.length === 0) return;

    reachGame.undo();
    state.reachSession.moves.pop();

    if (reachEntryBoardInstance) {
        reachEntryBoardInstance.position(reachGame.fen());
    }

    // Sync to physical board
    const newFen = reachGame.fen().split(' ')[0];
    lastSyncedBoardFen = newFen;
    syncToBoard(newFen);

    updateReachMoveList();
    updateReachIndicator();

    if (els.reachBtnUndo) els.reachBtnUndo.disabled = state.reachSession.moves.length === 0;
}

function reachReset() {
    if (!state.reachSession) return;

    const startFen = state.reachSession.startFen;
    const fullStartFen = `${startFen} w KQkq - 0 1`;

    reachGame = new Chess(fullStartFen);
    state.reachSession.moves = [];

    if (reachEntryBoardInstance) {
        reachEntryBoardInstance.position(startFen);
    }

    // Sync to physical board
    lastSyncedBoardFen = startFen;
    syncToBoard(startFen);

    updateReachMoveList();
    updateReachIndicator();
    if (els.reachBtnUndo) els.reachBtnUndo.disabled = true;

    status('Reset to starting position');
}

function reachDone() {
    if (!state.reachSession || !reachGame) return;

    const { moves, gameId, baseAnalysisId, turn } = state.reachSession;
    const finalFen = reachGame.fen();

    // Close modal first (this clears reachSession, so capture values above)
    closeReachModal();

    // Finalize the moves and start analysis with the selected turn
    finalizeMovesToTarget(moves, finalFen, turn);
}

function reachCancel() {
    // Close modal and cancel the pending game
    closeReachModal();

    // Remove the pending game from state
    if (state.pendingGameId) {
        const idx = state.games.findIndex(g => g.id === state.pendingGameId);
        if (idx !== -1) {
            state.games.splice(idx, 1);
        }
    }

    deactivatePosition();
    resetWorkflowPanels();
    status('Cancelled');
}

// Setup modal event listeners
function setupReachModalListeners() {
    if (els.reachModalClose) {
        els.reachModalClose.addEventListener('click', reachCancel);
    }
    if (els.reachBtnUndo) {
        els.reachBtnUndo.addEventListener('click', reachUndo);
    }
    if (els.reachBtnReset) {
        els.reachBtnReset.addEventListener('click', reachReset);
    }
    if (els.reachBtnDone) {
        els.reachBtnDone.addEventListener('click', reachDone);
    }
    if (els.reachBtnCancel) {
        els.reachBtnCancel.addEventListener('click', reachCancel);
    }

    // Close modal on backdrop click
    const backdrop = document.querySelector('.reach-modal-backdrop');
    if (backdrop) {
        backdrop.addEventListener('click', reachCancel);
    }
}

// =============================================================================
// Step 2: OCR / Text Extraction (DEPRECATED - kept for backward compatibility)
// =============================================================================

function startOcrFlow() {
    // Redirect to new Reach Modal instead
    showReachModal();
}

function enableTextSelection() {
    state.textSelectMode = 'ocr';
    status('Draw a box around the move text on the PDF');
}

function startTextOverlaySelection() {
    state.textSelectMode = 'overlay';
    if (els.textOverlay) {
        els.textOverlay.classList.add('hidden');
        els.textOverlay.textContent = '';
    }
    status('Draw a box to overlay extracted text');
}

async function handleOcrSelection(bbox) {
    if (!state.pendingTargetFen) return;
    if (els.ocrStatus) els.ocrStatus.textContent = 'Extracting text...';

    try {
        const response = await fetch('/api/extract-moves', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                pdf_id: state.pdfId,
                page: state.currentPage - 1,
                bbox: bbox,
            }),
        });

        const data = await response.json();
        if (data.error) {
            if (els.ocrStatus) els.ocrStatus.textContent = `Error: ${data.error}`;
            return;
        }

        const baseFen = getWorkflowBaseFen();
        const targetFen = state.pendingTargetFen;

        const pdfResult = resolveMovesToTarget(data.pdf_text || '', baseFen, targetFen);
        const ocrResult = resolveMovesToTarget(data.ocr_text || '', baseFen, targetFen);

        const best = chooseBestMoveResult(pdfResult, ocrResult);
        if (!best || !best.matched) {
            if (els.ocrStatus) els.ocrStatus.textContent = 'Could not resolve move order to target position.';
            return;
        }

        if (els.ocrStatus) {
            els.ocrStatus.textContent = `Resolved ${best.moves.length} moves (${best.source})`;
        }

        finalizeMovesToTarget(best.moves, best.finalFen);
    } catch (e) {
        if (els.ocrStatus) els.ocrStatus.textContent = `Error: ${e.message}`;
    }
}

async function handleTextOverlaySelection(bbox) {
    if (els.textOverlay) {
        els.textOverlay.textContent = 'Extracting text...';
        els.textOverlay.classList.remove('hidden');
    }

    try {
        const response = await fetch('/api/extract-moves', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                pdf_id: state.pdfId,
                page: state.currentPage - 1,
                bbox: bbox,
            }),
        });

        const data = await response.json();
        if (data.error) {
            if (els.textOverlay) {
                els.textOverlay.textContent = `Error: ${data.error}`;
            }
            return;
        }

        const bestText = data.pdf_text && data.pdf_text.trim().length > 0
            ? data.pdf_text
            : data.ocr_text || '';
        if (els.textOverlay) {
            els.textOverlay.textContent = bestText.trim() || 'No text detected';
        }
    } catch (e) {
        if (els.textOverlay) {
            els.textOverlay.textContent = `Error: ${e.message}`;
        }
    }
}

function getWorkflowBaseFen() {
    if (state.pendingBaseGameId) {
        const tree = state.analyses[state.pendingBaseGameId];
        if (tree) {
            const node = getMainLineLeaf(tree);
            return node.fen;
        }
    }
    return 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
}

function resolveMovesToTarget(text, startFen, targetFen) {
    const tokens = extractMoveTokens(text);
    if (tokens.length === 0) return { matched: false, moves: [], finalFen: startFen, source: 'none' };

    const game = new Chess(startFen);
    const moves = [];

    for (const token of tokens) {
        const move = game.move(token);
        if (!move) break;
        moves.push(move.san);
        if (placementsEqual(fenToPlacementMap(game.fen()), fenToPlacementMap(targetFen))) {
            return { matched: true, moves, finalFen: game.fen() };
        }
    }

    return { matched: false, moves, finalFen: game.fen() };
}

function extractMoveTokens(text) {
    let movesText = text || '';
    movesText = movesText.replace(/\[[^\]]+\]\s*/g, '');
    movesText = movesText.replace(/\b(1-0|0-1|1\/2-1\/2|\*)\b/g, '');
    return movesText
        .replace(/\d+\.+\s*/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .split(' ')
        .filter(m => m.length > 0 && !m.match(/^[\d.]+$/));
}

function chooseBestMoveResult(pdfResult, ocrResult) {
    const pdfMatched = pdfResult && pdfResult.matched;
    const ocrMatched = ocrResult && ocrResult.matched;

    if (pdfMatched && ocrMatched) {
        return pdfResult.moves.length >= ocrResult.moves.length
            ? { ...pdfResult, source: 'pdf' }
            : { ...ocrResult, source: 'ocr' };
    }
    if (pdfMatched) return { ...pdfResult, source: 'pdf' };
    if (ocrMatched) return { ...ocrResult, source: 'ocr' };
    return null;
}

function finalizeMovesToTarget(moves, finalFen, turn = null) {
    const gameId = state.pendingGameId;
    if (!gameId) return;

    let tree;
    let startNode;

    if (state.pendingBaseGameId) {
        tree = state.analyses[state.pendingBaseGameId];
        startNode = getMainLineLeaf(tree);
    } else {
        tree = new AnalysisTree('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
        startNode = tree.root;
    }

    tree.currentNode = startNode;
    let currentNode = startNode;
    const chessGame = new Chess(startNode.fen);
    for (const san of moves) {
        const move = chessGame.move(san);
        if (!move) break;
        currentNode = tree.makeMove(san, chessGame.fen());
    }

    // Save analysis for new game
    if (!state.pendingBaseGameId) {
        state.analyses[gameId] = tree;
    } else {
        // Link new game to existing analysis
        const nodePath = getNodePath(currentNode);
        state.continuations[gameId] = {
            analysisId: state.pendingBaseGameId,
            nodePath,
        };
    }

    state.currentNode = currentNode;
    analysisGame = new Chess(currentNode.fen);
    // Use provided turn or default to whose turn it is in the position
    const analyseTurn = turn || analysisGame.turn();
    enterAnalysisModeUI(gameId, tree, analyseTurn);
    markDirty();

    // Mark the game as confirmed (no longer pending)
    const game = state.games.find(g => g.id === gameId);
    if (game && game.pending) {
        game.pending = false;
        updatePositionList(); // Add to sidebar
    }

    if (els.ocrPanel) els.ocrPanel.classList.add('hidden');
    if (els.otbPanel) els.otbPanel.classList.add('hidden');
    if (els.reachPanel) els.reachPanel.classList.add('hidden');
    resetWorkflowPanels();
    state.pendingGameId = null;
    state.pendingTargetFen = null;
    state.pendingBaseGameId = null;
    state.pendingCandidates = [];
    state.selectedCandidateId = null;
    status('Position reached - analysis mode active');
}

// =============================================================================
// Opening Moves Input Feature
// =============================================================================

/**
 * Show the opening moves input panel.
 */
function showOpeningInput() {
    if (!els.openingInputPanel) return;

    // Pre-fill with existing moves if we have analysis
    const posId = state.activeGameId;
    if (posId) {
        const ctx = getAnalysisContext(posId);
        if (ctx && ctx.tree) {
            const pgn = ctx.tree.toPGN();
            if (els.openingMovesInput) {
                els.openingMovesInput.value = pgn;
            }
        }
    }

    els.openingInputPanel.classList.remove('hidden');
    if (els.openingMovesInput) {
        els.openingMovesInput.focus();
    }
}

/**
 * Hide the opening moves input panel.
 */
function hideOpeningInput() {
    if (els.openingInputPanel) {
        els.openingInputPanel.classList.add('hidden');
    }
}

/**
 * Apply opening moves from input to create/replace analysis tree.
 */
function applyOpeningMoves() {
    const posId = state.activeGameId;
    if (!posId) {
        status('No position selected');
        return;
    }

    const position = state.games.find(p => p.id === posId);
    if (!position) return;

    let movesText = els.openingMovesInput?.value?.trim() || '';

    // #region agent log
    fetch('http://127.0.0.1:7249/ingest/42c8e2b2-2791-4085-836e-044c16902ae2', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ location: 'reader.js:applyOpeningMoves:start', message: 'Applying opening moves', data: { posId, movesTextLen: movesText.length }, timestamp: Date.now(), sessionId: 'debug-session', hypothesisId: 'H8' }) }).catch(() => { });
    // #endregion

    // Parse moves with chess.js
    const game = new Chess();

    // Strip PGN headers like [Event "..."], [FEN "..."], etc.
    movesText = movesText.replace(/\[[^\]]+\]\s*/g, '');

    // Remove result markers like "1-0", "0-1", "1/2-1/2", "*"
    movesText = movesText.replace(/\b(1-0|0-1|1\/2-1\/2|\*)\b/g, '');

    // Remove move numbers and clean up the text
    const cleanMoves = movesText
        .replace(/\d+\.+\s*/g, '') // Remove move numbers like "1." or "1..."
        .replace(/\s+/g, ' ')      // Normalize whitespace
        .trim()
        .split(' ')
        .filter(m => m.length > 0 && !m.match(/^[\d.]+$/)); // Filter out any remaining number-only tokens

    // Play each move
    let lastValidFen = game.fen();
    const playedMoves = [];

    for (const moveStr of cleanMoves) {
        try {
            const move = game.move(moveStr);
            if (move) {
                playedMoves.push(move.san);
                lastValidFen = game.fen();
            } else {
                // #region agent log
                fetch('http://127.0.0.1:7249/ingest/42c8e2b2-2791-4085-836e-044c16902ae2', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ location: 'reader.js:applyOpeningMoves:invalidMove', message: 'Invalid move', data: { moveStr, playedMoves }, timestamp: Date.now(), sessionId: 'debug-session', hypothesisId: 'H8' }) }).catch(() => { });
                // #endregion
                status(`Invalid move: ${moveStr} (after ${playedMoves.length} moves)`);
                break;
            }
        } catch (e) {
            // #region agent log
            fetch('http://127.0.0.1:7249/ingest/42c8e2b2-2791-4085-836e-044c16902ae2', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ location: 'reader.js:applyOpeningMoves:moveError', message: 'Move error', data: { moveStr, error: e.message }, timestamp: Date.now(), sessionId: 'debug-session', hypothesisId: 'H8' }) }).catch(() => { });
            // #endregion
            status(`Error parsing move: ${moveStr}`);
            break;
        }
    }

    if (playedMoves.length === 0) {
        status('No valid moves found - check the format');
        return;
    }

    // Create new analysis tree from starting position
    const tree = new AnalysisTree('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');

    // Replay all moves into the tree
    const replayGame = new Chess();
    let currentNode = tree.root;

    tree.currentNode = tree.root;
    for (const san of playedMoves) {
        const move = replayGame.move(san);
        if (move) {
            currentNode = tree.makeMove(san, replayGame.fen());
        }
    }

    // Check if final position matches the diagram FEN (piece placement)
    const diagramPlacement = fenToPlacementMap(position.fen);
    const finalPlacement = fenToPlacementMap(lastValidFen);

    if (!placementsEqual(diagramPlacement, finalPlacement)) {
        // Warn but still apply - user might want partial moves
        status(`Applied ${playedMoves.length} moves (note: final position differs from diagram)`);
    } else {
        status(`Applied ${playedMoves.length} moves - matches diagram position!`);
    }

    // Save the analysis tree
    state.analyses[posId] = tree;

    // Remove any continuation link since we're creating fresh analysis
    delete state.continuations[posId];

    // Set up analysis game state
    analysisGame = new Chess(lastValidFen);
    state.currentNode = currentNode;

    // Determine turn
    const fenParts = lastValidFen.split(' ');
    const turn = fenParts[1] || 'w';

    // Switch to analysis mode UI
    enterAnalysisModeUI(posId, tree, turn);

    hideOpeningInput();
    markDirty();
    updatePositionList();

    // #region agent log
    fetch('http://127.0.0.1:7249/ingest/42c8e2b2-2791-4085-836e-044c16902ae2', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ location: 'reader.js:applyOpeningMoves:done', message: 'Opening moves applied', data: { playedMoves: playedMoves.length, matchesDiagram: placementsEqual(diagramPlacement, finalPlacement) }, timestamp: Date.now(), sessionId: 'debug-session', hypothesisId: 'H8' }) }).catch(() => { });
    // #endregion
}

/**
 * Enter analysis mode UI (shared helper for startAnalysis and continuation).
 */
function enterAnalysisModeUI(posId, tree, turn) {
    const position = state.games.find(p => p.id === posId);
    if (!position) return;

    // Switch to solid board overlay - make it larger for analysis
    els.boardOverlay.classList.remove('transparent');
    els.boardOverlay.classList.add('solid');

    // Expand board to a usable size (300px) for analysis
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

    // Recreate board with move validation
    if (state.previewBoard) {
        state.previewBoard.destroy();
    }

    const currentFen = state.currentNode ? state.currentNode.fen : position.fen;
    const boardFen = currentFen.split(' ')[0];

    state.previewBoard = Chessboard('active-board', {
        position: boardFen,
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
}

// =============================================================================
// Initialization
// =============================================================================

document.addEventListener('DOMContentLoaded', init);

function init() {
    bindEvents();
    setupPiecePalettes();
    initStockfish();
    startBoardStatusPolling();
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
        state.games = [];
        state.analyses = {};
        state.continuations = {};
        state.pendingContinuation = null;
        state.activeGameId = null;
        state.isDirty = false;

        // Try to load existing study
        const hasStudy = await loadStudy();
        if (!hasStudy) {
            updatePositionList();
        }

        // Go to first page
        await goToPage(1);

        if (hasStudy) {
            status(`Loaded ${data.filename} with existing study - ${state.games.length} games`);
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

    // Analysis buttons - if pending game, open reach modal first; otherwise start analysis directly
    els.btnAnalyseWhite.addEventListener('click', () => handleAnalyseClick('w'));
    els.btnAnalyseBlack.addEventListener('click', () => handleAnalyseClick('b'));
    els.btnCopyFen.addEventListener('click', copyFen);
    els.btnCopyPgn.addEventListener('click', copyPgn);
    els.btnToggleEngine.addEventListener('click', toggleEngine);

    // Continuation prompt buttons
    els.btnAcceptContinuation.addEventListener('click', acceptContinuation);
    els.btnDismissContinuation.addEventListener('click', dismissContinuation);

    // Workflow buttons
    if (els.btnConfirmPieces) {
        els.btnConfirmPieces.addEventListener('click', confirmPieces);
    }
    if (els.btnEditPieces) {
        els.btnEditPieces.addEventListener('click', startEditPieces);
    }
    if (els.btnContinueGame) {
        els.btnContinueGame.addEventListener('click', continueFromSelectedGame);
    }
    if (els.btnNewGame) {
        els.btnNewGame.addEventListener('click', startNewGameFlow);
    }
    // Legacy reach panel buttons (now both open the new modal)
    if (els.btnReachOtb) {
        els.btnReachOtb.addEventListener('click', showReachModal);
    }
    if (els.btnReachOcr) {
        els.btnReachOcr.addEventListener('click', showReachModal);
    }
    if (els.btnStopOtb) {
        els.btnStopOtb.addEventListener('click', stopOtbMonitoring);
    }
    if (els.btnStartTextSelect) {
        els.btnStartTextSelect.addEventListener('click', enableTextSelection);
    }
    if (els.btnSelectText) {
        els.btnSelectText.addEventListener('click', startTextOverlaySelection);
    }

    // New Reach Position Modal listeners
    setupReachModalListeners();

    // Opening moves input buttons
    if (els.btnSetOpening) {
        els.btnSetOpening.addEventListener('click', showOpeningInput);
    }
    if (els.btnApplyOpening) {
        els.btnApplyOpening.addEventListener('click', applyOpeningMoves);
    }
    if (els.btnCancelOpening) {
        els.btnCancelOpening.addEventListener('click', hideOpeningInput);
    }

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
let textSelectState = null;

function startManualBbox(e) {
    if (!state.pdfId) return;

    const rect = els.detectionOverlay.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    if (state.textSelectMode) {
        textSelectState = {
            startX: x,
            startY: y,
            rect: null,
        };

        const selectRect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        selectRect.setAttribute('x', x);
        selectRect.setAttribute('y', y);
        selectRect.setAttribute('width', 0);
        selectRect.setAttribute('height', 0);
        selectRect.classList.add('text-select-box');
        els.detectionOverlay.appendChild(selectRect);
        textSelectState.rect = selectRect;
        return;
    }

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
    if (textSelectState && textSelectState.rect) {
        const rect = els.detectionOverlay.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;

        const startX = textSelectState.startX;
        const startY = textSelectState.startY;
        const width = Math.abs(x - startX);
        const height = Math.abs(y - startY);
        const left = Math.min(startX, x);
        const top = Math.min(startY, y);

        textSelectState.rect.setAttribute('x', left);
        textSelectState.rect.setAttribute('y', top);
        textSelectState.rect.setAttribute('width', width);
        textSelectState.rect.setAttribute('height', height);
        return;
    }

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
    if (textSelectState && textSelectState.rect) {
        const drawRect = textSelectState.rect;
        const width = parseFloat(drawRect.getAttribute('width'));
        const height = parseFloat(drawRect.getAttribute('height'));

        if (width < 20 || height < 20) {
            drawRect.remove();
            textSelectState = null;
            state.textSelectMode = null;
            return;
        }

        const scaleFactor = state.scale;
        const bbox = {
            x: Math.round(parseFloat(drawRect.getAttribute('x')) * 2 / scaleFactor),
            y: Math.round(parseFloat(drawRect.getAttribute('y')) * 2 / scaleFactor),
            width: Math.round(width * 2 / scaleFactor),
            height: Math.round(height * 2 / scaleFactor),
        };

        drawRect.remove();
        textSelectState = null;

        if (state.textSelectMode === 'ocr') {
            handleOcrSelection(bbox);
        } else if (state.textSelectMode === 'overlay') {
            handleTextOverlaySelection(bbox);
        }

        state.textSelectMode = null;
        return;
    }

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
    const posId = state.activeGameId;
    const ctx = getAnalysisContext(posId);
    if (!posId || !ctx || !state.currentNode) return;

    // Go to parent node
    if (state.currentNode.parent) {
        state.currentNode = state.currentNode.parent;
        ctx.tree.currentNode = state.currentNode;

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
    const posId = state.activeGameId;
    const ctx = getAnalysisContext(posId);
    if (!posId || !ctx || !state.currentNode) return;

    // Follow main line (first child)
    const nextNode = state.currentNode.getMainLine();
    if (nextNode) {
        state.currentNode = nextNode;
        ctx.tree.currentNode = nextNode;

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
    const posId = state.activeGameId;
    const ctx = getAnalysisContext(posId);
    if (!posId || !ctx || !state.currentNode) return;

    const nextVar = ctx.tree.getNextVariation();
    if (nextVar) {
        state.currentNode = nextVar;
        ctx.tree.currentNode = nextVar;

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
    const posId = state.activeGameId;
    const ctx = getAnalysisContext(posId);
    if (!posId || !ctx || !state.currentNode) return;

    const prevVar = ctx.tree.getPrevVariation();
    if (prevVar) {
        state.currentNode = prevVar;
        ctx.tree.currentNode = prevVar;

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
    const posId = state.activeGameId;
    const ctx = getAnalysisContext(posId);
    if (!posId || !ctx || !state.currentNode) {
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

    if (ctx.tree.deleteCurrentVariation()) {
        // Update state
        state.currentNode = ctx.tree.currentNode;

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

/**
 * Calculate SHA256 hash of a file in the browser.
 * Returns first 16 hex characters to match server-side hashing.
 */
async function hashFile(file) {
    const buffer = await file.arrayBuffer();
    const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    return hashHex.substring(0, 16);
}

async function handleFileSelect(e) {
    const file = e.target.files[0];
    if (!file) return;

    status(`Checking ${file.name}...`);

    try {
        // Hash file in browser first
        const contentHash = await hashFile(file);

        // Check if PDF already exists on server
        const checkResponse = await fetch(`/api/check-pdf/${contentHash}`);
        let data;

        if (checkResponse.ok) {
            // PDF already exists - skip upload!
            data = await checkResponse.json();
            data.filename = file.name;  // Use local filename for display
            status(`Found cached PDF: ${file.name}`);
        } else {
            // PDF not found - upload it
            status(`Uploading ${file.name}...`);

            const formData = new FormData();
            formData.append('file', file);

            const uploadResponse = await fetch('/api/upload-pdf', {
                method: 'POST',
                body: formData
            });

            data = await uploadResponse.json();

            if (data.error) {
                status(`Error: ${data.error}`);
                return;
            }
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
        state.games = [];
        state.analyses = {};
        state.continuations = {};
        state.pendingContinuation = null;
        state.activeGameId = null;
        state.isDirty = false;

        // Try to load existing study
        const hasStudy = await loadStudy();
        if (!hasStudy) {
            updatePositionList();
        }

        // Go to first page
        await goToPage(1);

        if (hasStudy) {
            status(`Loaded ${data.filename} with existing study - ${state.games.length} games`);
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

// Guard against spam-clicking triggering multiple recognition requests
let recognitionInProgress = false;

async function handleDiagramClick(rect, diagram, pageNum) {
    // Prevent spam-clicking from launching multiple recognizers
    if (recognitionInProgress) {
        status('Recognition already in progress...');
        return;
    }

    recognitionInProgress = true;
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
            recognitionInProgress = false;
            status(`Recognition error: ${data.error}`);
            return;
        }

        // #region agent log
        fetch('http://127.0.0.1:7249/ingest/42c8e2b2-2791-4085-836e-044c16902ae2', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ location: 'reader.js:handleDiagramClick:recognized', message: 'Position recognized', data: { fen: data.fen, confidence: data.confidence }, timestamp: Date.now(), sessionId: 'debug-session', hypothesisId: 'H6' }) }).catch(() => { });
        // #endregion

        // === DEDUPLICATION: Check if game with same FEN already exists ===
        const existingGame = state.games.find(p => p.fen === data.fen && !p.pending);
        if (existingGame) {
            // #region agent log
            fetch('http://127.0.0.1:7249/ingest/42c8e2b2-2791-4085-836e-044c16902ae2', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ location: 'reader.js:handleDiagramClick:foundExisting', message: 'Found existing game with same FEN', data: { existingId: existingGame.id, existingPage: existingGame.page }, timestamp: Date.now(), sessionId: 'debug-session', hypothesisId: 'H6' }) }).catch(() => { });
            // #endregion

            // Just activate the existing game
            activatePosition(existingGame.id, rect);
            status(`Game already saved (Page ${existingGame.page}) - ${data.fen}`);
            syncToBoard(data.fen);
            recognitionInProgress = false;
            return;
        }

        // === Create pending game (not shown until confirmed) ===
        const gameId = `g${pageNum}_${Date.now()}`;
        const game = {
            id: gameId,
            page: pageNum,
            bbox: bbox,
            fen: data.fen,
            confidence: data.confidence,
            pending: true,
        };

        state.games.push(game);
        state.pendingGameId = gameId;
        state.pendingTargetFen = data.fen;
        state.pendingCandidates = [];
        state.selectedCandidateId = null;
        state.pendingBaseGameId = null;

        updatePositionList();
        activatePosition(gameId, rect);
        syncToBoard(data.fen);

        showConfirmPanel();
        status('Confirm pieces, then choose how to continue');
        recognitionInProgress = false;

    } catch (err) {
        console.error(err);
        status(`Recognition failed: ${err.message}`);
        recognitionInProgress = false;
    }
}

function activatePosition(posId, rect) {
    const position = state.games.find(p => p.id === posId);
    if (!position) return;

    state.activeGameId = posId;

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

    if (els.textOverlay) {
        els.textOverlay.classList.add('hidden');
        els.textOverlay.textContent = '';
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
    if (els.btnSetOpening) els.btnSetOpening.disabled = false;
    if (els.btnSelectText) els.btnSelectText.disabled = false;

    if (position.pending) {
        hideAnalysis();
        showConfirmPanel();
        // Call hideSquares with multiple delays to catch board after it fully renders
        setTimeout(hideSquares, 50);
        setTimeout(hideSquares, 150);
        setTimeout(hideSquares, 300);
        return;
    }

    resetWorkflowPanels();

    // Check if we have existing analysis for this position (direct or linked)
    const ctx = getAnalysisContext(posId);
    if (ctx) {
        const { tree, node, isLinked } = ctx;

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
            // Go to the linked node or current node in tree
            state.currentNode = node || tree.currentNode || tree.root;
            tree.currentNode = state.currentNode;
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
        const linkNote = isLinked ? ' (linked)' : '';
        status(`Restored analysis${linkNote} - ${moveCount} moves`);
    } else {
        // Only make squares transparent when NOT in analysis mode
        // This allows pieces to float over the PDF diagram
        setTimeout(hideSquares, 50);
        hideAnalysis();
    }

    // Hide any pending continuation prompt when switching games
    hideContinuationPrompt();
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
    state.activeGameId = null;
    state.pendingGameId = null;
    state.pendingTargetFen = null;
    state.pendingCandidates = [];
    state.selectedCandidateId = null;
    state.pendingBaseGameId = null;
    state.reachMode = null;

    els.boardOverlay.classList.add('hidden');

    document.querySelectorAll('.detection-box').forEach(r => r.classList.remove('active'));
    document.querySelectorAll('.position-item').forEach(item => item.classList.remove('active'));

    els.btnAnalyseWhite.disabled = true;
    els.btnAnalyseBlack.disabled = true;
    els.btnCopyFen.disabled = true;
    els.btnCopyPgn.disabled = true;
    if (els.btnSetOpening) els.btnSetOpening.disabled = true;
    if (els.btnSelectText) els.btnSelectText.disabled = true;
    hideOpeningInput();
    resetWorkflowPanels();

    hideAnalysis();
}

function onPreviewBoardDrop(source, target, piece, newPos, oldPos, orientation) {
    // If in analysis mode, don't use this handler (analysis has its own)
    if (hasAnalysis(state.activeGameId) && state.currentNode) {
        return 'snapback'; // Let analysis mode handle it
    }

    // Update FEN in current position after a short delay to let chessboard.js settle
    setTimeout(() => {
        updateCurrentPositionFen();
        hideSquares(); // Keep squares transparent after move
    }, 50);
}

function updateCurrentPositionFen() {
    if (!state.activeGameId || !state.previewBoard) return;

    const position = state.games.find(p => p.id === state.activeGameId);
    if (position) {
        const newFen = Chessboard.objToFen(state.previewBoard.position());
        position.fen = newFen;
        if (position.pending) {
            state.pendingTargetFen = newFen;
        }

        // Update the sidebar display
        updatePositionList();

        status(`Updated FEN: ${newFen}`);
    }
}

/**
 * Delete a game and its associated data.
 */
function deletePosition(posId) {
    // #region agent log
    fetch('http://127.0.0.1:7249/ingest/42c8e2b2-2791-4085-836e-044c16902ae2', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ location: 'reader.js:deletePosition', message: 'Deleting game', data: { posId }, timestamp: Date.now(), sessionId: 'debug-session', hypothesisId: 'H9' }) }).catch(() => { });
    // #endregion

    // Remove from games array
    const idx = state.games.findIndex(p => p.id === posId);
    const deletedPage = idx !== -1 ? state.games[idx].page : '?';
    if (idx !== -1) {
        state.games.splice(idx, 1);
    }

    // Remove associated analysis
    delete state.analyses[posId];

    // Remove continuation link
    delete state.continuations[posId];

    // Also remove any continuations that point TO this position's analysis
    for (const [otherId, cont] of Object.entries(state.continuations)) {
        if (cont.analysisId === posId) {
            delete state.continuations[otherId];
        }
    }

    // If this was the active position, clear selection
    if (state.activeGameId === posId) {
        deactivatePosition();
    }

    updatePositionList();
    markDirty();
    status(`Deleted game from Page ${deletedPage}`);
}

function updatePositionList() {
    els.positionList.innerHTML = '';

    const visibleGames = state.games.filter(g => !g.pending);

    visibleGames.forEach(pos => {
        const item = document.createElement('div');
        item.className = 'position-item';
        item.dataset.id = pos.id;

        if (pos.id === state.activeGameId) {
            item.classList.add('active');
        }

        // Check for direct analysis or continuation link
        if (hasAnalysis(pos.id)) {
            item.classList.add('analysed');
        }

        // Add linked indicator if this is a continuation
        const isLinked = state.continuations[pos.id] != null;

        item.innerHTML = `
            <div class="thumb">
                <div id="thumb-${pos.id}" style="width:48px;height:48px;"></div>
            </div>
            <div class="info">
                <div class="page-num">Page ${pos.page}${isLinked ? ' ↗' : ''}</div>
                <div class="fen-preview">${pos.fen}</div>
            </div>
            <button class="btn-delete-position" data-id="${pos.id}" title="Delete position">×</button>
        `;

        // Add delete button handler
        const deleteBtn = item.querySelector('.btn-delete-position');
        deleteBtn.addEventListener('click', (e) => {
            e.stopPropagation(); // Don't trigger position selection
            deletePosition(pos.id);
        });

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

/**
 * Handle click on "Play as White" or "Play as Black" button.
 * If this is a pending game (not yet confirmed), open the Reach Position modal.
 * If the game is already confirmed, start analysis directly.
 */
function handleAnalyseClick(turn) {
    const posId = state.activeGameId;
    if (!posId) return;

    const position = state.games.find(p => p.id === posId);
    if (!position) return;

    // If this is a pending game, we need to reach the position first
    if (position.pending) {
        // Set up for the reach modal flow
        state.pendingGameId = posId;
        state.pendingTargetFen = position.fen;

        // Store the turn for after reaching the position
        state.reachSession = state.reachSession || {};
        state.reachSession.turn = turn;

        // Open the reach modal
        showReachModal();
    } else {
        // Game already confirmed, start analysis directly
        startAnalysis(turn);
    }
}

function startAnalysis(turn) {
    const posId = state.activeGameId;
    if (!posId) return;

    const position = state.games.find(p => p.id === posId);
    if (!position) return;

    // Turn is now passed directly from button click
    if (!turn || (turn !== 'w' && turn !== 'b')) {
        status('Invalid turn');
        return;
    }

    // Hide workflow panels - we're entering analysis mode
    resetWorkflowPanels();

    // If this was a pending game, confirm it now
    if (position.pending) {
        position.pending = false;
        state.pendingGameId = null;
        state.pendingTargetFen = null;
        updatePositionList();
        markDirty();
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
    const posId = state.activeGameId;
    const ctx = getAnalysisContext(posId);
    if (posId && ctx) {
        // Add move to tree (creates variation if not on main line)
        const newNode = ctx.tree.makeMove(move.san, analysisGame.fen());
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
    const ctx = getAnalysisContext(posId);
    if (!ctx) return;
    const tree = ctx.tree;

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
    const posId = state.activeGameId;
    const ctx = getAnalysisContext(posId);
    if (!posId || !ctx || !node) return;

    state.currentNode = node;
    ctx.tree.currentNode = node;

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
    const ctx = getAnalysisContext(posId);
    if (!ctx) return;

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

    const posId = state.activeGameId;
    const ctx = getAnalysisContext(posId);
    const fen = ctx && state.currentNode ? state.currentNode.fen : null;

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
        if (hasAnalysis(state.activeGameId) && state.currentNode) {
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
        if (hasAnalysis(state.activeGameId) && state.currentNode) {
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
        if (hasAnalysis(state.activeGameId) && state.currentNode) {
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

function hideSquares(retryCount = 0) {
    // Don't hide squares in analysis mode - we want to see the actual board
    if (els.boardOverlay.classList.contains('solid')) {
        return;
    }

    const board = document.querySelector('#active-board');
    if (!board) {
        // Retry if board not found yet
        if (retryCount < 10) {
            setTimeout(() => hideSquares(retryCount + 1), 50);
        }
        return;
    }

    // Check if board has rendered (has children with backgrounds)
    const squares = board.querySelectorAll('[class*="square-"], [class*="white-"], [class*="black-"]');
    if (squares.length === 0 && retryCount < 10) {
        // Board not fully rendered yet, retry
        setTimeout(() => hideSquares(retryCount + 1), 50);
        return;
    }

    // NUCLEAR OPTION: Force ALL elements inside the board to be transparent
    // except for images (the pieces)
    board.style.setProperty('background', 'transparent', 'important');
    board.style.setProperty('background-color', 'transparent', 'important');

    board.querySelectorAll('*').forEach(el => {
        // Skip images - those are the pieces we want to keep visible
        if (el.tagName === 'IMG') return;

        el.style.setProperty('background', 'transparent', 'important');
        el.style.setProperty('background-color', 'transparent', 'important');
        el.style.setProperty('background-image', 'none', 'important');
    });

    console.log(`[Reader] hideSquares: made board transparent (attempt ${retryCount + 1}, ${squares.length} squares found)`);
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
        const position = state.games.find(p => p.id === state.activeGameId);
        if (!position) return;
        fen = position.fen;
    }

    navigator.clipboard.writeText(fen).then(() => {
        status('FEN copied to clipboard');
    });
}

function copyPgn() {
    const ctx = getAnalysisContext(state.activeGameId);
    if (!ctx) return;

    const pgn = ctx.tree.toPGN();

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
        games: state.games.filter(g => !g.pending).map(p => ({
            id: p.id,
            page: p.page,
            bbox: p.bbox,
            fen: p.fen,
        })),
        analyses: {},
        continuations: state.continuations,
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

        // Restore games (migrate from positions if needed)
        if (study.games) {
            state.games = study.games;
            updatePositionList();
        } else if (study.positions) {
            state.games = study.positions;
            updatePositionList();
            markDirty(); // Persist migration on next autosave
            console.log('[Reader] Migrated study.positions to study.games');
        }

        // Restore analysis trees
        if (study.analyses) {
            for (const [posId, treeData] of Object.entries(study.analyses)) {
                state.analyses[posId] = AnalysisTree.fromJSON(treeData);
            }
        }

        // Restore continuation links
        if (study.continuations) {
            state.continuations = study.continuations;
        }

        console.log(`[Reader] Loaded study with ${state.games.length} games, ${Object.keys(state.continuations).length} continuations`);
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

// =============================================================================
// Chessnut Move Board Sync
// =============================================================================

/**
 * Sync a FEN position to the Chessnut Move board service.
 * This is fire-and-forget: it updates the status bar but doesn't block
 * or throw errors that would disrupt the recognition flow.
 */
async function syncToBoard(fen) {
    try {
        const response = await fetch('/api/board/set-fen', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ fen: fen, force: true })
        });

        const data = await response.json();

        if (data.synced) {
            const driverNote = data.driver_synced ? ' (board updated)' : ' (service only)';
            status(`Board synced: ${fen}${driverNote}`);
        } else {
            // Log but don't alarm the user - service may just be offline
            console.warn('[Reader] Board sync failed:', data.error);
        }
    } catch (err) {
        // Connection error - service likely not running
        console.warn('[Reader] Board service unavailable:', err.message);
    }
}

// =============================================================================
// Chessnut Move Board Status Indicator
// =============================================================================

let boardStatusInterval = null;

function updateBoardStatus(available, connected) {
    const statusEl = document.getElementById('board-status');
    const textEl = statusEl?.querySelector('.board-status-text');
    if (!statusEl || !textEl) return;

    statusEl.classList.remove('offline', 'online', 'connected');

    if (connected) {
        // Physical board is connected and ready
        statusEl.classList.add('connected');
        textEl.textContent = '♟ Board ready';
    } else if (available) {
        // Service running but no board connected - show as warning
        statusEl.classList.add('online');
        textEl.textContent = '⚠ No board';
    } else {
        // Service not running
        statusEl.classList.add('offline');
        textEl.textContent = '○ Offline';
    }
}

async function pollBoardStatus() {
    try {
        const response = await fetch('/api/board/status', {
            method: 'GET',
            signal: AbortSignal.timeout(2000) // 2 second timeout
        });

        if (!response.ok) {
            updateBoardStatus(false, false);
            return;
        }

        const data = await response.json();
        updateBoardStatus(data.available, data.connected);
    } catch (err) {
        updateBoardStatus(false, false);
    }
}

function startBoardStatusPolling() {
    // Poll immediately
    pollBoardStatus();

    // Then poll every 5 seconds
    boardStatusInterval = setInterval(pollBoardStatus, 5000);
}

function stopBoardStatusPolling() {
    if (boardStatusInterval) {
        clearInterval(boardStatusInterval);
        boardStatusInterval = null;
    }
}
