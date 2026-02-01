import type { FenFull } from "./fen";
import type { San } from "./san";

export type NodePath = ReadonlyArray<San>;

export type AnalysisNode = Readonly<{
  fen: FenFull;
  san: San | null;
  comment: string;
  children: ReadonlyArray<AnalysisNode>;
}>;

export type AnalysisTree = Readonly<{
  startFen: FenFull;
  turn: "w" | "b";
  root: AnalysisNode;
}>;

export type AnalysisNodeJson = {
  fen: string;
  san: string | null;
  comment?: string;
  children: AnalysisNodeJson[];
};

export type AnalysisTreeJson = {
  startFen: string;
  turn: "w" | "b";
  tree: AnalysisNodeJson;
};

export const createAnalysisTree = (startFen: FenFull, turn: "w" | "b"): AnalysisTree => ({
  startFen,
  turn,
  root: {
    fen: startFen,
    san: null,
    comment: "",
    children: [],
  },
});

export const getNode = (root: AnalysisNode, path: NodePath): AnalysisNode | null => {
  let current: AnalysisNode = root;
  for (const san of path) {
    const next = current.children.find((child) => child.san === san) ?? null;
    if (!next) return null;
    current = next;
  }
  return current;
};

const updateNodeAtPath = (
  node: AnalysisNode,
  path: NodePath,
  updater: (target: AnalysisNode) => AnalysisNode,
): AnalysisNode => {
  if (path.length === 0) {
    return updater(node);
  }
  const [head, ...rest] = path;
  const nextIndex = node.children.findIndex((child) => child.san === head);
  if (nextIndex === -1) return node;
  const updatedChild = updateNodeAtPath(node.children[nextIndex], rest, updater);
  if (updatedChild === node.children[nextIndex]) return node;
  const updatedChildren = node.children.map((child, idx) =>
    idx === nextIndex ? updatedChild : child,
  );
  return { ...node, children: updatedChildren };
};

export const makeMove = (
  tree: AnalysisTree,
  cursor: NodePath,
  san: San,
  fen: FenFull,
): { tree: AnalysisTree; cursor: NodePath } => {
  const existing = getNode(tree.root, [...cursor, san]);
  if (existing) {
    return { tree, cursor: [...cursor, san] };
  }
  const newNode: AnalysisNode = {
    fen,
    san,
    comment: "",
    children: [],
  };
  const nextRoot = updateNodeAtPath(tree.root, cursor, (node) => ({
    ...node,
    children: [...node.children, newNode],
  }));
  return { tree: { ...tree, root: nextRoot }, cursor: [...cursor, san] };
};

export const goBack = (cursor: NodePath): NodePath | null =>
  cursor.length === 0 ? null : cursor.slice(0, -1);

export const goForward = (tree: AnalysisTree, cursor: NodePath): NodePath | null => {
  const node = getNode(tree.root, cursor);
  if (!node || node.children.length === 0) return null;
  const nextSan = node.children[0].san;
  if (!nextSan) return null;
  return [...cursor, nextSan];
};

export const getNextVariation = (tree: AnalysisTree, cursor: NodePath): NodePath | null => {
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

export const getPrevVariation = (tree: AnalysisTree, cursor: NodePath): NodePath | null => {
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

export const deleteVariation = (
  tree: AnalysisTree,
  cursor: NodePath,
): { tree: AnalysisTree; cursor: NodePath; deleted: boolean } => {
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
    children: nextChildren,
  }));
  const nextCursor =
    nextChildren.length > 0 && nextChildren[0].san
      ? [...parentPath, nextChildren[0].san as San]
      : parentPath;
  return { tree: { ...tree, root: nextRoot }, cursor: nextCursor, deleted: true };
};

export const promoteVariation = (
  tree: AnalysisTree,
  cursor: NodePath,
): { tree: AnalysisTree; promoted: boolean } => {
  // Cannot promote root or if cursor is empty
  if (cursor.length === 0) return { tree, promoted: false };
  const parentPath = cursor.slice(0, -1);
  const currentSan = cursor[cursor.length - 1];
  const parent = getNode(tree.root, parentPath);
  if (!parent) return { tree, promoted: false };

  // Find the index of the current variation
  const idx = parent.children.findIndex((child) => child.san === currentSan);
  if (idx === -1 || idx === 0) {
    // Already main line or not found
    return { tree, promoted: false };
  }

  // Reorder children: move current variation to index 0
  const currentChild = parent.children[idx];
  const reorderedChildren = [
    currentChild,
    ...parent.children.slice(0, idx),
    ...parent.children.slice(idx + 1),
  ];

  const nextRoot = updateNodeAtPath(tree.root, parentPath, (node) => ({
    ...node,
    children: reorderedChildren,
  }));

  return { tree: { ...tree, root: nextRoot }, promoted: true };
};

export const getMainLineLeaf = (
  tree: AnalysisTree,
): { node: AnalysisNode; path: NodePath } => {
  let node = tree.root;
  const path: San[] = [];
  while (node.children.length > 0) {
    const child = node.children[0];
    if (!child.san) break;
    path.push(child.san);
    node = child;
  }
  return { node, path };
};

export const getMainLineMoves = (tree: AnalysisTree): ReadonlyArray<San> =>
  getMainLineLeaf(tree).path;

const renderNode = (
  node: AnalysisNode,
  moveNum: number,
  isWhite: boolean,
): string => {
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

export const toPGN = (tree: AnalysisTree): string => {
  const lines: string[] = [];
  lines.push(`[FEN "${tree.startFen}"]`);
  lines.push("");
  const fenParts = tree.startFen.split(" ");
  const startMoveNum = Number.parseInt(fenParts[5] ?? "1", 10);
  const isWhiteToMove = (fenParts[1] ?? "w") === "w";
  const pgn = renderNode(tree.root, startMoveNum, isWhiteToMove);
  lines.push(pgn.trim() || "*");
  return lines.join("\n");
};

const serializeNode = (node: AnalysisNode): AnalysisNodeJson => ({
  fen: node.fen,
  san: node.san,
  comment: node.comment,
  children: node.children.map(serializeNode),
});

const deserializeNode = (data: AnalysisNodeJson): AnalysisNode => ({
  fen: data.fen as FenFull,
  san: (data.san ?? null) as San | null,
  comment: data.comment ?? "",
  children: (data.children ?? []).map(deserializeNode),
});

export const analysisTreeToJSON = (tree: AnalysisTree): AnalysisTreeJson => ({
  startFen: tree.startFen,
  turn: tree.turn,
  tree: serializeNode(tree.root),
});

export const analysisTreeFromJSON = (json: AnalysisTreeJson): AnalysisTree => ({
  startFen: json.startFen as FenFull,
  turn: json.turn,
  root: deserializeNode(json.tree),
});
