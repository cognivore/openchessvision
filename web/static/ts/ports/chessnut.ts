import type { Result } from "../core/result";
import { err, ok } from "../core/result";
import type { FenFull, FenPlacement } from "../domain/chess/fen";
import { asFenFull } from "../domain/chess/fen";

export type BoardStatus = Readonly<{
  available: boolean;
  connected: boolean;
}>;

export type SyncResult = Readonly<{
  synced: boolean;
  driverSynced: boolean;
  error?: string;
}>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

export const setFen = async (
  fen: FenPlacement,
  force: boolean,
): Promise<Result<SyncResult, string>> => {
  try {
    const response = await fetch("/api/board/set-fen", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fen, force }),
    });
    const data = (await response.json()) as unknown;
    if (!response.ok) {
      if (isRecord(data) && typeof data.error === "string") {
        return err(data.error);
      }
      return err("Failed to sync board");
    }
    if (!isRecord(data)) return err("Invalid board response");
    return ok({
      synced: Boolean(data.synced),
      driverSynced: Boolean(data.driver_synced),
      error: typeof data.error === "string" ? data.error : undefined,
    });
  } catch (error) {
    return err(String(error));
  }
};

export const fetchStatus = async (): Promise<Result<BoardStatus, string>> => {
  try {
    const response = await fetch("/api/board/status", {
      method: "GET",
      signal: AbortSignal.timeout(2000),
    });
    const data = (await response.json()) as unknown;
    if (!response.ok) {
      return err("Board status unavailable");
    }
    if (!isRecord(data)) return err("Invalid board status");
    return ok({
      available: Boolean(data.available),
      connected: Boolean(data.connected),
    });
  } catch (error) {
    return err(String(error));
  }
};

export const fetchFen = async (): Promise<Result<FenFull, string>> => {
  try {
    const response = await fetch("/api/board/fen");
    const data = (await response.json()) as unknown;
    if (!response.ok) {
      return err("Board fen unavailable");
    }
    if (!isRecord(data) || typeof data.fen !== "string") {
      return err("Invalid board fen");
    }
    return ok(asFenFull(data.fen));
  } catch (error) {
    return err(String(error));
  }
};
