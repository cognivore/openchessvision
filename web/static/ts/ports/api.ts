import type { Result } from "../core/result";
import { err, ok } from "../core/result";
import type {
  ContentHash,
  Game,
  GameId,
  PdfId,
  Study,
} from "../core/model";
import {
  asContentHash,
  asGameId,
  asPageNum,
  asPdfId,
  asPdfPx,
} from "../core/model";
import type { FenPlacement } from "../domain/chess/fen";
import { asFenPlacement } from "../domain/chess/fen";
import type { AnalysisTreeJson } from "../domain/chess/analysisTree";
import { analysisTreeFromJSON, analysisTreeToJSON } from "../domain/chess/analysisTree";
import type { San } from "../domain/chess/san";
import { asSan } from "../domain/chess/san";
import type { PdfBBox } from "../domain/pdf/bbox";
import { bbox } from "../domain/pdf/bbox";

type PdfInfo = Readonly<{
  pdfId: PdfId;
  contentHash: ContentHash;
  filename: string;
  pages: number;
  hasStudy: boolean;
}>;

type CheckPdfResult = Readonly<{ exists: false } | { exists: true; info: PdfInfo }>;

type RecognizeResult = Readonly<{ placement: FenPlacement; confidence: number }>;

type ExtractMovesResult = Readonly<{ pdfText: string; ocrText: string }>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const getString = (value: unknown): string | null =>
  typeof value === "string" ? value : null;

const getNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const decodePdfInfo = (data: Record<string, unknown>, filenameOverride?: string): Result<PdfInfo, string> => {
  const pdfId = getString(data.pdf_id);
  const contentHash = getString(data.content_hash) ?? pdfId;
  const pages = getNumber(data.pages);
  const filename = filenameOverride ?? getString(data.filename);
  const hasStudy = typeof data.has_study === "boolean" ? data.has_study : false;
  if (!pdfId || !contentHash || pages === null || !filename) {
    return err("Invalid PDF info response");
  }
  return ok({
    pdfId: asPdfId(pdfId),
    contentHash: asContentHash(contentHash),
    filename,
    pages,
    hasStudy,
  });
};

const decodePdfBBox = (data: Record<string, unknown>): Result<PdfBBox, string> => {
  const x = getNumber(data.x);
  const y = getNumber(data.y);
  const width = getNumber(data.width);
  const height = getNumber(data.height);
  if (x === null || y === null || width === null || height === null) {
    return err("Invalid bbox");
  }
  return ok(bbox(asPdfPx(x), asPdfPx(y), asPdfPx(width), asPdfPx(height)));
};

export const checkPdf = async (contentHash: ContentHash): Promise<Result<CheckPdfResult, string>> => {
  try {
    const response = await fetch(`/api/check-pdf/${contentHash}`);
    if (!response.ok) {
      if (response.status === 404) {
        return ok({ exists: false });
      }
      const errorData = (await response.json().catch(() => null)) as unknown;
      if (isRecord(errorData) && typeof errorData.error === "string") {
        return err(errorData.error);
      }
      return err("Failed to check PDF");
    }
    const data = (await response.json()) as unknown;
    if (!isRecord(data)) {
      return err("Invalid response");
    }
    const decoded = decodePdfInfo(data);
    if (!decoded.ok) return decoded;
    return ok({ exists: true, info: decoded.value });
  } catch (error) {
    return err(String(error));
  }
};

export const uploadPdf = async (
  file: File,
  _contentHash: ContentHash,
): Promise<Result<PdfInfo, string>> => {
  try {
    const formData = new FormData();
    formData.append("file", file);
    const response = await fetch("/api/upload-pdf", {
      method: "POST",
      body: formData,
    });
    const data = (await response.json()) as unknown;
    if (!response.ok) {
      if (isRecord(data) && typeof data.error === "string") {
        return err(data.error);
      }
      return err("Failed to upload PDF");
    }
    if (!isRecord(data)) {
      return err("Invalid response");
    }
    return decodePdfInfo(data, file.name);
  } catch (error) {
    return err(String(error));
  }
};

export const detectDiagrams = async (
  pdfId: PdfId,
  pageIndex: number,
): Promise<Result<ReadonlyArray<PdfBBox>, string>> => {
  try {
    const response = await fetch(`/api/detect-diagrams/${pdfId}/${pageIndex}`);
    const data = (await response.json()) as unknown;
    if (!response.ok) {
      if (isRecord(data) && typeof data.error === "string") {
        return err(data.error);
      }
      return err("Failed to detect diagrams");
    }
    if (!isRecord(data) || !Array.isArray(data.diagrams)) {
      return err("Invalid diagrams response");
    }
    const boxes: PdfBBox[] = [];
    for (const item of data.diagrams) {
      if (!isRecord(item)) {
        return err("Invalid bbox");
      }
      const decoded = decodePdfBBox(item);
      if (!decoded.ok) {
        return err(decoded.error);
      }
      boxes.push(decoded.value);
    }
    return ok(boxes);
  } catch (error) {
    return err(String(error));
  }
};

