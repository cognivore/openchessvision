import type { Cmd } from "./cmd";
import type { Msg } from "./msg";
import type { Model, Study } from "./model";
import { asContentHash, asGameId } from "./model";
import { update } from "./update";
import { render } from "../ui/render";
import { bindEvents } from "../ui/bindings";
import { els } from "../ui/dom";
import { setupPiecePalettes } from "../ui/palette";
import { bindManualSelection } from "../ui/selection";
import { getActiveGame, getAnalysisNodeFen } from "./selectors";
import { detectDiagrams, extractMoves, loadStudy, recognizeRegion, saveStudy, uploadPdf } from "../ports/api";
import { checkPdf } from "../ports/api";
import { fetchFen, fetchStatus, setFen } from "../ports/chessnut";
import { loadPdf, renderPage } from "../ports/pdfjs";
import { createStockfish, analyze, startEngine, stopEngine } from "../ports/stockfish";
import { asFenFull } from "../domain/chess/fen";
import { asSan } from "../domain/chess/san";
import { toPageNum } from "../domain/pdf/page";
import type { PdfResources } from "../ports/pdfjs";
import type { ChessboardInstance } from "../ui/adapters/chessboard";
import { createBoard, getBoardFen } from "../ui/adapters/chessboard";

type Resources = {
  pdf: PdfResources;
  previewBoard: ChessboardInstance | null;
  previewMode: "analysis" | "preview" | null;
  analysisGame: Chess | null;
  reachGame: Chess | null;
  reachBoards: {
    start: ChessboardInstance | null;
    entry: ChessboardInstance | null;
    target: ChessboardInstance | null;
  };
  stockfish: ReturnType<typeof createStockfish> | null;
  boardStatusTimer: number | null;
  chessnutPollTimer: number | null;
  saveTimer: number | null;
};

const createResources = (): Resources => ({
  pdf: { doc: null, renderTask: null },
  previewBoard: null,
  previewMode: null,
  analysisGame: null,
  reachGame: null,
  reachBoards: { start: null, entry: null, target: null },
  stockfish: null,
  boardStatusTimer: null,
  chessnutPollTimer: null,
  saveTimer: null,
});

