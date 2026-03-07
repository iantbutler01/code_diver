import dagre from "dagre";
import type { Node, Edge } from "@xyflow/react";

const DEFAULT_NODE_WIDTH = 500;

interface LayoutNodeSize {
  width: number;
  height: number;
}

interface LayoutEntry {
  node: Node;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface LayoutSpacing {
  nodesep: number;
  ranksep: number;
  marginx: number;
  marginy: number;
  spreadScale: number;
  collisionGapX: number;
  collisionGapY: number;
}

interface EdgeData {
  kind?: string;
  layout?: boolean;
  bundledCount?: number;
}

interface LayoutConcept {
  name?: string;
  description?: string;
}

interface LayoutTag {
  description?: string;
}

interface LayoutNodeData {
  concepts?: LayoutConcept[];
  diveFile?: string;
  diveRels?: string[];
  tags?: LayoutTag[];
  children?: string[];
  description?: string;
  path?: string;
  target?: string;
  tagCount?: number;
  hasChildren?: boolean;
  collapsedCount?: number;
  isSummary?: boolean;
}

interface DisjointSet {
  find: (key: string) => string;
  union: (a: string, b: string) => void;
}

function estimateWrappedLines(text: string | undefined, charsPerLine: number): number {
  if (!text) return 0;
  if (charsPerLine <= 0) return 1;
  const lines = Math.ceil(text.length / charsPerLine);
  return Math.max(1, Math.min(lines, 32));
}

function charsPerLineForWidth(width: number): number {
  return Math.max(24, Math.floor((width - 44) / 7));
}

// Estimate rendered height per node type so dagre doesn't overlap them.
function estimateNodeHeight(node: Node): number {
  const d = node.data as LayoutNodeData;
  const width = estimateNodeWidth(node);
  const chars = charsPerLineForWidth(width);

  if (node.type === "filegroup") {
    const concepts = d.concepts || [];
    const conceptHeight = concepts.reduce((sum: number, c) => {
      const nameLines = estimateWrappedLines(c.name, chars);
      const descLines = estimateWrappedLines(c.description, chars);
      return sum + 10 + nameLines * 16 + (descLines > 0 ? 6 + descLines * 14 : 0);
    }, 0);
    const collapseMetaHeight = (d.collapsedCount || 0) > 1 ? 48 : 0;
    const diveFileLines = estimateWrappedLines(d.diveFile, chars);
    const diveFileHeight = diveFileLines > 0 ? 12 + diveFileLines * 15 : 0;
    const relHeight =
      (d.diveRels?.length || 0) > 0
        ? 12 +
          (d.diveRels || []).reduce(
            (sum, rel) => sum + estimateWrappedLines(rel, chars) * 15,
            0
          )
        : 0;
    const tags = d.tags || [];
    const tagHeight =
      tags.length > 0
        ? 12 +
          tags.reduce((sum: number, tag) => {
            const wrappedLines = estimateWrappedLines(tag.description, chars);
            return sum + 10 + wrappedLines * 14;
          }, 0)
        : 0;
    const pathLines = estimateWrappedLines(d.path || d.target, chars);
    const pathHeight = pathLines > 0 ? 8 + pathLines * 14 : 0;
    return (
      54 +
      collapseMetaHeight +
      pathHeight +
      diveFileHeight +
      conceptHeight +
      relHeight +
      tagHeight +
      32
    );
  }

  if (node.type === "group") {
    const hasMore = (d.children?.length || 0) > 5;
    const childLines = (d.children || [])
      .slice(0, 5)
      .reduce((sum, child) => sum + estimateWrappedLines(child, chars), 0);
    return 60 + childLines * 16 + (hasMore ? 20 : 0) + 30;
  }

  if (node.type === "tag") {
    const descLines = estimateWrappedLines(d.description, charsPerLineForWidth(width));
    return 56 + descLines * 16;
  }

  // component / file nodes
  const hasDesc = !!(d.description && d.description.length > 0);
  const hasPath = !!(d.path || d.target);
  const hasRels = (d.diveRels?.length || 0) > 0;
  const descLines = estimateWrappedLines(d.description, chars);
  const pathLines = estimateWrappedLines((d.path || d.target) as string | undefined, chars);
  const relLines = (d.diveRels || []).reduce(
    (sum, rel) => sum + estimateWrappedLines(rel, chars),
    0
  );

  let h = 40; // title + padding
  if (hasDesc) h += 8 + descLines * 15;
  if (hasPath) h += 8 + pathLines * 14;
  if ((d.tagCount || 0) > 0 || d.hasChildren) h += 20; // hint
  if (hasRels) h += 12 + relLines * 15; // rel section

  return h;
}

function estimateNodeWidth(node: Node): number {
  const d = node.data as LayoutNodeData;

  if (node.type === "filegroup") {
    return 860;
  }

  if (node.type === "group") {
    return d.isSummary ? 640 : 620;
  }

  if (node.type === "tag") {
    return 460;
  }

  return DEFAULT_NODE_WIDTH;
}

export function estimateLayoutNodeSize(node: Node): LayoutNodeSize {
  return {
    width: estimateNodeWidth(node),
    height: estimateNodeHeight(node),
  };
}

function buildSpacing(
  nodeCount: number,
  layoutEdgeCount: number,
  totalEdgeCount: number
): LayoutSpacing {
  const safeNodeCount = Math.max(1, nodeCount);
  const structureDensity = layoutEdgeCount / safeNodeCount;
  const relationDensity = totalEdgeCount / safeNodeCount;
  const sizeFactor = Math.min(1.4, Math.sqrt(safeNodeCount) / 5);
  const densityFactor = Math.min(2.2, structureDensity * 0.75 + relationDensity * 0.25);
  const spreadBoost = Math.min(0.03, sizeFactor * 0.01 + densityFactor * 0.008);

  return {
    nodesep: Math.round(110 + sizeFactor * 36 + densityFactor * 34),
    ranksep: Math.round(130 + sizeFactor * 46 + densityFactor * 42),
    marginx: Math.round(56 + sizeFactor * 20 + densityFactor * 14),
    marginy: Math.round(48 + sizeFactor * 18 + densityFactor * 12),
    spreadScale: 1 + spreadBoost,
    collisionGapX: Math.round(42 + sizeFactor * 14 + densityFactor * 16),
    collisionGapY: Math.round(34 + sizeFactor * 12 + densityFactor * 14),
  };
}

function spreadFromCenter(entries: LayoutEntry[], scale: number): LayoutEntry[] {
  if (entries.length < 2 || scale <= 1) return entries;

  let centerX = 0;
  let centerY = 0;
  for (const entry of entries) {
    centerX += entry.x + entry.width / 2;
    centerY += entry.y + entry.height / 2;
  }
  centerX /= entries.length;
  centerY /= entries.length;

  return entries.map((entry) => {
    const nodeCenterX = entry.x + entry.width / 2;
    const nodeCenterY = entry.y + entry.height / 2;
    const nextCenterX = centerX + (nodeCenterX - centerX) * scale;
    const nextCenterY = centerY + (nodeCenterY - centerY) * scale;
    return {
      ...entry,
      x: nextCenterX - entry.width / 2,
      y: nextCenterY - entry.height / 2,
    };
  });
}

function resolveCollisions(
  entries: LayoutEntry[],
  direction: "TB" | "LR",
  minGapX: number,
  minGapY: number
): LayoutEntry[] {
  if (entries.length < 2) return entries;
  if (entries.length > 140) return entries;

  const out = entries.map((entry) => ({ ...entry }));
  const maxIterations = entries.length > 80 ? 8 : 16;
  const preferHorizontal = direction === "TB";

  for (let iter = 0; iter < maxIterations; iter += 1) {
    let moved = false;

    for (let i = 0; i < out.length; i += 1) {
      for (let j = i + 1; j < out.length; j += 1) {
        const a = out[i];
        const b = out[j];

        const aCenterX = a.x + a.width / 2;
        const aCenterY = a.y + a.height / 2;
        const bCenterX = b.x + b.width / 2;
        const bCenterY = b.y + b.height / 2;

        const dx = bCenterX - aCenterX;
        const dy = bCenterY - aCenterY;

        const requiredX = (a.width + b.width) / 2 + minGapX;
        const requiredY = (a.height + b.height) / 2 + minGapY;

        const overlapX = requiredX - Math.abs(dx);
        const overlapY = requiredY - Math.abs(dy);
        if (overlapX <= 0 || overlapY <= 0) continue;

        moved = true;

        const signX = dx === 0 ? (i % 2 === 0 ? -1 : 1) : Math.sign(dx);
        const signY = dy === 0 ? (j % 2 === 0 ? -1 : 1) : Math.sign(dy);

        if (preferHorizontal) {
          const pushX = overlapX / 2 + 2;
          a.x -= signX * pushX;
          b.x += signX * pushX;

          if (overlapY > overlapX * 1.25) {
            const pushY = overlapY / 6;
            a.y -= signY * pushY;
            b.y += signY * pushY;
          }
        } else {
          const pushY = overlapY / 2 + 2;
          a.y -= signY * pushY;
          b.y += signY * pushY;

          if (overlapX > overlapY * 1.25) {
            const pushX = overlapX / 6;
            a.x -= signX * pushX;
            b.x += signX * pushX;
          }
        }
      }
    }

    if (!moved) break;
  }

  const minX = Math.min(...out.map((entry) => entry.x));
  const minY = Math.min(...out.map((entry) => entry.y));
  if (minX < 0 || minY < 0) {
    const shiftX = minX < 0 ? -minX : 0;
    const shiftY = minY < 0 ? -minY : 0;
    for (const entry of out) {
      entry.x += shiftX;
      entry.y += shiftY;
    }
  }

  return out;
}

function relationEdgeWeight(edge: Edge): number {
  const data = edge.data as EdgeData | undefined;
  const bundled = typeof data?.bundledCount === "number" ? data.bundledCount : 1;
  return Math.max(1, bundled);
}

function createDisjointSet(keys: string[]): DisjointSet {
  const parent = new Map<string, string>();
  for (const key of keys) {
    parent.set(key, key);
  }

  const find = (key: string): string => {
    const current = parent.get(key) ?? key;
    if (current === key) {
      if (!parent.has(key)) parent.set(key, key);
      return key;
    }
    const root = find(current);
    parent.set(key, root);
    return root;
  };

  const union = (a: string, b: string) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) {
      parent.set(ra, rb);
    }
  };

  return { find, union };
}

