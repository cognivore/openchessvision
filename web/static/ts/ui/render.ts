import type { Msg } from "../core/msg";
import type { Model, GameId } from "../core/model";
import { getActiveGame, getActiveGameId } from "../core/selectors";
import { pdfToCssBBox } from "../domain/pdf/bbox";
import { els } from "./dom";
import { asSan } from "../domain/chess/san";
import { clearOverlay, renderOverlay } from "./adapters/overlay";

// Board row mode determines which boards and actions to show
type BoardRowMode =
  | { tag: "hidden" }
  | { tag: "confirm"; fen: string }
  | { tag: "match"; beforeFen: string | null; nowFen: string; candidates: ReadonlyArray<GameId> }
  | { tag: "reach"; beforeFen: string; nowFen: string; afterFen: string; moves: number; reached: boolean }
  | { tag: "analysis"; fen: string }
  | { tag: "howReach"; fen: string };

type Dispatch = (msg: Msg) => void;

const toggleHidden = (el: HTMLElement, visible: boolean): void => {
  el.classList.toggle("hidden", !visible);
};

const setText = (el: HTMLElement, text: string): void => {
  el.textContent = text;
};

const updateBoardStatus = (available: boolean, connected: boolean): void => {
  els.boardStatus.classList.remove("offline", "online", "connected");
  const textEl = els.boardStatus.querySelector(".board-status-text");
  if (connected) {
    els.boardStatus.classList.add("connected");
    if (textEl) textEl.textContent = "♟ Board ready";
  } else if (available) {
    els.boardStatus.classList.add("online");
    if (textEl) textEl.textContent = "⚠ No board";
  } else {
    els.boardStatus.classList.add("offline");
    if (textEl) textEl.textContent = "○ Offline";
  }
};

const renderPositions = (model: Model, dispatch: Dispatch): void => {
  els.positionList.innerHTML = "";
  const visibleGames = model.games.filter((game) => !game.pending);
  const activeId = getActiveGameId(model.workflow);
  visibleGames.forEach((game) => {
    const item = document.createElement("div");
    item.className = "position-item";
    item.dataset.id = String(game.id);
    if (activeId === game.id) {
      item.classList.add("active");
    }
    if (model.analyses[game.id] || model.continuations[game.id]) {
      item.classList.add("analysed");
    }
    const isLinked = Boolean(model.continuations[game.id]);
    item.innerHTML = `
      <div class="thumb">
        <div id="thumb-${game.id}" style="width:48px;height:48px;"></div>
      </div>
      <div class="info">
        <div class="page-num">Page ${game.page}${isLinked ? " ↗" : ""}</div>
        <div class="fen-preview">${game.fen}</div>
      </div>
      <button class="btn-delete-position" data-id="${game.id}" title="Delete position">×</button>
    `;
    const deleteBtn = item.querySelector(".btn-delete-position") as HTMLButtonElement | null;
    if (deleteBtn) {
      deleteBtn.addEventListener("click", (event) => {
        event.stopPropagation();
        dispatch({ tag: "DeleteGame", gameId: game.id });
      });
    }
    item.addEventListener("click", () => {
      if (model.pdf.currentPage !== game.page) {
        dispatch({ tag: "PageRequested", page: game.page });
      }
      dispatch({ tag: "DiagramActivated", gameId: game.id });
    });
    els.positionList.appendChild(item);
    setTimeout(() => {
      Chessboard(`thumb-${game.id}`, {
        position: game.fen,
        draggable: false,
        showNotation: false,
        pieceTheme: "/static/vendor/img/chesspieces/wikipedia/{piece}.png",
      });
    }, 10);
  });
};

const renderWorkflowPanels = (model: Model): void => {
  toggleHidden(els.confirmPanel, model.workflow.tag === "PENDING_CONFIRM");
  toggleHidden(els.gameMatchPanel, model.workflow.tag === "MATCH_EXISTING");
  toggleHidden(els.reachPanel, false);
  toggleHidden(els.otbPanel, false);
  toggleHidden(els.ocrPanel, false);
  if (model.workflow.tag === "MATCH_EXISTING") {
    els.btnContinueGame.disabled = model.workflow.candidates.length === 0;
  }
};

