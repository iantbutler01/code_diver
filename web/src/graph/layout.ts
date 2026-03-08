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
  evidence?: string[];
  ambiguous?: boolean;
  staticConfidence?: number;
  policySelected?: boolean;
  policySuppressed?: boolean;
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
  diffHop?: number;
  diffLane?: "group" | "module" | "file" | "tag";
  hasChanges?: boolean;
  name?: string;
}

const DIFF_LANE_ORDER = ["group", "module", "file", "tag"] as const;
type DiffLaneKey = (typeof DIFF_LANE_ORDER)[number];
const DIFF_LANE_X: Record<DiffLaneKey, number> = {
  group: 80,
  module: 760,
  file: 1480,
  tag: 2320,
};

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

function relationDegreeByNode(nodes: Node[], edges: Edge[]): Map<string, number> {
  const valid = new Set(nodes.map((node) => node.id));
  const degree = new Map<string, number>();
  for (const edge of edges) {
    if (!valid.has(edge.source) || !valid.has(edge.target)) continue;
    degree.set(edge.source, (degree.get(edge.source) || 0) + 1);
    degree.set(edge.target, (degree.get(edge.target) || 0) + 1);
  }
  return degree;
}

function laneRank(lane: string | undefined): number {
  const idx = DIFF_LANE_ORDER.indexOf((lane || "file") as DiffLaneKey);
  return idx >= 0 ? idx : DIFF_LANE_ORDER.length;
}

export function layoutDiffGraph(nodes: Node[], edges: Edge[]): Node[] {
  if (nodes.length === 0) return nodes;
  const degree = relationDegreeByNode(nodes, edges);
  const sizeById = new Map<string, LayoutNodeSize>();
  for (const node of nodes) {
    sizeById.set(node.id, estimateLayoutNodeSize(node));
  }

  const buckets = new Map<string, Node[]>();
  for (const node of nodes) {
    const d = node.data as LayoutNodeData;
    const hop = Math.max(0, Math.min(2, d.diffHop ?? 0));
    const lane = d.diffLane || "file";
    const key = `${hop}:${lane}`;
    const list = buckets.get(key) || [];
    list.push(node);
    buckets.set(key, list);
  }

  for (const list of buckets.values()) {
    list.sort((a, b) => {
      const da = a.data as LayoutNodeData;
      const db = b.data as LayoutNodeData;
      const changedA = da.hasChanges ? 1 : 0;
      const changedB = db.hasChanges ? 1 : 0;
      if (changedA !== changedB) return changedB - changedA;

      const degreeA = degree.get(a.id) || 0;
      const degreeB = degree.get(b.id) || 0;
      if (degreeA !== degreeB) return degreeB - degreeA;

      const nameA = `${da.path || da.target || da.name || a.id}`;
      const nameB = `${db.path || db.target || db.name || b.id}`;
      return nameA.localeCompare(nameB);
    });
  }

  const laneDefs = DIFF_LANE_ORDER.map((key) => ({ key, x: DIFF_LANE_X[key] }));

  const placed = new Map<string, { x: number; y: number }>();
  let bandY = 80;
  for (let hop = 0; hop <= 2; hop += 1) {
    let bandHeight = 280;
    for (const laneDef of laneDefs) {
      const key = `${hop}:${laneDef.key}`;
      const laneNodes = buckets.get(key) || [];
      let y = bandY + 52;
      for (const node of laneNodes) {
        const size = sizeById.get(node.id) || { width: DEFAULT_NODE_WIDTH, height: 220 };
        placed.set(node.id, { x: laneDef.x, y });
        y += size.height + 36;
      }
      bandHeight = Math.max(bandHeight, y - bandY);
    }
    bandY += bandHeight + 120;
  }

  return nodes
    .slice()
    .sort((a, b) => {
      const da = a.data as LayoutNodeData;
      const db = b.data as LayoutNodeData;
      const laneDiff = laneRank(da.diffLane) - laneRank(db.diffLane);
      if (laneDiff !== 0) return laneDiff;
      return (da.diffHop || 0) - (db.diffHop || 0);
    })
    .map((node) => ({
      ...node,
      position: placed.get(node.id) || { x: 0, y: 0 },
    }));
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

interface WeightedLayoutEdge {
  source: string;
  target: string;
  weight: number;
  structural: boolean;
}

interface LayoutBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  width: number;
  height: number;
}

