import type { ContentHash, GameId, PageNum, PageIndex, PdfId, Study } from "./model";
import type { FenFull, FenPlacement } from "../domain/chess/fen";
import type { NodePath } from "../domain/chess/analysisTree";
import type { San } from "../domain/chess/san";
import type { CssBBox, PdfBBox } from "../domain/pdf/bbox";

export type Msg =
  | { tag: "Error"; scope: string; message: string }
  | { tag: "Status"; message: string }
  | { tag: "PdfFileSelected"; file: File }
  | { tag: "PdfOpened"; pdfId: PdfId; pages: number; filename: string; contentHash: ContentHash }
  | { tag: "PdfClosed" }
  | { tag: "PageRequested"; page: PageNum }
  | { tag: "PageRendered"; page: PageNum; scale: number; initialScaleSet: boolean }
  | { tag: "ZoomChanged"; scale: number }
  | { tag: "DiagramsDetected"; page: PageNum; diagrams: ReadonlyArray<PdfBBox> }
  | { tag: "DiagramActivated"; gameId: GameId | null }
  | { tag: "DeleteGame"; gameId: GameId }
  | { tag: "DiagramClicked"; page: PageNum; bbox: CssBBox; diagramIndex: number }
  | { tag: "DiagramResized"; page: PageNum; bbox: CssBBox }
  | {
      tag: "Recognized";
      page: PageNum;
      bbox: PdfBBox;
      placement: FenPlacement;
      confidence: number;
      gameId: GameId;
    }
  | { tag: "RecognitionFailed"; message: string }
  | { tag: "ConfirmPieces" }
  | { tag: "PiecesConfirmed"; placement: FenPlacement }
  | { tag: "EditPieces" }
  | { tag: "CancelEdit" }
  | { tag: "SelectCandidate"; gameId: GameId }
  | { tag: "MatchGameSelected"; gameId: GameId }
  | { tag: "ContinueSelectedGame" }
  | { tag: "StartNewGame" }
  | { tag: "ReachStartManual" }
  | { tag: "ReachStartOtb" }
  | { tag: "ReachMoveMade"; san: San; fen: FenFull }
  | { tag: "ReachUndo" }
  | { tag: "ReachReset" }
  | { tag: "ReachDone" }
  | { tag: "ReachCancel" }
  | { tag: "ReachTargetResolved"; moves: ReadonlyArray<San>; finalFen: FenFull; turn: "w" | "b" | null }
  | { tag: "TextSelectModeChanged"; mode: "ocr" | "overlay" | null }
  | { tag: "TextOverlayUpdated"; text: string; visible: boolean }
  | { tag: "OcrStatusUpdated"; text: string }
  | { tag: "ExtractMovesRequested"; page: PageIndex; bbox: PdfBBox }
  | { tag: "ExtractMovesFailed"; message: string }
  | { tag: "AnalysisStarted"; gameId: GameId; turn: "w" | "b" }
  | { tag: "AnalysisMoveMade"; san: San; fen: FenFull }
  | { tag: "AnalysisGoBack" }
  | { tag: "AnalysisGoForward" }
  | { tag: "AnalysisNextVariation" }
  | { tag: "AnalysisPrevVariation" }
  | { tag: "AnalysisDeleteVariation" }
  | { tag: "AnalysisGoTo"; path: NodePath }
  | { tag: "EngineStarted" }
  | { tag: "EngineStopped" }
  | { tag: "EngineToggle" }
  | { tag: "EngineInfo"; evalText: string; pv: string }
  | { tag: "StudySaved" }
  | { tag: "StudyLoaded"; study: Study | null }
  | { tag: "BoardStatusUpdated"; available: boolean; connected: boolean }
  | { tag: "BoardFenUpdated"; fen: FenFull }
  | { tag: "CopyFen" }
  | { tag: "CopyPgn" }
  | { tag: "OpeningsInputShown"; content: string }
  | { tag: "OpeningsInputHidden" };