const renderOverlayBoards = (model: Model): void => {
  const activeGame = getActiveGame(model);
  // Only show transparent overlay in VIEWING mode (for alignment verification)
  // In ANALYSIS, PENDING_CONFIRM, MATCH_EXISTING, and REACHING modes, use the board row instead
  if (!activeGame || model.workflow.tag !== "VIEWING") {
    toggleHidden(els.boardOverlay, false);
    return;
  }
  const displayBbox = pdfToCssBBox(activeGame.bbox, model.pdf.scale);
  els.boardOverlay.style.left = `${displayBbox.x}px`;
  els.boardOverlay.style.top = `${displayBbox.y}px`;
  els.boardOverlay.style.width = `${displayBbox.width}px`;
  els.boardOverlay.style.height = `${displayBbox.height}px`;
  els.boardOverlay.classList.add("transparent");
  els.boardOverlay.classList.remove("solid");
  toggleHidden(els.boardOverlay, true);
};

const renderDiagramOverlay = (model: Model, dispatch: Dispatch): void => {
  if (!model.diagrams || model.diagrams.page !== model.pdf.currentPage) {
    clearOverlay(els.detectionOverlay);
    return;
  }
  const diagrams = model.diagrams.diagrams.map((diagram) => pdfToCssBBox(diagram, model.pdf.scale));
  const activeGame = getActiveGame(model);
  let activeIndex: number | null = null;
  if (activeGame) {
    const activeBox = pdfToCssBBox(activeGame.bbox, model.pdf.scale);
    let bestDist = Number.POSITIVE_INFINITY;
    diagrams.forEach((diagram, index) => {
      const dx = Math.abs((diagram.x as number) - (activeBox.x as number));
      const dy = Math.abs((diagram.y as number) - (activeBox.y as number));
      const dist = dx + dy;
      if (dist < bestDist) {
        bestDist = dist;
        activeIndex = index;
      }
    });
  }
  renderOverlay(els.detectionOverlay, diagrams, {
    onClick: (rect, index) => dispatch({ tag: "DiagramClicked", page: model.pdf.currentPage, bbox: rect, diagramIndex: index }),
    onResize: (rect) => dispatch({ tag: "DiagramResized", page: model.pdf.currentPage, bbox: rect }),
  }, activeIndex, model.recognitionInProgress);
};

const renderAnalysis = (model: Model, dispatch: Dispatch): void => {
  const noAnalysis = els.analysisContainer.querySelector(".no-analysis") as HTMLElement | null;
  if (model.workflow.tag !== "ANALYSIS") {
    if (noAnalysis) toggleHidden(noAnalysis, true);
    toggleHidden(els.pgnViewer, false);
    toggleHidden(els.enginePanel, false);
    return;
  }
  if (noAnalysis) toggleHidden(noAnalysis, false);
  toggleHidden(els.pgnViewer, true);
  toggleHidden(els.enginePanel, true);
  els.engineEval.textContent = model.engine.evalText;
  els.engineLine.textContent = model.engine.pv;
  els.btnToggleEngine.textContent = model.engine.running ? "⏹ Stop" : "▶ Start";
  const tree = model.analyses[model.workflow.activeGameId];
  if (!tree) {
    els.pgnViewer.textContent = "No moves yet";
    return;
  }
  const currentPath = model.workflow.cursor;
  const pathEquals = (a: ReadonlyArray<string>, b: ReadonlyArray<string>): boolean =>
    a.length === b.length && a.every((item, idx) => item === b[idx]);
  const pathIsPrefix = (prefix: ReadonlyArray<string>, full: ReadonlyArray<string>): boolean =>
    prefix.every((item, idx) => item === full[idx]);

  const renderTree = (
    node: typeof tree.root,
    moveNum: number,
    isWhite: boolean,
    path: ReadonlyArray<string>,
    depth: number,
  ): string => {
    let html = "";
    node.children.forEach((child, index) => {
      if (!child.san) return;
      const childPath = [...path, child.san];
      const isVariation = index > 0;
      if (isVariation && depth === 0) {
        html += " <span class=\"variation\">(";
        if (!isWhite) {
          html += `<span class="move-number">${moveNum}...</span> `;
        }
      }
      if (isWhite && (index === 0 || isVariation)) {
        html += `<span class="move-number">${moveNum}.</span> `;
      }
      const isCurrent = pathEquals(childPath, currentPath);
      const isOnPath = pathIsPrefix(childPath, currentPath);
      const classes = ["move-item"];
      if (isCurrent) classes.push("current");
      if (isOnPath) classes.push("on-path");
      html += `<span class="${classes.join(" ")}" data-path='${JSON.stringify(childPath)}'>${child.san}</span>`;
      const nextMoveNum = isWhite ? moveNum : moveNum + 1;
      html += ` ${renderTree(child, nextMoveNum, !isWhite, childPath, isVariation ? depth + 1 : depth)}`;
      if (isVariation && depth === 0) {
        html += ")</span>";
      }
    });
    return html;
  };

  const fenParts = tree.startFen.split(" ");
  const startMoveNum = Number.parseInt(fenParts[5] ?? "1", 10);
  const isWhiteToMove = (fenParts[1] ?? "w") === "w";
  const movesHtml = renderTree(tree.root, startMoveNum, isWhiteToMove, [], 0);
  els.pgnViewer.innerHTML = `<div class="move-list">${movesHtml || "<em>No moves yet</em>"}</div>`;
  els.pgnViewer.querySelectorAll(".move-item").forEach((el) => {
    el.addEventListener("click", () => {
      const pathRaw = (el as HTMLElement).dataset.path;
      if (!pathRaw) return;
      try {
        const parsed = JSON.parse(pathRaw) as string[];
        dispatch({ tag: "AnalysisGoTo", path: parsed.map(asSan) });
      } catch {
        return;
      }
    });
  });
};