function selectRelationLayoutEdges(nodes: Node[], relationEdges: Edge[]): Edge[] {
  if (relationEdges.length === 0) return [];

  const nodeIds = new Set(nodes.map((node) => node.id));
  const dedup = new Map<string, Edge>();
  const weightByKey = new Map<string, number>();

  for (const edge of relationEdges) {
    if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) continue;
    if (edge.source === edge.target) continue;

    const key = `${edge.source}->${edge.target}`;
    const weight = relationEdgeWeight(edge);
    const currentWeight = weightByKey.get(key) || 0;
    if (!dedup.has(key) || weight > currentWeight) {
      dedup.set(key, edge);
      weightByKey.set(key, weight);
    }
  }

  const candidates = [...dedup.values()];
  if (candidates.length === 0) return [];

  const maxEdges = Math.min(
    candidates.length,
    Math.max(nodes.length - 1, Math.ceil(nodes.length * 1.4))
  );
  if (candidates.length <= maxEdges) return candidates;

  const outDegree = new Map<string, number>();
  const inDegree = new Map<string, number>();
  for (const edge of candidates) {
    outDegree.set(edge.source, (outDegree.get(edge.source) || 0) + 1);
    inDegree.set(edge.target, (inDegree.get(edge.target) || 0) + 1);
  }

  const ranked = [...candidates].sort((a, b) => {
    const scoreA =
      relationEdgeWeight(a) * 2 +
      (outDegree.get(a.source) || 0) +
      (inDegree.get(a.target) || 0);
    const scoreB =
      relationEdgeWeight(b) * 2 +
      (outDegree.get(b.source) || 0) +
      (inDegree.get(b.target) || 0);
    return scoreB - scoreA;
  });

  const maxPerNode = 2;
  const selected: Edge[] = [];
  const selectedKeys = new Set<string>();
  const usedOut = new Map<string, number>();
  const usedIn = new Map<string, number>();
  const coveredNodes = new Set<string>();
  const dsu = createDisjointSet(nodes.map((node) => node.id));

  const edgeKey = (edge: Edge) => `${edge.source}->${edge.target}`;

  const addSelected = (edge: Edge) => {
    selected.push(edge);
    selectedKeys.add(edgeKey(edge));
    usedOut.set(edge.source, (usedOut.get(edge.source) || 0) + 1);
    usedIn.set(edge.target, (usedIn.get(edge.target) || 0) + 1);
    coveredNodes.add(edge.source);
    coveredNodes.add(edge.target);
  };

  // Phase 1: build a sparse backbone that connects components with minimal cycles.
  for (const edge of ranked) {
    if (selected.length >= maxEdges) break;
    if ((usedOut.get(edge.source) || 0) >= 1) continue;
    if ((usedIn.get(edge.target) || 0) >= 1) continue;
    if (dsu.find(edge.source) === dsu.find(edge.target)) continue;

    addSelected(edge);
    dsu.union(edge.source, edge.target);
  }

  // Phase 2: ensure isolated nodes get at least one relation in layout.
  for (const edge of ranked) {
    if (selected.length >= maxEdges) break;
    if (selectedKeys.has(edgeKey(edge))) continue;
    if (coveredNodes.has(edge.source) && coveredNodes.has(edge.target)) continue;
    if ((usedOut.get(edge.source) || 0) >= maxPerNode) continue;
    if ((usedIn.get(edge.target) || 0) >= maxPerNode) continue;
    addSelected(edge);
  }

  // Phase 3: add a few strong extra edges to retain directional flow cues.
  for (const edge of ranked) {
    if (selected.length >= maxEdges) break;
    if (selectedKeys.has(edgeKey(edge))) continue;
    if ((usedOut.get(edge.source) || 0) >= maxPerNode) continue;
    if ((usedIn.get(edge.target) || 0) >= maxPerNode) continue;
    addSelected(edge);
  }

  return selected;
}

