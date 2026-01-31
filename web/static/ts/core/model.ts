import type { FenFull, FenPlacement, PlacementKey } from "../domain/chess/fen";
import type { San } from "../domain/chess/san";
import type { AnalysisTree, NodePath } from "../domain/chess/analysisTree";
import type { CssBBox, PdfBBox } from "../domain/pdf/bbox";

export type Brand<T, B extends string> = T & { readonly __brand: B };

export type PdfId = Brand<string, "PdfId">;
export type ContentHash = Brand<string, "ContentHash">;
export type GameId = Brand<string, "GameId">;

export type PageNum = Brand<number, "PageNum1">;
export type PageIndex = Brand<number, "PageIndex0">;

export type CssPx = Brand<number, "CssPx">;
export type PdfPx = Brand<number, "PdfPx">;
export type RetinaPx = Brand<number, "RetinaPx">;

export const asPdfId = (value: string): PdfId => value as PdfId;
export const asContentHash = (value: string): ContentHash => value as ContentHash;
export const asGameId = (value: string): GameId => value as GameId;
export const asPageNum = (value: number): PageNum => value as PageNum;
export const asPageIndex = (value: number): PageIndex => value as PageIndex;
export const asCssPx = (value: number): CssPx => value as CssPx;
export const asPdfPx = (value: number): PdfPx => value as PdfPx;
export const asRetinaPx = (value: number): RetinaPx => value as RetinaPx;

export type TextSelectMode = "ocr" | "overlay";
export type ReachMode = "manual" | "otb";

export type EngineState = Readonly<{
  running: boolean;
  evalText: string;
  pv: string;
}>;

export type BoardStatus = Readonly<{
  available: boolean;
  connected: boolean;
}>;

export type Game = Readonly<{
  id: GameId;
  page: PageNum;
  bbox: PdfBBox;
  displayBbox?: CssBBox;
  fen: FenPlacement;
  confidence: number;
  pending: boolean;
}>;

export type ContinuationLink = Readonly<{
  analysisId: GameId;
  nodePath: NodePath;
}>;

export type ContinuationPrompt = Readonly<{
  posId: GameId;
  analysisId: GameId;
  nodePath: NodePath;
  sourcePage: PageNum;
}>;

export type PendingGame = Readonly<{
  gameId: GameId;
  targetFen: FenPlacement;
  page: PageNum;
  bbox: PdfBBox;
  confidence: number;
}>;

export type ReachSession = Readonly<{
  targetFen: FenPlacement;
  startFen: FenFull;
  currentFen: FenFull;
  baseAnalysisId: GameId | null;
  gameId: GameId;
  moves: ReadonlyArray<San>;
  mode: ReachMode | null;
  turn: "w" | "b";
}>;

export type Workflow =
  | { tag: "NO_PDF" }
  | { tag: "VIEWING"; activeGameId: GameId | null }
  | { tag: "PENDING_CONFIRM"; pending: PendingGame }
  | {
      tag: "MATCH_EXISTING";
      pending: PendingGame;
      candidates: ReadonlyArray<GameId>;
      selected: GameId | null;
    }
  | { tag: "REACHING"; session: ReachSession }
  | { tag: "ANALYSIS"; activeGameId: GameId; cursor: NodePath };

export type PdfState = Readonly<{
  id: PdfId | null;
  contentHash: ContentHash | null;
  filename: string | null;
  currentPage: PageNum;
  totalPages: number;
  scale: number;
  initialScaleSet: boolean;
}>;

export type DiagramPage = Readonly<{
  page: PageNum;
  diagrams: ReadonlyArray<PdfBBox>;
}>;

export type UiState = Readonly<{
  statusMessage: string;
  textSelectMode: TextSelectMode | null;
  textOverlayText: string;
  textOverlayVisible: boolean;
  ocrStatus: string;
  openingInputVisible: boolean;
  openingMovesInput: string;
  selectedPiece: string | null;
  editingPosition: boolean;
  settingUpFen: boolean;
  boardOrientation: "white" | "black";
}>;

export type Model = Readonly<{
  pdf: PdfState;
  diagrams: DiagramPage | null;
  games: ReadonlyArray<Game>;
  analyses: Readonly<Record<GameId, AnalysisTree>>;
  continuations: Readonly<Record<GameId, ContinuationLink>>;
  continuationPrompt: ContinuationPrompt | null;
  workflow: Workflow;
  currentNode: NodePath | null;
  engine: EngineState;
  boardStatus: BoardStatus;
  recognitionInProgress: number | null;  // Index of diagram being recognized, null if none
  isDirty: boolean;
  ui: UiState;
  placementKeyIndex: Readonly<Record<PlacementKey, GameId>>;
}>;

export type Study = Readonly<{
  games: ReadonlyArray<Game>;
  analyses: Readonly<Record<GameId, AnalysisTree>>;
  continuations: Readonly<Record<GameId, ContinuationLink>>;
}>;

export const initialModel: Model = {
  pdf: {
    id: null,
    contentHash: null,
    filename: null,
    currentPage: 1 as PageNum,
    totalPages: 0,
    scale: 1,
    initialScaleSet: false,
  },
  diagrams: null,
  games: [],
  analyses: {},
  continuations: {},
  continuationPrompt: null,
  workflow: { tag: "NO_PDF" },
  currentNode: null,
  engine: {
    running: false,
    evalText: "-",
    pv: "-",
  },
  boardStatus: {
    available: false,
    connected: false,
  },
  recognitionInProgress: null,
  isDirty: false,
  ui: {
    statusMessage: "Ready",
    textSelectMode: null,
    textOverlayText: "",
    textOverlayVisible: false,
    ocrStatus: "",
    openingInputVisible: false,
    openingMovesInput: "",
    selectedPiece: null,
    editingPosition: false,
    settingUpFen: false,
    boardOrientation: "white",
  },
  placementKeyIndex: {},
};
