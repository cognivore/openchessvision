import type { FenPlacement, FenFull } from "../../domain/chess/fen";
import { asFenPlacement } from "../../domain/chess/fen";

export type BoardOrientation = "white" | "black";

export type ChessboardInstance = {
  destroy(): void;
  position(position?: string | Record<string, string>, animate?: boolean): Record<string, string>;
  resize(): void;
  orientation(orientation?: BoardOrientation): BoardOrientation;
};

export type ChessboardConfig = {
  position: string;
  draggable: boolean;
  showNotation: boolean;
  pieceTheme: string;
  orientation?: BoardOrientation;
  onDragStart?: (...args: unknown[]) => boolean | void;
  onDrop?: (...args: unknown[]) => string | void;
  onSnapEnd?: (...args: unknown[]) => void;
  [key: string]: unknown;
};

export const createBoard = (elementId: string, config: ChessboardConfig): ChessboardInstance =>
  Chessboard(elementId, config) as ChessboardInstance;

export const setBoardPosition = (board: ChessboardInstance, fen: FenFull | FenPlacement): void => {
  board.position(String(fen), false);
};

export const getBoardFen = (board: ChessboardInstance): FenPlacement => {
  const position = board.position();
  return asFenPlacement(Chessboard.objToFen(position));
};
