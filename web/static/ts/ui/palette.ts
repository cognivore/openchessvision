import type { Msg } from "../core/msg";
import type { ChessboardInstance } from "./adapters/chessboard";
import { els } from "./dom";

type Dispatch = (msg: Msg) => void;
type GetPreviewBoard = () => ChessboardInstance | null;
type IsEditable = () => boolean;

let selectedPiece: string | null = null;

const pieceTheme = "/static/vendor/img/chesspieces/wikipedia/{piece}.png";

const createPieceImg = (piece: string, dispatch: Dispatch): HTMLImageElement => {
  const img = document.createElement("img");
  img.src = pieceTheme.replace("{piece}", piece);
  img.draggable = true;
  img.dataset.piece = piece;
  img.className = "palette-piece";
  img.addEventListener("dragstart", (event) => {
    event.dataTransfer?.setData("piece", piece);
    event.dataTransfer?.setData("text/plain", piece);
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = "copy";
    }
  });
  img.addEventListener("click", () => {
    document.querySelectorAll(".palette-piece.selected").forEach((el) => {
      el.classList.remove("selected");
    });
    if (selectedPiece === piece) {
      selectedPiece = null;
      dispatch({ tag: "Status", message: "Piece deselected" });
    } else {
      selectedPiece = piece;
      img.classList.add("selected");
      dispatch({
        tag: "Status",
        message: `Selected ${piece} - click on board to place, or click piece again to deselect`,
      });
    }
  });
  return img;
};

const getSquareFromEvent = (event: MouseEvent): string | null => {
  const boardEl = document.getElementById("active-board");
  if (!boardEl) return null;
  const rect = boardEl.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top;
  if (x < 0 || y < 0 || x > rect.width || y > rect.height) return null;
  const squareSize = rect.width / 8;
  const file = Math.floor(x / squareSize);
  const rank = 7 - Math.floor(y / squareSize);
  if (file < 0 || file > 7 || rank < 0 || rank > 7) return null;
  const files = "abcdefgh";
  return `${files[file]}${rank + 1}`;
};

const placePieceOnSquare = (
  board: ChessboardInstance,
  piece: string,
  square: string,
  dispatch: Dispatch,
): void => {
  const current = board.position();
  current[square] = piece;
  board.position(current, false);
  dispatch({ tag: "Status", message: `Placed ${piece} on ${square}` });
};

const removePieceFromSquare = (
  board: ChessboardInstance,
  square: string,
  dispatch: Dispatch,
): void => {
  const current = board.position();
  if (!current[square]) {
    dispatch({ tag: "Status", message: `No piece on ${square}` });
    return;
  }
  const piece = current[square];
  delete current[square];
  board.position(current, false);
  dispatch({ tag: "Status", message: `Removed ${piece} from ${square}` });
};

export const setupPiecePalettes = (
  dispatch: Dispatch,
  getPreviewBoard: GetPreviewBoard,
  isEditable: IsEditable,
): void => {
  const blackPieces = ["bK", "bQ", "bR", "bB", "bN", "bP"];
  const whitePieces = ["wK", "wQ", "wR", "wB", "wN", "wP"];
  els.paletteBlack.innerHTML = "";
  els.paletteWhite.innerHTML = "";
  blackPieces.forEach((piece) => els.paletteBlack.appendChild(createPieceImg(piece, dispatch)));
  whitePieces.forEach((piece) => els.paletteWhite.appendChild(createPieceImg(piece, dispatch)));

  els.boardOverlay.addEventListener("dragover", (event) => {
    console.log("[PALETTE] dragover on boardOverlay");
    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = "copy";
    }
  });
  els.boardOverlay.addEventListener("drop", (event) => {
    console.log("[PALETTE] drop on boardOverlay, piece:", event.dataTransfer?.getData("piece"));
    event.preventDefault();
    if (!isEditable()) {
      dispatch({ tag: "Status", message: "Cannot edit board during analysis" });
      return;
    }
    const board = getPreviewBoard();
    if (!board) {
      console.log("[PALETTE] no board available");
      return;
    }
    const piece = event.dataTransfer?.getData("piece");
    if (!piece) {
      console.log("[PALETTE] no piece in dataTransfer");
      return;
    }
    const square = getSquareFromEvent(event);
    if (!square) {
      console.log("[PALETTE] could not determine square from event");
      return;
    }
    console.log("[PALETTE] placing", piece, "on", square);
    placePieceOnSquare(board, piece, square, dispatch);
  });
  els.boardOverlay.addEventListener("click", (event) => {
    console.log("[PALETTE] click on boardOverlay, selectedPiece:", selectedPiece);
    if (!selectedPiece) return;
    if (!isEditable()) {
      dispatch({ tag: "Status", message: "Cannot edit board during analysis" });
      return;
    }
    const board = getPreviewBoard();
    if (!board) {
      console.log("[PALETTE] no board for click");
      return;
    }
    const square = getSquareFromEvent(event);
    if (!square) {
      console.log("[PALETTE] no square from click event");
      return;
    }
    console.log("[PALETTE] placing", selectedPiece, "on", square, "via click");
    placePieceOnSquare(board, selectedPiece, square, dispatch);
    selectedPiece = null;
    document.querySelectorAll(".palette-piece.selected").forEach((el) => {
      el.classList.remove("selected");
    });
  });
  els.boardOverlay.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    if (!isEditable()) {
      dispatch({ tag: "Status", message: "Cannot edit board during analysis" });
      return;
    }
    const board = getPreviewBoard();
    if (!board) return;
    const square = getSquareFromEvent(event);
    if (!square) return;
    removePieceFromSquare(board, square, dispatch);
  });
};