function edgeEvidenceSet(data: EdgeData | undefined): Set<string> {
  const raw = Array.isArray(data?.evidence) ? data.evidence : [];
  return new Set(raw.filter((value): value is string => typeof value === "string"));
}

function relationEdgeWeight(edge: Edge): number {
  const data = edge.data as EdgeData | undefined;
  const bundled = typeof data?.bundledCount === "number" ? data.bundledCount : 1;
  const evidence = edgeEvidenceSet(data);
  const hasStatic = evidence.has("static");
  const hasSemantic = evidence.has("semantic") || evidence.size === 0;

  let score = Math.max(1, bundled) * 0.9;
  if (hasSemantic) score += 1.5;
  if (hasStatic) score += 0.55;
  if (hasStatic && hasSemantic) score += 0.8;
  if (data?.policySelected) score += 0.45;
  if (data?.policySuppressed) score -= 0.6;
  if (typeof data?.staticConfidence === "number") {
    score += Math.max(0, Math.min(1, data.staticConfidence)) * 0.8;
  }
  if (data?.ambiguous) score -= 0.2;

  return Number(Math.max(0.5, Math.min(9, score)).toFixed(3));
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

function collectBlendedLayoutEdges(nodes: Node[], edges: Edge[]): WeightedLayoutEdge[] {
  const nodeIds = new Set(nodes.map((node) => node.id));
  const dedup = new Map<string, WeightedLayoutEdge>();

  for (const edge of edges) {
    if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) continue;
    if (edge.source === edge.target) continue;

    const data = edge.data as EdgeData | undefined;
    const isStructure = data?.layout !== false;
    const isRelationship = data?.kind === "relationship";
    if (!isStructure && !isRelationship) continue;

    // Suppressed relationship overlays should not drive rank.
    if (isRelationship && (edge.hidden || data?.policySuppressed)) continue;

    const key = `${edge.source}->${edge.target}`;
    const nextWeight = isStructure ? 6 : relationEdgeWeight(edge);
    const existing = dedup.get(key);
    if (!existing) {
      dedup.set(key, {
        source: edge.source,
        target: edge.target,
        weight: nextWeight,
        structural: isStructure,
      });
      continue;
    }

    const mergedStructural = existing.structural || isStructure;
    let mergedWeight = Math.max(existing.weight, nextWeight);
    if (existing.structural !== isStructure) {
      mergedWeight += 1.4;
    }

    dedup.set(key, {
      source: edge.source,
      target: edge.target,
      weight: Number(Math.min(10, mergedWeight).toFixed(3)),
      structural: mergedStructural,
    });
  }

  return [...dedup.values()];
}

