import type { Msg } from "../core/msg";
import type { Model } from "../core/model";
import { cssToPdfBBox, bbox } from "../domain/pdf/bbox";
import { asCssPx } from "../core/model";
import { toPageIndex } from "../domain/pdf/page";
import { els } from "./dom";

type Dispatch = (msg: Msg) => void;
type GetModel = () => Model;

type DragState = {
  startX: number;
  startY: number;
  rect: SVGRectElement;
  mode: "text" | "manual";
};

let dragState: DragState | null = null;

const createRect = (x: number, y: number, className: string): SVGRectElement => {
  const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  rect.setAttribute("x", String(x));
  rect.setAttribute("y", String(y));
  rect.setAttribute("width", "0");
  rect.setAttribute("height", "0");
  rect.classList.add(className);
  return rect;
};

const updateRect = (state: DragState, x: number, y: number): void => {
  const width = Math.abs(x - state.startX);
  const height = state.mode === "manual" ? width : Math.abs(y - state.startY);
  const left = Math.min(state.startX, x);
  const top = state.mode === "manual" ? Math.min(state.startY, state.startY + (y > state.startY ? height : -height)) : Math.min(state.startY, y);
  state.rect.setAttribute("x", String(left));
  state.rect.setAttribute("y", String(top));
  state.rect.setAttribute("width", String(width));
  state.rect.setAttribute("height", String(height));
};

export const bindManualSelection = (dispatch: Dispatch, getModel: GetModel): void => {
  const getLocalPoint = (event: MouseEvent): { x: number; y: number } => {
    const rect = els.detectionOverlay.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };

  els.detectionOverlay.addEventListener("mousedown", (event) => {
    const model = getModel();
    if (!model.pdf.id) return;

    // Don't start a new selection if clicking on an existing detection box
    const target = event.target as Element;
    if (target.classList.contains("detection-box") || target.classList.contains("resize-handle")) {
      return;
    }

    const { x, y } = getLocalPoint(event);
    if (model.ui.textSelectMode) {
      const rect = createRect(x, y, "text-select-box");
      els.detectionOverlay.appendChild(rect);
      dragState = { startX: x, startY: y, rect, mode: "text" };
      return;
    }
    const rect = createRect(x, y, "detection-box");
    rect.classList.add("drawing");
    rect.style.strokeDasharray = "5,5";
    els.detectionOverlay.appendChild(rect);
    dragState = { startX: x, startY: y, rect, mode: "manual" };
  });

  els.detectionOverlay.addEventListener("mousemove", (event) => {
    if (!dragState) return;
    const { x, y } = getLocalPoint(event);
    updateRect(dragState, x, y);
  });

  const endSelection = (event: MouseEvent) => {
    if (!dragState) return;
    const model = getModel();
    const rect = dragState.rect;
    const width = Number.parseFloat(rect.getAttribute("width") ?? "0");
    const height = Number.parseFloat(rect.getAttribute("height") ?? "0");
    const minSize = dragState.mode === "text" ? 20 : 50;
    if (width < minSize || height < minSize) {
      rect.remove();
      dragState = null;
      dispatch({ tag: "TextSelectModeChanged", mode: null });
      return;
    }
    const cssBox = bbox(
      asCssPx(Number.parseFloat(rect.getAttribute("x") ?? "0")),
      asCssPx(Number.parseFloat(rect.getAttribute("y") ?? "0")),
      asCssPx(width),
      asCssPx(height),
    );
    rect.remove();
    if (dragState.mode === "text") {
      dispatch({ tag: "TextSelectModeChanged", mode: null });
      if (model.pdf.id) {
        dispatch({
          tag: "ExtractMovesRequested",
          page: toPageIndex(model.pdf.currentPage),
          bbox: cssToPdfBBox(cssBox, model.pdf.scale),
        });
      }
    } else {
      const diagrams = model.diagrams?.diagrams ?? [];
      const updated = [...diagrams, cssToPdfBBox(cssBox, model.pdf.scale)];
      dispatch({ tag: "DiagramsDetected", page: model.pdf.currentPage, diagrams: updated });
      dispatch({ tag: "Status", message: "Click on the box to recognize the position" });
    }
    dragState = null;
  };

  els.detectionOverlay.addEventListener("mouseup", endSelection);
  els.detectionOverlay.addEventListener("mouseleave", endSelection);
};
