import type { Brand } from "../../core/model";

export type File = "a" | "b" | "c" | "d" | "e" | "f" | "g" | "h";
export type Rank = "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8";
export type Square = `${File}${Rank}`;

export type PieceRole = "K" | "Q" | "R" | "B" | "N" | "P";
export type Side = "w" | "b";
export type Piece = `${Side}${PieceRole}`;

export type FenPiece = PieceRole | Lowercase<PieceRole>;

export type San = Brand<string, "San">;

export const asSan = (value: string): San => value as San;
