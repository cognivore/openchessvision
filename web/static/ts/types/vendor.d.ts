declare const pdfjsLib: {
  GlobalWorkerOptions: { workerSrc: string };
  getDocument: (src: string) => { promise: Promise<PDFDocumentProxy> };
};

type PDFRenderTask = {
  promise: Promise<void>;
  cancel: () => void;
};

type PDFViewport = {
  width: number;
  height: number;
};

type PDFPageProxy = {
  getViewport: (options: { scale: number }) => PDFViewport;
  render: (params: { canvasContext: CanvasRenderingContext2D; viewport: PDFViewport }) => PDFRenderTask;
};

type PDFDocumentProxy = {
  getPage: (pageNumber: number) => Promise<PDFPageProxy>;
};

declare const Chessboard: (elementId: string, config: Record<string, unknown>) => {
  destroy: () => void;
  position: (position?: string | Record<string, string>, animate?: boolean) => Record<string, string>;
  resize: () => void;
};

declare namespace Chessboard {
  function objToFen(position: Record<string, string>): string;
}

declare class Chess {
  constructor(fen?: string);
  fen(): string;
  turn(): "w" | "b";
  move(move: string | { from: string; to: string; promotion?: string }): { san: string } | null;
  moves(options?: { verbose?: boolean }): Array<{
    san: string;
    from: string;
    to: string;
    promotion?: string;
  }>;
  game_over(): boolean;
}
