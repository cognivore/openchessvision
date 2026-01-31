export const byId = <T extends HTMLElement>(id: string): T => {
    const el = document.getElementById(id);
    if (!el) {
        throw new Error(`Missing element: ${id}`);
    }
    return el as T;
};

// Lazy element cache - only populated after DOM is ready
let _els: ReturnType<typeof initEls> | null = null;

const initEls = () => ({
    pdfInput: byId<HTMLInputElement>("pdf-input"),
    btnOpen: byId<HTMLButtonElement>("btn-open"),
    pdfInfo: byId<HTMLSpanElement>("pdf-info"),
    btnPrevPage: byId<HTMLButtonElement>("btn-prev-page"),
    btnNextPage: byId<HTMLButtonElement>("btn-next-page"),
    pageInfo: byId<HTMLSpanElement>("page-info"),
    pageInput: byId<HTMLInputElement>("page-input"),
    btnGotoPage: byId<HTMLButtonElement>("btn-goto-page"),
    zoomSlider: byId<HTMLInputElement>("zoom-slider"),
    zoomValue: byId<HTMLSpanElement>("zoom-value"),
    pdfViewport: byId<HTMLDivElement>("pdf-viewport"),
    pdfPageContainer: byId<HTMLDivElement>("pdf-page-container"),
    pdfCanvas: byId<HTMLCanvasElement>("pdf-canvas"),
    detectionOverlay: byId<SVGSVGElement>("detection-overlay"),
    boardOverlay: byId<HTMLDivElement>("board-overlay"),
    btnCloseBoard: byId<HTMLButtonElement>("btn-close-board"),
    activeBoard: byId<HTMLDivElement>("active-board"),
    textOverlay: byId<HTMLDivElement>("text-overlay"),
    noPdfMessage: byId<HTMLDivElement>("no-pdf-message"),
    positionList: byId<HTMLDivElement>("position-list"),
    analysisContainer: byId<HTMLDivElement>("analysis-container"),
    pgnViewer: byId<HTMLDivElement>("pgn-viewer"),
    enginePanel: byId<HTMLDivElement>("engine-panel"),
    engineEval: byId<HTMLDivElement>("engine-eval"),
    engineLine: byId<HTMLDivElement>("engine-line"),
    btnToggleEngine: byId<HTMLButtonElement>("btn-toggle-engine"),
    btnAnalyseWhite: byId<HTMLButtonElement>("btn-analyse-white"),
    btnAnalyseBlack: byId<HTMLButtonElement>("btn-analyse-black"),
    btnCopyFen: byId<HTMLButtonElement>("btn-copy-fen"),
    btnCopyPgn: byId<HTMLButtonElement>("btn-copy-pgn"),
    btnSelectText: byId<HTMLButtonElement>("btn-select-text"),
    statusBar: byId<HTMLSpanElement>("status-bar"),
    boardStatus: byId<HTMLSpanElement>("board-status"),
    paletteBlack: byId<HTMLDivElement>("piece-palette-black"),
    paletteWhite: byId<HTMLDivElement>("piece-palette-white"),
    workflowPanel: byId<HTMLDivElement>("workflow-panel"),
    confirmPanel: byId<HTMLDivElement>("confirm-panel"),
    btnConfirmPieces: byId<HTMLButtonElement>("btn-confirm-pieces"),
    btnEditPieces: byId<HTMLButtonElement>("btn-edit-pieces"),
    gameMatchPanel: byId<HTMLDivElement>("game-match-panel"),
    gameMatchList: byId<HTMLDivElement>("game-match-list"),
    btnContinueGame: byId<HTMLButtonElement>("btn-continue-game"),
    btnNewGame: byId<HTMLButtonElement>("btn-new-game"),
    reachPanel: byId<HTMLDivElement>("reach-panel"),
    btnReachOtb: byId<HTMLButtonElement>("btn-reach-otb"),
    btnReachOcr: byId<HTMLButtonElement>("btn-reach-ocr"),
    otbPanel: byId<HTMLDivElement>("otb-panel"),
    otbStatus: byId<HTMLDivElement>("otb-status"),
    btnStopOtb: byId<HTMLButtonElement>("btn-stop-otb"),
    ocrPanel: byId<HTMLDivElement>("ocr-panel"),
    btnStartTextSelect: byId<HTMLButtonElement>("btn-start-text-select"),
    ocrStatus: byId<HTMLDivElement>("ocr-status"),
    continuationPrompt: byId<HTMLDivElement>("continuation-prompt"),
    continuationInfo: byId<HTMLDivElement>("continuation-info"),
    btnAcceptContinuation: byId<HTMLButtonElement>("btn-accept-continuation"),
    btnDismissContinuation: byId<HTMLButtonElement>("btn-dismiss-continuation"),
    openingInputPanel: byId<HTMLDivElement>("opening-input-panel"),
    openingMovesInput: byId<HTMLTextAreaElement>("opening-moves-input"),
    btnSetOpening: byId<HTMLButtonElement>("btn-set-opening"),
    btnApplyOpening: byId<HTMLButtonElement>("btn-apply-opening"),
    btnCancelOpening: byId<HTMLButtonElement>("btn-cancel-opening"),
    reachModal: byId<HTMLDivElement>("reach-modal"),
    reachModalClose: byId<HTMLButtonElement>("reach-modal-close"),
    reachStartBoard: byId<HTMLDivElement>("reach-start-board"),
    reachEntryBoard: byId<HTMLDivElement>("reach-entry-board"),
    reachTargetBoard: byId<HTMLDivElement>("reach-target-board"),
    reachStartLabel: byId<HTMLDivElement>("reach-start-label"),
    reachMoveList: byId<HTMLDivElement>("reach-move-list"),
    reachStatus: byId<HTMLDivElement>("reach-status"),
    reachIndicator: byId<HTMLDivElement>("reach-indicator"),
    reachBtnUndo: byId<HTMLButtonElement>("reach-btn-undo"),
    reachBtnReset: byId<HTMLButtonElement>("reach-btn-reset"),
    reachBtnDone: byId<HTMLButtonElement>("reach-btn-done"),
    reachBtnCancel: byId<HTMLButtonElement>("reach-btn-cancel"),
    // Board row elements
    boardRow: byId<HTMLDivElement>("board-row"),
    boardSlotBefore: byId<HTMLDivElement>("board-slot-before"),
    boardSlotNow: byId<HTMLDivElement>("board-slot-now"),
    boardSlotAfter: byId<HTMLDivElement>("board-slot-after"),
    beforeBoard: byId<HTMLDivElement>("before-board"),
    nowBoard: byId<HTMLDivElement>("now-board"),
    afterBoard: byId<HTMLDivElement>("after-board"),
    beforeBoardInfo: byId<HTMLDivElement>("before-board-info"),
    nowBoardInfo: byId<HTMLDivElement>("now-board-info"),
    afterBoardInfo: byId<HTMLDivElement>("after-board-info"),
    boardRowActions: byId<HTMLDivElement>("board-row-actions"),
    boardRowReachIndicator: byId<HTMLSpanElement>("board-row-reach-indicator"),
    // Board row action groups
    boardRowConfirm: byId<HTMLDivElement>("board-row-confirm"),
    boardRowEdit: byId<HTMLDivElement>("board-row-edit"),
    boardRowMatch: byId<HTMLDivElement>("board-row-match"),
    boardRowReach: byId<HTMLDivElement>("board-row-reach"),
    boardRowAnalysis: byId<HTMLDivElement>("board-row-analysis"),
    boardRowHowReach: byId<HTMLDivElement>("board-row-how-reach"),
    // Board row buttons - confirm
    btnRowConfirm: byId<HTMLButtonElement>("btn-row-confirm"),
    btnRowSetupFen: byId<HTMLButtonElement>("btn-row-setup-fen"),
    btnRowEdit: byId<HTMLButtonElement>("btn-row-edit"),
    // Board row buttons - edit
    btnRowSave: byId<HTMLButtonElement>("btn-row-save"),
    btnRowCancelEdit: byId<HTMLButtonElement>("btn-row-cancel-edit"),
    // Board row - FEN setup
    boardRowFenSetup: byId<HTMLDivElement>("board-row-fen-setup"),
    fenTurnSelect: byId<HTMLSelectElement>("fen-turn-select"),
    castleK: byId<HTMLInputElement>("castle-K"),
    castleQ: byId<HTMLInputElement>("castle-Q"),
    castlek: byId<HTMLInputElement>("castle-k"),
    castleq: byId<HTMLInputElement>("castle-q"),
    btnRowFenDone: byId<HTMLButtonElement>("btn-row-fen-done"),
    btnRowFenCancel: byId<HTMLButtonElement>("btn-row-fen-cancel"),
    // Board row buttons - match
    matchGameSelect: byId<HTMLSelectElement>("match-game-select"),
    btnRowContinue: byId<HTMLButtonElement>("btn-row-continue"),
    btnRowNewGame: byId<HTMLButtonElement>("btn-row-new-game"),
    // Board row buttons - reach
    boardRowReachStatus: byId<HTMLSpanElement>("board-row-reach-status"),
    btnRowUndo: byId<HTMLButtonElement>("btn-row-undo"),
    btnRowReset: byId<HTMLButtonElement>("btn-row-reset"),
    btnRowDone: byId<HTMLButtonElement>("btn-row-done"),
    btnRowCancel: byId<HTMLButtonElement>("btn-row-cancel"),
    // Board row buttons - analysis
    btnRowAnalyseWhite: byId<HTMLButtonElement>("btn-row-analyse-white"),
    btnRowAnalyseBlack: byId<HTMLButtonElement>("btn-row-analyse-black"),
    btnRowCopyFen: byId<HTMLButtonElement>("btn-row-copy-fen"),
    btnRowCopyPgn: byId<HTMLButtonElement>("btn-row-copy-pgn"),
    btnRowClose: byId<HTMLButtonElement>("btn-row-close"),
    // Board row buttons - how to reach
    btnRowOtb: byId<HTMLButtonElement>("btn-row-otb"),
    btnRowManual: byId<HTMLButtonElement>("btn-row-manual"),
});

// Proxy that lazily initializes els on first access
export const els: ReturnType<typeof initEls> = new Proxy({} as ReturnType<typeof initEls>, {
    get(_target, prop: string) {
        if (!_els) {
            _els = initEls();
        }
        return _els[prop as keyof typeof _els];
    },
});
