import type { FenFull } from "../domain/chess/fen";

export type StockfishHandle = {
  worker: Worker;
};

export type EngineInfo = Readonly<{
  evalText: string;
  pv: string;
}>;

const parseScore = (line: string): string | null => {
  const match = line.match(/score (cp|mate) (-?\d+)/);
  if (!match) return null;
  const type = match[1];
  const value = Number.parseInt(match[2], 10);
  if (Number.isNaN(value)) return null;
  if (type === "cp") {
    const evalText = (value / 100).toFixed(2);
    return value >= 0 ? `+${evalText}` : evalText;
  }
  return value >= 0 ? `M${value}` : `-M${Math.abs(value)}`;
};

const parsePv = (line: string): string | null => {
  const match = line.match(/pv (.+)/);
  if (!match) return null;
  return match[1].split(" ").slice(0, 8).join(" ");
};

export const createStockfish = (onInfo: (info: EngineInfo) => void): StockfishHandle | null => {
  try {
    const worker = new Worker("/static/js/stockfish-worker.js");
    worker.onmessage = (event) => {
      const line = String(event.data ?? "");
      if (line.startsWith("info") && line.includes("score")) {
        const evalText = parseScore(line);
        const pv = parsePv(line);
        if (evalText || pv) {
          onInfo({ evalText: evalText ?? "-", pv: pv ?? "-" });
        }
      }
    };
    worker.postMessage("uci");
    worker.postMessage("isready");
    return { worker };
  } catch {
    return null;
  }
};

export const startEngine = (engine: StockfishHandle): void => {
  engine.worker.postMessage("uci");
  engine.worker.postMessage("isready");
};

export const stopEngine = (engine: StockfishHandle): void => {
  engine.worker.postMessage("stop");
};

export const analyze = (engine: StockfishHandle, fen: FenFull, depth: number): void => {
  engine.worker.postMessage(`position fen ${fen}`);
  engine.worker.postMessage(`go depth ${depth}`);
};