function selectBlendedRankEdges(
  nodeIds: string[],
  allEdges: WeightedLayoutEdge[]
): WeightedLayoutEdge[] {
  if (allEdges.length === 0 || nodeIds.length < 2) return allEdges;

  const maxEdges = Math.min(
    allEdges.length,
    Math.max(nodeIds.length - 1, Math.ceil(nodeIds.length * 2.4))
  );
  if (allEdges.length <= maxEdges) return allEdges;

  const weightedOut = new Map<string, number>();
  const weightedIn = new Map<string, number>();
  for (const edge of allEdges) {
    weightedOut.set(edge.source, (weightedOut.get(edge.source) || 0) + edge.weight);
    weightedIn.set(edge.target, (weightedIn.get(edge.target) || 0) + edge.weight);
  }

  const ranked = [...allEdges].sort((a, b) => {
    const scoreA =
      a.weight * 2.2 +
      (weightedOut.get(a.source) || 0) * 0.24 +
      (weightedIn.get(a.target) || 0) * 0.24;
    const scoreB =
      b.weight * 2.2 +
      (weightedOut.get(b.source) || 0) * 0.24 +
      (weightedIn.get(b.target) || 0) * 0.24;
    if (scoreA !== scoreB) return scoreB - scoreA;
    return `${a.source}->${a.target}`.localeCompare(`${b.source}->${b.target}`);
  });

  const selected: WeightedLayoutEdge[] = [];
  const selectedKeys = new Set<string>();
  const incident = new Map<string, number>();
  const dsu = createDisjointSet(nodeIds);
  const nodeSet = new Set(nodeIds);

  const keyOf = (edge: WeightedLayoutEdge) => `${edge.source}->${edge.target}`;
  const add = (edge: WeightedLayoutEdge) => {
    selected.push(edge);
    selectedKeys.add(keyOf(edge));
    incident.set(edge.source, (incident.get(edge.source) || 0) + 1);
    incident.set(edge.target, (incident.get(edge.target) || 0) + 1);
  };

  // Phase 1: strongest forest to keep global flow coherent.
  for (const edge of ranked) {
    if (selected.length >= maxEdges) break;
    if (dsu.find(edge.source) === dsu.find(edge.target)) continue;
    add(edge);
    dsu.union(edge.source, edge.target);
  }

  // Phase 2: ensure every visible node gets at least one rank-driving edge when possible.
  for (const nodeId of nodeSet) {
    if (selected.length >= maxEdges) break;
    if ((incident.get(nodeId) || 0) > 0) continue;

    const candidate = ranked.find(
      (edge) =>
        !selectedKeys.has(keyOf(edge)) && (edge.source === nodeId || edge.target === nodeId)
    );
    if (!candidate) continue;
    add(candidate);
  }

  // Phase 3: add directional cues while avoiding hub over-saturation.
  const maxIncident = Math.max(3, Math.ceil(maxEdges / Math.max(1, nodeIds.length)) + 2);
  for (const edge of ranked) {
    if (selected.length >= maxEdges) break;
    if (selectedKeys.has(keyOf(edge))) continue;
    if ((incident.get(edge.source) || 0) >= maxIncident) continue;
    if ((incident.get(edge.target) || 0) >= maxIncident) continue;
    add(edge);
  }

  return selected;
}

function stronglyConnectedComponents(
  nodeIds: string[],
  edges: WeightedLayoutEdge[]
): string[][] {
  const adjacency = new Map<string, string[]>();
  const edgeSets = new Map<string, Set<string>>();
  for (const nodeId of nodeIds) {
    adjacency.set(nodeId, []);
    edgeSets.set(nodeId, new Set<string>());
  }

  for (const edge of edges) {
    const out = edgeSets.get(edge.source);
    if (!out || out.has(edge.target)) continue;
    out.add(edge.target);
    adjacency.get(edge.source)?.push(edge.target);
  }

  const index = new Map<string, number>();
  const lowlink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const components: string[][] = [];
  let nextIndex = 0;

  const visit = (nodeId: string) => {
    index.set(nodeId, nextIndex);
    lowlink.set(nodeId, nextIndex);
    nextIndex += 1;
    stack.push(nodeId);
    onStack.add(nodeId);

    const neighbors = adjacency.get(nodeId) || [];
    for (const neighbor of neighbors) {
      if (!index.has(neighbor)) {
        visit(neighbor);
        const min = Math.min(lowlink.get(nodeId) || 0, lowlink.get(neighbor) || 0);
        lowlink.set(nodeId, min);
      } else if (onStack.has(neighbor)) {
        const min = Math.min(lowlink.get(nodeId) || 0, index.get(neighbor) || 0);
        lowlink.set(nodeId, min);
      }
    }

    if ((lowlink.get(nodeId) || 0) !== (index.get(nodeId) || 0)) return;

    const component: string[] = [];
    while (stack.length > 0) {
      const current = stack.pop();
      if (!current) break;
      onStack.delete(current);
      component.push(current);
      if (current === nodeId) break;
    }
    component.sort((a, b) => a.localeCompare(b));
    components.push(component);
  };

  const ordered = [...nodeIds].sort((a, b) => a.localeCompare(b));
  for (const nodeId of ordered) {
    if (index.has(nodeId)) continue;
    visit(nodeId);
  }

  components.sort((a, b) => {
    if (b.length !== a.length) return b.length - a.length;
    return a[0].localeCompare(b[0]);
  });

  return components;
}