const renderReachModal = (model: Model): void => {
  // Always hide the modal - we use the board row instead
  toggleHidden(els.reachModal, false);
};

const getBoardRowMode = (model: Model): BoardRowMode => {
  switch (model.workflow.tag) {
    case "NO_PDF":
      return { tag: "hidden" };
    case "VIEWING":
      // In viewing mode, we don't show the board row (transparent overlay on PDF instead)
      return { tag: "hidden" };
    case "PENDING_CONFIRM":
      return { tag: "confirm", fen: String(model.workflow.pending.targetFen) };
    case "MATCH_EXISTING": {
      const selectedId = model.workflow.selected;
      const selectedGame = selectedId ? model.games.find(g => g.id === selectedId) : null;
      return {
        tag: "match",
        beforeFen: selectedGame ? String(selectedGame.fen) : null,
        nowFen: String(model.workflow.pending.targetFen),
        candidates: model.workflow.candidates,
      };
    }
    case "REACHING": {
      const session = model.workflow.session;
      const currentPlacement = String(session.currentFen).split(" ")[0];
      return {
        tag: "reach",
        beforeFen: String(session.startFen),
        nowFen: String(session.currentFen),
        afterFen: String(session.targetFen),
        moves: session.moves.length,
        reached: currentPlacement === String(session.targetFen),
      };
    }
    case "ANALYSIS": {
      const game = model.games.find(g => g.id === model.workflow.activeGameId);
      const tree = model.analyses[model.workflow.activeGameId];
      // Get FEN at current cursor position
      let fen = game?.fen ?? "start";
      if (tree && model.workflow.cursor.length > 0) {
        // Navigate to cursor position
        let node = tree.root;
        for (const san of model.workflow.cursor) {
          const child = node.children.find(c => c.san === san);
          if (child) {
            node = child;
          } else {
            break;
          }
        }
        fen = node.fen.split(" ")[0]; // Just the placement part
      }
      return { tag: "analysis", fen };
    }
  }
};

