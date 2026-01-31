import type { Cmd } from "./cmd";
import type { Msg } from "./msg";
import type {
  Game,
  GameId,
  Model,
  PendingGame,
  ReachSession,
  Study,
  Workflow,
} from "./model";
import { initialModel } from "./model";
import { assertNever } from "./invariant";
import {
  asFenPlacement,
  asFenFull,
  extractPlacement,
  placementKey,
  toFullFen,
  fenTurn,
} from "../domain/chess/fen";
import {
  createAnalysisTree,
  deleteVariation,
  getMainLineLeaf,
  getNextVariation,
  getNode,
  getPrevVariation,
  goBack,
  goForward,
  makeMove,
  toPGN,
} from "../domain/chess/analysisTree";
import { asSan } from "../domain/chess/san";
import { cssToPdfBBox } from "../domain/pdf/bbox";
import { toPageIndex } from "../domain/pdf/page";
import { getActiveGameId, getAnalysisContext } from "./selectors";

type UpdateResult = readonly [Model, ReadonlyArray<Cmd>];

const noCmd: ReadonlyArray<Cmd> = [];

const withStatus = (model: Model, message: string): Model => ({
  ...model,
  ui: {
    ...model.ui,
    statusMessage: message,
  },
});

const buildPlacementIndex = (
  games: ReadonlyArray<Game>,
): Readonly<Record<string, GameId>> => {
  const index: Record<string, GameId> = {};
  games.forEach((game) => {
    if (!game.pending) {
      index[placementKey(game.fen)] = game.id;
    }
  });
  return index;
};

const updateGame = (
  games: ReadonlyArray<Game>,
  gameId: GameId,
  updater: (game: Game) => Game,
): ReadonlyArray<Game> => games.map((game) => (game.id === gameId ? updater(game) : game));

const findExistingByPlacement = (model: Model, placement: string): Game | null =>
  model.games.find((game) => !game.pending && game.fen === placement) ?? null;

const getPendingFromWorkflow = (workflow: Workflow): PendingGame | null => {
  switch (workflow.tag) {
    case "PENDING_CONFIRM":
      return workflow.pending;
    case "MATCH_EXISTING":
      return workflow.pending;
    case "REACHING":
      return null;
    case "NO_PDF":
    case "VIEWING":
    case "ANALYSIS":
      return null;
    default:
      return assertNever(workflow);
  }
};

const applyStudy = (model: Model, study: Study | null): Model => {
  if (!study) {
    return model;
  }
  const games = study.games;
  return {
    ...model,
    games,
    analyses: study.analyses,
    continuations: study.continuations,
    placementKeyIndex: buildPlacementIndex(games),
  };
};

const createReachSession = (
  model: Model,
  pending: PendingGame,
  baseAnalysisId: GameId | null,
): ReachSession => {
  if (baseAnalysisId && model.analyses[baseAnalysisId]) {
    const baseTree = model.analyses[baseAnalysisId];
    const { node } = getMainLineLeaf(baseTree);
    return {
      targetFen: pending.targetFen,
      startFen: node.fen,
      currentFen: node.fen,
      baseAnalysisId,
      gameId: pending.gameId,
      moves: [],
      mode: null,
      turn: fenTurn(node.fen),
    };
  }
  const startFen = toFullFen(
    asFenPlacement("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR"),
    "w",
  );
  return {
    targetFen: pending.targetFen,
    startFen,
    currentFen: startFen,
    baseAnalysisId: null,
    gameId: pending.gameId,
    moves: [],
    mode: null,
    turn: "w",
  };
};