const hashFile = async (file: File): Promise<string> => {
  const buffer = await file.arrayBuffer();
  const hashBuffer = await crypto.subtle.digest("SHA-256", buffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
  return hashHex.substring(0, 16);
};

const buildStudy = (model: Model): Study => ({
  games: model.games,
  analyses: model.analyses,
  continuations: model.continuations,
});

export const createRuntime = (initial: Model) => {
  let model = initial;
  const resources = createResources();

  const getModel = () => model;

  const dispatch = (msg: Msg): void => {
    const [next, cmds] = update(model, msg);
    model = next;
    render(model, dispatch);
    syncPreviewBoard();
    syncReachBoards();
    cmds.forEach((cmd) => {
      void runCmd(cmd);
    });
  };

  let lastActiveGameId: string | null = null;

  const syncPreviewBoard = (): void => {
    const active = getActiveGame(model);
    if (!active) {
      resources.previewBoard?.destroy();
      resources.previewBoard = null;
      resources.previewMode = null;
      resources.analysisGame = null;
      lastActiveGameId = null;
      return;
    }
    const mode = model.workflow.tag === "ANALYSIS" ? "analysis" : "preview";
    const analysisFen =
      model.workflow.tag === "ANALYSIS" ? getAnalysisNodeFen(model, active.id) : null;
    const boardFen = analysisFen ?? active.fen;
    const gameChanged = lastActiveGameId !== active.id;
    lastActiveGameId = active.id;
    if (!resources.previewBoard || resources.previewMode !== mode || gameChanged) {
      resources.previewBoard?.destroy();
      resources.previewBoard = null;
      const onDrop =
        mode === "analysis"
          ? (source: string, target: string) => {
              if (!resources.analysisGame) return "snapback";
              const move = resources.analysisGame.move({
                from: source,
                to: target,
                promotion: "q",
              });
              if (!move) return "snapback";
              dispatch({ tag: "AnalysisMoveMade", san: asSan(move.san), fen: asFenFull(resources.analysisGame.fen()) });
              return undefined;
            }
          : undefined;
      const onSnapEnd =
        mode === "analysis"
          ? () => {
              if (!resources.analysisGame || !resources.previewBoard) return;
              resources.previewBoard.position(resources.analysisGame.fen());
            }
          : undefined;
      resources.previewBoard = createBoard("active-board", {
        position: String(boardFen),
        draggable: true,
        showNotation: mode === "analysis",
        pieceTheme: "/static/vendor/img/chesspieces/wikipedia/{piece}.png",
        dropOffBoard: "trash",
        sparePieces: false,
        onDrop,
        onSnapEnd,
      });
      resources.previewMode = mode;
    } else if (mode === "analysis") {
      // Only sync position in analysis mode - in preview mode, let user edit freely
      resources.previewBoard?.position(String(boardFen), false);
    }
    resources.analysisGame = mode === "analysis" && analysisFen ? new Chess(analysisFen) : null;
  };

  const syncReachBoards = (): void => {
    if (model.workflow.tag !== "REACHING") {
      resources.reachGame = null;
      return;
    }
    if (!resources.reachGame || resources.reachGame.fen() !== String(model.workflow.session.currentFen)) {
      resources.reachGame = new Chess(model.workflow.session.currentFen);
    }
    resources.reachBoards.entry?.position(String(model.workflow.session.currentFen));
  };

  const runCmd = async (cmd: Cmd): Promise<void> => {
    switch (cmd.tag) {
      case "PDF_LOAD_FILE": {
        const contentHash = await hashFile(cmd.file);
        const hash = asContentHash(contentHash);
        const check = await checkPdf(hash);
        if (check.ok && check.value.exists) {
          const info = check.value.info;
          const loaded = await loadPdf(info.pdfId);
          if (!loaded.ok) {
            dispatch({ tag: "Error", scope: "pdf", message: loaded.error });
            return;
          }
          resources.pdf.doc = loaded.value;
          dispatch({
            tag: "PdfOpened",
            pdfId: info.pdfId,
            pages: info.pages,
            filename: cmd.file.name,
            contentHash: info.contentHash,
          });
          return;
        }
        const uploaded = await uploadPdf(cmd.file, hash);
        if (!uploaded.ok) {
          dispatch({ tag: "Error", scope: "upload", message: uploaded.error });
          return;
        }
        const loaded = await loadPdf(uploaded.value.pdfId);
        if (!loaded.ok) {
          dispatch({ tag: "Error", scope: "pdf", message: loaded.error });
          return;
        }
        resources.pdf.doc = loaded.value;
        dispatch({
          tag: "PdfOpened",
          pdfId: uploaded.value.pdfId,
          pages: uploaded.value.pages,
          filename: uploaded.value.filename,
          contentHash: uploaded.value.contentHash,
        });
        return;
      }
      case "PDF_LOAD_BY_ID": {
        const loaded = await loadPdf(cmd.pdfId);
        if (!loaded.ok) {
          dispatch({ tag: "Error", scope: "pdf", message: loaded.error });
          return;
        }
        resources.pdf.doc = loaded.value;
        return;
      }
      case "PDF_RENDER_PAGE": {
        const result = await renderPage(
          resources.pdf,
          { canvas: els.pdfCanvas, overlay: els.detectionOverlay, viewportContainer: els.pdfViewport },
          cmd.page,
          cmd.scale,
          model.pdf.initialScaleSet,
        );
        if (result.ok) {
          dispatch({
            tag: "PageRendered",
            page: cmd.page,
            scale: result.value.scale,
            initialScaleSet: result.value.initialScaleSet,
          });
        } else {
          dispatch({ tag: "Error", scope: "render", message: result.error });
        }
        return;
      }
      case "PDF_CANCEL_RENDER":
        if (resources.pdf.renderTask) {
          try {
            resources.pdf.renderTask.cancel();
          } catch {
            // ignore
          }
          resources.pdf.renderTask = null;
        }
        return;
      case "API_CHECK_PDF":
        await checkPdf(cmd.contentHash);
        return;
      case "API_UPLOAD_PDF":
        await uploadPdf(cmd.file, cmd.contentHash);
        return;
      case "API_DETECT_DIAGRAMS": {
        const result = await detectDiagrams(cmd.pdfId, cmd.page as number);
        if (result.ok) {
          dispatch({ tag: "DiagramsDetected", page: toPageNum(cmd.page), diagrams: result.value });
        } else {
          dispatch({ tag: "Error", scope: "detect", message: result.error });
        }
        return;
      }
      case "API_RECOGNIZE_REGION": {
        const result = await recognizeRegion(cmd.pdfId, cmd.page as number, cmd.bbox);
        if (result.ok) {
          dispatch({
            tag: "Recognized",
            page: toPageNum(cmd.page),
            bbox: cmd.bbox,
            placement: result.value.placement,
            confidence: result.value.confidence,
            gameId: asGameId(`g${cmd.page}_${Date.now()}`),
          });
        } else {
          dispatch({ tag: "RecognitionFailed", message: result.error });
        }
        return;
      }
      case "API_EXTRACT_MOVES": {
        const result = await extractMoves(cmd.pdfId, cmd.page as number, cmd.bbox);
        if (!result.ok) {
          dispatch({ tag: "ExtractMovesFailed", message: result.error });
          return;
        }
        const bestText = result.value.pdfText.trim().length > 0 ? result.value.pdfText : result.value.ocrText;
        dispatch({
          tag: "TextOverlayUpdated",
          text: bestText.trim() || "No text detected",
          visible: true,
        });
        dispatch({ tag: "OcrStatusUpdated", text: "Text extracted" });
        return;
      }
      case "STUDY_LOAD": {
        const result = await loadStudy(cmd.pdfId);
        if (result.ok) {
          dispatch({ tag: "StudyLoaded", study: result.value });
        } else {
          dispatch({ tag: "Error", scope: "study", message: result.error });
        }
        return;
      }
      case "STUDY_SAVE": {
        const study = buildStudy(model);
        const result = await saveStudy(cmd.pdfId, study);
        if (result.ok) {
          dispatch({ tag: "StudySaved" });
        } else {
          dispatch({ tag: "Error", scope: "study", message: result.error });
        }
        return;
      }
      case "STUDY_DELETE":
        return;
      case "BOARD_STATUS_POLL_START": {
        if (resources.boardStatusTimer) {
          window.clearInterval(resources.boardStatusTimer);
        }
        const poll = async () => {
          const status = await fetchStatus();
          if (status.ok) {
            dispatch({
              tag: "BoardStatusUpdated",
              available: status.value.available,
              connected: status.value.connected,
            });
          }
        };
        void poll();
        const timer = window.setInterval(poll, cmd.everyMs);
        resources.boardStatusTimer = timer;
        return;
      }
      case "BOARD_STATUS_POLL_STOP":
        if (resources.boardStatusTimer) {
          window.clearInterval(resources.boardStatusTimer);
          resources.boardStatusTimer = null;
        }
        return;
      case "CHESSNUT_SET_FEN": {
        await setFen(cmd.fen, cmd.force);
        return;
      }
      case "CHESSNUT_POLL_START": {
        if (resources.chessnutPollTimer) {
          window.clearInterval(resources.chessnutPollTimer);
        }
        const timer = window.setInterval(async () => {
          const result = await fetchFen();
          if (result.ok) {
            dispatch({ tag: "BoardFenUpdated", fen: result.value });
          }
        }, cmd.everyMs);
        resources.chessnutPollTimer = timer;
        return;
      }
      case "CHESSNUT_POLL_STOP":
        if (resources.chessnutPollTimer) {
          window.clearInterval(resources.chessnutPollTimer);
          resources.chessnutPollTimer = null;
        }
        return;
      case "REACH_SYNC_BOARD":
        await setFen(cmd.fen, true);
        return;
      case "REACH_HANDLE_PHYSICAL":
        return;
      case "ENGINE_START": {
        if (!resources.stockfish) {
          resources.stockfish = createStockfish((info) =>
            dispatch({ tag: "EngineInfo", evalText: info.evalText, pv: info.pv }),
          );
        }
        if (resources.stockfish) {
          startEngine(resources.stockfish);
          dispatch({ tag: "EngineStarted" });
        }
        return;
      }
      case "ENGINE_STOP":
        if (resources.stockfish) {
          stopEngine(resources.stockfish);
          dispatch({ tag: "EngineStopped" });
        }
        return;
      case "ENGINE_ANALYZE":
        if (resources.stockfish) {
          analyze(resources.stockfish, cmd.fen, cmd.depth);
        }
        return;
      case "ANALYSIS_SYNC":
        if (resources.stockfish && model.engine.running) {
          analyze(resources.stockfish, cmd.fen, 16);
        }
        return;
      case "CLIPBOARD_WRITE":
        try {
          await navigator.clipboard.writeText(cmd.text);
        } catch {
          dispatch({ tag: "Error", scope: "clipboard", message: "Clipboard unavailable" });
        }
        return;
      case "CHESSBOARD_READ_PREVIEW":
        if (resources.previewBoard) {
          const placement = getBoardFen(resources.previewBoard);
          dispatch({ tag: "PiecesConfirmed", placement });
        }
        return;
      case "OPEN_REACH_MODAL": {
        const session =
          model.workflow.tag === "REACHING" ? model.workflow.session : null;
        if (!session) return;
        resources.reachGame = new Chess(session.startFen);
        const onDragStart = (_source: string, piece: string) => {
          if (!resources.reachGame) return false;
          if (resources.reachGame.game_over()) return false;
          const turn = resources.reachGame.turn();
          if ((turn === "w" && piece.startsWith("b")) || (turn === "b" && piece.startsWith("w"))) {
            return false;
          }
          return true;
        };
        const onDrop = (source: string, target: string) => {
          if (!resources.reachGame) return "snapback";
          const move = resources.reachGame.move({ from: source, to: target, promotion: "q" });
          if (!move) return "snapback";
          dispatch({ tag: "ReachMoveMade", san: asSan(move.san), fen: asFenFull(resources.reachGame.fen()) });
          return undefined;
        };
        const onSnapEnd = () => {
          if (!resources.reachGame || !resources.reachBoards.entry) return;
          resources.reachBoards.entry.position(resources.reachGame.fen());
        };
        resources.reachBoards.start?.destroy();
        resources.reachBoards.entry?.destroy();
        resources.reachBoards.target?.destroy();
        const startPlacement = String(session.startFen).split(" ")[0];
        const targetPlacement = String(session.targetFen);
        resources.reachBoards.start = createBoard("reach-start-board", {
          position: startPlacement,
          draggable: false,
          showNotation: false,
          pieceTheme: "/static/vendor/img/chesspieces/wikipedia/{piece}.png",
        });
        resources.reachBoards.entry = createBoard("reach-entry-board", {
          position: startPlacement,
          draggable: true,
          showNotation: true,
          pieceTheme: "/static/vendor/img/chesspieces/wikipedia/{piece}.png",
          onDragStart,
          onDrop,
          onSnapEnd,
        });
        resources.reachBoards.target = createBoard("reach-target-board", {
          position: targetPlacement,
          draggable: false,
          showNotation: false,
          pieceTheme: "/static/vendor/img/chesspieces/wikipedia/{piece}.png",
        });
        els.reachStartLabel.textContent = session.baseAnalysisId ? "Continue from game" : "Starting position";
        window.setTimeout(() => {
          resources.reachBoards.start?.resize();
          resources.reachBoards.entry?.resize();
          resources.reachBoards.target?.resize();
        }, 50);
        return;
      }
      case "CLOSE_REACH_MODAL":
        resources.reachBoards.start?.destroy();
        resources.reachBoards.entry?.destroy();
        resources.reachBoards.target?.destroy();
        resources.reachBoards = { start: null, entry: null, target: null };
        return;
      case "REACH_SET_MOVES":
        dispatch({ tag: "ReachTargetResolved", moves: cmd.moves, finalFen: cmd.finalFen, turn: null });
        return;
      case "SCHEDULE_SAVE":
        if (resources.saveTimer) {
          window.clearTimeout(resources.saveTimer);
        }
        resources.saveTimer = window.setTimeout(() => {
          if (model.pdf.id) {
            dispatch({ tag: "Status", message: "Saving study..." });
            void runCmd({ tag: "STUDY_SAVE", pdfId: model.pdf.id });
          }
        }, cmd.delayMs);
        return;
      case "NO_OP":
        return;
      default:
        return;
    }
  };

  bindEvents(dispatch, getModel);
  setupPiecePalettes(
    dispatch,
    () => resources.previewBoard,
    () => model.workflow.tag !== "ANALYSIS",
  );
  bindManualSelection(dispatch, getModel);
  render(model, dispatch);
  syncPreviewBoard();
  syncReachBoards();
  window.addEventListener("beforeunload", (event) => {
    if (model.isDirty && model.pdf.id) {
      void runCmd({ tag: "STUDY_SAVE", pdfId: model.pdf.id });
      event.preventDefault();
      event.returnValue = "";
    }
  });
  return { dispatch, getModel };
};
