import type { ContentHash, PageIndex, PageNum, PdfId } from "./model";
import type { FenFull, FenPlacement } from "../domain/chess/fen";
import type { San } from "../domain/chess/san";
import type { PdfBBox } from "../domain/pdf/bbox";

export type Cmd =
  | { tag: "PDF_LOAD_FILE"; file: File }
  | { tag: "PDF_LOAD_BY_ID"; pdfId: PdfId }
  | { tag: "PDF_RENDER_PAGE"; page: PageNum; scale: number }
  | { tag: "PDF_CANCEL_RENDER" }
  | { tag: "API_CHECK_PDF"; contentHash: ContentHash }
  | { tag: "API_UPLOAD_PDF"; file: File; contentHash: ContentHash }
  | { tag: "API_DETECT_DIAGRAMS"; pdfId: PdfId; page: PageIndex }
  | { tag: "API_RECOGNIZE_REGION"; pdfId: PdfId; page: PageIndex; bbox: PdfBBox }
  | { tag: "API_EXTRACT_MOVES"; pdfId: PdfId; page: PageIndex; bbox: PdfBBox }
  | { tag: "STUDY_SAVE"; pdfId: PdfId }
  | { tag: "STUDY_LOAD"; pdfId: PdfId }
  | { tag: "STUDY_DELETE"; pdfId: PdfId }
  | { tag: "ENGINE_START" }
  | { tag: "ENGINE_STOP" }
  | { tag: "ENGINE_ANALYZE"; fen: FenFull; depth: number }
  | { tag: "CHESSNUT_SET_FEN"; fen: FenPlacement; force: boolean }
  | { tag: "CHESSNUT_POLL_START"; everyMs: number }
  | { tag: "CHESSNUT_POLL_STOP" }
  | { tag: "BOARD_STATUS_POLL_START"; everyMs: number }
  | { tag: "BOARD_STATUS_POLL_STOP" }
  | { tag: "CLIPBOARD_WRITE"; text: string }
  | { tag: "CHESSBOARD_READ_PREVIEW" }
  | { tag: "SCHEDULE_SAVE"; delayMs: number }
  | { tag: "NO_OP" }
  | { tag: "ANALYSIS_SYNC"; fen: FenFull }
  | { tag: "REACH_SYNC_BOARD"; fen: FenPlacement }
  | { tag: "REACH_HANDLE_PHYSICAL"; fen: FenPlacement }
  | { tag: "REACH_SET_MOVES"; moves: ReadonlyArray<San>; finalFen: FenFull };
