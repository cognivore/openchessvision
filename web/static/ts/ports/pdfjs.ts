import type { Result } from "../core/result";
import { err, ok } from "../core/result";
import type { PageNum, PdfId } from "../core/model";

export type PdfResources = {
  doc: PDFDocumentProxy | null;
  renderTask: PDFRenderTask | null;
};

export type RenderTarget = Readonly<{
  canvas: HTMLCanvasElement;
  overlay: SVGSVGElement;
  viewportContainer: HTMLElement;
}>;

export type RenderResult = Readonly<{
  scale: number;
  initialScaleSet: boolean;
}>;

export const loadPdf = async (pdfId: PdfId): Promise<Result<PDFDocumentProxy, string>> => {
  try {
    const pdfUrl = `/api/pdf/${pdfId}`;
    const doc = await pdfjsLib.getDocument(pdfUrl).promise;
    return ok(doc);
  } catch (error) {
    return err(String(error));
  }
};

export const renderPage = async (
  resources: PdfResources,
  target: RenderTarget,
  pageNum: PageNum,
  scale: number,
  initialScaleSet: boolean,
): Promise<Result<RenderResult, string>> => {
  if (!resources.doc) {
    return err("PDF not loaded");
  }
  if (resources.renderTask) {
    try {
      resources.renderTask.cancel();
    } catch {
      // ignore
    }
    resources.renderTask = null;
  }
  try {
    const page = await resources.doc.getPage(pageNum as number);
    let nextScale = scale;
    let nextInitialScaleSet = initialScaleSet;
    if (!initialScaleSet) {
      const containerWidth = target.viewportContainer.clientWidth - 40;
      const defaultViewport = page.getViewport({ scale: 1.0 });
      const fitWidthScale = containerWidth / defaultViewport.width;
      nextScale = Math.min(fitWidthScale, 1.5);
      nextInitialScaleSet = true;
    }
    const viewport = page.getViewport({ scale: nextScale * 2 });
    const ctx = target.canvas.getContext("2d");
    if (!ctx) {
      return err("Canvas context unavailable");
    }
    target.canvas.width = viewport.width;
    target.canvas.height = viewport.height;
    target.canvas.style.width = `${viewport.width / 2}px`;
    target.canvas.style.height = `${viewport.height / 2}px`;
    target.overlay.setAttribute("width", String(viewport.width / 2));
    target.overlay.setAttribute("height", String(viewport.height / 2));
    target.overlay.style.width = `${viewport.width / 2}px`;
    target.overlay.style.height = `${viewport.height / 2}px`;
    resources.renderTask = page.render({ canvasContext: ctx, viewport });
    try {
      await resources.renderTask.promise;
    } catch (error) {
      if ((error as Error).name !== "RenderingCancelledException") {
        return err(String(error));
      }
    } finally {
      resources.renderTask = null;
    }
    return ok({ scale: nextScale, initialScaleSet: nextInitialScaleSet });
  } catch (error) {
    return err(String(error));
  }
};