export function layoutGraph(
  nodes: Node[],
  edges: Edge[],
  direction: "TB" | "LR" = "TB"
): Node[] {
  if (nodes.length === 0) return nodes;

  const structuralEdges = edges.filter((edge) => {
    const data = edge.data as EdgeData | undefined;
    return data?.layout !== false;
  });

  const relationEdges = edges.filter((edge) => {
    const data = edge.data as EdgeData | undefined;
    return data?.kind === "relationship";
  });

  // Relation-driven fallback can become expensive/noisy on large dense views.
  // Keep it for small/medium graphs; otherwise rely on structural backbone or grid.
  const canUseRelationDrivenFallback =
    structuralEdges.length === 0 &&
    relationEdges.length > 0 &&
    nodes.length <= 80 &&
    relationEdges.length <= 700;
  const relationDriven = canUseRelationDrivenFallback;
  const relationLayoutEdges = relationDriven
    ? selectRelationLayoutEdges(nodes, relationEdges)
    : [];
  const layoutEdges = relationDriven ? relationLayoutEdges : structuralEdges;

  if (layoutEdges.length === 0) {
    return gridLayout(nodes);
  }

  const spacing = buildSpacing(nodes.length, layoutEdges.length, edges.length);

  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({
    rankdir: relationDriven ? "LR" : direction,
    nodesep: spacing.nodesep,
    ranksep: spacing.ranksep,
    marginx: spacing.marginx,
    marginy: spacing.marginy,
    ranker: relationDriven ? "network-simplex" : "tight-tree",
    acyclicer: "greedy",
  });

  for (const node of nodes) {
    const size = estimateLayoutNodeSize(node);
    g.setNode(node.id, { width: size.width, height: size.height });
  }

  for (const edge of layoutEdges) {
    g.setEdge(edge.source, edge.target);
  }

  dagre.layout(g);

  const initial = nodes.map((node) => {
    const info = g.node(node.id);
    return {
      node,
      x: info.x - info.width / 2,
      y: info.y - info.height / 2,
      width: info.width,
      height: info.height,
    };
  });

  const spread = spreadFromCenter(initial, spacing.spreadScale);
  const separated = resolveCollisions(
    spread,
    relationDriven ? "LR" : direction,
    spacing.collisionGapX,
    spacing.collisionGapY
  );

  return separated.map((entry) => ({
    ...entry.node,
    position: {
      x: entry.x,
      y: entry.y,
    },
  }));
}

function gridLayout(nodes: Node[]): Node[] {
  if (nodes.length === 0) return nodes;

  const sizes = nodes.map((node) => estimateLayoutNodeSize(node));
  const maxWidth = Math.max(...sizes.map((s) => s.width), DEFAULT_NODE_WIDTH);
  const cols = Math.max(1, Math.ceil(Math.sqrt(nodes.length)));
  const gapX = maxWidth + 120;

  const rowCount = Math.ceil(nodes.length / cols);
  const rowHeights = new Array<number>(rowCount).fill(0);
  for (let i = 0; i < sizes.length; i += 1) {
    const row = Math.floor(i / cols);
    rowHeights[row] = Math.max(rowHeights[row], sizes[i].height);
  }

  const rowOffsets = new Array<number>(rowCount).fill(0);
  for (let row = 1; row < rowCount; row += 1) {
    rowOffsets[row] = rowOffsets[row - 1] + rowHeights[row - 1] + 100;
  }

  return nodes.map((node, i) => {
    const row = Math.floor(i / cols);
    const col = i % cols;
    const size = sizes[i];
    return {
      ...node,
      position: {
        x: col * gapX + (maxWidth - size.width) / 2,
        y: rowOffsets[row],
      },
    };
  });
}