const renderBoardRow = (model: Model, dispatch: Dispatch): void => {
  const mode = getBoardRowMode(model);

  // Hide all action groups first
  toggleHidden(els.boardRowConfirm, false);
  toggleHidden(els.boardRowMatch, false);
  toggleHidden(els.boardRowReach, false);
  toggleHidden(els.boardRowAnalysis, false);
  toggleHidden(els.boardRowHowReach, false);

  // Hide board row if no mode
  if (mode.tag === "hidden") {
    els.boardRow.classList.add("hidden");
    return;
  }

  // Show board row
  els.boardRow.classList.remove("hidden");

  // Configure slots based on mode
  switch (mode.tag) {
    case "confirm":
      // Only "Now" board, confirm/edit actions
      toggleHidden(els.boardSlotBefore, false);
      toggleHidden(els.boardSlotAfter, false);
      toggleHidden(els.boardRowConfirm, true);
      setText(els.nowBoardInfo, "Detected position");
      break;

    case "match":
      // "Before" (selected game) + "Now" (detected), match actions
      toggleHidden(els.boardSlotBefore, mode.beforeFen !== null);
      toggleHidden(els.boardSlotAfter, false);
      toggleHidden(els.boardRowMatch, true);
      setText(els.beforeBoardInfo, "Previous game");
      setText(els.nowBoardInfo, "Detected position");
      // Populate match game select
      els.matchGameSelect.innerHTML = mode.candidates.map((id, idx) => {
        const game = model.games.find(g => g.id === id);
        return `<option value="${id}">Game ${idx + 1} (Page ${game?.page ?? "?"})</option>`;
      }).join("");
      break;

    case "reach":
      // All three boards, reach actions
      toggleHidden(els.boardSlotBefore, true);
      toggleHidden(els.boardSlotAfter, true);
      toggleHidden(els.boardRowReach, true);
      setText(els.beforeBoardInfo, "Starting position");
      setText(els.nowBoardInfo, "Enter moves here");
      // Update reach indicator
      if (mode.reached) {
        els.boardRowReachIndicator.textContent = "✓ Position reached!";
        els.boardRowReachIndicator.classList.add("reached");
        els.boardRowReachIndicator.classList.remove("not-reached");
      } else {
        els.boardRowReachIndicator.textContent = "Target position";
        els.boardRowReachIndicator.classList.remove("reached");
        els.boardRowReachIndicator.classList.add("not-reached");
      }
      setText(els.boardRowReachStatus, `Moves: ${mode.moves}`);
      els.btnRowUndo.disabled = mode.moves === 0;
      els.btnRowDone.disabled = mode.moves === 0;
      break;

    case "analysis":
      // Only "Now" board for analysis, analysis actions
      toggleHidden(els.boardSlotBefore, false);
      toggleHidden(els.boardSlotAfter, false);
      toggleHidden(els.boardRowAnalysis, true);
      setText(els.nowBoardInfo, "");
      break;

    case "howReach":
      // Only "Now" board, how-to-reach actions
      toggleHidden(els.boardSlotBefore, false);
      toggleHidden(els.boardSlotAfter, false);
      toggleHidden(els.boardRowHowReach, true);
      setText(els.nowBoardInfo, "How to reach?");
      break;
  }
};

export const render = (model: Model, dispatch: Dispatch): void => {
  const hasPdf = Boolean(model.pdf.id);
  toggleHidden(els.noPdfMessage, !hasPdf);
  setText(els.pdfInfo, model.pdf.filename ? `${model.pdf.filename} (${model.pdf.totalPages} pages)` : "");
  els.btnPrevPage.disabled = model.pdf.currentPage <= 1;
  els.btnNextPage.disabled = model.pdf.currentPage >= model.pdf.totalPages;
  setText(els.pageInfo, `Page ${model.pdf.currentPage} / ${model.pdf.totalPages}`);
  els.pageInput.value = String(model.pdf.currentPage);
  const zoomPercent = Math.round(model.pdf.scale * 100);
  els.zoomSlider.value = String(zoomPercent);
  setText(els.zoomValue, `${zoomPercent}%`);
  setText(els.statusBar, model.ui.statusMessage);
  updateBoardStatus(model.boardStatus.available, model.boardStatus.connected);
  els.textOverlay.textContent = model.ui.textOverlayText;
  toggleHidden(els.textOverlay, model.ui.textOverlayVisible);
  els.ocrStatus.textContent = model.ui.ocrStatus;
  toggleHidden(els.openingInputPanel, model.ui.openingInputVisible);
  if (model.ui.openingInputVisible) {
    els.openingMovesInput.value = model.ui.openingMovesInput;
  }
  const activeGame = getActiveGame(model);
  const hasActive = Boolean(activeGame);
  const isPending = activeGame?.pending ?? false;
  els.btnAnalyseWhite.disabled = !hasActive || isPending;
  els.btnAnalyseBlack.disabled = !hasActive || isPending;
  els.btnCopyFen.disabled = !hasActive;
  els.btnCopyPgn.disabled = !hasActive;
  els.btnSetOpening.disabled = !hasActive;
  els.btnSelectText.disabled = !hasActive;
  renderPositions(model, dispatch);
  renderWorkflowPanels(model);
  renderOverlayBoards(model);
  renderDiagramOverlay(model, dispatch);
  renderAnalysis(model, dispatch);
  renderReachModal(model);
  renderBoardRow(model, dispatch);
};
