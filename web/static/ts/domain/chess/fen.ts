import type { Brand } from "../../core/model";
import type { FenPiece, Square } from "./san";

export type FenPlacement = Brand<string, "FenPlacement">;
export type FenFull = Brand<string, "FenFull">;
export type PlacementKey = Brand<string, "PlacementKey">;

export type FenError =
  | { tag: "EMPTY" }
  | { tag: "INVALID_RANKS"; detail: string }
  | { tag: "INVALID_ROW"; detail: string };

export type PlacementMap = Readonly<Record<Square, FenPiece>>;

const files: ReadonlyArray<string> = ["a", "b", "c", "d", "e", "f", "g", "h"];

export const asFenPlacement = (value: string): FenPlacement => value as FenPlacement;
export const asFenFull = (value: string): FenFull => value as FenFull;

export const placementKey = (placement: FenPlacement): PlacementKey =>
  placement as PlacementKey;

export const extractPlacement = (fen: FenFull | FenPlacement | string): FenPlacement =>
  asFenPlacement(fen.split(" ")[0] ?? "");

export const toFullFen = (placement: FenPlacement, turn: "w" | "b"): FenFull =>
  asFenFull(`${placement} ${turn} KQkq - 0 1`);

export const fenTurn = (fen: FenFull | string): "w" | "b" => {
  const raw = fen.split(" ")[1];
  return raw === "b" ? "b" : "w";
};

export const parseFenPlacement = (raw: string): FenPlacement | FenError => {
  if (!raw || raw.trim().length === 0) {
    return { tag: "EMPTY" };
  }
  const placement = raw.split(" ")[0] ?? "";
  const ranks = placement.split("/");
  if (ranks.length !== 8) {
    return { tag: "INVALID_RANKS", detail: placement };
  }
  for (const rank of ranks) {
    let fileCount = 0;
    for (const char of rank) {
      if (char >= "1" && char <= "8") {
        fileCount += Number(char);
      } else if (/[prnbqkPRNBQK]/.test(char)) {
        fileCount += 1;
      } else {
        return { tag: "INVALID_ROW", detail: rank };
      }
    }
    if (fileCount !== 8) {
      return { tag: "INVALID_ROW", detail: rank };
    }
  }
  return asFenPlacement(placement);
};

export const fenToPlacementMap = (fen: FenFull | FenPlacement): PlacementMap => {
  const placement = extractPlacement(fen);
  const map: Record<Square, FenPiece> = {} as Record<Square, FenPiece>;
  const ranks = placement.split("/");
  for (let r = 0; r < 8; r += 1) {
    const rank = 8 - r;
    let file = 0;
    for (const char of ranks[r] ?? "") {
      if (char >= "1" && char <= "8") {
        file += Number(char);
      } else {
        const square = `${files[file]}${rank}` as Square;
        map[square] = char as FenPiece;
        file += 1;
      }
    }
  }
  return map;
};

export const placementsEqual = (map1: PlacementMap, map2: PlacementMap): boolean => {
  const keys1 = Object.keys(map1).sort();
  const keys2 = Object.keys(map2).sort();
  if (keys1.length !== keys2.length) return false;
  for (let i = 0; i < keys1.length; i += 1) {
    const key = keys1[i] as Square;
    if (key !== keys2[i]) return false;
    if (map1[key] !== map2[key]) return false;
  }
  return true;
};