export const recognizeRegion = async (
  pdfId: PdfId,
  pageIndex: number,
  bbox: PdfBBox,
): Promise<Result<RecognizeResult, string>> => {
  try {
    const response = await fetch("/api/recognize-region", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pdf_id: pdfId,
        page: pageIndex,
        bbox: {
          x: bbox.x,
          y: bbox.y,
          width: bbox.width,
          height: bbox.height,
        },
      }),
    });
    const data = (await response.json()) as unknown;
    if (!response.ok) {
      if (isRecord(data) && typeof data.error === "string") {
        return err(data.error);
      }
      return err("Recognition failed");
    }
    if (!isRecord(data)) return err("Invalid response");
    const fen = getString(data.fen);
    const confidence = getNumber(data.confidence);
    if (!fen || confidence === null) {
      return err("Invalid recognition response");
    }
    return ok({ placement: asFenPlacement(fen), confidence });
  } catch (error) {
    return err(String(error));
  }
};

export const extractMoves = async (
  pdfId: PdfId,
  pageIndex: number,
  bbox: PdfBBox,
): Promise<Result<ExtractMovesResult, string>> => {
  try {
    const response = await fetch("/api/extract-moves", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pdf_id: pdfId,
        page: pageIndex,
        bbox: {
          x: bbox.x,
          y: bbox.y,
          width: bbox.width,
          height: bbox.height,
        },
      }),
    });
    const data = (await response.json()) as unknown;
    if (!response.ok) {
      if (isRecord(data) && typeof data.error === "string") {
        return err(data.error);
      }
      return err("Failed to extract moves");
    }
    if (!isRecord(data)) return err("Invalid response");
    const pdfText = getString(data.pdf_text) ?? "";
    const ocrText = getString(data.ocr_text) ?? "";
    return ok({ pdfText, ocrText });
  } catch (error) {
    return err(String(error));
  }
};

export const saveStudy = async (pdfId: PdfId, study: Study): Promise<Result<void, string>> => {
  try {
    const response = await fetch("/api/save-study", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pdf_id: pdfId,
        study: serializeStudy(study),
      }),
    });
    const data = (await response.json()) as unknown;
    if (!response.ok) {
      if (isRecord(data) && typeof data.error === "string") {
        return err(data.error);
      }
      return err("Failed to save study");
    }
    return ok(undefined);
  } catch (error) {
    return err(String(error));
  }
};

export const loadStudy = async (pdfId: PdfId): Promise<Result<Study | null, string>> => {
  try {
    const response = await fetch(`/api/load-study/${pdfId}`);
    if (!response.ok) {
      if (response.status === 404) {
        return ok(null);
      }
    }
    const data = (await response.json()) as unknown;
    if (!response.ok) {
      if (isRecord(data) && typeof data.error === "string") {
        return err(data.error);
      }
      return err("Failed to load study");
    }
    if (!isRecord(data)) return err("Invalid response");
    if (data.exists !== true || !isRecord(data.study)) {
      return ok(null);
    }
    return decodeStudy(data.study);
  } catch (error) {
    return err(String(error));
  }
};

const serializeStudy = (study: Study): Record<string, unknown> => ({
  games: study.games.filter((game) => !game.pending).map((game) => ({
    id: game.id,
    page: game.page,
    bbox: game.bbox,
    fen: game.fen,
    confidence: game.confidence,
    pending: game.pending,
  })),
  analyses: Object.fromEntries(
    Object.entries(study.analyses).map(([id, tree]) => [id, analysisTreeToJSON(tree)]),
  ),
  continuations: study.continuations,
});

const decodeStudy = (data: Record<string, unknown>): Result<Study, string> => {
  if (!Array.isArray(data.games)) {
    return err("Invalid study games");
  }
  const games: Game[] = [];
  for (const entry of data.games) {
    if (!isRecord(entry)) {
      return err("Invalid game entry");
    }
    const id = getString(entry.id);
    const page = getNumber(entry.page);
    const bboxEntry = entry.bbox;
    const fen = getString(entry.fen);
    const confidence = getNumber(entry.confidence) ?? 0;
    const pending = typeof entry.pending === "boolean" ? entry.pending : false;
    if (!id || page === null || !fen || !isRecord(bboxEntry)) {
      return err("Invalid game data");
    }
    const bboxDecoded = decodePdfBBox(bboxEntry);
    if (!bboxDecoded.ok) {
      return err(bboxDecoded.error);
    }
    games.push({
      id: asGameId(id),
      page: asPageNum(page),
      bbox: bboxDecoded.value,
      fen: asFenPlacement(fen),
      confidence,
      pending,
    });
  }
  const analyses: Record<GameId, import("../domain/chess/analysisTree").AnalysisTree> = {};
  if (isRecord(data.analyses)) {
    for (const [id, treeData] of Object.entries(data.analyses)) {
      if (isRecord(treeData)) {
        analyses[asGameId(id)] = analysisTreeFromJSON(treeData as AnalysisTreeJson);
      }
    }
  }
  const continuations: Record<GameId, { analysisId: GameId; nodePath: ReadonlyArray<San> }> = {};
  if (isRecord(data.continuations)) {
    for (const [id, linkData] of Object.entries(data.continuations)) {
      if (isRecord(linkData)) {
        const analysisId = getString(linkData.analysisId);
        const nodePath = Array.isArray(linkData.nodePath)
          ? linkData.nodePath.map((san) => asSanSafe(san))
          : [];
        if (analysisId) {
          continuations[asGameId(id)] = {
            analysisId: asGameId(analysisId),
            nodePath,
          };
        }
      }
    }
  }
  return ok({ games, analyses, continuations });
};
const asSanSafe = (value: unknown): San => (typeof value === "string" ? asSan(value) : asSan(""));