export const update = (model: Model = initialModel, msg: Msg): UpdateResult => {
  switch (msg.tag) {
    case "Status":
      return [withStatus(model, msg.message), noCmd];
    case "Error":
      return [withStatus(model, msg.message), noCmd];
    case "PdfFileSelected":
      return [
        withStatus(model, `Checking ${msg.file.name}...`),
        [{ tag: "PDF_LOAD_FILE", file: msg.file }],
      ];
    case "PdfOpened": {
      const nextModel: Model = {
        ...model,
        pdf: {
          id: msg.pdfId,
          contentHash: msg.contentHash,
          filename: msg.filename,
          currentPage: 1 as Model["pdf"]["currentPage"],
          totalPages: msg.pages,
          scale: 1,
          initialScaleSet: false,
        },
        diagrams: null,
        games: [],
        analyses: {},
        continuations: {},
        continuationPrompt: null,
        workflow: { tag: "VIEWING", activeGameId: null },
        currentNode: null,
        recognitionInProgress: null,
        isDirty: false,
        placementKeyIndex: {},
        ui: initialModel.ui,
      };
      return [
        withStatus(nextModel, `Loaded ${msg.filename}`),
        [
          { tag: "STUDY_LOAD", pdfId: msg.pdfId },
          { tag: "PDF_RENDER_PAGE", page: 1 as Model["pdf"]["currentPage"], scale: 1 },
          { tag: "BOARD_STATUS_POLL_START", everyMs: 5000 },
        ],
      ];
    }
    case "PdfClosed":
      return [initialModel, noCmd];
    case "PageRequested": {
      const nextModel = {
        ...model,
        pdf: {
          ...model.pdf,
          currentPage: msg.page,
        },
      };
      return [nextModel, [{ tag: "PDF_RENDER_PAGE", page: msg.page, scale: model.pdf.scale }]];
    }
    case "PageRendered": {
      const nextModel = {
        ...model,
        pdf: {
          ...model.pdf,
          currentPage: msg.page,
          scale: msg.scale,
          initialScaleSet: msg.initialScaleSet,
        },
      };
      if (!model.pdf.id) {
        return [nextModel, noCmd];
      }
      return [
        nextModel,
        [
          {
            tag: "API_DETECT_DIAGRAMS",
            pdfId: model.pdf.id,
            page: toPageIndex(msg.page),
          },
        ],
      ];
    }
    case "ZoomChanged": {
      const nextModel = {
        ...model,
        pdf: {
          ...model.pdf,
          scale: msg.scale,
          initialScaleSet: true,
        },
      };
      return [
        nextModel,
        [{ tag: "PDF_RENDER_PAGE", page: model.pdf.currentPage, scale: msg.scale }],
      ];
    }
    case "DiagramsDetected": {
      const nextModel = {
        ...model,
        diagrams: { page: msg.page, diagrams: msg.diagrams },
      };
      return [withStatus(nextModel, `Found ${msg.diagrams.length} potential diagrams`), noCmd];
    }
    case "DiagramActivated":
      return [
        {
          ...model,
          workflow:
            msg.gameId === null
              ? { tag: "VIEWING", activeGameId: null }
              : { tag: "VIEWING", activeGameId: msg.gameId },
        },
        noCmd,
      ];
    case "DeleteGame": {
      const filtered = model.games.filter((game) => game.id !== msg.gameId);
      const continuations = Object.fromEntries(
        Object.entries(model.continuations).filter(([key, link]) => {
          if (key === msg.gameId) return false;
          return link.analysisId !== msg.gameId;
        }),
      );
      const analyses = { ...model.analyses };
      delete analyses[msg.gameId];
      const activeId = getActiveGameId(model.workflow);
      const nextWorkflow =
        activeId === msg.gameId ? { tag: "VIEWING", activeGameId: null as GameId | null } : model.workflow;
      const nextModel = {
        ...model,
        games: filtered,
        analyses,
        continuations,
        placementKeyIndex: buildPlacementIndex(filtered),
        workflow: nextWorkflow,
      };
      return [withStatus(nextModel, "Deleted game"), [{ tag: "SCHEDULE_SAVE", delayMs: 2000 }]];
    }
    case "DiagramClicked": {
      console.log("[DEBUG] DiagramClicked received:", msg);
      console.log("[DEBUG] model.pdf.id:", model.pdf.id);
      console.log("[DEBUG] model.recognitionInProgress:", model.recognitionInProgress);
      if (!model.pdf.id) {
        return [withStatus(model, "No PDF loaded"), noCmd];
      }
      if (model.recognitionInProgress !== null) {
        return [withStatus(model, "Recognition already in progress..."), noCmd];
      }
      const pdfBBox = cssToPdfBBox(msg.bbox, model.pdf.scale);
      const nextModel = {
        ...model,
        recognitionInProgress: msg.diagramIndex,
      };
      return [
        withStatus(nextModel, "Recognizing position..."),
        [
          {
            tag: "API_RECOGNIZE_REGION",
            pdfId: model.pdf.id,
            page: toPageIndex(msg.page),
            bbox: pdfBBox,
          },
        ],
      ];
    }
    case "DiagramResized":
      return [model, noCmd];
    case "Recognized": {
      const existing = findExistingByPlacement(model, msg.placement);
      if (existing) {
        const nextModel = {
          ...model,
          recognitionInProgress: null,
          workflow: { tag: "VIEWING", activeGameId: existing.id },
        };
        return [
          withStatus(nextModel, `Game already saved (Page ${(existing.page as number) ?? "?"})`),
          [{ tag: "CHESSNUT_SET_FEN", fen: msg.placement, force: true }],
        ];
      }
      const pending: PendingGame = {
        gameId: msg.gameId,
        targetFen: msg.placement,
        page: msg.page,
        bbox: msg.bbox,
        confidence: msg.confidence,
      };
      const newGame: Game = {
        id: msg.gameId,
        page: msg.page,
        bbox: msg.bbox,
        fen: msg.placement,
        confidence: msg.confidence,
        pending: true,
      };
      const games = [...model.games, newGame];
      const nextModel = {
        ...model,
        recognitionInProgress: null,
        games,
        placementKeyIndex: buildPlacementIndex(games),
        workflow: { tag: "PENDING_CONFIRM", pending },
      };
      return [
        withStatus(nextModel, "Confirm pieces, then choose how to continue"),
        [{ tag: "CHESSNUT_SET_FEN", fen: msg.placement, force: true }],
      ];
    }
    case "RecognitionFailed":
      return [
        withStatus(
          { ...model, recognitionInProgress: false },
          `Recognition error: ${msg.message}`,
        ),
        noCmd,
      ];
    case "ConfirmPieces":
      return [model, [{ tag: "CHESSBOARD_READ_PREVIEW" }]];
    case "PiecesConfirmed": {
      const pending = getPendingFromWorkflow(model.workflow);
      if (!pending) {
        return [withStatus(model, "No pending game to confirm"), noCmd];
      }
      const updatedGames = updateGame(model.games, pending.gameId, (game) => ({
        ...game,
        fen: msg.placement,
      }));
      const analyzedCandidates = Object.keys(model.analyses) as GameId[];
      const nextModel = {
        ...model,
        games: updatedGames,
        placementKeyIndex: buildPlacementIndex(updatedGames),
        workflow: {
          tag: "MATCH_EXISTING",
          pending: { ...pending, targetFen: msg.placement },
          candidates: analyzedCandidates,
          selected: analyzedCandidates[0] ?? null,
        },
        isDirty: true,
      };
      return [nextModel, [{ tag: "SCHEDULE_SAVE", delayMs: 2000 }]];
    }
    case "EditPieces":
      return [withStatus(model, "Edit pieces using the palette, then confirm"), noCmd];
    case "SelectCandidate": {
      if (model.workflow.tag !== "MATCH_EXISTING") {
        return [model, noCmd];
      }
      return [
        {
          ...model,
          workflow: {
            ...model.workflow,
            selected: msg.gameId,
          },
        },
        noCmd,
      ];
    }
    case "ContinueSelectedGame": {
      if (model.workflow.tag !== "MATCH_EXISTING") {
        return [model, noCmd];
      }
      const baseId = model.workflow.selected;
      if (!baseId) {
        return [withStatus(model, "No game selected"), noCmd];
      }
      const nextGames = updateGame(model.games, model.workflow.pending.gameId, (game) => ({
        ...game,
        pending: false,
      }));
      const session = createReachSession(model, model.workflow.pending, baseId);
      const nextModel = {
        ...model,
        games: nextGames,
        placementKeyIndex: buildPlacementIndex(nextGames),
        workflow: { tag: "REACHING", session },
        isDirty: true,
      };
      return [nextModel, [{ tag: "OPEN_REACH_MODAL" }, { tag: "SCHEDULE_SAVE", delayMs: 2000 }]];
    }
    case "StartNewGame": {
      if (model.workflow.tag !== "MATCH_EXISTING") {
        return [model, noCmd];
      }
      const nextGames = updateGame(model.games, model.workflow.pending.gameId, (game) => ({
        ...game,
        pending: false,
      }));
      const session = createReachSession(model, model.workflow.pending, null);
      const nextModel = {
        ...model,
        games: nextGames,
        placementKeyIndex: buildPlacementIndex(nextGames),
        workflow: { tag: "REACHING", session },
        isDirty: true,
      };
      return [nextModel, [{ tag: "OPEN_REACH_MODAL" }, { tag: "SCHEDULE_SAVE", delayMs: 2000 }]];
    }
    case "ReachStartManual":
      if (model.workflow.tag !== "REACHING") {
        return [model, noCmd];
      }
      return [
        {
          ...model,
          workflow: {
            ...model.workflow,
            session: { ...model.workflow.session, mode: "manual" },
          },
        },
        noCmd,
      ];
    case "ReachStartOtb":
      if (model.workflow.tag !== "REACHING") {
        return [model, noCmd];
      }
      return [
        {
          ...model,
          workflow: {
            ...model.workflow,
            session: { ...model.workflow.session, mode: "otb" },
          },
        },
        [{ tag: "CHESSNUT_POLL_START", everyMs: 500 }],
      ];
    case "ReachMoveMade":
      if (model.workflow.tag !== "REACHING") {
        return [model, noCmd];
      }
      return [
        {
          ...model,
          workflow: {
            ...model.workflow,
            session: {
              ...model.workflow.session,
              moves: [...model.workflow.session.moves, msg.san],
              currentFen: msg.fen,
            },
          },
        },
        [{ tag: "REACH_SYNC_BOARD", fen: extractPlacement(msg.fen) }],
      ];
    case "ReachUndo":
      if (model.workflow.tag !== "REACHING") {
        return [model, noCmd];
      }
      if (model.workflow.session.moves.length === 0) {
        return [model, noCmd];
      }
      try {
        const remaining = model.workflow.session.moves.slice(0, -1);
        const game = new Chess(model.workflow.session.startFen);
        for (const san of remaining) {
          if (!game.move(String(san))) break;
        }
        return [
          {
            ...model,
            workflow: {
              ...model.workflow,
              session: {
                ...model.workflow.session,
                moves: remaining,
                currentFen: asFenFull(game.fen()),
              },
            },
          },
          noCmd,
        ];
      } catch {
        return [model, noCmd];
      }
    case "ReachReset":
      if (model.workflow.tag !== "REACHING") {
        return [model, noCmd];
      }
      return [
        {
          ...model,
          workflow: {
            ...model.workflow,
            session: {
              ...model.workflow.session,
              moves: [],
              currentFen: model.workflow.session.startFen,
            },
          },
        },
        noCmd,
      ];
    case "ReachDone":
      if (model.workflow.tag !== "REACHING") {
        return [model, noCmd];
      }
      return [
        model,
        [
          {
            tag: "REACH_SET_MOVES",
            moves: model.workflow.session.moves,
            finalFen: model.workflow.session.currentFen,
          },
        ],
      ];
    case "ReachCancel":
      if (model.workflow.tag !== "REACHING") {
        return [model, noCmd];
      }
      const filtered = model.games.filter((game) => game.id !== model.workflow.session.gameId);
      return [
        {
          ...model,
          games: filtered,
          placementKeyIndex: buildPlacementIndex(filtered),
          workflow: { tag: "VIEWING", activeGameId: null },
          currentNode: null,
        },
        [
          { tag: "CLOSE_REACH_MODAL" },
          { tag: "CHESSNUT_POLL_STOP" },
          { tag: "SCHEDULE_SAVE", delayMs: 2000 },
        ],
      ];
    case "ReachTargetResolved":
      if (model.workflow.tag !== "REACHING") {
        return [model, noCmd];
      }
      try {
        const session = model.workflow.session;
        const baseId = session.baseAnalysisId;
        let tree =
          baseId && model.analyses[baseId]
            ? model.analyses[baseId]
            : createAnalysisTree(session.startFen, session.turn);
        let cursor = baseId && model.analyses[baseId] ? getMainLineLeaf(tree).path : [];
        const game = new Chess(session.startFen);
        for (const san of msg.moves) {
          const move = game.move(String(san));
          if (!move) break;
          const next = makeMove(tree, cursor, asSan(move.san), asFenFull(game.fen()));
          tree = next.tree;
          cursor = next.cursor;
        }
        const analyses = baseId
          ? { ...model.analyses, [baseId]: tree }
          : { ...model.analyses, [session.gameId]: tree };
        const continuations = baseId
          ? {
              ...model.continuations,
              [session.gameId]: { analysisId: baseId, nodePath: cursor },
            }
          : model.continuations;
        const nextModel = {
          ...model,
          analyses,
          continuations,
          currentNode: cursor,
          isDirty: true,
          workflow: { tag: "ANALYSIS", activeGameId: session.gameId, cursor },
        };
        return [
          nextModel,
          [
            { tag: "ENGINE_ANALYZE", fen: msg.finalFen, depth: 16 },
            { tag: "SCHEDULE_SAVE", delayMs: 2000 },
          ],
        ];
      } catch {
        return [withStatus(model, "Failed to reach target"), noCmd];
      }
    case "TextSelectModeChanged":
      {
        const message =
          msg.mode === "ocr"
            ? "Draw a box around the move text on the PDF"
            : msg.mode === "overlay"
              ? "Draw a box to overlay extracted text"
              : model.ui.statusMessage;
        return [
          {
            ...model,
            ui: {
              ...model.ui,
              textSelectMode: msg.mode,
              statusMessage: message,
            },
          },
          noCmd,
        ];
      }
    case "TextOverlayUpdated":
      return [
        {
          ...model,
          ui: {
            ...model.ui,
            textOverlayText: msg.text,
            textOverlayVisible: msg.visible,
          },
        },
        noCmd,
      ];
    case "OcrStatusUpdated":
      return [
        {
          ...model,
          ui: {
            ...model.ui,
            ocrStatus: msg.text,
          },
        },
        noCmd,
      ];
    case "ExtractMovesRequested":
      if (!model.pdf.id) {
        return [model, noCmd];
      }
      return [
        {
          ...model,
          ui: {
            ...model.ui,
            ocrStatus: "Extracting text...",
          },
        },
        [
          {
            tag: "API_EXTRACT_MOVES",
            pdfId: model.pdf.id,
            page: msg.page,
            bbox: msg.bbox,
          },
        ],
      ];
    case "ExtractMovesFailed":
      return [withStatus(model, msg.message), noCmd];
    case "AnalysisStarted": {
      const position = model.games.find((game) => game.id === msg.gameId);
      if (!position) {
        return [model, noCmd];
      }
      const continuation = model.continuations[msg.gameId];
      if (continuation && model.analyses[continuation.analysisId]) {
        const tree = model.analyses[continuation.analysisId];
        const node = getNode(tree.root, continuation.nodePath);
        const fen = node ? node.fen : tree.startFen;
        const nextModel = {
          ...model,
          currentNode: continuation.nodePath,
          workflow: {
            tag: "ANALYSIS",
            activeGameId: msg.gameId,
            cursor: continuation.nodePath,
          },
        };
        return [nextModel, [{ tag: "ENGINE_ANALYZE", fen, depth: 16 }]];
      }
      const fullFen = toFullFen(position.fen, msg.turn);
      const existing = model.analyses[msg.gameId];
      const tree = existing ?? createAnalysisTree(fullFen, msg.turn);
      const nextModel = {
        ...model,
        analyses: existing ? model.analyses : { ...model.analyses, [msg.gameId]: tree },
        currentNode: [],
        workflow: { tag: "ANALYSIS", activeGameId: msg.gameId, cursor: [] },
      };
      return [nextModel, [{ tag: "ENGINE_ANALYZE", fen: fullFen, depth: 16 }]];
    }
    case "AnalysisMoveMade":
      if (model.workflow.tag !== "ANALYSIS") {
        return [model, noCmd];
      }
      {
        const ctx = getAnalysisContext(model, model.workflow.activeGameId);
        if (!ctx) return [model, noCmd];
        const next = makeMove(ctx.tree, model.workflow.cursor, msg.san, msg.fen);
        const nextModel = {
          ...model,
          analyses: { ...model.analyses, [ctx.analysisId]: next.tree },
          currentNode: next.cursor,
          workflow: { ...model.workflow, cursor: next.cursor },
          isDirty: true,
        };
        const cmds = [
          { tag: "SCHEDULE_SAVE", delayMs: 2000 },
          ...(model.engine.running ? [{ tag: "ENGINE_ANALYZE", fen: msg.fen, depth: 16 }] : []),
        ];
        return [nextModel, cmds];
      }
    case "AnalysisGoBack": {
      if (model.workflow.tag !== "ANALYSIS") return [model, noCmd];
      const ctx = getAnalysisContext(model, model.workflow.activeGameId);
      if (!ctx) return [model, noCmd];
      const nextCursor = goBack(model.workflow.cursor);
      if (!nextCursor) return [model, noCmd];
      const node = getNode(ctx.tree.root, nextCursor);
      if (!node) return [model, noCmd];
      const nextModel = {
        ...model,
        currentNode: nextCursor,
        workflow: { ...model.workflow, cursor: nextCursor },
      };
      const cmds = model.engine.running
        ? [{ tag: "ENGINE_ANALYZE", fen: node.fen, depth: 16 }]
        : noCmd;
      return [nextModel, cmds];
    }
    case "AnalysisGoForward": {
      if (model.workflow.tag !== "ANALYSIS") return [model, noCmd];
      const ctx = getAnalysisContext(model, model.workflow.activeGameId);
      if (!ctx) return [model, noCmd];
      const nextCursor = goForward(ctx.tree, model.workflow.cursor);
      if (!nextCursor) return [model, noCmd];
      const node = getNode(ctx.tree.root, nextCursor);
      if (!node) return [model, noCmd];
      const nextModel = {
        ...model,
        currentNode: nextCursor,
        workflow: { ...model.workflow, cursor: nextCursor },
      };
      const cmds = model.engine.running
        ? [{ tag: "ENGINE_ANALYZE", fen: node.fen, depth: 16 }]
        : noCmd;
      return [nextModel, cmds];
    }
    case "AnalysisNextVariation": {
      if (model.workflow.tag !== "ANALYSIS") return [model, noCmd];
      const ctx = getAnalysisContext(model, model.workflow.activeGameId);
      if (!ctx) return [model, noCmd];
      const nextCursor = getNextVariation(ctx.tree, model.workflow.cursor);
      if (!nextCursor) return [model, noCmd];
      const node = getNode(ctx.tree.root, nextCursor);
      if (!node) return [model, noCmd];
      return [
        {
          ...model,
          currentNode: nextCursor,
          workflow: { ...model.workflow, cursor: nextCursor },
        },
        model.engine.running ? [{ tag: "ENGINE_ANALYZE", fen: node.fen, depth: 16 }] : noCmd,
      ];
    }
    case "AnalysisPrevVariation": {
      if (model.workflow.tag !== "ANALYSIS") return [model, noCmd];
      const ctx = getAnalysisContext(model, model.workflow.activeGameId);
      if (!ctx) return [model, noCmd];
      const nextCursor = getPrevVariation(ctx.tree, model.workflow.cursor);
      if (!nextCursor) return [model, noCmd];
      const node = getNode(ctx.tree.root, nextCursor);
      if (!node) return [model, noCmd];
      return [
        {
          ...model,
          currentNode: nextCursor,
          workflow: { ...model.workflow, cursor: nextCursor },
        },
        model.engine.running ? [{ tag: "ENGINE_ANALYZE", fen: node.fen, depth: 16 }] : noCmd,
      ];
    }
    case "AnalysisDeleteVariation": {
      if (model.workflow.tag !== "ANALYSIS") return [model, noCmd];
      const ctx = getAnalysisContext(model, model.workflow.activeGameId);
      if (!ctx) return [model, noCmd];
      const result = deleteVariation(ctx.tree, model.workflow.cursor);
      if (!result.deleted) return [model, noCmd];
      const nextModel = {
        ...model,
        analyses: { ...model.analyses, [ctx.analysisId]: result.tree },
        currentNode: result.cursor,
        workflow: { ...model.workflow, cursor: result.cursor },
        isDirty: true,
      };
      return [nextModel, [{ tag: "SCHEDULE_SAVE", delayMs: 2000 }]];
    }
    case "AnalysisGoTo": {
      if (model.workflow.tag !== "ANALYSIS") return [model, noCmd];
      const ctx = getAnalysisContext(model, model.workflow.activeGameId);
      if (!ctx) return [model, noCmd];
      const node = getNode(ctx.tree.root, msg.path);
      if (!node) return [model, noCmd];
      const nextModel = {
        ...model,
        currentNode: msg.path,
        workflow: { ...model.workflow, cursor: msg.path },
      };
      const cmds = model.engine.running
        ? [{ tag: "ENGINE_ANALYZE", fen: node.fen, depth: 16 }]
        : noCmd;
      return [nextModel, cmds];
    }
    case "EngineStarted":
      return [
        {
          ...model,
          engine: { ...model.engine, running: true },
        },
        noCmd,
      ];
    case "EngineStopped":
      return [
        {
          ...model,
          engine: { ...model.engine, running: false },
        },
        noCmd,
      ];
    case "EngineInfo":
      return [
        {
          ...model,
          engine: {
            ...model.engine,
            evalText: msg.evalText,
            pv: msg.pv,
          },
        },
        noCmd,
      ];
    case "EngineToggle":
      return [model, [model.engine.running ? { tag: "ENGINE_STOP" } : { tag: "ENGINE_START" }]];
    case "StudySaved":
      return [{ ...model, isDirty: false }, noCmd];
    case "StudyLoaded": {
      const nextModel = applyStudy(model, msg.study);
      return [nextModel, noCmd];
    }
    case "BoardStatusUpdated":
      return [
        {
          ...model,
          boardStatus: { available: msg.available, connected: msg.connected },
        },
        noCmd,
      ];
    case "BoardFenUpdated":
      if (model.workflow.tag !== "REACHING") {
        return [model, noCmd];
      }
      if (model.workflow.session.mode !== "otb") {
        return [model, noCmd];
      }
      try {
        const currentPlacement = extractPlacement(model.workflow.session.currentFen);
        const nextPlacement = extractPlacement(msg.fen);
        if (currentPlacement === nextPlacement) {
          return [model, noCmd];
        }
        const baseGame = new Chess(model.workflow.session.currentFen);
        const moves = baseGame.moves({ verbose: true });
        for (const move of moves) {
          const testGame = new Chess(model.workflow.session.currentFen);
          testGame.move(move);
          const resultFen = asFenFull(testGame.fen());
          if (extractPlacement(resultFen) === nextPlacement) {
            return [
              {
                ...model,
                workflow: {
                  ...model.workflow,
                  session: {
                    ...model.workflow.session,
                    moves: [...model.workflow.session.moves, asSan(move.san)],
                    currentFen: resultFen,
                  },
                },
              },
              noCmd,
            ];
          }
        }
      } catch {
        return [model, noCmd];
      }
      return [model, noCmd];
    case "CopyFen":
      {
        const activeId = getActiveGameId(model.workflow);
        const ctx = activeId ? getAnalysisContext(model, activeId) : null;
        if (ctx) {
          const node = getNode(ctx.tree.root, ctx.nodePath);
          if (node) {
            return [model, [{ tag: "CLIPBOARD_WRITE", text: node.fen }]];
          }
        }
        const active = model.games.find((game) => game.id === activeId);
        return active
          ? [model, [{ tag: "CLIPBOARD_WRITE", text: active.fen }]]
          : [model, noCmd];
      }
    case "CopyPgn": {
      const activeId = getActiveGameId(model.workflow);
      if (!activeId) return [model, noCmd];
      const ctx = getAnalysisContext(model, activeId);
      if (!ctx) return [model, noCmd];
      const pgn = toPGN(ctx.tree);
      return [model, [{ tag: "CLIPBOARD_WRITE", text: pgn }]];
    }
    case "OpeningsInputShown":
      return [
        {
          ...model,
          ui: { ...model.ui, openingInputVisible: true, openingMovesInput: msg.content },
        },
        noCmd,
      ];
    case "OpeningsInputHidden":
      return [
        {
          ...model,
          ui: { ...model.ui, openingInputVisible: false },
        },
        noCmd,
      ];
    default:
      return assertNever(msg);
  }
};
