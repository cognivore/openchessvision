import type { Msg } from "../core/msg";
import type { Model } from "../core/model";
import { asPageNum } from "../core/model";
import { els } from "./dom";

type Dispatch = (msg: Msg) => void;
type GetModel = () => Model;

export const bindEvents = (dispatch: Dispatch, getModel: GetModel): void => {
    els.btnOpen.addEventListener("click", () => els.pdfInput.click());
    els.btnCloseBoard.addEventListener("click", () => dispatch({ tag: "DiagramActivated", gameId: null }));

    // Debug: Add click handler directly on pdfPageContainer
    els.pdfPageContainer.addEventListener("click", (e) => {
        const rect = els.pdfPageContainer.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        console.log("[DEBUG] pdfPageContainer clicked at:", x, y, "target:", e.target);
    });
    els.pdfInput.addEventListener("change", () => {
        const file = els.pdfInput.files?.[0];
        if (!file) return;
        dispatch({ tag: "PdfFileSelected", file });
        els.pdfInput.value = "";
    });
    els.btnPrevPage.addEventListener("click", () => {
        const model = getModel();
        if (model.pdf.currentPage > 1) {
            dispatch({
                tag: "PageRequested",
                page: asPageNum((model.pdf.currentPage as number) - 1),
            });
        }
    });
    els.btnNextPage.addEventListener("click", () => {
        const model = getModel();
        if (model.pdf.currentPage < model.pdf.totalPages) {
            dispatch({
                tag: "PageRequested",
                page: asPageNum((model.pdf.currentPage as number) + 1),
            });
        }
    });
    els.btnGotoPage.addEventListener("click", () => {
        const model = getModel();
        const next = Number.parseInt(els.pageInput.value, 10);
        if (!Number.isFinite(next)) return;
        dispatch({
            tag: "PageRequested",
            page: asPageNum(Math.min(Math.max(next, 1), model.pdf.totalPages)),
        });
    });
    els.pageInput.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
            els.btnGotoPage.click();
        }
    });
    els.zoomSlider.addEventListener("input", () => {
        const value = Number.parseInt(els.zoomSlider.value, 10);
        if (!Number.isFinite(value)) return;
        dispatch({ tag: "ZoomChanged", scale: value / 100 });
    });
    els.btnConfirmPieces.addEventListener("click", () => dispatch({ tag: "ConfirmPieces" }));
    els.btnEditPieces.addEventListener("click", () => dispatch({ tag: "EditPieces" }));
    els.btnContinueGame.addEventListener("click", () => dispatch({ tag: "ContinueSelectedGame" }));
    els.btnNewGame.addEventListener("click", () => dispatch({ tag: "StartNewGame" }));
    els.btnReachOtb.addEventListener("click", () => dispatch({ tag: "ReachStartOtb" }));
    els.btnReachOcr.addEventListener("click", () =>
        dispatch({ tag: "TextSelectModeChanged", mode: "ocr" }),
    );
    els.btnStopOtb.addEventListener("click", () => dispatch({ tag: "ReachCancel" }));
    els.btnStartTextSelect.addEventListener("click", () =>
        dispatch({ tag: "TextSelectModeChanged", mode: "overlay" }),
    );
    els.btnToggleEngine.addEventListener("click", () => dispatch({ tag: "EngineToggle" }));
    els.btnAnalyseWhite.addEventListener("click", () => {
        const model = getModel();
        const active = model.workflow.tag === "VIEWING" ? model.workflow.activeGameId : null;
        if (active) {
            dispatch({ tag: "AnalysisStarted", gameId: active, turn: "w" });
        }
    });
    els.btnAnalyseBlack.addEventListener("click", () => {
        const model = getModel();
        const active = model.workflow.tag === "VIEWING" ? model.workflow.activeGameId : null;
        if (active) {
            dispatch({ tag: "AnalysisStarted", gameId: active, turn: "b" });
        }
    });
    els.btnCopyFen.addEventListener("click", () => dispatch({ tag: "CopyFen" }));
    els.btnCopyPgn.addEventListener("click", () => dispatch({ tag: "CopyPgn" }));
    els.btnSelectText.addEventListener("click", () =>
        dispatch({ tag: "TextSelectModeChanged", mode: "overlay" }),
    );
    els.btnSetOpening.addEventListener("click", () =>
        dispatch({ tag: "OpeningsInputShown", content: "" }),
    );
    els.btnApplyOpening.addEventListener("click", () =>
        dispatch({ tag: "OpeningsInputHidden" }),
    );
    els.btnCancelOpening.addEventListener("click", () =>
        dispatch({ tag: "OpeningsInputHidden" }),
    );
    els.reachBtnUndo.addEventListener("click", () => dispatch({ tag: "ReachUndo" }));
    els.reachBtnReset.addEventListener("click", () => dispatch({ tag: "ReachReset" }));
    els.reachBtnDone.addEventListener("click", () => dispatch({ tag: "ReachDone" }));
    els.reachBtnCancel.addEventListener("click", () => dispatch({ tag: "ReachCancel" }));
    els.reachModalClose.addEventListener("click", () => dispatch({ tag: "ReachCancel" }));
    const backdrop = document.querySelector(".reach-modal-backdrop");
    if (backdrop) {
        backdrop.addEventListener("click", () => dispatch({ tag: "ReachCancel" }));
    }

    // Board row bindings - Confirm mode
    els.btnRowConfirm.addEventListener("click", () => dispatch({ tag: "ConfirmPieces" }));
    els.btnRowSetupFen.addEventListener("click", () => dispatch({ tag: "SetupFenMode" }));
    els.btnRowEdit.addEventListener("click", () => dispatch({ tag: "EditPieces" }));

    // Board row bindings - FEN setup mode
    els.btnRowFenDone.addEventListener("click", () => {
        const turn = els.fenTurnSelect.value as "w" | "b";
        let castling = "";
        if (els.castleK.checked) castling += "K";
        if (els.castleQ.checked) castling += "Q";
        if (els.castlek.checked) castling += "k";
        if (els.castleq.checked) castling += "q";
        if (!castling) castling = "-";
        dispatch({ tag: "FenSetupCompleted", turn, castling });
    });
    els.btnRowFenCancel.addEventListener("click", () => dispatch({ tag: "FenSetupCancelled" }));

    // Board row bindings - Edit mode
    els.btnRowSave.addEventListener("click", () => dispatch({ tag: "ConfirmPieces" }));
    els.btnRowCancelEdit.addEventListener("click", () => dispatch({ tag: "CancelEdit" }));

    // Board row bindings - Match mode
    els.btnRowContinue.addEventListener("click", () => dispatch({ tag: "ContinueSelectedGame" }));
    els.btnRowNewGame.addEventListener("click", () => dispatch({ tag: "StartNewGame" }));
    els.matchGameSelect.addEventListener("change", () => {
        const selectedId = els.matchGameSelect.value;
        if (selectedId) {
            dispatch({ tag: "MatchGameSelected", gameId: selectedId as any });
        }
    });

    // Board row bindings - Reach mode
    els.btnRowUndo.addEventListener("click", () => dispatch({ tag: "ReachUndo" }));
    els.btnRowReset.addEventListener("click", () => dispatch({ tag: "ReachReset" }));
    els.btnRowDone.addEventListener("click", () => dispatch({ tag: "ReachDone" }));
    els.btnRowCancel.addEventListener("click", () => dispatch({ tag: "ReachCancel" }));

    // Board row bindings - Analysis mode (flip board orientation)
    els.btnRowAnalyseWhite.addEventListener("click", () => {
        dispatch({ tag: "BoardOrientationChanged", orientation: "white" });
    });
    els.btnRowAnalyseBlack.addEventListener("click", () => {
        dispatch({ tag: "BoardOrientationChanged", orientation: "black" });
    });
    els.btnRowCopyFen.addEventListener("click", () => dispatch({ tag: "CopyFen" }));
    els.btnRowCopyPgn.addEventListener("click", () => dispatch({ tag: "CopyPgn" }));
    els.btnRowClose.addEventListener("click", () => dispatch({ tag: "DiagramActivated", gameId: null }));

    // Board row bindings - How to reach mode
    els.btnRowOtb.addEventListener("click", () => dispatch({ tag: "ReachStartOtb" }));
    els.btnRowManual.addEventListener("click", () => dispatch({ tag: "ReachStartManual" }))

    document.addEventListener("keydown", (event) => {
        const target = event.target as HTMLElement | null;
        if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) {
            return;
        }
        const model = getModel();
        switch (event.key) {
            case "ArrowLeft":
                if (model.pdf.currentPage > 1) {
                    dispatch({ tag: "PageRequested", page: asPageNum((model.pdf.currentPage as number) - 1) });
                }
                break;
            case "ArrowRight":
                if (model.pdf.currentPage < model.pdf.totalPages) {
                    dispatch({ tag: "PageRequested", page: asPageNum((model.pdf.currentPage as number) + 1) });
                }
                break;
            case "Escape":
                dispatch({ tag: "DiagramActivated", gameId: null });
                break;
            case "h":
                dispatch({ tag: "AnalysisGoBack" });
                break;
            case "l":
                dispatch({ tag: "AnalysisGoForward" });
                break;
            case "j":
                dispatch({ tag: "AnalysisNextVariation" });
                break;
            case "k":
                dispatch({ tag: "AnalysisPrevVariation" });
                break;
            case "x":
            case "Delete":
            case "Backspace":
                if (event.key === "Backspace" && !event.ctrlKey && !event.metaKey) {
                    break;
                }
                dispatch({ tag: "AnalysisDeleteVariation" });
                event.preventDefault();
                break;
            case "p":
                dispatch({ tag: "AnalysisPromoteVariation" });
                break;
            default:
                break;
        }
    });
};
