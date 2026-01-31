import type { Game, GameId, Model, PendingGame, Workflow } from "./model";
import type { AnalysisTree, NodePath } from "../domain/chess/analysisTree";
import { getNode } from "../domain/chess/analysisTree";

export const getActiveGameId = (workflow: Workflow): GameId | null => {
  switch (workflow.tag) {
    case "VIEWING":
      return workflow.activeGameId;
    case "PENDING_CONFIRM":
      return workflow.pending.gameId;
    case "MATCH_EXISTING":
      return workflow.pending.gameId;
    case "REACHING":
      return workflow.session.gameId;
    case "ANALYSIS":
      return workflow.activeGameId;
    case "NO_PDF":
      return null;
    default:
      return null;
  }
};

export const getPendingGame = (workflow: Workflow): PendingGame | null => {
  switch (workflow.tag) {
    case "PENDING_CONFIRM":
      return workflow.pending;
    case "MATCH_EXISTING":
      return workflow.pending;
    default:
      return null;
  }
};

export const getActiveGame = (model: Model): Game | null => {
  const id = getActiveGameId(model.workflow);
  if (!id) return null;
  return model.games.find((game) => game.id === id) ?? null;
};

export type AnalysisContext = Readonly<{
  tree: AnalysisTree;
  nodePath: NodePath;
  analysisId: GameId;
}>;

export const getAnalysisContext = (model: Model, gameId: GameId): AnalysisContext | null => {
  const direct = model.analyses[gameId];
  if (direct) {
    return {
      tree: direct,
      nodePath: model.currentNode ?? [],
      analysisId: gameId,
    };
  }
  const link = model.continuations[gameId];
  if (link && model.analyses[link.analysisId]) {
    const cursorOverride =
      model.workflow.tag === "ANALYSIS" && model.workflow.activeGameId === gameId && model.currentNode
        ? model.currentNode
        : null;
    return {
      tree: model.analyses[link.analysisId],
      nodePath: cursorOverride ?? link.nodePath,
      analysisId: link.analysisId,
    };
  }
  return null;
};

export const getAnalysisNodeFen = (model: Model, gameId: GameId): string | null => {
  const ctx = getAnalysisContext(model, gameId);
  if (!ctx) return null;
  const node = getNode(ctx.tree.root, ctx.nodePath);
  return node ? node.fen : null;
};