function estimateComponentFootprint(
  memberIds: string[],
  sizeById: Map<string, LayoutNodeSize>
): LayoutNodeSize {
  if (memberIds.length === 0) {
    return { width: DEFAULT_NODE_WIDTH, height: 260 };
  }

  if (memberIds.length === 1) {
    const single = sizeById.get(memberIds[0]) || {
      width: DEFAULT_NODE_WIDTH,
      height: 220,
    };
    return {
      width: Math.round(single.width + 120),
      height: Math.round(single.height + 120),
    };
  }

  let totalWidth = 0;
  let totalHeight = 0;
  let maxWidth = 0;
  let maxHeight = 0;
  for (const id of memberIds) {
    const size = sizeById.get(id) || { width: DEFAULT_NODE_WIDTH, height: 220 };
    totalWidth += size.width;
    totalHeight += size.height;
    maxWidth = Math.max(maxWidth, size.width);
    maxHeight = Math.max(maxHeight, size.height);
  }

  const avgWidth = totalWidth / memberIds.length;
  const avgHeight = totalHeight / memberIds.length;
  const cols = Math.max(2, Math.ceil(Math.sqrt(memberIds.length)));
  const rows = Math.ceil(memberIds.length / cols);

  return {
    width: Math.round(
      Math.min(4800, Math.max(maxWidth + 180, cols * (avgWidth + 86) + 180))
    ),
    height: Math.round(
      Math.min(5200, Math.max(maxHeight + 180, rows * (avgHeight + 86) + 180))
    ),
  };
}

function computeBounds(entries: LayoutEntry[]): LayoutBounds {
  if (entries.length === 0) {
    return {
      minX: 0,
      minY: 0,
      maxX: 0,
      maxY: 0,
      width: 0,
      height: 0,
    };
  }

  const minX = Math.min(...entries.map((entry) => entry.x));
  const minY = Math.min(...entries.map((entry) => entry.y));
  const maxX = Math.max(...entries.map((entry) => entry.x + entry.width));
  const maxY = Math.max(...entries.map((entry) => entry.y + entry.height));

  return {
    minX,
    minY,
    maxX,
    maxY,
    width: maxX - minX,
    height: maxY - minY,
  };
}

function layoutSubgraph(
  memberNodes: Node[],
  memberEdges: WeightedLayoutEdge[],
  sizeById: Map<string, LayoutNodeSize>,
  nodesep: number,
  ranksep: number,
  marginx: number,
  marginy: number
): LayoutEntry[] {
  if (memberNodes.length === 0) return [];

  if (memberEdges.length === 0) {
    const gridNodes = gridLayout(memberNodes);
    return gridNodes.map((node) => {
      const size = sizeById.get(node.id) || estimateLayoutNodeSize(node);
      return {
        node,
        x: node.position.x,
        y: node.position.y,
        width: size.width,
        height: size.height,
      };
    });
  }

  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({
    rankdir: "TB",
    nodesep,
    ranksep,
    marginx,
    marginy,
    ranker: "network-simplex",
    acyclicer: "greedy",
  });

  for (const node of memberNodes) {
    const size = sizeById.get(node.id) || estimateLayoutNodeSize(node);
    g.setNode(node.id, { width: size.width, height: size.height });
  }

  for (const edge of memberEdges) {
    g.setEdge(edge.source, edge.target, {
      weight: Math.max(1, Math.round(edge.weight * 3)),
    });
  }

  dagre.layout(g);

  return memberNodes.map((node) => {
    const info = g.node(node.id);
    return {
      node,
      x: info.x - info.width / 2,
      y: info.y - info.height / 2,
      width: info.width,
      height: info.height,
    };
  });
}

