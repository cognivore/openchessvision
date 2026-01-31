"use strict";
(() => {
  // static/ts/core/model.ts
  var asPdfId = (value) => value;
  var asContentHash = (value) => value;
  var asGameId = (value) => value;
  var asPageNum = (value) => value;
  var asCssPx = (value) => value;
  var asPdfPx = (value) => value;
  var initialModel = {
    pdf: {
      id: null,
      contentHash: null,
      filename: null,
      currentPage: 1,
      totalPages: 0,
      scale: 1,
      initialScaleSet: false
    },
    diagrams: null,
    games: [],
    analyses: {},
    continuations: {},
    continuationPrompt: null,
    workflow: { tag: "NO_PDF" },
    currentNode: null,
    engine: {
      running: false,
      evalText: "-",
      pv: "-"
    },
    boardStatus: {
      available: false,
      connected: false
    },
    recognitionInProgress: null,
    isDirty: false,
    ui: {
      statusMessage: "Ready",
      textSelectMode: null,
      textOverlayText: "",
      textOverlayVisible: false,
      ocrStatus: "",
      openingInputVisible: false,
      openingMovesInput: "",
      selectedPiece: null
    },
    placementKeyIndex: {}
  };

  // static/ts/core/invariant.ts
  var assertNever = (value) => {
    throw new Error(`Unexpected value: ${String(value)}`);
  };

  // static/ts/domain/chess/fen.ts
  var asFenPlacement = (value) => value;
  var asFenFull = (value) => value;
  var placementKey = (placement) => placement;
  var extractPlacement = (fen) => asFenPlacement(fen.split(" ")[0] ?? "");
  var toFullFen = (placement, turn) => asFenFull(`${placement} ${turn} KQkq - 0 1`);
  var fenTurn = (fen) => {
    const raw = fen.split(" ")[1];
    return raw === "b" ? "b" : "w";
  };

  // static/ts/domain/chess/analysisTree.ts
  var createAnalysisTree = (startFen, turn) => ({
    startFen,
    turn,
    root: {
      fen: startFen,
      san: null,
      comment: "",
      children: []
    }
  });
  var getNode = (root, path) => {
    let current = root;
    for (const san of path) {
      const next = current.children.find((child) => child.san === san) ?? null;
      if (!next) return null;
      current = next;
    }
    return current;
  };
  var updateNodeAtPath = (node, path, updater) => {
    if (path.length === 0) {
      return updater(node);
    }
    const [head, ...rest] = path;
    const nextIndex = node.children.findIndex((child) => child.san === head);
    if (nextIndex === -1) return node;
    const updatedChild = updateNodeAtPath(node.children[nextIndex], rest, updater);
    if (updatedChild === node.children[nextIndex]) return node;
    const updatedChildren = node.children.map(
      (child, idx) => idx === nextIndex ? updatedChild : child
    );
    return { ...node, children: updatedChildren };
  };
  var makeMove = (tree, cursor, san, fen) => {
    const existing = getNode(tree.root, [...cursor, san]);
    if (existing) {
      return { tree, cursor: [...cursor, san] };
    }
    const newNode = {
      fen,
      san,
      comment: "",
      children: []
    };
    const nextRoot = updateNodeAtPath(tree.root, cursor, (node) => ({
      ...node,
      children: [...node.children, newNode]
    }));
    return { tree: { ...tree, root: nextRoot }, cursor: [...cursor, san] };
  };
  var goBack = (cursor) => cursor.length === 0 ? null : cursor.slice(0, -1);
  var goForward = (tree, cursor) => {
    const node = getNode(tree.root, cursor);
    if (!node || node.children.length === 0) return null;
    const nextSan = node.children[0].san;
    if (!nextSan) return null;
    return [...cursor, nextSan];
  };
  var getNextVariation = (tree, cursor) => {
    if (cursor.length === 0) return null;
    const parentPath = cursor.slice(0, -1);
    const currentSan = cursor[cursor.length - 1];
    const parent = getNode(tree.root, parentPath);
    if (!parent) return null;
    const idx = parent.children.findIndex((child) => child.san === currentSan);
    if (idx === -1 || idx >= parent.children.length - 1) return null;
    const nextSan = parent.children[idx + 1].san;
    if (!nextSan) return null;
    return [...parentPath, nextSan];
  };
  var getPrevVariation = (tree, cursor) => {
    if (cursor.length === 0) return null;
    const parentPath = cursor.slice(0, -1);
    const currentSan = cursor[cursor.length - 1];
    const parent = getNode(tree.root, parentPath);
    if (!parent) return null;
    const idx = parent.children.findIndex((child) => child.san === currentSan);
    if (idx <= 0) return null;
    const prevSan = parent.children[idx - 1].san;
    if (!prevSan) return null;
    return [...parentPath, prevSan];
  };
  var deleteVariation = (tree, cursor) => {
    if (cursor.length === 0) return { tree, cursor, deleted: false };
    const parentPath = cursor.slice(0, -1);
    const currentSan = cursor[cursor.length - 1];
    const parent = getNode(tree.root, parentPath);
    if (!parent) return { tree, cursor, deleted: false };
    const nextChildren = parent.children.filter((child) => child.san !== currentSan);
    if (nextChildren.length === parent.children.length) {
      return { tree, cursor, deleted: false };
    }
    const nextRoot = updateNodeAtPath(tree.root, parentPath, (node) => ({
      ...node,
      children: nextChildren
    }));
    const nextCursor = nextChildren.length > 0 && nextChildren[0].san ? [...parentPath, nextChildren[0].san] : parentPath;
    return { tree: { ...tree, root: nextRoot }, cursor: nextCursor, deleted: true };
  };
  var getMainLineLeaf = (tree) => {
    let node = tree.root;
    const path = [];
    while (node.children.length > 0) {
      const child = node.children[0];
      if (!child.san) break;
      path.push(child.san);
      node = child;
    }
    return { node, path };
  };
  var renderNode = (node, moveNum, isWhite) => {
    let result = "";
    if (node.san) {
      result += isWhite ? `${moveNum}. ${node.san}` : node.san;
    }
    if (node.children.length > 0) {
      const mainChild = node.children[0];
      const nextIsWhite = !isWhite;
      const nextMoveNum = isWhite ? moveNum : moveNum + 1;
      if (result) result += " ";
      result += renderNode(mainChild, nextMoveNum, nextIsWhite);
      for (let i = 1; i < node.children.length; i += 1) {
        const variation = node.children[i];
        result += " (";
        if (!isWhite) {
          result += `${moveNum}... `;
        }
        result += renderNode(variation, isWhite ? moveNum : moveNum + 1, !isWhite);
        result += ")";
      }
    }
    return result;
  };
  var toPGN = (tree) => {
    const lines = [];
    lines.push(`[FEN "${tree.startFen}"]`);
    lines.push("");
    const fenParts = tree.startFen.split(" ");
    const startMoveNum = Number.parseInt(fenParts[5] ?? "1", 10);
    const isWhiteToMove = (fenParts[1] ?? "w") === "w";
    const pgn = renderNode(tree.root, startMoveNum, isWhiteToMove);
    lines.push(pgn.trim() || "*");
    return lines.join("\n");
  };
  var serializeNode = (node) => ({
    fen: node.fen,
    san: node.san,
    comment: node.comment,
    children: node.children.map(serializeNode)
  });
  var deserializeNode = (data) => ({
    fen: data.fen,
    san: data.san ?? null,
    comment: data.comment ?? "",
    children: (data.children ?? []).map(deserializeNode)
  });
  var analysisTreeToJSON = (tree) => ({
    startFen: tree.startFen,
    turn: tree.turn,
    tree: serializeNode(tree.root)
  });
  var analysisTreeFromJSON = (json) => ({
    startFen: json.startFen,
    turn: json.turn,
    root: deserializeNode(json.tree)
  });

  // static/ts/domain/chess/san.ts
  var asSan = (value) => value;

  // static/ts/domain/pdf/bbox.ts
  var bbox = (x, y, width, height) => ({
    x,
    y,
    width,
    height
  });
  var pdfToRetinaBBox = (pdf, scale) => bbox(
    pdf.x * scale,
    pdf.y * scale,
    pdf.width * scale,
    pdf.height * scale
  );
  var retinaToCssBBox = (retina) => bbox(
    retina.x / 2,
    retina.y / 2,
    retina.width / 2,
    retina.height / 2
  );
  var cssToRetinaBBox = (css) => bbox(
    css.x * 2,
    css.y * 2,
    css.width * 2,
    css.height * 2
  );
  var pdfToCssBBox = (pdf, scale) => retinaToCssBBox(pdfToRetinaBBox(pdf, scale));
  var cssToPdfBBox = (css, scale) => {
    const retina = cssToRetinaBBox(css);
    return bbox(
      retina.x / scale,
      retina.y / scale,
      retina.width / scale,
      retina.height / scale
    );
  };

  // static/ts/domain/pdf/page.ts
  var toPageIndex = (page) => page - 1;
  var toPageNum = (index) => index + 1;

  // static/ts/core/selectors.ts
  var getActiveGameId = (workflow) => {
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
  var getActiveGame = (model) => {
    const id = getActiveGameId(model.workflow);
    if (!id) return null;
    return model.games.find((game) => game.id === id) ?? null;
  };
  var getAnalysisContext = (model, gameId) => {
    const direct = model.analyses[gameId];
    if (direct) {
      return {
        tree: direct,
        nodePath: model.currentNode ?? [],
        analysisId: gameId
      };
    }
    const link = model.continuations[gameId];
    if (link && model.analyses[link.analysisId]) {
      const cursorOverride = model.workflow.tag === "ANALYSIS" && model.workflow.activeGameId === gameId && model.currentNode ? model.currentNode : null;
      return {
        tree: model.analyses[link.analysisId],
        nodePath: cursorOverride ?? link.nodePath,
        analysisId: link.analysisId
      };
    }
    return null;
  };
  var getAnalysisNodeFen = (model, gameId) => {
    const ctx = getAnalysisContext(model, gameId);
    if (!ctx) return null;
    const node = getNode(ctx.tree.root, ctx.nodePath);
    return node ? node.fen : null;
  };

  // static/ts/core/update.ts
  var noCmd = [];
  var withStatus = (model, message) => ({
    ...model,
    ui: {
      ...model.ui,
      statusMessage: message
    }
  });
  var buildPlacementIndex = (games) => {
    const index = {};
    games.forEach((game) => {
      if (!game.pending) {
        index[placementKey(game.fen)] = game.id;
      }
    });
    return index;
  };
  var updateGame = (games, gameId, updater) => games.map((game) => game.id === gameId ? updater(game) : game);
  var findExistingByPlacement = (model, placement) => model.games.find((game) => !game.pending && game.fen === placement) ?? null;
  var getPendingFromWorkflow = (workflow) => {
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
  var applyStudy = (model, study) => {
    if (!study) {
      return model;
    }
    const games = study.games;
    return {
      ...model,
      games,
      analyses: study.analyses,
      continuations: study.continuations,
      placementKeyIndex: buildPlacementIndex(games)
    };
  };
  var createReachSession = (model, pending, baseAnalysisId) => {
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
        turn: fenTurn(node.fen)
      };
    }
    const startFen = toFullFen(
      asFenPlacement("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR"),
      "w"
    );
    return {
      targetFen: pending.targetFen,
      startFen,
      currentFen: startFen,
      baseAnalysisId: null,
      gameId: pending.gameId,
      moves: [],
      mode: null,
      turn: "w"
    };
  };
  var update = (model = initialModel, msg) => {
    switch (msg.tag) {
      case "Status":
        return [withStatus(model, msg.message), noCmd];
      case "Error":
        return [withStatus(model, msg.message), noCmd];
      case "PdfFileSelected":
        return [
          withStatus(model, `Checking ${msg.file.name}...`),
          [{ tag: "PDF_LOAD_FILE", file: msg.file }]
        ];
      case "PdfOpened": {
        const nextModel = {
          ...model,
          pdf: {
            id: msg.pdfId,
            contentHash: msg.contentHash,
            filename: msg.filename,
            currentPage: 1,
            totalPages: msg.pages,
            scale: 1,
            initialScaleSet: false
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
          ui: initialModel.ui
        };
        return [
          withStatus(nextModel, `Loaded ${msg.filename}`),
          [
            { tag: "STUDY_LOAD", pdfId: msg.pdfId },
            { tag: "PDF_RENDER_PAGE", page: 1, scale: 1 },
            { tag: "BOARD_STATUS_POLL_START", everyMs: 5e3 }
          ]
        ];
      }
      case "PdfClosed":
        return [initialModel, noCmd];
      case "PageRequested": {
        const nextModel = {
          ...model,
          pdf: {
            ...model.pdf,
            currentPage: msg.page
          }
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
            initialScaleSet: msg.initialScaleSet
          }
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
              page: toPageIndex(msg.page)
            }
          ]
        ];
      }
      case "ZoomChanged": {
        const nextModel = {
          ...model,
          pdf: {
            ...model.pdf,
            scale: msg.scale,
            initialScaleSet: true
          }
        };
        return [
          nextModel,
          [{ tag: "PDF_RENDER_PAGE", page: model.pdf.currentPage, scale: msg.scale }]
        ];
      }
      case "DiagramsDetected": {
        const nextModel = {
          ...model,
          diagrams: { page: msg.page, diagrams: msg.diagrams }
        };
        return [withStatus(nextModel, `Found ${msg.diagrams.length} potential diagrams`), noCmd];
      }
      case "DiagramActivated":
        return [
          {
            ...model,
            workflow: msg.gameId === null ? { tag: "VIEWING", activeGameId: null } : { tag: "VIEWING", activeGameId: msg.gameId }
          },
          noCmd
        ];
      case "DeleteGame": {
        const filtered2 = model.games.filter((game) => game.id !== msg.gameId);
        const continuations = Object.fromEntries(
          Object.entries(model.continuations).filter(([key, link]) => {
            if (key === msg.gameId) return false;
            return link.analysisId !== msg.gameId;
          })
        );
        const analyses = { ...model.analyses };
        delete analyses[msg.gameId];
        const activeId = getActiveGameId(model.workflow);
        const nextWorkflow = activeId === msg.gameId ? { tag: "VIEWING", activeGameId: null } : model.workflow;
        const nextModel = {
          ...model,
          games: filtered2,
          analyses,
          continuations,
          placementKeyIndex: buildPlacementIndex(filtered2),
          workflow: nextWorkflow
        };
        return [withStatus(nextModel, "Deleted game"), [{ tag: "SCHEDULE_SAVE", delayMs: 2e3 }]];
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
          recognitionInProgress: msg.diagramIndex
        };
        return [
          withStatus(nextModel, "Recognizing position..."),
          [
            {
              tag: "API_RECOGNIZE_REGION",
              pdfId: model.pdf.id,
              page: toPageIndex(msg.page),
              bbox: pdfBBox
            }
          ]
        ];
      }
      case "DiagramResized":
        return [model, noCmd];
      case "Recognized": {
        const existing = findExistingByPlacement(model, msg.placement);
        if (existing) {
          const nextModel2 = {
            ...model,
            recognitionInProgress: null,
            workflow: { tag: "VIEWING", activeGameId: existing.id }
          };
          return [
            withStatus(nextModel2, `Game already saved (Page ${existing.page ?? "?"})`),
            [{ tag: "CHESSNUT_SET_FEN", fen: msg.placement, force: true }]
          ];
        }
        const pending = {
          gameId: msg.gameId,
          targetFen: msg.placement,
          page: msg.page,
          bbox: msg.bbox,
          confidence: msg.confidence
        };
        const newGame = {
          id: msg.gameId,
          page: msg.page,
          bbox: msg.bbox,
          fen: msg.placement,
          confidence: msg.confidence,
          pending: true
        };
        const games = [...model.games, newGame];
        const nextModel = {
          ...model,
          recognitionInProgress: null,
          games,
          placementKeyIndex: buildPlacementIndex(games),
          workflow: { tag: "PENDING_CONFIRM", pending }
        };
        return [
          withStatus(nextModel, "Confirm pieces, then choose how to continue"),
          [{ tag: "CHESSNUT_SET_FEN", fen: msg.placement, force: true }]
        ];
      }
      case "RecognitionFailed":
        return [
          withStatus(
            { ...model, recognitionInProgress: false },
            `Recognition error: ${msg.message}`
          ),
          noCmd
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
          fen: msg.placement
        }));
        const analyzedCandidates = Object.keys(model.analyses);
        const nextModel = {
          ...model,
          games: updatedGames,
          placementKeyIndex: buildPlacementIndex(updatedGames),
          workflow: {
            tag: "MATCH_EXISTING",
            pending: { ...pending, targetFen: msg.placement },
            candidates: analyzedCandidates,
            selected: analyzedCandidates[0] ?? null
          },
          isDirty: true
        };
        return [nextModel, [{ tag: "SCHEDULE_SAVE", delayMs: 2e3 }]];
      }
      case "EditPieces":
        return [withStatus(model, "Edit pieces using the palette, then confirm"), noCmd];
      case "SelectCandidate":
      case "MatchGameSelected": {
        if (model.workflow.tag !== "MATCH_EXISTING") {
          return [model, noCmd];
        }
        return [
          {
            ...model,
            workflow: {
              ...model.workflow,
              selected: msg.gameId
            }
          },
          noCmd
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
          pending: false
        }));
        const session = createReachSession(model, model.workflow.pending, baseId);
        const nextModel = {
          ...model,
          games: nextGames,
          placementKeyIndex: buildPlacementIndex(nextGames),
          workflow: { tag: "REACHING", session },
          isDirty: true
        };
        return [nextModel, [{ tag: "SCHEDULE_SAVE", delayMs: 2e3 }]];
      }
      case "StartNewGame": {
        if (model.workflow.tag !== "MATCH_EXISTING") {
          return [model, noCmd];
        }
        const nextGames = updateGame(model.games, model.workflow.pending.gameId, (game) => ({
          ...game,
          pending: false
        }));
        const session = createReachSession(model, model.workflow.pending, null);
        const nextModel = {
          ...model,
          games: nextGames,
          placementKeyIndex: buildPlacementIndex(nextGames),
          workflow: { tag: "REACHING", session },
          isDirty: true
        };
        return [nextModel, [{ tag: "SCHEDULE_SAVE", delayMs: 2e3 }]];
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
              session: { ...model.workflow.session, mode: "manual" }
            }
          },
          noCmd
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
              session: { ...model.workflow.session, mode: "otb" }
            }
          },
          [{ tag: "CHESSNUT_POLL_START", everyMs: 500 }]
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
                currentFen: msg.fen
              }
            }
          },
          [{ tag: "REACH_SYNC_BOARD", fen: extractPlacement(msg.fen) }]
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
                  currentFen: asFenFull(game.fen())
                }
              }
            },
            noCmd
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
                currentFen: model.workflow.session.startFen
              }
            }
          },
          noCmd
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
              finalFen: model.workflow.session.currentFen
            }
          ]
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
            currentNode: null
          },
          [
            { tag: "CLOSE_REACH_MODAL" },
            { tag: "CHESSNUT_POLL_STOP" },
            { tag: "SCHEDULE_SAVE", delayMs: 2e3 }
          ]
        ];
      case "ReachTargetResolved":
        if (model.workflow.tag !== "REACHING") {
          return [model, noCmd];
        }
        try {
          const session = model.workflow.session;
          const baseId = session.baseAnalysisId;
          let tree = baseId && model.analyses[baseId] ? model.analyses[baseId] : createAnalysisTree(session.startFen, session.turn);
          let cursor = baseId && model.analyses[baseId] ? getMainLineLeaf(tree).path : [];
          const game = new Chess(session.startFen);
          for (const san of msg.moves) {
            const move = game.move(String(san));
            if (!move) break;
            const next = makeMove(tree, cursor, asSan(move.san), asFenFull(game.fen()));
            tree = next.tree;
            cursor = next.cursor;
          }
          const analyses = baseId ? { ...model.analyses, [baseId]: tree } : { ...model.analyses, [session.gameId]: tree };
          const continuations = baseId ? {
            ...model.continuations,
            [session.gameId]: { analysisId: baseId, nodePath: cursor }
          } : model.continuations;
          const nextModel = {
            ...model,
            analyses,
            continuations,
            currentNode: cursor,
            isDirty: true,
            workflow: { tag: "ANALYSIS", activeGameId: session.gameId, cursor }
          };
          return [
            nextModel,
            [
              { tag: "ENGINE_ANALYZE", fen: msg.finalFen, depth: 16 },
              { tag: "SCHEDULE_SAVE", delayMs: 2e3 }
            ]
          ];
        } catch {
          return [withStatus(model, "Failed to reach target"), noCmd];
        }
      case "TextSelectModeChanged": {
        const message = msg.mode === "ocr" ? "Draw a box around the move text on the PDF" : msg.mode === "overlay" ? "Draw a box to overlay extracted text" : model.ui.statusMessage;
        return [
          {
            ...model,
            ui: {
              ...model.ui,
              textSelectMode: msg.mode,
              statusMessage: message
            }
          },
          noCmd
        ];
      }
      case "TextOverlayUpdated":
        return [
          {
            ...model,
            ui: {
              ...model.ui,
              textOverlayText: msg.text,
              textOverlayVisible: msg.visible
            }
          },
          noCmd
        ];
      case "OcrStatusUpdated":
        return [
          {
            ...model,
            ui: {
              ...model.ui,
              ocrStatus: msg.text
            }
          },
          noCmd
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
              ocrStatus: "Extracting text..."
            }
          },
          [
            {
              tag: "API_EXTRACT_MOVES",
              pdfId: model.pdf.id,
              page: msg.page,
              bbox: msg.bbox
            }
          ]
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
          const tree2 = model.analyses[continuation.analysisId];
          const node = getNode(tree2.root, continuation.nodePath);
          const fen = node ? node.fen : tree2.startFen;
          const nextModel2 = {
            ...model,
            currentNode: continuation.nodePath,
            workflow: {
              tag: "ANALYSIS",
              activeGameId: msg.gameId,
              cursor: continuation.nodePath
            }
          };
          return [nextModel2, [{ tag: "ENGINE_ANALYZE", fen, depth: 16 }]];
        }
        const fullFen = toFullFen(position.fen, msg.turn);
        const existing = model.analyses[msg.gameId];
        const tree = existing ?? createAnalysisTree(fullFen, msg.turn);
        const nextModel = {
          ...model,
          analyses: existing ? model.analyses : { ...model.analyses, [msg.gameId]: tree },
          currentNode: [],
          workflow: { tag: "ANALYSIS", activeGameId: msg.gameId, cursor: [] }
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
            isDirty: true
          };
          const cmds = [
            { tag: "SCHEDULE_SAVE", delayMs: 2e3 },
            ...model.engine.running ? [{ tag: "ENGINE_ANALYZE", fen: msg.fen, depth: 16 }] : []
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
          workflow: { ...model.workflow, cursor: nextCursor }
        };
        const cmds = model.engine.running ? [{ tag: "ENGINE_ANALYZE", fen: node.fen, depth: 16 }] : noCmd;
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
          workflow: { ...model.workflow, cursor: nextCursor }
        };
        const cmds = model.engine.running ? [{ tag: "ENGINE_ANALYZE", fen: node.fen, depth: 16 }] : noCmd;
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
            workflow: { ...model.workflow, cursor: nextCursor }
          },
          model.engine.running ? [{ tag: "ENGINE_ANALYZE", fen: node.fen, depth: 16 }] : noCmd
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
            workflow: { ...model.workflow, cursor: nextCursor }
          },
          model.engine.running ? [{ tag: "ENGINE_ANALYZE", fen: node.fen, depth: 16 }] : noCmd
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
          isDirty: true
        };
        return [nextModel, [{ tag: "SCHEDULE_SAVE", delayMs: 2e3 }]];
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
          workflow: { ...model.workflow, cursor: msg.path }
        };
        const cmds = model.engine.running ? [{ tag: "ENGINE_ANALYZE", fen: node.fen, depth: 16 }] : noCmd;
        return [nextModel, cmds];
      }
      case "EngineStarted":
        return [
          {
            ...model,
            engine: { ...model.engine, running: true }
          },
          noCmd
        ];
      case "EngineStopped":
        return [
          {
            ...model,
            engine: { ...model.engine, running: false }
          },
          noCmd
        ];
      case "EngineInfo":
        return [
          {
            ...model,
            engine: {
              ...model.engine,
              evalText: msg.evalText,
              pv: msg.pv
            }
          },
          noCmd
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
            boardStatus: { available: msg.available, connected: msg.connected }
          },
          noCmd
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
                      currentFen: resultFen
                    }
                  }
                },
                noCmd
              ];
            }
          }
        } catch {
          return [model, noCmd];
        }
        return [model, noCmd];
      case "CopyFen": {
        const activeId = getActiveGameId(model.workflow);
        const ctx = activeId ? getAnalysisContext(model, activeId) : null;
        if (ctx) {
          const node = getNode(ctx.tree.root, ctx.nodePath);
          if (node) {
            return [model, [{ tag: "CLIPBOARD_WRITE", text: node.fen }]];
          }
        }
        const active = model.games.find((game) => game.id === activeId);
        return active ? [model, [{ tag: "CLIPBOARD_WRITE", text: active.fen }]] : [model, noCmd];
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
            ui: { ...model.ui, openingInputVisible: true, openingMovesInput: msg.content }
          },
          noCmd
        ];
      case "OpeningsInputHidden":
        return [
          {
            ...model,
            ui: { ...model.ui, openingInputVisible: false }
          },
          noCmd
        ];
      default:
        return assertNever(msg);
    }
  };

  // static/ts/ui/dom.ts
  var byId = (id) => {
    const el = document.getElementById(id);
    if (!el) {
      throw new Error(`Missing element: ${id}`);
    }
    return el;
  };
  var _els = null;
  var initEls = () => ({
    pdfInput: byId("pdf-input"),
    btnOpen: byId("btn-open"),
    pdfInfo: byId("pdf-info"),
    btnPrevPage: byId("btn-prev-page"),
    btnNextPage: byId("btn-next-page"),
    pageInfo: byId("page-info"),
    pageInput: byId("page-input"),
    btnGotoPage: byId("btn-goto-page"),
    zoomSlider: byId("zoom-slider"),
    zoomValue: byId("zoom-value"),
    pdfViewport: byId("pdf-viewport"),
    pdfPageContainer: byId("pdf-page-container"),
    pdfCanvas: byId("pdf-canvas"),
    detectionOverlay: byId("detection-overlay"),
    boardOverlay: byId("board-overlay"),
    btnCloseBoard: byId("btn-close-board"),
    activeBoard: byId("active-board"),
    textOverlay: byId("text-overlay"),
    noPdfMessage: byId("no-pdf-message"),
    positionList: byId("position-list"),
    analysisContainer: byId("analysis-container"),
    pgnViewer: byId("pgn-viewer"),
    enginePanel: byId("engine-panel"),
    engineEval: byId("engine-eval"),
    engineLine: byId("engine-line"),
    btnToggleEngine: byId("btn-toggle-engine"),
    btnAnalyseWhite: byId("btn-analyse-white"),
    btnAnalyseBlack: byId("btn-analyse-black"),
    btnCopyFen: byId("btn-copy-fen"),
    btnCopyPgn: byId("btn-copy-pgn"),
    btnSelectText: byId("btn-select-text"),
    statusBar: byId("status-bar"),
    boardStatus: byId("board-status"),
    paletteBlack: byId("piece-palette-black"),
    paletteWhite: byId("piece-palette-white"),
    workflowPanel: byId("workflow-panel"),
    confirmPanel: byId("confirm-panel"),
    btnConfirmPieces: byId("btn-confirm-pieces"),
    btnEditPieces: byId("btn-edit-pieces"),
    gameMatchPanel: byId("game-match-panel"),
    gameMatchList: byId("game-match-list"),
    btnContinueGame: byId("btn-continue-game"),
    btnNewGame: byId("btn-new-game"),
    reachPanel: byId("reach-panel"),
    btnReachOtb: byId("btn-reach-otb"),
    btnReachOcr: byId("btn-reach-ocr"),
    otbPanel: byId("otb-panel"),
    otbStatus: byId("otb-status"),
    btnStopOtb: byId("btn-stop-otb"),
    ocrPanel: byId("ocr-panel"),
    btnStartTextSelect: byId("btn-start-text-select"),
    ocrStatus: byId("ocr-status"),
    continuationPrompt: byId("continuation-prompt"),
    continuationInfo: byId("continuation-info"),
    btnAcceptContinuation: byId("btn-accept-continuation"),
    btnDismissContinuation: byId("btn-dismiss-continuation"),
    openingInputPanel: byId("opening-input-panel"),
    openingMovesInput: byId("opening-moves-input"),
    btnSetOpening: byId("btn-set-opening"),
    btnApplyOpening: byId("btn-apply-opening"),
    btnCancelOpening: byId("btn-cancel-opening"),
    reachModal: byId("reach-modal"),
    reachModalClose: byId("reach-modal-close"),
    reachStartBoard: byId("reach-start-board"),
    reachEntryBoard: byId("reach-entry-board"),
    reachTargetBoard: byId("reach-target-board"),
    reachStartLabel: byId("reach-start-label"),
    reachMoveList: byId("reach-move-list"),
    reachStatus: byId("reach-status"),
    reachIndicator: byId("reach-indicator"),
    reachBtnUndo: byId("reach-btn-undo"),
    reachBtnReset: byId("reach-btn-reset"),
    reachBtnDone: byId("reach-btn-done"),
    reachBtnCancel: byId("reach-btn-cancel"),
    // Board row elements
    boardRow: byId("board-row"),
    boardSlotBefore: byId("board-slot-before"),
    boardSlotNow: byId("board-slot-now"),
    boardSlotAfter: byId("board-slot-after"),
    beforeBoard: byId("before-board"),
    nowBoard: byId("now-board"),
    afterBoard: byId("after-board"),
    beforeBoardInfo: byId("before-board-info"),
    nowBoardInfo: byId("now-board-info"),
    afterBoardInfo: byId("after-board-info"),
    boardRowActions: byId("board-row-actions"),
    boardRowReachIndicator: byId("board-row-reach-indicator"),
    // Board row action groups
    boardRowConfirm: byId("board-row-confirm"),
    boardRowMatch: byId("board-row-match"),
    boardRowReach: byId("board-row-reach"),
    boardRowAnalysis: byId("board-row-analysis"),
    boardRowHowReach: byId("board-row-how-reach"),
    // Board row buttons - confirm
    btnRowConfirm: byId("btn-row-confirm"),
    btnRowEdit: byId("btn-row-edit"),
    // Board row buttons - match
    matchGameSelect: byId("match-game-select"),
    btnRowContinue: byId("btn-row-continue"),
    btnRowNewGame: byId("btn-row-new-game"),
    // Board row buttons - reach
    boardRowReachStatus: byId("board-row-reach-status"),
    btnRowUndo: byId("btn-row-undo"),
    btnRowReset: byId("btn-row-reset"),
    btnRowDone: byId("btn-row-done"),
    btnRowCancel: byId("btn-row-cancel"),
    // Board row buttons - analysis
    btnRowAnalyseWhite: byId("btn-row-analyse-white"),
    btnRowAnalyseBlack: byId("btn-row-analyse-black"),
    btnRowCopyFen: byId("btn-row-copy-fen"),
    btnRowCopyPgn: byId("btn-row-copy-pgn"),
    btnRowClose: byId("btn-row-close"),
    // Board row buttons - how to reach
    btnRowOtb: byId("btn-row-otb"),
    btnRowManual: byId("btn-row-manual")
  });
  var els = new Proxy({}, {
    get(_target, prop) {
      if (!_els) {
        _els = initEls();
      }
      return _els[prop];
    }
  });

  // static/ts/ui/adapters/overlay.ts
  var resizeState = null;
  var parseAttr = (rect, attr) => Number.parseFloat(rect.getAttribute(attr) ?? "0");
  var rectToBBox = (rect) => bbox(
    asCssPx(parseAttr(rect, "x")),
    asCssPx(parseAttr(rect, "y")),
    asCssPx(parseAttr(rect, "width")),
    asCssPx(parseAttr(rect, "height"))
  );
  var startResize = (event, rect, corner, onResize) => {
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
      onResize
    };
    document.addEventListener("mousemove", doResize);
    document.addEventListener("mouseup", endResize);
  };
  var doResize = (event) => {
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
  var endResize = () => {
    if (!resizeState) return;
    const { rect, onResize } = resizeState;
    resizeState = null;
    document.removeEventListener("mousemove", doResize);
    document.removeEventListener("mouseup", endResize);
    onResize(rectToBBox(rect));
  };
  var clearOverlay = (overlay) => {
    overlay.innerHTML = "";
  };
  var renderOverlay = (overlay, diagrams, handlers, activeIndex, loadingIndex = null) => {
    clearOverlay(overlay);
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
        const cx = diagram.x + diagram.width / 2;
        const cy = diagram.y + diagram.height / 2;
        const spinner = document.createElementNS("http://www.w3.org/2000/svg", "circle");
        spinner.setAttribute("cx", String(cx));
        spinner.setAttribute("cy", String(cy));
        spinner.setAttribute("r", "20");
        spinner.classList.add("loading-spinner");
        overlay.appendChild(spinner);
      }
      const handleClick = (e) => {
        console.log("[DEBUG] RECT CLICK FIRED! index:", index, "event type:", e.type);
        e.stopPropagation();
        e.preventDefault();
        handlers.onClick(rectToBBox(rect), index);
      };
      rect.addEventListener("click", handleClick);
      rect.addEventListener("touchend", handleClick);
      rect.style.pointerEvents = "auto";
      rect.style.cursor = "pointer";
      console.log("[DEBUG] Appending rect", index, "at", diagram.x, diagram.y, diagram.width, diagram.height);
      overlay.appendChild(rect);
      addResizeHandles(overlay, rect, handlers.onResize);
    });
  };
  var addResizeHandles = (overlay, rect, onResize) => {
    const corners = ["nw", "ne", "sw", "se"];
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

  // static/ts/ui/render.ts
  var toggleHidden = (el, visible) => {
    el.classList.toggle("hidden", !visible);
  };
  var setText = (el, text) => {
    el.textContent = text;
  };
  var updateBoardStatus = (available, connected) => {
    els.boardStatus.classList.remove("offline", "online", "connected");
    const textEl = els.boardStatus.querySelector(".board-status-text");
    if (connected) {
      els.boardStatus.classList.add("connected");
      if (textEl) textEl.textContent = "\u265F Board ready";
    } else if (available) {
      els.boardStatus.classList.add("online");
      if (textEl) textEl.textContent = "\u26A0 No board";
    } else {
      els.boardStatus.classList.add("offline");
      if (textEl) textEl.textContent = "\u25CB Offline";
    }
  };
  var renderPositions = (model, dispatch) => {
    els.positionList.innerHTML = "";
    const visibleGames = model.games.filter((game) => !game.pending);
    const activeId = getActiveGameId(model.workflow);
    visibleGames.forEach((game) => {
      const item = document.createElement("div");
      item.className = "position-item";
      item.dataset.id = String(game.id);
      if (activeId === game.id) {
        item.classList.add("active");
      }
      if (model.analyses[game.id] || model.continuations[game.id]) {
        item.classList.add("analysed");
      }
      const isLinked = Boolean(model.continuations[game.id]);
      item.innerHTML = `
      <div class="thumb">
        <div id="thumb-${game.id}" style="width:48px;height:48px;"></div>
      </div>
      <div class="info">
        <div class="page-num">Page ${game.page}${isLinked ? " \u2197" : ""}</div>
        <div class="fen-preview">${game.fen}</div>
      </div>
      <button class="btn-delete-position" data-id="${game.id}" title="Delete position">\xD7</button>
    `;
      const deleteBtn = item.querySelector(".btn-delete-position");
      if (deleteBtn) {
        deleteBtn.addEventListener("click", (event) => {
          event.stopPropagation();
          dispatch({ tag: "DeleteGame", gameId: game.id });
        });
      }
      item.addEventListener("click", () => {
        if (model.pdf.currentPage !== game.page) {
          dispatch({ tag: "PageRequested", page: game.page });
        }
        dispatch({ tag: "DiagramActivated", gameId: game.id });
      });
      els.positionList.appendChild(item);
      setTimeout(() => {
        Chessboard(`thumb-${game.id}`, {
          position: game.fen,
          draggable: false,
          showNotation: false,
          pieceTheme: "/static/vendor/img/chesspieces/wikipedia/{piece}.png"
        });
      }, 10);
    });
  };
  var renderWorkflowPanels = (model) => {
    toggleHidden(els.confirmPanel, model.workflow.tag === "PENDING_CONFIRM");
    toggleHidden(els.gameMatchPanel, model.workflow.tag === "MATCH_EXISTING");
    toggleHidden(els.reachPanel, false);
    toggleHidden(els.otbPanel, false);
    toggleHidden(els.ocrPanel, false);
    if (model.workflow.tag === "MATCH_EXISTING") {
      els.btnContinueGame.disabled = model.workflow.candidates.length === 0;
    }
  };
  var renderOverlayBoards = (model) => {
    const activeGame = getActiveGame(model);
    if (!activeGame || model.workflow.tag !== "VIEWING") {
      toggleHidden(els.boardOverlay, false);
      return;
    }
    const displayBbox = pdfToCssBBox(activeGame.bbox, model.pdf.scale);
    els.boardOverlay.style.left = `${displayBbox.x}px`;
    els.boardOverlay.style.top = `${displayBbox.y}px`;
    els.boardOverlay.style.width = `${displayBbox.width}px`;
    els.boardOverlay.style.height = `${displayBbox.height}px`;
    els.boardOverlay.classList.add("transparent");
    els.boardOverlay.classList.remove("solid");
    toggleHidden(els.boardOverlay, true);
  };
  var renderDiagramOverlay = (model, dispatch) => {
    if (!model.diagrams || model.diagrams.page !== model.pdf.currentPage) {
      clearOverlay(els.detectionOverlay);
      return;
    }
    const diagrams = model.diagrams.diagrams.map((diagram) => pdfToCssBBox(diagram, model.pdf.scale));
    const activeGame = getActiveGame(model);
    let activeIndex = null;
    if (activeGame) {
      const activeBox = pdfToCssBBox(activeGame.bbox, model.pdf.scale);
      let bestDist = Number.POSITIVE_INFINITY;
      diagrams.forEach((diagram, index) => {
        const dx = Math.abs(diagram.x - activeBox.x);
        const dy = Math.abs(diagram.y - activeBox.y);
        const dist = dx + dy;
        if (dist < bestDist) {
          bestDist = dist;
          activeIndex = index;
        }
      });
    }
    renderOverlay(els.detectionOverlay, diagrams, {
      onClick: (rect, index) => dispatch({ tag: "DiagramClicked", page: model.pdf.currentPage, bbox: rect, diagramIndex: index }),
      onResize: (rect) => dispatch({ tag: "DiagramResized", page: model.pdf.currentPage, bbox: rect })
    }, activeIndex, model.recognitionInProgress);
  };
  var renderAnalysis = (model, dispatch) => {
    const noAnalysis = els.analysisContainer.querySelector(".no-analysis");
    if (model.workflow.tag !== "ANALYSIS") {
      if (noAnalysis) toggleHidden(noAnalysis, true);
      toggleHidden(els.pgnViewer, false);
      toggleHidden(els.enginePanel, false);
      return;
    }
    if (noAnalysis) toggleHidden(noAnalysis, false);
    toggleHidden(els.pgnViewer, true);
    toggleHidden(els.enginePanel, true);
    els.engineEval.textContent = model.engine.evalText;
    els.engineLine.textContent = model.engine.pv;
    els.btnToggleEngine.textContent = model.engine.running ? "\u23F9 Stop" : "\u25B6 Start";
    const tree = model.analyses[model.workflow.activeGameId];
    if (!tree) {
      els.pgnViewer.textContent = "No moves yet";
      return;
    }
    const currentPath = model.workflow.cursor;
    const pathEquals = (a, b) => a.length === b.length && a.every((item, idx) => item === b[idx]);
    const pathIsPrefix = (prefix, full) => prefix.every((item, idx) => item === full[idx]);
    const renderTree = (node, moveNum, isWhite, path, depth) => {
      let html = "";
      node.children.forEach((child, index) => {
        if (!child.san) return;
        const childPath = [...path, child.san];
        const isVariation = index > 0;
        if (isVariation && depth === 0) {
          html += ' <span class="variation">(';
          if (!isWhite) {
            html += `<span class="move-number">${moveNum}...</span> `;
          }
        }
        if (isWhite && (index === 0 || isVariation)) {
          html += `<span class="move-number">${moveNum}.</span> `;
        }
        const isCurrent = pathEquals(childPath, currentPath);
        const isOnPath = pathIsPrefix(childPath, currentPath);
        const classes = ["move-item"];
        if (isCurrent) classes.push("current");
        if (isOnPath) classes.push("on-path");
        html += `<span class="${classes.join(" ")}" data-path='${JSON.stringify(childPath)}'>${child.san}</span>`;
        const nextMoveNum = isWhite ? moveNum : moveNum + 1;
        html += ` ${renderTree(child, nextMoveNum, !isWhite, childPath, isVariation ? depth + 1 : depth)}`;
        if (isVariation && depth === 0) {
          html += ")</span>";
        }
      });
      return html;
    };
    const fenParts = tree.startFen.split(" ");
    const startMoveNum = Number.parseInt(fenParts[5] ?? "1", 10);
    const isWhiteToMove = (fenParts[1] ?? "w") === "w";
    const movesHtml = renderTree(tree.root, startMoveNum, isWhiteToMove, [], 0);
    els.pgnViewer.innerHTML = `<div class="move-list">${movesHtml || "<em>No moves yet</em>"}</div>`;
    els.pgnViewer.querySelectorAll(".move-item").forEach((el) => {
      el.addEventListener("click", () => {
        const pathRaw = el.dataset.path;
        if (!pathRaw) return;
        try {
          const parsed = JSON.parse(pathRaw);
          dispatch({ tag: "AnalysisGoTo", path: parsed.map(asSan) });
        } catch {
          return;
        }
      });
    });
  };
  var renderReachModal = (model) => {
    toggleHidden(els.reachModal, false);
  };
  var getBoardRowMode = (model) => {
    switch (model.workflow.tag) {
      case "NO_PDF":
        return { tag: "hidden" };
      case "VIEWING":
        return { tag: "hidden" };
      case "PENDING_CONFIRM":
        return { tag: "confirm", fen: String(model.workflow.pending.targetFen) };
      case "MATCH_EXISTING": {
        const selectedId = model.workflow.selected;
        const selectedGame = selectedId ? model.games.find((g) => g.id === selectedId) : null;
        return {
          tag: "match",
          beforeFen: selectedGame ? String(selectedGame.fen) : null,
          nowFen: String(model.workflow.pending.targetFen),
          candidates: model.workflow.candidates
        };
      }
      case "REACHING": {
        const session = model.workflow.session;
        const currentPlacement = String(session.currentFen).split(" ")[0];
        return {
          tag: "reach",
          beforeFen: String(session.startFen),
          nowFen: String(session.currentFen),
          afterFen: String(session.targetFen),
          moves: session.moves.length,
          reached: currentPlacement === String(session.targetFen)
        };
      }
      case "ANALYSIS": {
        const game = model.games.find((g) => g.id === model.workflow.activeGameId);
        const tree = model.analyses[model.workflow.activeGameId];
        let fen = game?.fen ?? "start";
        if (tree && model.workflow.cursor.length > 0) {
          let node = tree.root;
          for (const san of model.workflow.cursor) {
            const child = node.children.find((c) => c.san === san);
            if (child) {
              node = child;
            } else {
              break;
            }
          }
          fen = node.fen.split(" ")[0];
        }
        return { tag: "analysis", fen };
      }
    }
  };
  var renderBoardRow = (model, dispatch) => {
    const mode = getBoardRowMode(model);
    toggleHidden(els.boardRowConfirm, false);
    toggleHidden(els.boardRowMatch, false);
    toggleHidden(els.boardRowReach, false);
    toggleHidden(els.boardRowAnalysis, false);
    toggleHidden(els.boardRowHowReach, false);
    if (mode.tag === "hidden") {
      els.boardRow.classList.add("hidden");
      return;
    }
    els.boardRow.classList.remove("hidden");
    switch (mode.tag) {
      case "confirm":
        toggleHidden(els.boardSlotBefore, false);
        toggleHidden(els.boardSlotAfter, false);
        toggleHidden(els.boardRowConfirm, true);
        setText(els.nowBoardInfo, "Detected position");
        break;
      case "match":
        toggleHidden(els.boardSlotBefore, mode.beforeFen !== null);
        toggleHidden(els.boardSlotAfter, false);
        toggleHidden(els.boardRowMatch, true);
        setText(els.beforeBoardInfo, "Previous game");
        setText(els.nowBoardInfo, "Detected position");
        els.matchGameSelect.innerHTML = mode.candidates.map((id, idx) => {
          const game = model.games.find((g) => g.id === id);
          return `<option value="${id}">Game ${idx + 1} (Page ${game?.page ?? "?"})</option>`;
        }).join("");
        break;
      case "reach":
        toggleHidden(els.boardSlotBefore, true);
        toggleHidden(els.boardSlotAfter, true);
        toggleHidden(els.boardRowReach, true);
        setText(els.beforeBoardInfo, "Starting position");
        setText(els.nowBoardInfo, "Enter moves here");
        if (mode.reached) {
          els.boardRowReachIndicator.textContent = "\u2713 Position reached!";
          els.boardRowReachIndicator.classList.add("reached");
          els.boardRowReachIndicator.classList.remove("not-reached");
        } else {
          els.boardRowReachIndicator.textContent = "Target position";
          els.boardRowReachIndicator.classList.remove("reached");
          els.boardRowReachIndicator.classList.add("not-reached");
        }
        setText(els.boardRowReachStatus, `Moves: ${mode.moves}`);
        els.btnRowUndo.disabled = mode.moves === 0;
        els.btnRowDone.disabled = mode.moves === 0;
        break;
      case "analysis":
        toggleHidden(els.boardSlotBefore, false);
        toggleHidden(els.boardSlotAfter, false);
        toggleHidden(els.boardRowAnalysis, true);
        setText(els.nowBoardInfo, "");
        break;
      case "howReach":
        toggleHidden(els.boardSlotBefore, false);
        toggleHidden(els.boardSlotAfter, false);
        toggleHidden(els.boardRowHowReach, true);
        setText(els.nowBoardInfo, "How to reach?");
        break;
    }
  };
  var render = (model, dispatch) => {
    const hasPdf = Boolean(model.pdf.id);
    toggleHidden(els.noPdfMessage, !hasPdf);
    setText(els.pdfInfo, model.pdf.filename ? `${model.pdf.filename} (${model.pdf.totalPages} pages)` : "");
    els.btnPrevPage.disabled = model.pdf.currentPage <= 1;
    els.btnNextPage.disabled = model.pdf.currentPage >= model.pdf.totalPages;
    setText(els.pageInfo, `Page ${model.pdf.currentPage} / ${model.pdf.totalPages}`);
    els.pageInput.value = String(model.pdf.currentPage);
    const zoomPercent = Math.round(model.pdf.scale * 100);
    els.zoomSlider.value = String(zoomPercent);
    setText(els.zoomValue, `${zoomPercent}%`);
    setText(els.statusBar, model.ui.statusMessage);
    updateBoardStatus(model.boardStatus.available, model.boardStatus.connected);
    els.textOverlay.textContent = model.ui.textOverlayText;
    toggleHidden(els.textOverlay, model.ui.textOverlayVisible);
    els.ocrStatus.textContent = model.ui.ocrStatus;
    toggleHidden(els.openingInputPanel, model.ui.openingInputVisible);
    if (model.ui.openingInputVisible) {
      els.openingMovesInput.value = model.ui.openingMovesInput;
    }
    const activeGame = getActiveGame(model);
    const hasActive = Boolean(activeGame);
    const isPending = activeGame?.pending ?? false;
    els.btnAnalyseWhite.disabled = !hasActive || isPending;
    els.btnAnalyseBlack.disabled = !hasActive || isPending;
    els.btnCopyFen.disabled = !hasActive;
    els.btnCopyPgn.disabled = !hasActive;
    els.btnSetOpening.disabled = !hasActive;
    els.btnSelectText.disabled = !hasActive;
    renderPositions(model, dispatch);
    renderWorkflowPanels(model);
    renderOverlayBoards(model);
    renderDiagramOverlay(model, dispatch);
    renderAnalysis(model, dispatch);
    renderReachModal(model);
    renderBoardRow(model, dispatch);
  };

  // static/ts/ui/bindings.ts
  var bindEvents = (dispatch, getModel) => {
    els.btnOpen.addEventListener("click", () => els.pdfInput.click());
    els.btnCloseBoard.addEventListener("click", () => dispatch({ tag: "DiagramActivated", gameId: null }));
    els.pdfPageContainer.addEventListener("click", (e) => {
      const rect = els.pdfPageContainer.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      console.log("[DEBUG] pdfPageContainer clicked at:", x, y, "target:", e.target);
    });
    els.pdfInput.addEventListener("change", () => {
      const file = els.pdfInput.files?.[0];
      if (!file) return;
      dispatch({ tag: "PdfFileSelected", file });
      els.pdfInput.value = "";
    });
    els.btnPrevPage.addEventListener("click", () => {
      const model = getModel();
      if (model.pdf.currentPage > 1) {
        dispatch({
          tag: "PageRequested",
          page: asPageNum(model.pdf.currentPage - 1)
        });
      }
    });
    els.btnNextPage.addEventListener("click", () => {
      const model = getModel();
      if (model.pdf.currentPage < model.pdf.totalPages) {
        dispatch({
          tag: "PageRequested",
          page: asPageNum(model.pdf.currentPage + 1)
        });
      }
    });
    els.btnGotoPage.addEventListener("click", () => {
      const model = getModel();
      const next = Number.parseInt(els.pageInput.value, 10);
      if (!Number.isFinite(next)) return;
      dispatch({
        tag: "PageRequested",
        page: asPageNum(Math.min(Math.max(next, 1), model.pdf.totalPages))
      });
    });
    els.pageInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        els.btnGotoPage.click();
      }
    });
    els.zoomSlider.addEventListener("input", () => {
      const value = Number.parseInt(els.zoomSlider.value, 10);
      if (!Number.isFinite(value)) return;
      dispatch({ tag: "ZoomChanged", scale: value / 100 });
    });
    els.btnConfirmPieces.addEventListener("click", () => dispatch({ tag: "ConfirmPieces" }));
    els.btnEditPieces.addEventListener("click", () => dispatch({ tag: "EditPieces" }));
    els.btnContinueGame.addEventListener("click", () => dispatch({ tag: "ContinueSelectedGame" }));
    els.btnNewGame.addEventListener("click", () => dispatch({ tag: "StartNewGame" }));
    els.btnReachOtb.addEventListener("click", () => dispatch({ tag: "ReachStartOtb" }));
    els.btnReachOcr.addEventListener(
      "click",
      () => dispatch({ tag: "TextSelectModeChanged", mode: "ocr" })
    );
    els.btnStopOtb.addEventListener("click", () => dispatch({ tag: "ReachCancel" }));
    els.btnStartTextSelect.addEventListener(
      "click",
      () => dispatch({ tag: "TextSelectModeChanged", mode: "overlay" })
    );
    els.btnToggleEngine.addEventListener("click", () => dispatch({ tag: "EngineToggle" }));
    els.btnAnalyseWhite.addEventListener("click", () => {
      const model = getModel();
      const active = model.workflow.tag === "VIEWING" ? model.workflow.activeGameId : null;
      if (active) {
        dispatch({ tag: "AnalysisStarted", gameId: active, turn: "w" });
      }
    });
    els.btnAnalyseBlack.addEventListener("click", () => {
      const model = getModel();
      const active = model.workflow.tag === "VIEWING" ? model.workflow.activeGameId : null;
      if (active) {
        dispatch({ tag: "AnalysisStarted", gameId: active, turn: "b" });
      }
    });
    els.btnCopyFen.addEventListener("click", () => dispatch({ tag: "CopyFen" }));
    els.btnCopyPgn.addEventListener("click", () => dispatch({ tag: "CopyPgn" }));
    els.btnSelectText.addEventListener(
      "click",
      () => dispatch({ tag: "TextSelectModeChanged", mode: "overlay" })
    );
    els.btnSetOpening.addEventListener(
      "click",
      () => dispatch({ tag: "OpeningsInputShown", content: "" })
    );
    els.btnApplyOpening.addEventListener(
      "click",
      () => dispatch({ tag: "OpeningsInputHidden" })
    );
    els.btnCancelOpening.addEventListener(
      "click",
      () => dispatch({ tag: "OpeningsInputHidden" })
    );
    els.reachBtnUndo.addEventListener("click", () => dispatch({ tag: "ReachUndo" }));
    els.reachBtnReset.addEventListener("click", () => dispatch({ tag: "ReachReset" }));
    els.reachBtnDone.addEventListener("click", () => dispatch({ tag: "ReachDone" }));
    els.reachBtnCancel.addEventListener("click", () => dispatch({ tag: "ReachCancel" }));
    els.reachModalClose.addEventListener("click", () => dispatch({ tag: "ReachCancel" }));
    const backdrop = document.querySelector(".reach-modal-backdrop");
    if (backdrop) {
      backdrop.addEventListener("click", () => dispatch({ tag: "ReachCancel" }));
    }
    els.btnRowConfirm.addEventListener("click", () => dispatch({ tag: "ConfirmPieces" }));
    els.btnRowEdit.addEventListener("click", () => dispatch({ tag: "EditPieces" }));
    els.btnRowContinue.addEventListener("click", () => dispatch({ tag: "ContinueSelectedGame" }));
    els.btnRowNewGame.addEventListener("click", () => dispatch({ tag: "StartNewGame" }));
    els.matchGameSelect.addEventListener("change", () => {
      const selectedId = els.matchGameSelect.value;
      if (selectedId) {
        dispatch({ tag: "MatchGameSelected", gameId: selectedId });
      }
    });
    els.btnRowUndo.addEventListener("click", () => dispatch({ tag: "ReachUndo" }));
    els.btnRowReset.addEventListener("click", () => dispatch({ tag: "ReachReset" }));
    els.btnRowDone.addEventListener("click", () => dispatch({ tag: "ReachDone" }));
    els.btnRowCancel.addEventListener("click", () => dispatch({ tag: "ReachCancel" }));
    els.btnRowAnalyseWhite.addEventListener("click", () => {
      const model = getModel();
      const active = model.workflow.tag === "VIEWING" ? model.workflow.activeGameId : null;
      if (active) {
        dispatch({ tag: "AnalysisStarted", gameId: active, turn: "w" });
      }
    });
    els.btnRowAnalyseBlack.addEventListener("click", () => {
      const model = getModel();
      const active = model.workflow.tag === "VIEWING" ? model.workflow.activeGameId : null;
      if (active) {
        dispatch({ tag: "AnalysisStarted", gameId: active, turn: "b" });
      }
    });
    els.btnRowCopyFen.addEventListener("click", () => dispatch({ tag: "CopyFen" }));
    els.btnRowCopyPgn.addEventListener("click", () => dispatch({ tag: "CopyPgn" }));
    els.btnRowClose.addEventListener("click", () => dispatch({ tag: "DiagramActivated", gameId: null }));
    els.btnRowOtb.addEventListener("click", () => dispatch({ tag: "ReachStartOtb" }));
    els.btnRowManual.addEventListener("click", () => dispatch({ tag: "ReachStartManual" }));
    document.addEventListener("keydown", (event) => {
      const target = event.target;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) {
        return;
      }
      const model = getModel();
      switch (event.key) {
        case "ArrowLeft":
          if (model.pdf.currentPage > 1) {
            dispatch({ tag: "PageRequested", page: asPageNum(model.pdf.currentPage - 1) });
          }
          break;
        case "ArrowRight":
          if (model.pdf.currentPage < model.pdf.totalPages) {
            dispatch({ tag: "PageRequested", page: asPageNum(model.pdf.currentPage + 1) });
          }
          break;
        case "Escape":
          dispatch({ tag: "DiagramActivated", gameId: null });
          break;
        case "h":
          dispatch({ tag: "AnalysisGoBack" });
          break;
        case "l":
          dispatch({ tag: "AnalysisGoForward" });
          break;
        case "j":
          dispatch({ tag: "AnalysisNextVariation" });
          break;
        case "k":
          dispatch({ tag: "AnalysisPrevVariation" });
          break;
        case "x":
        case "Delete":
        case "Backspace":
          if (event.key === "Backspace" && !event.ctrlKey && !event.metaKey) {
            break;
          }
          dispatch({ tag: "AnalysisDeleteVariation" });
          event.preventDefault();
          break;
        default:
          break;
      }
    });
  };

  // static/ts/ui/palette.ts
  var selectedPiece = null;
  var pieceTheme = "/static/vendor/img/chesspieces/wikipedia/{piece}.png";
  var createPieceImg = (piece, dispatch) => {
    const img = document.createElement("img");
    img.src = pieceTheme.replace("{piece}", piece);
    img.draggable = true;
    img.dataset.piece = piece;
    img.className = "palette-piece";
    img.addEventListener("dragstart", (event) => {
      event.dataTransfer?.setData("piece", piece);
      event.dataTransfer?.setData("text/plain", piece);
      if (event.dataTransfer) {
        event.dataTransfer.effectAllowed = "copy";
      }
    });
    img.addEventListener("click", () => {
      document.querySelectorAll(".palette-piece.selected").forEach((el) => {
        el.classList.remove("selected");
      });
      if (selectedPiece === piece) {
        selectedPiece = null;
        dispatch({ tag: "Status", message: "Piece deselected" });
      } else {
        selectedPiece = piece;
        img.classList.add("selected");
        dispatch({
          tag: "Status",
          message: `Selected ${piece} - click on board to place, or click piece again to deselect`
        });
      }
    });
    return img;
  };
  var getSquareFromEvent = (event) => {
    const boardEl = document.getElementById("active-board");
    if (!boardEl) return null;
    const rect = boardEl.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    if (x < 0 || y < 0 || x > rect.width || y > rect.height) return null;
    const squareSize = rect.width / 8;
    const file = Math.floor(x / squareSize);
    const rank = 7 - Math.floor(y / squareSize);
    if (file < 0 || file > 7 || rank < 0 || rank > 7) return null;
    const files = "abcdefgh";
    return `${files[file]}${rank + 1}`;
  };
  var placePieceOnSquare = (board, piece, square, dispatch) => {
    const current = board.position();
    current[square] = piece;
    board.position(current, false);
    dispatch({ tag: "Status", message: `Placed ${piece} on ${square}` });
  };
  var removePieceFromSquare = (board, square, dispatch) => {
    const current = board.position();
    if (!current[square]) {
      dispatch({ tag: "Status", message: `No piece on ${square}` });
      return;
    }
    const piece = current[square];
    delete current[square];
    board.position(current, false);
    dispatch({ tag: "Status", message: `Removed ${piece} from ${square}` });
  };
  var setupPiecePalettes = (dispatch, getPreviewBoard, isEditable) => {
    const blackPieces = ["bK", "bQ", "bR", "bB", "bN", "bP"];
    const whitePieces = ["wK", "wQ", "wR", "wB", "wN", "wP"];
    els.paletteBlack.innerHTML = "";
    els.paletteWhite.innerHTML = "";
    blackPieces.forEach((piece) => els.paletteBlack.appendChild(createPieceImg(piece, dispatch)));
    whitePieces.forEach((piece) => els.paletteWhite.appendChild(createPieceImg(piece, dispatch)));
    els.boardOverlay.addEventListener("dragover", (event) => {
      console.log("[PALETTE] dragover on boardOverlay");
      event.preventDefault();
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = "copy";
      }
    });
    els.boardOverlay.addEventListener("drop", (event) => {
      console.log("[PALETTE] drop on boardOverlay, piece:", event.dataTransfer?.getData("piece"));
      event.preventDefault();
      if (!isEditable()) {
        dispatch({ tag: "Status", message: "Cannot edit board during analysis" });
        return;
      }
      const board = getPreviewBoard();
      if (!board) {
        console.log("[PALETTE] no board available");
        return;
      }
      const piece = event.dataTransfer?.getData("piece");
      if (!piece) {
        console.log("[PALETTE] no piece in dataTransfer");
        return;
      }
      const square = getSquareFromEvent(event);
      if (!square) {
        console.log("[PALETTE] could not determine square from event");
        return;
      }
      console.log("[PALETTE] placing", piece, "on", square);
      placePieceOnSquare(board, piece, square, dispatch);
    });
    els.boardOverlay.addEventListener("click", (event) => {
      console.log("[PALETTE] click on boardOverlay, selectedPiece:", selectedPiece);
      if (!selectedPiece) return;
      if (!isEditable()) {
        dispatch({ tag: "Status", message: "Cannot edit board during analysis" });
        return;
      }
      const board = getPreviewBoard();
      if (!board) {
        console.log("[PALETTE] no board for click");
        return;
      }
      const square = getSquareFromEvent(event);
      if (!square) {
        console.log("[PALETTE] no square from click event");
        return;
      }
      console.log("[PALETTE] placing", selectedPiece, "on", square, "via click");
      placePieceOnSquare(board, selectedPiece, square, dispatch);
      selectedPiece = null;
      document.querySelectorAll(".palette-piece.selected").forEach((el) => {
        el.classList.remove("selected");
      });
    });
    els.boardOverlay.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      if (!isEditable()) {
        dispatch({ tag: "Status", message: "Cannot edit board during analysis" });
        return;
      }
      const board = getPreviewBoard();
      if (!board) return;
      const square = getSquareFromEvent(event);
      if (!square) return;
      removePieceFromSquare(board, square, dispatch);
    });
  };

  // static/ts/ui/selection.ts
  var dragState = null;
  var createRect = (x, y, className) => {
    const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    rect.setAttribute("x", String(x));
    rect.setAttribute("y", String(y));
    rect.setAttribute("width", "0");
    rect.setAttribute("height", "0");
    rect.classList.add(className);
    return rect;
  };
  var updateRect = (state, x, y) => {
    const width = Math.abs(x - state.startX);
    const height = state.mode === "manual" ? width : Math.abs(y - state.startY);
    const left = Math.min(state.startX, x);
    const top = state.mode === "manual" ? Math.min(state.startY, state.startY + (y > state.startY ? height : -height)) : Math.min(state.startY, y);
    state.rect.setAttribute("x", String(left));
    state.rect.setAttribute("y", String(top));
    state.rect.setAttribute("width", String(width));
    state.rect.setAttribute("height", String(height));
  };
  var bindManualSelection = (dispatch, getModel) => {
    const getLocalPoint = (event) => {
      const rect = els.detectionOverlay.getBoundingClientRect();
      return { x: event.clientX - rect.left, y: event.clientY - rect.top };
    };
    els.detectionOverlay.addEventListener("mousedown", (event) => {
      const model = getModel();
      if (!model.pdf.id) return;
      const target = event.target;
      if (target.classList.contains("detection-box") || target.classList.contains("resize-handle")) {
        return;
      }
      const { x, y } = getLocalPoint(event);
      if (model.ui.textSelectMode) {
        const rect2 = createRect(x, y, "text-select-box");
        els.detectionOverlay.appendChild(rect2);
        dragState = { startX: x, startY: y, rect: rect2, mode: "text" };
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
    const endSelection = (event) => {
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
        asCssPx(height)
      );
      rect.remove();
      if (dragState.mode === "text") {
        dispatch({ tag: "TextSelectModeChanged", mode: null });
        if (model.pdf.id) {
          dispatch({
            tag: "ExtractMovesRequested",
            page: toPageIndex(model.pdf.currentPage),
            bbox: cssToPdfBBox(cssBox, model.pdf.scale)
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

  // static/ts/core/result.ts
  var ok = (value) => ({ ok: true, value });
  var err = (error) => ({ ok: false, error });

  // static/ts/ports/api.ts
  var isRecord = (value) => typeof value === "object" && value !== null;
  var getString = (value) => typeof value === "string" ? value : null;
  var getNumber = (value) => typeof value === "number" && Number.isFinite(value) ? value : null;
  var decodePdfInfo = (data, filenameOverride) => {
    const pdfId = getString(data.pdf_id);
    const contentHash = getString(data.content_hash) ?? pdfId;
    const pages = getNumber(data.pages);
    const filename = filenameOverride ?? getString(data.filename);
    const hasStudy = typeof data.has_study === "boolean" ? data.has_study : false;
    if (!pdfId || !contentHash || pages === null || !filename) {
      return err("Invalid PDF info response");
    }
    return ok({
      pdfId: asPdfId(pdfId),
      contentHash: asContentHash(contentHash),
      filename,
      pages,
      hasStudy
    });
  };
  var decodePdfBBox = (data) => {
    const x = getNumber(data.x);
    const y = getNumber(data.y);
    const width = getNumber(data.width);
    const height = getNumber(data.height);
    if (x === null || y === null || width === null || height === null) {
      return err("Invalid bbox");
    }
    return ok(bbox(asPdfPx(x), asPdfPx(y), asPdfPx(width), asPdfPx(height)));
  };
  var checkPdf = async (contentHash) => {
    try {
      const response = await fetch(`/api/check-pdf/${contentHash}`);
      if (!response.ok) {
        if (response.status === 404) {
          return ok({ exists: false });
        }
        const errorData = await response.json().catch(() => null);
        if (isRecord(errorData) && typeof errorData.error === "string") {
          return err(errorData.error);
        }
        return err("Failed to check PDF");
      }
      const data = await response.json();
      if (!isRecord(data)) {
        return err("Invalid response");
      }
      const decoded = decodePdfInfo(data);
      if (!decoded.ok) return decoded;
      return ok({ exists: true, info: decoded.value });
    } catch (error) {
      return err(String(error));
    }
  };
  var uploadPdf = async (file, _contentHash) => {
    try {
      const formData = new FormData();
      formData.append("file", file);
      const response = await fetch("/api/upload-pdf", {
        method: "POST",
        body: formData
      });
      const data = await response.json();
      if (!response.ok) {
        if (isRecord(data) && typeof data.error === "string") {
          return err(data.error);
        }
        return err("Failed to upload PDF");
      }
      if (!isRecord(data)) {
        return err("Invalid response");
      }
      return decodePdfInfo(data, file.name);
    } catch (error) {
      return err(String(error));
    }
  };
  var detectDiagrams = async (pdfId, pageIndex) => {
    try {
      const response = await fetch(`/api/detect-diagrams/${pdfId}/${pageIndex}`);
      const data = await response.json();
      if (!response.ok) {
        if (isRecord(data) && typeof data.error === "string") {
          return err(data.error);
        }
        return err("Failed to detect diagrams");
      }
      if (!isRecord(data) || !Array.isArray(data.diagrams)) {
        return err("Invalid diagrams response");
      }
      const boxes = [];
      for (const item of data.diagrams) {
        if (!isRecord(item)) {
          return err("Invalid bbox");
        }
        const decoded = decodePdfBBox(item);
        if (!decoded.ok) {
          return err(decoded.error);
        }
        boxes.push(decoded.value);
      }
      return ok(boxes);
    } catch (error) {
      return err(String(error));
    }
  };
  var recognizeRegion = async (pdfId, pageIndex, bbox2) => {
    try {
      const response = await fetch("/api/recognize-region", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pdf_id: pdfId,
          page: pageIndex,
          bbox: {
            x: bbox2.x,
            y: bbox2.y,
            width: bbox2.width,
            height: bbox2.height
          }
        })
      });
      const data = await response.json();
      if (!response.ok) {
        if (isRecord(data) && typeof data.error === "string") {
          return err(data.error);
        }
        return err("Recognition failed");
      }
      if (!isRecord(data)) return err("Invalid response");
      const fen = getString(data.fen);
      const confidence = getNumber(data.confidence);
      if (!fen || confidence === null) {
        return err("Invalid recognition response");
      }
      return ok({ placement: asFenPlacement(fen), confidence });
    } catch (error) {
      return err(String(error));
    }
  };
  var extractMoves = async (pdfId, pageIndex, bbox2) => {
    try {
      const response = await fetch("/api/extract-moves", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pdf_id: pdfId,
          page: pageIndex,
          bbox: {
            x: bbox2.x,
            y: bbox2.y,
            width: bbox2.width,
            height: bbox2.height
          }
        })
      });
      const data = await response.json();
      if (!response.ok) {
        if (isRecord(data) && typeof data.error === "string") {
          return err(data.error);
        }
        return err("Failed to extract moves");
      }
      if (!isRecord(data)) return err("Invalid response");
      const pdfText = getString(data.pdf_text) ?? "";
      const ocrText = getString(data.ocr_text) ?? "";
      return ok({ pdfText, ocrText });
    } catch (error) {
      return err(String(error));
    }
  };
  var saveStudy = async (pdfId, study) => {
    try {
      const response = await fetch("/api/save-study", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pdf_id: pdfId,
          study: serializeStudy(study)
        })
      });
      const data = await response.json();
      if (!response.ok) {
        if (isRecord(data) && typeof data.error === "string") {
          return err(data.error);
        }
        return err("Failed to save study");
      }
      return ok(void 0);
    } catch (error) {
      return err(String(error));
    }
  };
  var loadStudy = async (pdfId) => {
    try {
      const response = await fetch(`/api/load-study/${pdfId}`);
      if (!response.ok) {
        if (response.status === 404) {
          return ok(null);
        }
      }
      const data = await response.json();
      if (!response.ok) {
        if (isRecord(data) && typeof data.error === "string") {
          return err(data.error);
        }
        return err("Failed to load study");
      }
      if (!isRecord(data)) return err("Invalid response");
      if (data.exists !== true || !isRecord(data.study)) {
        return ok(null);
      }
      return decodeStudy(data.study);
    } catch (error) {
      return err(String(error));
    }
  };
  var serializeStudy = (study) => ({
    games: study.games.filter((game) => !game.pending).map((game) => ({
      id: game.id,
      page: game.page,
      bbox: game.bbox,
      fen: game.fen,
      confidence: game.confidence,
      pending: game.pending
    })),
    analyses: Object.fromEntries(
      Object.entries(study.analyses).map(([id, tree]) => [id, analysisTreeToJSON(tree)])
    ),
    continuations: study.continuations
  });
  var decodeStudy = (data) => {
    if (!Array.isArray(data.games)) {
      return err("Invalid study games");
    }
    const games = [];
    for (const entry of data.games) {
      if (!isRecord(entry)) {
        return err("Invalid game entry");
      }
      const id = getString(entry.id);
      const page = getNumber(entry.page);
      const bboxEntry = entry.bbox;
      const fen = getString(entry.fen);
      const confidence = getNumber(entry.confidence) ?? 0;
      const pending = typeof entry.pending === "boolean" ? entry.pending : false;
      if (!id || page === null || !fen || !isRecord(bboxEntry)) {
        return err("Invalid game data");
      }
      const bboxDecoded = decodePdfBBox(bboxEntry);
      if (!bboxDecoded.ok) {
        return err(bboxDecoded.error);
      }
      games.push({
        id: asGameId(id),
        page: asPageNum(page),
        bbox: bboxDecoded.value,
        fen: asFenPlacement(fen),
        confidence,
        pending
      });
    }
    const analyses = {};
    if (isRecord(data.analyses)) {
      for (const [id, treeData] of Object.entries(data.analyses)) {
        if (isRecord(treeData)) {
          analyses[asGameId(id)] = analysisTreeFromJSON(treeData);
        }
      }
    }
    const continuations = {};
    if (isRecord(data.continuations)) {
      for (const [id, linkData] of Object.entries(data.continuations)) {
        if (isRecord(linkData)) {
          const analysisId = getString(linkData.analysisId);
          const nodePath = Array.isArray(linkData.nodePath) ? linkData.nodePath.map((san) => asSanSafe(san)) : [];
          if (analysisId) {
            continuations[asGameId(id)] = {
              analysisId: asGameId(analysisId),
              nodePath
            };
          }
        }
      }
    }
    return ok({ games, analyses, continuations });
  };
  var asSanSafe = (value) => typeof value === "string" ? asSan(value) : asSan("");

  // static/ts/ports/chessnut.ts
  var isRecord2 = (value) => typeof value === "object" && value !== null;
  var setFen = async (fen, force) => {
    try {
      const response = await fetch("/api/board/set-fen", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fen, force })
      });
      const data = await response.json();
      if (!response.ok) {
        if (isRecord2(data) && typeof data.error === "string") {
          return err(data.error);
        }
        return err("Failed to sync board");
      }
      if (!isRecord2(data)) return err("Invalid board response");
      return ok({
        synced: Boolean(data.synced),
        driverSynced: Boolean(data.driver_synced),
        error: typeof data.error === "string" ? data.error : void 0
      });
    } catch (error) {
      return err(String(error));
    }
  };
  var fetchStatus = async () => {
    try {
      const response = await fetch("/api/board/status", {
        method: "GET",
        signal: AbortSignal.timeout(2e3)
      });
      const data = await response.json();
      if (!response.ok) {
        return err("Board status unavailable");
      }
      if (!isRecord2(data)) return err("Invalid board status");
      return ok({
        available: Boolean(data.available),
        connected: Boolean(data.connected)
      });
    } catch (error) {
      return err(String(error));
    }
  };
  var fetchFen = async () => {
    try {
      const response = await fetch("/api/board/fen");
      const data = await response.json();
      if (!response.ok) {
        return err("Board fen unavailable");
      }
      if (!isRecord2(data) || typeof data.fen !== "string") {
        return err("Invalid board fen");
      }
      return ok(asFenFull(data.fen));
    } catch (error) {
      return err(String(error));
    }
  };

  // static/ts/ports/pdfjs.ts
  var loadPdf = async (pdfId) => {
    try {
      const pdfUrl = `/api/pdf/${pdfId}`;
      const doc = await pdfjsLib.getDocument(pdfUrl).promise;
      return ok(doc);
    } catch (error) {
      return err(String(error));
    }
  };
  var renderPage = async (resources, target, pageNum, scale, initialScaleSet) => {
    if (!resources.doc) {
      return err("PDF not loaded");
    }
    if (resources.renderTask) {
      try {
        resources.renderTask.cancel();
      } catch {
      }
      resources.renderTask = null;
    }
    try {
      const page = await resources.doc.getPage(pageNum);
      let nextScale = scale;
      let nextInitialScaleSet = initialScaleSet;
      if (!initialScaleSet) {
        const containerWidth = target.viewportContainer.clientWidth - 40;
        const defaultViewport = page.getViewport({ scale: 1 });
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
        if (error.name !== "RenderingCancelledException") {
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

  // static/ts/ports/stockfish.ts
  var parseScore = (line) => {
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
  var parsePv = (line) => {
    const match = line.match(/pv (.+)/);
    if (!match) return null;
    return match[1].split(" ").slice(0, 8).join(" ");
  };
  var createStockfish = (onInfo) => {
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
  var startEngine = (engine) => {
    engine.worker.postMessage("uci");
    engine.worker.postMessage("isready");
  };
  var stopEngine = (engine) => {
    engine.worker.postMessage("stop");
  };
  var analyze = (engine, fen, depth) => {
    engine.worker.postMessage(`position fen ${fen}`);
    engine.worker.postMessage(`go depth ${depth}`);
  };

  // static/ts/ui/adapters/chessboard.ts
  var createBoard = (elementId, config) => Chessboard(elementId, config);
  var getBoardFen = (board) => {
    const position = board.position();
    return asFenPlacement(Chessboard.objToFen(position));
  };

  // static/ts/core/runtime.ts
  var createResources = () => ({
    pdf: { doc: null, renderTask: null },
    previewBoard: null,
    previewMode: null,
    analysisGame: null,
    reachGame: null,
    reachBoards: { start: null, entry: null, target: null },
    boardRow: { before: null, now: null, after: null, nowGame: null, currentMode: null },
    stockfish: null,
    boardStatusTimer: null,
    chessnutPollTimer: null,
    saveTimer: null
  });
  var hashFile = async (file) => {
    const buffer = await file.arrayBuffer();
    const hashBuffer = await crypto.subtle.digest("SHA-256", buffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hashHex = hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
    return hashHex.substring(0, 16);
  };
  var buildStudy = (model) => ({
    games: model.games,
    analyses: model.analyses,
    continuations: model.continuations
  });
  var createRuntime = (initial) => {
    let model = initial;
    const resources = createResources();
    const getModel = () => model;
    const dispatch = (msg) => {
      const [next, cmds] = update(model, msg);
      model = next;
      render(model, dispatch);
      syncPreviewBoard();
      syncReachBoards();
      syncBoardRow();
      cmds.forEach((cmd) => {
        void runCmd(cmd);
      });
    };
    let lastActiveGameId = null;
    const syncPreviewBoard = () => {
      const active = getActiveGame(model);
      if (!active) {
        resources.previewBoard?.destroy();
        resources.previewBoard = null;
        resources.previewMode = null;
        resources.analysisGame = null;
        lastActiveGameId = null;
        return;
      }
      const mode = model.workflow.tag === "ANALYSIS" ? "analysis" : "preview";
      const analysisFen = model.workflow.tag === "ANALYSIS" ? getAnalysisNodeFen(model, active.id) : null;
      const boardFen = analysisFen ?? active.fen;
      const gameChanged = lastActiveGameId !== active.id;
      lastActiveGameId = active.id;
      if (!resources.previewBoard || resources.previewMode !== mode || gameChanged) {
        resources.previewBoard?.destroy();
        resources.previewBoard = null;
        const onDrop = mode === "analysis" ? (source, target) => {
          if (!resources.analysisGame) return "snapback";
          const move = resources.analysisGame.move({
            from: source,
            to: target,
            promotion: "q"
          });
          if (!move) return "snapback";
          dispatch({ tag: "AnalysisMoveMade", san: asSan(move.san), fen: asFenFull(resources.analysisGame.fen()) });
          return void 0;
        } : void 0;
        const onSnapEnd = mode === "analysis" ? () => {
          if (!resources.analysisGame || !resources.previewBoard) return;
          resources.previewBoard.position(resources.analysisGame.fen());
        } : void 0;
        resources.previewBoard = createBoard("active-board", {
          position: String(boardFen),
          draggable: true,
          showNotation: mode === "analysis",
          pieceTheme: "/static/vendor/img/chesspieces/wikipedia/{piece}.png",
          dropOffBoard: "trash",
          sparePieces: false,
          onDrop,
          onSnapEnd
        });
        resources.previewMode = mode;
      } else if (mode === "analysis") {
        resources.previewBoard?.position(String(boardFen), false);
      }
      resources.analysisGame = mode === "analysis" && analysisFen ? new Chess(analysisFen) : null;
    };
    const syncReachBoards = () => {
      if (model.workflow.tag !== "REACHING") {
        resources.reachGame = null;
        return;
      }
      if (!resources.reachGame || resources.reachGame.fen() !== String(model.workflow.session.currentFen)) {
        resources.reachGame = new Chess(model.workflow.session.currentFen);
      }
      resources.reachBoards.entry?.position(String(model.workflow.session.currentFen));
    };
    const syncBoardRow = () => {
      const workflow = model.workflow;
      const modeKey = workflow.tag;
      if (modeKey === "NO_PDF" || modeKey === "VIEWING") {
        if (resources.boardRow.currentMode !== null) {
          resources.boardRow.before?.destroy();
          resources.boardRow.now?.destroy();
          resources.boardRow.after?.destroy();
          resources.boardRow = { before: null, now: null, after: null, nowGame: null, currentMode: null };
        }
        return;
      }
      if (resources.boardRow.currentMode !== modeKey) {
        resources.boardRow.before?.destroy();
        resources.boardRow.now?.destroy();
        resources.boardRow.after?.destroy();
        resources.boardRow.nowGame = null;
        const pieceTheme2 = "/static/vendor/img/chesspieces/wikipedia/{piece}.png";
        switch (workflow.tag) {
          case "PENDING_CONFIRM": {
            resources.boardRow.now = createBoard("now-board", {
              position: String(workflow.pending.targetFen),
              draggable: false,
              showNotation: false,
              pieceTheme: pieceTheme2
            });
            resources.boardRow.before = null;
            resources.boardRow.after = null;
            break;
          }
          case "MATCH_EXISTING": {
            const selectedId = workflow.selected;
            const selectedGame = selectedId ? model.games.find((g) => g.id === selectedId) : null;
            if (selectedGame) {
              resources.boardRow.before = createBoard("before-board", {
                position: String(selectedGame.fen),
                draggable: false,
                showNotation: false,
                pieceTheme: pieceTheme2
              });
            }
            resources.boardRow.now = createBoard("now-board", {
              position: String(workflow.pending.targetFen),
              draggable: false,
              showNotation: false,
              pieceTheme: pieceTheme2
            });
            resources.boardRow.after = null;
            break;
          }
          case "REACHING": {
            const session = workflow.session;
            resources.boardRow.nowGame = new Chess(session.startFen);
            resources.boardRow.before = createBoard("before-board", {
              position: String(session.startFen).split(" ")[0],
              draggable: false,
              showNotation: false,
              pieceTheme: pieceTheme2
            });
            const onDragStart = (_source, piece) => {
              if (!resources.boardRow.nowGame) return false;
              if (resources.boardRow.nowGame.game_over()) return false;
              const turn = resources.boardRow.nowGame.turn();
              if (turn === "w" && piece.startsWith("b") || turn === "b" && piece.startsWith("w")) {
                return false;
              }
              return true;
            };
            const onDrop = (source, target) => {
              if (!resources.boardRow.nowGame) return "snapback";
              const move = resources.boardRow.nowGame.move({ from: source, to: target, promotion: "q" });
              if (!move) return "snapback";
              dispatch({ tag: "ReachMoveMade", san: asSan(move.san), fen: asFenFull(resources.boardRow.nowGame.fen()) });
              return void 0;
            };
            const onSnapEnd = () => {
              if (!resources.boardRow.nowGame || !resources.boardRow.now) return;
              resources.boardRow.now.position(resources.boardRow.nowGame.fen());
            };
            resources.boardRow.now = createBoard("now-board", {
              position: String(session.startFen).split(" ")[0],
              draggable: true,
              showNotation: true,
              pieceTheme: pieceTheme2,
              onDragStart,
              onDrop,
              onSnapEnd
            });
            resources.boardRow.after = createBoard("after-board", {
              position: String(session.targetFen),
              draggable: false,
              showNotation: false,
              pieceTheme: pieceTheme2
            });
            break;
          }
          case "ANALYSIS": {
            const game = model.games.find((g) => g.id === workflow.activeGameId);
            const tree = model.analyses[workflow.activeGameId];
            let currentFen = game?.fen ?? "start";
            if (tree && workflow.cursor.length > 0) {
              let node = tree.root;
              for (const san of workflow.cursor) {
                const child = node.children.find((c) => c.san === san);
                if (child) {
                  node = child;
                } else {
                  break;
                }
              }
              currentFen = node.fen.split(" ")[0];
            }
            resources.boardRow.nowGame = new Chess(currentFen);
            const onDrop = (source, target) => {
              if (!resources.boardRow.nowGame) return "snapback";
              const move = resources.boardRow.nowGame.move({ from: source, to: target, promotion: "q" });
              if (!move) return "snapback";
              dispatch({ tag: "AnalysisMoveMade", san: asSan(move.san), fen: asFenFull(resources.boardRow.nowGame.fen()) });
              return void 0;
            };
            const onSnapEnd = () => {
              if (!resources.boardRow.nowGame || !resources.boardRow.now) return;
              resources.boardRow.now.position(resources.boardRow.nowGame.fen());
            };
            resources.boardRow.now = createBoard("now-board", {
              position: currentFen,
              draggable: true,
              showNotation: true,
              pieceTheme: pieceTheme2,
              onDrop,
              onSnapEnd
            });
            resources.boardRow.before = null;
            resources.boardRow.after = null;
            break;
          }
        }
        resources.boardRow.currentMode = modeKey;
        setTimeout(() => {
          resources.boardRow.before?.resize();
          resources.boardRow.now?.resize();
          resources.boardRow.after?.resize();
        }, 50);
        return;
      }
      switch (workflow.tag) {
        case "REACHING": {
          const session = workflow.session;
          if (!resources.boardRow.nowGame || resources.boardRow.nowGame.fen() !== String(session.currentFen)) {
            resources.boardRow.nowGame = new Chess(session.currentFen);
          }
          resources.boardRow.now?.position(String(session.currentFen));
          break;
        }
        case "ANALYSIS": {
          const tree = model.analyses[workflow.activeGameId];
          const game = model.games.find((g) => g.id === workflow.activeGameId);
          let currentFen = game?.fen ?? "start";
          if (tree && workflow.cursor.length > 0) {
            let node = tree.root;
            for (const san of workflow.cursor) {
              const child = node.children.find((c) => c.san === san);
              if (child) {
                node = child;
              } else {
                break;
              }
            }
            currentFen = node.fen;
          }
          resources.boardRow.now?.position(currentFen.split(" ")[0]);
          if (resources.boardRow.nowGame) {
            resources.boardRow.nowGame = new Chess(currentFen);
          }
          break;
        }
        case "MATCH_EXISTING": {
          const selectedId = workflow.selected;
          const selectedGame = selectedId ? model.games.find((g) => g.id === selectedId) : null;
          if (selectedGame && resources.boardRow.before) {
            resources.boardRow.before.position(String(selectedGame.fen));
          }
          break;
        }
      }
    };
    const runCmd = async (cmd) => {
      switch (cmd.tag) {
        case "PDF_LOAD_FILE": {
          const contentHash = await hashFile(cmd.file);
          const hash = asContentHash(contentHash);
          const check = await checkPdf(hash);
          if (check.ok && check.value.exists) {
            const info = check.value.info;
            const loaded2 = await loadPdf(info.pdfId);
            if (!loaded2.ok) {
              dispatch({ tag: "Error", scope: "pdf", message: loaded2.error });
              return;
            }
            resources.pdf.doc = loaded2.value;
            dispatch({
              tag: "PdfOpened",
              pdfId: info.pdfId,
              pages: info.pages,
              filename: cmd.file.name,
              contentHash: info.contentHash
            });
            return;
          }
          const uploaded = await uploadPdf(cmd.file, hash);
          if (!uploaded.ok) {
            dispatch({ tag: "Error", scope: "upload", message: uploaded.error });
            return;
          }
          const loaded = await loadPdf(uploaded.value.pdfId);
          if (!loaded.ok) {
            dispatch({ tag: "Error", scope: "pdf", message: loaded.error });
            return;
          }
          resources.pdf.doc = loaded.value;
          dispatch({
            tag: "PdfOpened",
            pdfId: uploaded.value.pdfId,
            pages: uploaded.value.pages,
            filename: uploaded.value.filename,
            contentHash: uploaded.value.contentHash
          });
          return;
        }
        case "PDF_LOAD_BY_ID": {
          const loaded = await loadPdf(cmd.pdfId);
          if (!loaded.ok) {
            dispatch({ tag: "Error", scope: "pdf", message: loaded.error });
            return;
          }
          resources.pdf.doc = loaded.value;
          return;
        }
        case "PDF_RENDER_PAGE": {
          const result = await renderPage(
            resources.pdf,
            { canvas: els.pdfCanvas, overlay: els.detectionOverlay, viewportContainer: els.pdfViewport },
            cmd.page,
            cmd.scale,
            model.pdf.initialScaleSet
          );
          if (result.ok) {
            dispatch({
              tag: "PageRendered",
              page: cmd.page,
              scale: result.value.scale,
              initialScaleSet: result.value.initialScaleSet
            });
          } else {
            dispatch({ tag: "Error", scope: "render", message: result.error });
          }
          return;
        }
        case "PDF_CANCEL_RENDER":
          if (resources.pdf.renderTask) {
            try {
              resources.pdf.renderTask.cancel();
            } catch {
            }
            resources.pdf.renderTask = null;
          }
          return;
        case "API_CHECK_PDF":
          await checkPdf(cmd.contentHash);
          return;
        case "API_UPLOAD_PDF":
          await uploadPdf(cmd.file, cmd.contentHash);
          return;
        case "API_DETECT_DIAGRAMS": {
          const result = await detectDiagrams(cmd.pdfId, cmd.page);
          if (result.ok) {
            dispatch({ tag: "DiagramsDetected", page: toPageNum(cmd.page), diagrams: result.value });
          } else {
            dispatch({ tag: "Error", scope: "detect", message: result.error });
          }
          return;
        }
        case "API_RECOGNIZE_REGION": {
          const result = await recognizeRegion(cmd.pdfId, cmd.page, cmd.bbox);
          if (result.ok) {
            dispatch({
              tag: "Recognized",
              page: toPageNum(cmd.page),
              bbox: cmd.bbox,
              placement: result.value.placement,
              confidence: result.value.confidence,
              gameId: asGameId(`g${cmd.page}_${Date.now()}`)
            });
          } else {
            dispatch({ tag: "RecognitionFailed", message: result.error });
          }
          return;
        }
        case "API_EXTRACT_MOVES": {
          const result = await extractMoves(cmd.pdfId, cmd.page, cmd.bbox);
          if (!result.ok) {
            dispatch({ tag: "ExtractMovesFailed", message: result.error });
            return;
          }
          const bestText = result.value.pdfText.trim().length > 0 ? result.value.pdfText : result.value.ocrText;
          dispatch({
            tag: "TextOverlayUpdated",
            text: bestText.trim() || "No text detected",
            visible: true
          });
          dispatch({ tag: "OcrStatusUpdated", text: "Text extracted" });
          return;
        }
        case "STUDY_LOAD": {
          const result = await loadStudy(cmd.pdfId);
          if (result.ok) {
            dispatch({ tag: "StudyLoaded", study: result.value });
          } else {
            dispatch({ tag: "Error", scope: "study", message: result.error });
          }
          return;
        }
        case "STUDY_SAVE": {
          const study = buildStudy(model);
          const result = await saveStudy(cmd.pdfId, study);
          if (result.ok) {
            dispatch({ tag: "StudySaved" });
          } else {
            dispatch({ tag: "Error", scope: "study", message: result.error });
          }
          return;
        }
        case "STUDY_DELETE":
          return;
        case "BOARD_STATUS_POLL_START": {
          if (resources.boardStatusTimer) {
            window.clearInterval(resources.boardStatusTimer);
          }
          const poll = async () => {
            const status = await fetchStatus();
            if (status.ok) {
              dispatch({
                tag: "BoardStatusUpdated",
                available: status.value.available,
                connected: status.value.connected
              });
            }
          };
          void poll();
          const timer = window.setInterval(poll, cmd.everyMs);
          resources.boardStatusTimer = timer;
          return;
        }
        case "BOARD_STATUS_POLL_STOP":
          if (resources.boardStatusTimer) {
            window.clearInterval(resources.boardStatusTimer);
            resources.boardStatusTimer = null;
          }
          return;
        case "CHESSNUT_SET_FEN": {
          await setFen(cmd.fen, cmd.force);
          return;
        }
        case "CHESSNUT_POLL_START": {
          if (resources.chessnutPollTimer) {
            window.clearInterval(resources.chessnutPollTimer);
          }
          const timer = window.setInterval(async () => {
            const result = await fetchFen();
            if (result.ok) {
              dispatch({ tag: "BoardFenUpdated", fen: result.value });
            }
          }, cmd.everyMs);
          resources.chessnutPollTimer = timer;
          return;
        }
        case "CHESSNUT_POLL_STOP":
          if (resources.chessnutPollTimer) {
            window.clearInterval(resources.chessnutPollTimer);
            resources.chessnutPollTimer = null;
          }
          return;
        case "REACH_SYNC_BOARD":
          await setFen(cmd.fen, true);
          return;
        case "REACH_HANDLE_PHYSICAL":
          return;
        case "ENGINE_START": {
          if (!resources.stockfish) {
            resources.stockfish = createStockfish(
              (info) => dispatch({ tag: "EngineInfo", evalText: info.evalText, pv: info.pv })
            );
          }
          if (resources.stockfish) {
            startEngine(resources.stockfish);
            dispatch({ tag: "EngineStarted" });
          }
          return;
        }
        case "ENGINE_STOP":
          if (resources.stockfish) {
            stopEngine(resources.stockfish);
            dispatch({ tag: "EngineStopped" });
          }
          return;
        case "ENGINE_ANALYZE":
          if (resources.stockfish) {
            analyze(resources.stockfish, cmd.fen, cmd.depth);
          }
          return;
        case "ANALYSIS_SYNC":
          if (resources.stockfish && model.engine.running) {
            analyze(resources.stockfish, cmd.fen, 16);
          }
          return;
        case "CLIPBOARD_WRITE":
          try {
            await navigator.clipboard.writeText(cmd.text);
          } catch {
            dispatch({ tag: "Error", scope: "clipboard", message: "Clipboard unavailable" });
          }
          return;
        case "CHESSBOARD_READ_PREVIEW":
          if (resources.previewBoard) {
            const placement = getBoardFen(resources.previewBoard);
            dispatch({ tag: "PiecesConfirmed", placement });
          }
          return;
        // OPEN_REACH_MODAL and CLOSE_REACH_MODAL removed - board row handles reach mode now
        case "REACH_SET_MOVES":
          dispatch({ tag: "ReachTargetResolved", moves: cmd.moves, finalFen: cmd.finalFen, turn: null });
          return;
        case "SCHEDULE_SAVE":
          if (resources.saveTimer) {
            window.clearTimeout(resources.saveTimer);
          }
          resources.saveTimer = window.setTimeout(() => {
            if (model.pdf.id) {
              dispatch({ tag: "Status", message: "Saving study..." });
              void runCmd({ tag: "STUDY_SAVE", pdfId: model.pdf.id });
            }
          }, cmd.delayMs);
          return;
        case "NO_OP":
          return;
        default:
          return;
      }
    };
    bindEvents(dispatch, getModel);
    setupPiecePalettes(
      dispatch,
      () => resources.previewBoard,
      () => model.workflow.tag !== "ANALYSIS"
    );
    bindManualSelection(dispatch, getModel);
    render(model, dispatch);
    syncPreviewBoard();
    syncReachBoards();
    syncBoardRow();
    window.addEventListener("beforeunload", (event) => {
      if (model.isDirty && model.pdf.id) {
        void runCmd({ tag: "STUDY_SAVE", pdfId: model.pdf.id });
        event.preventDefault();
        event.returnValue = "";
      }
    });
    return { dispatch, getModel };
  };

  // static/ts/main.ts
  pdfjsLib.GlobalWorkerOptions.workerSrc = "/static/vendor/js/pdf.worker.min.js";
  window.addEventListener("DOMContentLoaded", () => {
    createRuntime(initialModel);
  });
})();
//# sourceMappingURL=reader.bundle.js.map
