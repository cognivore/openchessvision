import type { CssBBox } from "../../domain/pdf/bbox";
import { bbox } from "../../domain/pdf/bbox";
import { asCssPx } from "../../core/model";

type OverlayHandlers = Readonly<{
  onClick: (rect: CssBBox, index: number) => void;
  onResize: (rect: CssBBox) => void;
}>;

type ResizeState = {
  rect: SVGRectElement;
  corner: "nw" | "ne" | "sw" | "se";
  startX: number;
  startY: number;
  origX: number;
  origY: number;
  origW: number;
  origH: number;
  onResize: (rect: CssBBox) => void;
};

let resizeState: ResizeState | null = null;

const parseAttr = (rect: SVGRectElement, attr: string): number =>
  Number.parseFloat(rect.getAttribute(attr) ?? "0");

const rectToBBox = (rect: SVGRectElement): CssBBox =>
  bbox(
    asCssPx(parseAttr(rect, "x")),
    asCssPx(parseAttr(rect, "y")),
    asCssPx(parseAttr(rect, "width")),
    asCssPx(parseAttr(rect, "height")),
  );

const startResize = (
  event: MouseEvent,
  rect: SVGRectElement,
  corner: ResizeState["corner"],
  onResize: (rect: CssBBox) => void,
): void => {
  event.stopPropagation();
  resizeState = {
    rect,
    corner,
    startX: event.clientX,
    startY: event.clientY,
    origX: parseAttr(rect, "x"),
    origY: parseAttr(rect, "y"),
    origW: parseAttr(rect, "width"),
    origH: parseAttr(rect, "height"),
    onResize,
  };
  document.addEventListener("mousemove", doResize);
  document.addEventListener("mouseup", endResize);
};

const doResize = (event: MouseEvent): void => {
  if (!resizeState) return;
  const dx = event.clientX - resizeState.startX;
  const dy = event.clientY - resizeState.startY;
  const { origX, origY, origW, origH } = resizeState;
  switch (resizeState.corner) {
    case "nw":
      resizeState.rect.setAttribute("x", String(origX + dx));
      resizeState.rect.setAttribute("y", String(origY + dy));
      resizeState.rect.setAttribute("width", String(origW - dx));
      resizeState.rect.setAttribute("height", String(origH - dy));
      break;
    case "ne":
      resizeState.rect.setAttribute("y", String(origY + dy));
      resizeState.rect.setAttribute("width", String(origW + dx));
      resizeState.rect.setAttribute("height", String(origH - dy));
      break;
    case "sw":
      resizeState.rect.setAttribute("x", String(origX + dx));
      resizeState.rect.setAttribute("width", String(origW - dx));
      resizeState.rect.setAttribute("height", String(origH + dy));
      break;
    case "se":
      resizeState.rect.setAttribute("width", String(origW + dx));
      resizeState.rect.setAttribute("height", String(origH + dy));
      break;
    default:
      break;
  }
};

const endResize = (): void => {
  if (!resizeState) return;
  const { rect, onResize } = resizeState;
  resizeState = null;
  document.removeEventListener("mousemove", doResize);
  document.removeEventListener("mouseup", endResize);
  onResize(rectToBBox(rect));
};

export const clearOverlay = (overlay: SVGSVGElement): void => {
  overlay.innerHTML = "";
};

export const renderOverlay = (
  overlay: SVGSVGElement,
  diagrams: ReadonlyArray<CssBBox>,
  handlers: OverlayHandlers,
  activeIndex: number | null,
  loadingIndex: number | null = null,
): void => {
  clearOverlay(overlay);

  // Clear any existing click handler
  overlay.onclick = null;

  diagrams.forEach((diagram, index) => {
    const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    rect.setAttribute("x", String(diagram.x));
    rect.setAttribute("y", String(diagram.y));
    rect.setAttribute("width", String(diagram.width));
    rect.setAttribute("height", String(diagram.height));
    rect.setAttribute("data-index", String(index));
    rect.classList.add("detection-box");
    if (activeIndex === index) {
      rect.classList.add("active");
    }
    if (loadingIndex === index) {
      rect.classList.add("loading");
      // Add loading spinner
      const cx = (diagram.x as number) + (diagram.width as number) / 2;
      const cy = (diagram.y as number) + (diagram.height as number) / 2;
      const spinner = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      spinner.setAttribute("cx", String(cx));
      spinner.setAttribute("cy", String(cy));
      spinner.setAttribute("r", "20");
      spinner.classList.add("loading-spinner");
      overlay.appendChild(spinner);
    }
    // Direct click handler on the rect element
    const handleClick = (e: Event) => {
      console.log("[DEBUG] RECT CLICK FIRED! index:", index, "event type:", e.type);
      e.stopPropagation();
      e.preventDefault();
      handlers.onClick(rectToBBox(rect), index);
    };
    rect.addEventListener("click", handleClick);
    rect.addEventListener("touchend", handleClick);
    // Make sure rect is clickable
    rect.style.pointerEvents = "auto";
    rect.style.cursor = "pointer";
    console.log("[DEBUG] Appending rect", index, "at", diagram.x, diagram.y, diagram.width, diagram.height);
    overlay.appendChild(rect);
    addResizeHandles(overlay, rect, handlers.onResize);
  });
};

const addResizeHandles = (
  overlay: SVGSVGElement,
  rect: SVGRectElement,
  onResize: (rect: CssBBox) => void,
): void => {
  const corners: Array<ResizeState["corner"]> = ["nw", "ne", "sw", "se"];
  const x = parseAttr(rect, "x");
  const y = parseAttr(rect, "y");
  const w = parseAttr(rect, "width");
  const h = parseAttr(rect, "height");

  corners.forEach((corner) => {
    const handle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    handle.setAttribute("r", "5");
    handle.classList.add("resize-handle");
    let cx = x;
    let cy = y;
    switch (corner) {
      case "ne":
        cx = x + w;
        cy = y;
        break;
      case "sw":
        cx = x;
        cy = y + h;
        break;
      case "se":
        cx = x + w;
        cy = y + h;
        break;
      default:
        break;
    }
    handle.setAttribute("cx", String(cx));
    handle.setAttribute("cy", String(cy));
    handle.addEventListener("mousedown", (event) => startResize(event, rect, corner, onResize));
    overlay.appendChild(handle);
  });
};