export function layoutGraph(nodes: Node[], edges: Edge[]): Node[] {
  if (nodes.length === 0) return nodes;

  const nodeIds = nodes.map((node) => node.id);
  const blendedEdges = collectBlendedLayoutEdges(nodes, edges);
  if (blendedEdges.length === 0) {
    return gridLayout(nodes);
  }

  const rankEdges = selectBlendedRankEdges(nodeIds, blendedEdges);
  if (rankEdges.length === 0) {
    return gridLayout(nodes);
  }

  const spacing = buildSpacing(nodes.length, rankEdges.length, edges.length);
  const rankDensity = rankEdges.length / Math.max(1, nodes.length);
  const denseFactor = Math.max(0, Math.min(1, (rankDensity - 1.15) / 1.85));
  const sizeById = new Map<string, LayoutNodeSize>();
  const nodeById = new Map<string, Node>();
  for (const node of nodes) {
    sizeById.set(node.id, estimateLayoutNodeSize(node));
    nodeById.set(node.id, node);
  }

  const components = stronglyConnectedComponents(nodeIds, blendedEdges);
  const compByNodeId = new Map<string, number>();
  for (let i = 0; i < components.length; i += 1) {
    for (const nodeId of components[i]) {
      compByNodeId.set(nodeId, i);
    }
  }

  const internalRankEdgeCountByComponent = new Map<number, number>();
  for (const edge of rankEdges) {
    const sourceComp = compByNodeId.get(edge.source);
    const targetComp = compByNodeId.get(edge.target);
    if (sourceComp == null || targetComp == null || sourceComp !== targetComp) continue;
    internalRankEdgeCountByComponent.set(
      sourceComp,
      (internalRankEdgeCountByComponent.get(sourceComp) || 0) + 1
    );
  }

  const componentNodes = components.map((memberIds, index) => {
    const footprint = estimateComponentFootprint(memberIds, sizeById);
    const internalCount = internalRankEdgeCountByComponent.get(index) || 0;
    const internalDensity = internalCount / Math.max(1, memberIds.length);
    const densityScale =
      1 + Math.min(0.65, denseFactor * 0.35 + Math.max(0, internalDensity - 1) * 0.12);
    return {
      id: `scc:${index}`,
      width: Math.round(footprint.width * densityScale),
      height: Math.round(footprint.height * densityScale),
      memberIds,
    };
  });

  const condensedEdges = new Map<string, WeightedLayoutEdge>();
  for (const edge of rankEdges) {
    const sourceComp = compByNodeId.get(edge.source);
    const targetComp = compByNodeId.get(edge.target);
    if (sourceComp == null || targetComp == null || sourceComp === targetComp) continue;
    const key = `scc:${sourceComp}->scc:${targetComp}`;
    const existing = condensedEdges.get(key);
    if (!existing) {
      condensedEdges.set(key, {
        source: `scc:${sourceComp}`,
        target: `scc:${targetComp}`,
        weight: edge.weight,
        structural: edge.structural,
      });
      continue;
    }
    condensedEdges.set(key, {
      ...existing,
      weight: existing.weight + edge.weight,
      structural: existing.structural || edge.structural,
    });
  }

  if (condensedEdges.size === 0 && componentNodes.length > 1) {
    for (let i = 1; i < componentNodes.length; i += 1) {
      condensedEdges.set(
        `${componentNodes[i - 1].id}->${componentNodes[i].id}`,
        {
          source: componentNodes[i - 1].id,
          target: componentNodes[i].id,
          weight: 1,
          structural: true,
        }
      );
    }
  }

  const componentGraph = new dagre.graphlib.Graph();
  componentGraph.setDefaultEdgeLabel(() => ({}));
  componentGraph.setGraph({
    rankdir: "TB",
    nodesep: Math.round(spacing.nodesep * (1.16 + denseFactor * 0.28)),
    ranksep: Math.round(spacing.ranksep * (1.34 + denseFactor * 0.34)),
    marginx: Math.round(spacing.marginx * 1.1),
    marginy: Math.round(spacing.marginy * 1.1),
    ranker: "network-simplex",
    acyclicer: "greedy",
  });

  for (const comp of componentNodes) {
    componentGraph.setNode(comp.id, { width: comp.width, height: comp.height });
  }
  for (const edge of condensedEdges.values()) {
    componentGraph.setEdge(edge.source, edge.target, {
      weight: Math.max(1, Math.round(edge.weight * 2)),
    });
  }

  dagre.layout(componentGraph);

  const internalEdgesByComponent = new Map<number, WeightedLayoutEdge[]>();
  for (const edge of rankEdges) {
    const sourceComp = compByNodeId.get(edge.source);
    const targetComp = compByNodeId.get(edge.target);
    if (sourceComp == null || targetComp == null || sourceComp !== targetComp) continue;
    const existing = internalEdgesByComponent.get(sourceComp) || [];
    existing.push(edge);
    internalEdgesByComponent.set(sourceComp, existing);
  }

  const fewSuperNodes = componentNodes.length <= 2;
  const localSepScale = Math.min(1.24, 0.72 + denseFactor * 0.42 + (fewSuperNodes ? 0.18 : 0));
  const localRankScale = Math.min(1.32, 0.76 + denseFactor * 0.46 + (fewSuperNodes ? 0.22 : 0));
  const localSpreadExtra = Math.min(0.12, denseFactor * 0.08 + (fewSuperNodes ? 0.03 : 0));
  const localGapScale = Math.min(1.0, 0.56 + denseFactor * 0.34 + (fewSuperNodes ? 0.12 : 0));

  const placed: LayoutEntry[] = [];
  for (let compIndex = 0; compIndex < componentNodes.length; compIndex += 1) {
    const comp = componentNodes[compIndex];
    const memberNodes: Node[] = comp.memberIds
      .map((nodeId) => nodeById.get(nodeId))
      .filter((node): node is Node => !!node);
    if (memberNodes.length === 0) continue;

    const localNodes = layoutSubgraph(
      memberNodes,
      internalEdgesByComponent.get(compIndex) || [],
      sizeById,
      Math.max(86, Math.round(spacing.nodesep * localSepScale)),
      Math.max(104, Math.round(spacing.ranksep * localRankScale)),
      28,
      28
    );
    const localSpread = spreadFromCenter(
      localNodes,
      1 + (spacing.spreadScale - 1) * 0.55 + localSpreadExtra
    );
    const localSeparated = resolveCollisions(
      localSpread,
      "TB",
      Math.max(24, Math.round(spacing.collisionGapX * localGapScale)),
      Math.max(18, Math.round(spacing.collisionGapY * localGapScale))
    );
    const bounds = computeBounds(localSeparated);

    const info = componentGraph.node(comp.id);
    const anchorX = info.x;
    const anchorY = info.y;
    const centerX = bounds.minX + bounds.width / 2;
    const centerY = bounds.minY + bounds.height / 2;
    const shiftX = anchorX - centerX;
    const shiftY = anchorY - centerY;

    for (const entry of localSeparated) {
      placed.push({
        ...entry,
        x: entry.x + shiftX,
        y: entry.y + shiftY,
      });
    }
  }

  if (placed.length === 0) return gridLayout(nodes);

  const finalGapScale = Math.min(1.08, 0.72 + denseFactor * 0.28 + (fewSuperNodes ? 0.08 : 0));
  const compactSpread = spreadFromCenter(
    placed,
    1 + (spacing.spreadScale - 1) * (0.44 + denseFactor * 0.75) + localSpreadExtra * 0.35
  );
  const separated = resolveCollisions(
    compactSpread,
    "TB",
    Math.max(28, Math.round(spacing.collisionGapX * finalGapScale)),
    Math.max(22, Math.round(spacing.collisionGapY * finalGapScale))
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
