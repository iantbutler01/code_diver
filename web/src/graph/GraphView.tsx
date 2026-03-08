import { useMemo, useCallback, useEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  ViewportPortal,
  useNodesState,
  useEdgesState,
  type Edge,
  type Node,
  type NodeMouseHandler,
  type ReactFlowInstance,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import type { DiffResponse, GraphData, NavEntry } from "../types";
import { graphScopeCoverage, transformGraph } from "./transform";
import { estimateLayoutNodeSize, layoutDiffGraph, layoutGraph } from "./layout";
import { ComponentNode } from "./ComponentNode";
import { FileNode } from "./FileNode";
import { TagNode } from "./TagNode";
import { GroupNode } from "./GroupNode";
import { FileGroupNode } from "./FileGroupNode";
import { RelationEdge } from "./RelationEdge";
import { fetchDiff, openInVscode } from "../api";
import { graphColors, minimapNodeColor } from "./colors";

const nodeTypes = {
  component: ComponentNode,
  file: FileNode,
  tag: TagNode,
  group: GroupNode,
  filegroup: FileGroupNode,
};

const edgeTypes = {
  relation: RelationEdge,
};

const MODULE_DIR_FILTER_PREFIX = "moduledir::";

interface Props {
  data: GraphData;
  nav: NavEntry;
  onNavigate: (entry: NavEntry) => void;
}

interface EdgeData {
  kind?: "structure" | "relationship";
  layout?: boolean;
  evidence?: string[];
  staticKind?: string;
  policyScore?: number;
  policySelected?: boolean;
  policySuppressed?: boolean;
}

interface GraphNodeData {
  name?: string;
  groupId?: string;
  isSummary?: boolean;
  nonNavigable?: boolean;
  absPath?: string;
  isLeaf?: boolean;
  tagCount?: number;
  hasDiveMeta?: boolean;
  path?: string;
  hasChildren?: boolean;
  moduleId?: string | null;
  dirPath?: string | null;
  isHeader?: boolean;
  isReference?: boolean;
  line?: number;
  target?: string | null;
  relIn?: number;
  relOut?: number;
  relTotal?: number;
  relRole?: "entry" | "sink" | "hub" | "isolated" | "flow";
  gitStatus?: "added" | "modified" | "deleted";
  diffPaths?: string[];
  hasChanges?: boolean;
  diffHop?: number;
  diffLane?: "group" | "module" | "file" | "tag";
}

interface FolderZone {
  key: string;
  label: string;
  count: number;
  depth: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface CycleZone {
  key: string;
  label: string;
  count: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface DiffLaneZone {
  key: string;
  label: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface DiffBandZone {
  key: string;
  label: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface DiffDockState {
  open: boolean;
  title: string;
  key: string;
  paths: string[];
  loading: boolean;
  error: string | null;
  response: DiffResponse | null;
  noChanges: boolean;
}

interface RectZone {
  key: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface DiffDockStateArgs {
  title: string;
  key: string;
  paths: string[];
  loading?: boolean;
  error?: string | null;
  response?: DiffResponse | null;
  noChanges?: boolean;
}

interface DiffDockSelection {
  files: DiffResponse["files"];
  activeFileIndex: number;
  activeFile: DiffResponse["files"][number] | null;
  hunks: DiffResponse["files"][number]["hunks"];
  activeHunkIndex: number;
  activeHunk: DiffResponse["files"][number]["hunks"][number] | null;
}

const CLOSED_DIFF_DOCK: DiffDockState = {
  open: false,
  title: "",
  key: "",
  paths: [],
  loading: false,
  error: null,
  response: null,
  noChanges: false,
};

function buildDiffDockState({
  title,
  key,
  paths,
  loading = false,
  error = null,
  response = null,
  noChanges = false,
}: DiffDockStateArgs): DiffDockState {
  return {
    open: true,
    title,
    key,
    paths,
    loading,
    error,
    response,
    noChanges,
  };
}

function clampIndex(index: number, length: number): number {
  if (length <= 0) return 0;
  return Math.max(0, Math.min(index, length - 1));
}

function nodeDiffDockTitle(node: Node, data: GraphNodeData): string {
  return (
    data.name ||
    data.path ||
    data.target ||
    (node.type === "tag" ? `tag:${data.line || "?"}` : node.id)
  );
}

function diffOriginLevel(level: NavEntry["level"]): "system" | "module" | "file" {
  if (level === "diff") return "system";
  if (level === "doc") return "file";
  return level;
}

function deriveDiffDockSelection(
  response: DiffResponse | null,
  activeFileIndex: number,
  activeHunkIndex: number
): DiffDockSelection {
  const files = response?.files || [];
  const safeFileIndex = clampIndex(activeFileIndex, files.length);
  const activeFile = files[safeFileIndex] || null;
  const hunks = activeFile?.hunks || [];
  const safeHunkIndex = clampIndex(activeHunkIndex, hunks.length);
  const activeHunk = hunks[safeHunkIndex] || null;

  return {
    files,
    activeFileIndex: safeFileIndex,
    activeFile,
    hunks,
    activeHunkIndex: safeHunkIndex,
    activeHunk,
  };
}

function renderViewportZones<T extends RectZone>(
  zones: T[],
  layerClass: string,
  zoneClass: (zone: T) => string,
  labelClass: string,
  renderLabel: (zone: T) => ReactNode
): ReactNode {
  if (zones.length === 0) return null;

  return (
    <ViewportPortal>
      <div className={layerClass}>
        {zones.map((zone) => (
          <div
            key={zone.key}
            className={zoneClass(zone)}
            style={{
              width: `${zone.width}px`,
              height: `${zone.height}px`,
              transform: `translate(${zone.x}px, ${zone.y}px)`,
            }}
          >
            <div className={labelClass}>{renderLabel(zone)}</div>
          </div>
        ))}
      </div>
    </ViewportPortal>
  );
}

function normalizePath(value: string): string {
  return value
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/^\/+/, "")
    .replace(/\/+/g, "/");
}

function folderPathForNode(node: Node): string | null {
  if (node.type === "tag") return null;

  const data = node.data as GraphNodeData;
  if (data.isSummary || data.nonNavigable) return null;

  let raw = "";
  if (typeof data.path === "string" && data.path.trim()) {
    raw = data.path;
  } else if (typeof data.target === "string" && data.target.trim()) {
    raw = data.target;
  } else if (typeof data.groupId === "string" && data.groupId.startsWith("path:")) {
    raw = data.groupId.slice(5);
  }

  if (!raw) return null;
  const normalized = normalizePath(raw);
  if (!normalized) return null;

  const segments = normalized.split("/").filter(Boolean);
  if (segments.length === 0) return null;

  const last = segments[segments.length - 1] || "";
  if (last.includes(".")) {
    segments.pop();
  }

  if (segments.length === 0) return null;
  return segments.join("/");
}

function buildFolderZones(nodes: Node[]): FolderZone[] {
  const membersByPrefix = new Map<string, Set<string>>();
  const nodeById = new Map<string, Node>();

  for (const node of nodes) {
    nodeById.set(node.id, node);
    const folderPath = folderPathForNode(node);
    if (!folderPath) continue;

    const segments = folderPath.split("/").filter(Boolean);
    if (segments.length === 0) continue;

    const maxDepth = Math.min(3, segments.length);
    for (let depth = 1; depth <= maxDepth; depth += 1) {
      const prefix = segments.slice(0, depth).join("/");
      const set = membersByPrefix.get(prefix) || new Set<string>();
      set.add(node.id);
      membersByPrefix.set(prefix, set);
    }
  }

  const countByPrefix = new Map<string, number>();
  for (const [prefix, set] of membersByPrefix) {
    countByPrefix.set(prefix, set.size);
  }

  const includedPrefixes = [...membersByPrefix.keys()].filter((prefix) => {
    const count = countByPrefix.get(prefix) || 0;
    if (count < 2) return false;

    const depth = prefix.split("/").length;
    if (depth <= 1) return true;

    const parent = prefix.split("/").slice(0, -1).join("/");
    const parentCount = countByPrefix.get(parent) || 0;

    // If a child zone would contain exactly the same nodes as parent, it adds
    // visual clutter without separating space.
    if (parentCount > 0 && parentCount === count) return false;

    return true;
  });

  const zones: FolderZone[] = [];
  for (const prefix of includedPrefixes) {
    const memberIds = membersByPrefix.get(prefix);
    if (!memberIds || memberIds.size < 2) continue;
    const depth = prefix.split("/").length;

    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;

    for (const nodeId of memberIds) {
      const node = nodeById.get(nodeId);
      if (!node) continue;
      const size = estimateLayoutNodeSize(node);
      const x1 = node.position.x;
      const y1 = node.position.y;
      const x2 = x1 + size.width;
      const y2 = y1 + size.height;
      minX = Math.min(minX, x1);
      minY = Math.min(minY, y1);
      maxX = Math.max(maxX, x2);
      maxY = Math.max(maxY, y2);
    }

    const padX = depth === 1 ? 48 : 32;
    const padTop = depth === 1 ? 42 : 32;
    const padBottom = depth === 1 ? 26 : 20;

    zones.push({
      key: `zone:${prefix}`,
      label: prefix,
      count: memberIds.size,
      depth,
      x: minX - padX,
      y: minY - padTop,
      width: maxX - minX + padX * 2,
      height: maxY - minY + padTop + padBottom,
    });
  }

  return zones
    .sort((a, b) => {
      if (a.depth !== b.depth) return a.depth - b.depth;
      if (b.count !== a.count) return b.count - a.count;
      return a.label.localeCompare(b.label);
    })
    .slice(0, 28);
}

function buildCycleZones(nodes: Node[], edges: Edge[]): CycleZone[] {
  const relationEdges = edges.filter((edge) => {
    const data = edge.data as EdgeData | undefined;
    return data?.kind === "relationship" && !edge.hidden;
  });
  if (relationEdges.length === 0) return [];

  const nodeById = new Map<string, Node>();
  for (const node of nodes) {
    nodeById.set(node.id, node);
  }

  const adjacency = new Map<string, Set<string>>();
  const activeNodes = new Set<string>();
  for (const edge of relationEdges) {
    if (!nodeById.has(edge.source) || !nodeById.has(edge.target)) continue;
    activeNodes.add(edge.source);
    activeNodes.add(edge.target);
    const set = adjacency.get(edge.source) || new Set<string>();
    set.add(edge.target);
    adjacency.set(edge.source, set);
  }
  if (activeNodes.size < 3) return [];

  let index = 0;
  const stack: string[] = [];
  const onStack = new Set<string>();
  const indexByNode = new Map<string, number>();
  const lowByNode = new Map<string, number>();
  const sccs: string[][] = [];

  const strongConnect = (nodeId: string) => {
    indexByNode.set(nodeId, index);
    lowByNode.set(nodeId, index);
    index += 1;
    stack.push(nodeId);
    onStack.add(nodeId);

    const neighbors = adjacency.get(nodeId) || new Set<string>();
    for (const neighbor of neighbors) {
      if (!indexByNode.has(neighbor)) {
        strongConnect(neighbor);
        const low = Math.min(lowByNode.get(nodeId) || 0, lowByNode.get(neighbor) || 0);
        lowByNode.set(nodeId, low);
      } else if (onStack.has(neighbor)) {
        const low = Math.min(lowByNode.get(nodeId) || 0, indexByNode.get(neighbor) || 0);
        lowByNode.set(nodeId, low);
      }
    }

    if ((lowByNode.get(nodeId) || 0) === (indexByNode.get(nodeId) || 0)) {
      const component: string[] = [];
      while (stack.length > 0) {
        const member = stack.pop();
        if (!member) break;
        onStack.delete(member);
        component.push(member);
        if (member === nodeId) break;
      }
      if (component.length > 0) sccs.push(component);
    }
  };

  const sortedNodes = [...activeNodes].sort((a, b) => a.localeCompare(b));
  for (const nodeId of sortedNodes) {
    if (!indexByNode.has(nodeId)) {
      strongConnect(nodeId);
    }
  }

  const cyclic = sccs.filter((component) => component.length >= 3);
  if (cyclic.length === 0) return [];

  const zones: CycleZone[] = [];
  let cycleIndex = 0;
  for (const component of cyclic) {
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;

    for (const nodeId of component) {
      const node = nodeById.get(nodeId);
      if (!node) continue;
      const size = estimateLayoutNodeSize(node);
      const x1 = node.position.x;
      const y1 = node.position.y;
      const x2 = x1 + size.width;
      const y2 = y1 + size.height;
      minX = Math.min(minX, x1);
      minY = Math.min(minY, y1);
      maxX = Math.max(maxX, x2);
      maxY = Math.max(maxY, y2);
    }

    if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) {
      continue;
    }

    const padX = 26;
    const padY = 24;
    cycleIndex += 1;
    zones.push({
      key: `cycle:${component.slice().sort().join("|")}`,
      label: `cycle ${cycleIndex}`,
      count: component.length,
      x: minX - padX,
      y: minY - padY,
      width: maxX - minX + padX * 2,
      height: maxY - minY + padY * 2,
    });
  }

  return zones
    .sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      return a.label.localeCompare(b.label);
    })
    .slice(0, 16);
}

function diffLaneForNode(node: Node): GraphNodeData["diffLane"] | null {
  const d = node.data as GraphNodeData;
  if (!d.diffLane) return null;
  if (d.diffLane === "group" || d.diffLane === "module" || d.diffLane === "file" || d.diffLane === "tag") {
    return d.diffLane;
  }
  return null;
}

function buildDiffLaneZones(nodes: Node[]): DiffLaneZone[] {
  const lanes = new Map<string, { minX: number; minY: number; maxX: number; maxY: number }>();

  for (const node of nodes) {
    const lane = diffLaneForNode(node);
    if (!lane) continue;
    const size = estimateLayoutNodeSize(node);
    const x1 = node.position.x;
    const y1 = node.position.y;
    const x2 = x1 + size.width;
    const y2 = y1 + size.height;
    const current = lanes.get(lane);
    if (!current) {
      lanes.set(lane, { minX: x1, minY: y1, maxX: x2, maxY: y2 });
      continue;
    }
    current.minX = Math.min(current.minX, x1);
    current.minY = Math.min(current.minY, y1);
    current.maxX = Math.max(current.maxX, x2);
    current.maxY = Math.max(current.maxY, y2);
  }

  return [...lanes.entries()]
    .map(([lane, bounds]) => ({
      key: `lane:${lane}`,
      label: lane,
      x: bounds.minX - 34,
      y: bounds.minY - 34,
      width: bounds.maxX - bounds.minX + 68,
      height: bounds.maxY - bounds.minY + 68,
    }))
    .sort((a, b) => a.x - b.x);
}

function buildDiffBandZones(nodes: Node[]): DiffBandZone[] {
  const bands = new Map<number, { minX: number; minY: number; maxX: number; maxY: number }>();

  for (const node of nodes) {
    const d = node.data as GraphNodeData;
    const hop = typeof d.diffHop === "number" ? d.diffHop : -1;
    if (hop < 0) continue;
    const boundedHop = Math.max(0, Math.min(2, hop));
    const size = estimateLayoutNodeSize(node);
    const x1 = node.position.x;
    const y1 = node.position.y;
    const x2 = x1 + size.width;
    const y2 = y1 + size.height;
    const current = bands.get(boundedHop);
    if (!current) {
      bands.set(boundedHop, { minX: x1, minY: y1, maxX: x2, maxY: y2 });
      continue;
    }
    current.minX = Math.min(current.minX, x1);
    current.minY = Math.min(current.minY, y1);
    current.maxX = Math.max(current.maxX, x2);
    current.maxY = Math.max(current.maxY, y2);
  }

  return [...bands.entries()]
    .map(([hop, bounds]) => ({
      key: `band:${hop}`,
      label: `hop ${hop}`,
      x: bounds.minX - 42,
      y: bounds.minY - 44,
      width: bounds.maxX - bounds.minX + 84,
      height: bounds.maxY - bounds.minY + 88,
    }))
    .sort((a, b) => a.y - b.y);
}

function normalizeDiffPaths(paths: string[] | undefined): string[] {
  const set = new Set<string>();
  for (const raw of paths || []) {
    const normalized = normalizePath(raw);
    if (!normalized) continue;
    set.add(normalized);
  }
  return [...set].sort((a, b) => a.localeCompare(b));
}

function isMarkdownPath(path: string | null | undefined): boolean {
  if (!path) return false;
  const normalized = path.toLowerCase();
  return normalized.endsWith(".md") || normalized.endsWith(".markdown");
}

function markdownNavEntry(node: Node, data: GraphNodeData): NavEntry | null {
  if (node.type === "component" && !data.hasChildren && isMarkdownPath(data.target)) {
    const filePath = data.target!;
    const fileName = filePath.split("/").pop() || filePath;
    return { level: "doc", label: fileName, id: filePath };
  }

  if ((node.type === "file" || node.type === "filegroup") && data.path && isMarkdownPath(data.path)) {
    const fileName = data.path.split("/").pop() || data.path;
    return { level: "doc", label: fileName, id: data.path };
  }

  return null;
}

function applyRelationFocus(
  baseNodes: Node[],
  baseEdges: Edge[],
  enabled: boolean,
  focusedNodeId: string | null
): { nodes: Node[]; edges: Edge[] } {
  if (!enabled || !focusedNodeId) {
    return { nodes: baseNodes, edges: baseEdges };
  }

  const activeNeighbors = new Set<string>([focusedNodeId]);
  const activeEdgeIds = new Set<string>();

  for (const edge of baseEdges) {
    const data = edge.data as EdgeData | undefined;
    if (data?.kind !== "relationship") continue;
    if (edge.source === focusedNodeId || edge.target === focusedNodeId) {
      activeEdgeIds.add(edge.id);
      activeNeighbors.add(edge.source);
      activeNeighbors.add(edge.target);
    }
  }

  const nodes = baseNodes.map((node) => {
    const active = activeNeighbors.has(node.id);
    return {
      ...node,
      style: {
        ...(node.style || {}),
        opacity: active ? 1 : 0.2,
        filter: active ? "none" : "saturate(0.45)",
      },
    };
  });

  const edges = baseEdges.map((edge) => {
    const active = activeEdgeIds.has(edge.id);
    const data = edge.data as EdgeData | undefined;
    const edgeStyle = edge.style || {};
    const stroke = edgeStyle.stroke || graphColors.edgeStructure;
    const strokeWidth = typeof edgeStyle.strokeWidth === "number" ? edgeStyle.strokeWidth : 1.5;
    const evidence = Array.isArray(data?.evidence) ? data.evidence : [];
    const hasStatic = evidence.includes("static");
    const hasSemantic = evidence.includes("semantic");

    const activeStroke =
      data?.kind === "relationship"
        ? hasStatic && hasSemantic
          ? graphColors.edgeFocusBlended
          : hasStatic
            ? graphColors.edgeFocusStatic
            : graphColors.edgeFocusRelationship
        : graphColors.edgeFocusStructure;

    return {
      ...edge,
      animated: active ? true : false,
      style: {
        ...edgeStyle,
        stroke: active ? activeStroke : stroke,
        strokeWidth: active ? Math.max(strokeWidth, 2.5) : strokeWidth,
        opacity: active ? 1 : 0.1,
      },
      labelStyle: {
        ...(edge.labelStyle || {}),
        opacity: active ? 1 : 0.1,
      },
      zIndex: active ? 20 : 1,
    };
  });

  return { nodes, edges };
}

function enrichNodesWithRelationMetrics(baseNodes: Node[], baseEdges: Edge[]): Node[] {
  const relationEdges = baseEdges.filter(
    (edge) => (edge.data as EdgeData | undefined)?.kind === "relationship"
  );

  const relIn = new Map<string, number>();
  const relOut = new Map<string, number>();

  for (const edge of relationEdges) {
    relOut.set(edge.source, (relOut.get(edge.source) || 0) + 1);
    relIn.set(edge.target, (relIn.get(edge.target) || 0) + 1);
  }

  let maxTotal = 0;
  for (const node of baseNodes) {
    const total = (relIn.get(node.id) || 0) + (relOut.get(node.id) || 0);
    if (total > maxTotal) maxTotal = total;
  }

  const hubThreshold = Math.max(4, Math.ceil(maxTotal * 0.6));

  return baseNodes.map((node) => {
    const incoming = relIn.get(node.id) || 0;
    const outgoing = relOut.get(node.id) || 0;
    const total = incoming + outgoing;

    let relRole: GraphNodeData["relRole"] = "flow";
    if (total === 0) relRole = "isolated";
    else if (incoming === 0 && outgoing > 0) relRole = "entry";
    else if (outgoing === 0 && incoming > 0) relRole = "sink";
    else if (total >= hubThreshold) relRole = "hub";

    return {
      ...node,
      data: {
        ...(node.data as Record<string, unknown>),
        relIn: incoming,
        relOut: outgoing,
        relTotal: total,
        relRole,
      },
    };
  });
}

export function GraphView({ data, nav, onNavigate }: Props) {
  const [relationFocusOverride, setRelationFocusOverride] = useState<boolean | null>(null);
  const [focusedNodeId, setFocusedNodeId] = useState<string | null>(null);
  const [folderZonesEnabled, setFolderZonesEnabled] = useState(true);
  const [cycleZonesEnabled, setCycleZonesEnabled] = useState(true);
  const [diffDock, setDiffDock] = useState<DiffDockState>(() => ({ ...CLOSED_DIFF_DOCK }));
  const [activeDiffFile, setActiveDiffFile] = useState(0);
  const [activeDiffHunk, setActiveDiffHunk] = useState(0);
  const diffCacheRef = useRef<Map<string, DiffResponse>>(new Map());
  const hoverRequestRef = useRef(0);
  const flowRef = useRef<ReactFlowInstance<Node, Edge> | null>(null);
  const pendingFitScopeRef = useRef<string | null>(null);

  const navScopeKey = `${nav.level}:${nav.id || ""}`;
  const defaultRelationFocus = nav.level === "system";
  const relationFocusEnabled = relationFocusOverride ?? defaultRelationFocus;

  const { layoutNodes, layoutEdges } = useMemo(() => {
    try {
      const { nodes, edges } = transformGraph(data, nav);
      const positioned = nav.level === "diff" ? layoutDiffGraph(nodes, edges) : layoutGraph(nodes, edges);
      return { layoutNodes: positioned, layoutEdges: edges };
    } catch (err) {
      console.error("[graph] layout failed; using fallback positioning", err);
      const { nodes, edges } = transformGraph(data, nav);
      const fallback = nodes.map((node, idx) => ({
        ...node,
        position: {
          x: (idx % 3) * 420,
          y: Math.floor(idx / 3) * 260,
        },
      }));
      return { layoutNodes: fallback, layoutEdges: edges };
    }
  }, [data, nav]);

  const enrichedLayoutNodes = useMemo(
    () => enrichNodesWithRelationMetrics(layoutNodes, layoutEdges),
    [layoutNodes, layoutEdges]
  );

  const relationPolicyStats = useMemo(() => {
    let total = 0;
    let selected = 0;
    let suppressed = 0;
    let hidden = 0;
    for (const edge of layoutEdges) {
      const data = edge.data as EdgeData | undefined;
      if (data?.kind !== "relationship") continue;
      total += 1;
      if (data.policySelected) selected += 1;
      if (data.policySuppressed) suppressed += 1;
      if (edge.hidden) hidden += 1;
    }
    return { total, selected, suppressed, hidden };
  }, [layoutEdges]);

  const staticSummary = useMemo(
    () => ({
      files: data.static_analysis?.files_analyzed || 0,
      edges: data.static_analysis?.edges?.length || 0,
      truncated: !!data.static_analysis?.truncated,
    }),
    [data.static_analysis]
  );

  const scopeCoverage = useMemo(
    () => graphScopeCoverage(data, nav),
    [data, nav]
  );

  const folderZones = useMemo(() => {
    if (!folderZonesEnabled) return [];
    if (nav.level === "file" || nav.level === "diff") return [];
    return buildFolderZones(enrichedLayoutNodes);
  }, [enrichedLayoutNodes, nav.level, folderZonesEnabled]);

  const cycleZones = useMemo(() => {
    if (!cycleZonesEnabled) return [];
    if (nav.level === "file" || nav.level === "diff") return [];
    return buildCycleZones(enrichedLayoutNodes, layoutEdges);
  }, [enrichedLayoutNodes, layoutEdges, nav.level, cycleZonesEnabled]);

  const diffLaneZones = useMemo(
    () => (nav.level === "diff" ? buildDiffLaneZones(enrichedLayoutNodes) : []),
    [enrichedLayoutNodes, nav.level]
  );

  const diffBandZones = useMemo(
    () => (nav.level === "diff" ? buildDiffBandZones(enrichedLayoutNodes) : []),
    [enrichedLayoutNodes, nav.level]
  );

  const { nodes: displayNodes, edges: displayEdges } = useMemo(
    () =>
      applyRelationFocus(
        enrichedLayoutNodes,
        layoutEdges,
        relationFocusEnabled,
        focusedNodeId
      ),
    [enrichedLayoutNodes, layoutEdges, relationFocusEnabled, focusedNodeId]
  );

  const [nodes, setNodes, onNodesChange] = useNodesState(layoutNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(layoutEdges);

  useEffect(() => {
    pendingFitScopeRef.current = navScopeKey;
    const timer = window.setTimeout(() => {
      setRelationFocusOverride(null);
      setFocusedNodeId(null);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [navScopeKey]);

  useEffect(() => {
    setNodes(displayNodes);
    setEdges(displayEdges);
    if (pendingFitScopeRef.current === navScopeKey && flowRef.current && displayNodes.length > 0) {
      const raf = window.requestAnimationFrame(() => {
        flowRef.current?.fitView({ padding: 0.24, duration: 260 });
        pendingFitScopeRef.current = null;
      });
      return () => window.cancelAnimationFrame(raf);
    }
  }, [displayNodes, displayEdges, navScopeKey, setNodes, setEdges]);

  useEffect(() => {
    diffCacheRef.current.clear();
  }, [data.generated_at]);

  const diffSelection = useMemo(
    () => deriveDiffDockSelection(diffDock.response, activeDiffFile, activeDiffHunk),
    [diffDock.response, activeDiffFile, activeDiffHunk]
  );
  const {
    files: diffFiles,
    activeFileIndex: safeActiveDiffFile,
    activeFile: activeDiffFileDoc,
    hunks: activeDiffHunks,
    activeHunkIndex: safeActiveDiffHunk,
    activeHunk: activeDiffHunkDoc,
  } = diffSelection;

  const resetDiffSelection = useCallback(() => {
    setActiveDiffFile(0);
    setActiveDiffHunk(0);
  }, []);

  const onFlowInit = useCallback(
    (instance: ReactFlowInstance<Node, Edge>) => {
      flowRef.current = instance;
      if (pendingFitScopeRef.current === navScopeKey) {
        window.requestAnimationFrame(() => {
          instance.fitView({ padding: 0.24, duration: 260 });
          pendingFitScopeRef.current = null;
        });
      }
    },
    [navScopeKey]
  );

  const onPaneClick = useCallback(() => {
    if (relationFocusEnabled) {
      setFocusedNodeId(null);
    }
  }, [relationFocusEnabled]);

  const onMiniMapClick = useCallback(
    (event: MouseEvent<Element>, position: { x: number; y: number }) => {
      event.stopPropagation();
      const instance = flowRef.current;
      if (!instance) return;

      void instance.setCenter(position.x, position.y, {
        zoom: instance.getZoom(),
        duration: 220,
      });
    },
    []
  );

  const onNodeMouseEnter: NodeMouseHandler = useCallback(
    (_event, node: Node) => {
      const d = node.data as GraphNodeData;
      const title = nodeDiffDockTitle(node, d);
      const paths = normalizeDiffPaths(d.diffPaths);
      resetDiffSelection();

      if (paths.length === 0) {
        setDiffDock(
          buildDiffDockState({
            title,
            key: `none:${node.id}`,
            paths: [],
            noChanges: true,
          })
        );
        return;
      }

      const cacheKey = paths.join("|");
      const cached = diffCacheRef.current.get(cacheKey);
      if (cached) {
        setDiffDock(
          buildDiffDockState({
            title,
            key: cacheKey,
            paths,
            response: cached,
          })
        );
        return;
      }

      const requestId = ++hoverRequestRef.current;
      setDiffDock(
        buildDiffDockState({
          title,
          key: cacheKey,
          paths,
          loading: true,
        })
      );

      void fetchDiff(paths)
        .then((response) => {
          diffCacheRef.current.set(cacheKey, response);
          if (hoverRequestRef.current !== requestId) return;
          setDiffDock(
            buildDiffDockState({
              title,
              key: cacheKey,
              paths,
              response,
            })
          );
        })
        .catch((err) => {
          if (hoverRequestRef.current !== requestId) return;
          setDiffDock(
            buildDiffDockState({
              title,
              key: cacheKey,
              paths,
              error: String(err),
            })
          );
        });
    },
    [resetDiffSelection]
  );

  const onNodeClick: NodeMouseHandler = useCallback(
    (event, node: Node) => {
      const d = node.data as GraphNodeData;
      const wantsNavigate = event.metaKey || event.ctrlKey || event.shiftKey;
      const isDeleted = d.gitStatus === "deleted";
      const markdownNav = markdownNavEntry(node, d);
      const diffPaths = normalizeDiffPaths(d.diffPaths);

      if (event.altKey && diffPaths.length > 0) {
        onNavigate({
          level: "diff",
          label: `Diff: ${d.name || d.path || d.target || node.id}`,
          id: `diff:${diffPaths.join("|")}`,
          diff: {
            seedPaths: diffPaths,
            originScope: {
              level: diffOriginLevel(nav.level),
              label: nav.label,
              id: nav.id,
            },
            maxHops: 2,
            baseline: "head_worktree",
          },
        });
        return;
      }

      if (isDeleted && (node.type === "file" || node.type === "filegroup")) {
        return;
      }

      if (markdownNav) {
        onNavigate(markdownNav);
        return;
      }

      if (relationFocusEnabled && !wantsNavigate) {
        setFocusedNodeId((current) => (current === node.id ? null : node.id));
        return;
      }

      if (node.type === "group") {
        if (d.nonNavigable || d.isSummary) return;
        if (typeof d.moduleId === "string" && d.moduleId.trim()) {
          onNavigate({ level: "module", label: d.name || "Module", id: d.moduleId });
          return;
        }
        const groupId = typeof d.groupId === "string" ? d.groupId : "";
        if (groupId.startsWith(MODULE_DIR_FILTER_PREFIX)) {
          onNavigate({ level: "module", label: d.name || "Group", id: groupId });
          return;
        }
        // Subsystem group: drill into filtered system view
        onNavigate({ level: "system", label: d.name || "Group", id: d.groupId });
      } else if (node.type === "filegroup") {
        if (isDeleted) return;
        if (d.isSummary) {
          // Summary node in file view: open in VS Code
          if (d.absPath) openInVscode(d.absPath, 1);
        } else if (d.isLeaf) {
          if ((d.hasDiveMeta || (d.tagCount || 0) > 0) && d.path) {
            const fileName = d.path.split("/").pop() || d.path;
            onNavigate({ level: "file", label: fileName, id: d.path });
          } else if (d.absPath) {
            openInVscode(d.absPath, 1);
          }
        } else if ((d.hasDiveMeta || (d.tagCount || 0) > 0) && d.path) {
          const fileName = d.path.split("/").pop() || d.path;
          onNavigate({ level: "file", label: fileName, id: d.path });
        } else if (d.absPath) {
          openInVscode(d.absPath, 1);
        }
      } else if (node.type === "component") {
        if (!d.hasChildren) {
          return;
        }
        const id = d.moduleId || d.dirPath || d.name;
        const label = d.name || "Component";
        if (!id) return;
        onNavigate({ level: "module", label, id });
      } else if (node.type === "file") {
        if (isDeleted) return;
        if (d.isHeader && d.absPath) {
          openInVscode(d.absPath, 1);
        } else if (d.isReference && d.path) {
          const fileName = d.path.split("/").pop() || d.path;
          onNavigate({ level: "file", label: fileName, id: d.path });
        } else if ((d.hasDiveMeta || (d.tagCount || 0) > 0) && d.path) {
          // Has dive metadata: drill into file level to show narrative/relations/tags.
          const fileName = d.path.split("/").pop() || d.path;
          onNavigate({ level: "file", label: fileName, id: d.path });
        } else if (d.absPath) {
          // No dive metadata: open in VS Code directly.
          openInVscode(d.absPath, 1);
        }
      } else if (node.type === "tag") {
        if (d.absPath && d.line) {
          openInVscode(d.absPath, d.line);
        }
      }
    },
    [onNavigate, relationFocusEnabled, nav]
  );

  useEffect(() => {
    if (!diffDock.open) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (diffFiles.length === 0) return;

      if (event.key === "ArrowLeft") {
        event.preventDefault();
        setActiveDiffFile((current) => Math.max(0, current - 1));
        setActiveDiffHunk(0);
        return;
      }

      if (event.key === "ArrowRight") {
        event.preventDefault();
        setActiveDiffFile((current) => Math.min(diffFiles.length - 1, current + 1));
        setActiveDiffHunk(0);
        return;
      }

      if (event.key === "ArrowUp") {
        event.preventDefault();
        setActiveDiffHunk((current) => Math.max(0, current - 1));
      } else if (event.key === "ArrowDown") {
        event.preventDefault();
        setActiveDiffHunk((current) =>
          Math.min(Math.max(0, activeDiffHunks.length - 1), current + 1)
        );
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [diffDock.open, diffFiles.length, activeDiffHunks.length]);

  const closeDiffDock = useCallback(() => {
    setDiffDock((current) => ({ ...current, open: false }));
  }, []);

  return (
    <div style={{ width: "100%", height: "100%" }}>
      <div className="graph-toolbar">
        <button
          type="button"
          className={`graph-toolbar-button ${folderZonesEnabled ? "is-active" : ""}`}
          onClick={() => setFolderZonesEnabled((value) => !value)}
        >
          {folderZonesEnabled ? "Folder Zones: ON" : "Folder Zones: OFF"}
        </button>
        <button
          type="button"
          className={`graph-toolbar-button ${relationFocusEnabled ? "is-active" : ""}`}
          onClick={() => {
            const next = !relationFocusEnabled;
            setRelationFocusOverride(next);
            if (!next) setFocusedNodeId(null);
          }}
        >
          {relationFocusEnabled ? "Relation Focus: ON" : "Relation Focus: OFF"}
        </button>
        <button
          type="button"
          className={`graph-toolbar-button ${cycleZonesEnabled ? "is-active" : ""}`}
          onClick={() => setCycleZonesEnabled((value) => !value)}
        >
          {cycleZonesEnabled ? "Cycle Clusters: ON" : "Cycle Clusters: OFF"}
        </button>
        {relationPolicyStats.total > 0 && (
          <span className="graph-toolbar-hint">
            policy: showing {relationPolicyStats.selected}/{relationPolicyStats.total} relations
            {relationPolicyStats.hidden > 0
              ? `, hidden ${relationPolicyStats.hidden}`
              : relationPolicyStats.suppressed > 0
                ? `, de-emphasized ${relationPolicyStats.suppressed}`
                : ""}
          </span>
        )}
        {staticSummary.files > 0 && (
          <span className="graph-toolbar-hint">
            static: {staticSummary.files} files, {staticSummary.edges} inferred edges
            {staticSummary.truncated ? " (truncated)" : ""}
          </span>
        )}
        {scopeCoverage.staticFiles > 0 && (
          <span className="graph-toolbar-hint">
            coverage: {scopeCoverage.representedFiles}/{scopeCoverage.staticFiles} represented
            {" · "}
            missing {scopeCoverage.missingFiles}
            {" · "}
            {scopeCoverage.representedPct}%
          </span>
        )}
        {relationFocusEnabled && (
          <span className="graph-toolbar-hint">
            click node to isolate 1-hop relations, click canvas to clear, hold cmd/ctrl to navigate
          </span>
        )}
      </div>
      <div className="graph-legend" aria-label="Graph color legend">
        <div className="graph-legend-section">
          <span className="graph-legend-label">node outline</span>
          <span className="graph-legend-item">
            <span className="graph-legend-outline is-component" />
            component
          </span>
          <span className="graph-legend-item">
            <span className="graph-legend-outline is-file" />
            file
          </span>
          <span className="graph-legend-item">
            <span className="graph-legend-outline is-filegroup" />
            file group
          </span>
          <span className="graph-legend-item">
            <span className="graph-legend-outline is-group" />
            group
          </span>
          <span className="graph-legend-item">
            <span className="graph-legend-outline is-tag" />
            tag
          </span>
          <span className="graph-legend-item">
            <span className="graph-legend-outline is-anchor" />
            anchor / unannotated
          </span>
        </div>
        <div className="graph-legend-section">
          <span className="graph-legend-label">git outline</span>
          <span className="graph-legend-item">
            <span className="graph-legend-outline is-git-added" />
            added
          </span>
          <span className="graph-legend-item">
            <span className="graph-legend-outline is-git-modified" />
            modified
          </span>
          <span className="graph-legend-item">
            <span className="graph-legend-outline is-git-deleted" />
            deleted
          </span>
        </div>
        <div className="graph-legend-section">
          <span className="graph-legend-label">edge line</span>
          <span className="graph-legend-item">
            <span className="graph-legend-line is-structure" />
            structure
          </span>
          <span className="graph-legend-item">
            <span className="graph-legend-line is-relationship" />
            semantic
          </span>
          <span className="graph-legend-item">
            <span className="graph-legend-line is-static" />
            static
          </span>
          <span className="graph-legend-item">
            <span className="graph-legend-line is-blended" />
            blended
          </span>
          <span className="graph-legend-item">
            <span className="graph-legend-line is-ambiguous" />
            ambiguous
          </span>
          <span className="graph-legend-item">
            <span className="graph-legend-line is-focus-relationship" />
            focus semantic
          </span>
          <span className="graph-legend-item">
            <span className="graph-legend-line is-focus-static" />
            focus static
          </span>
          <span className="graph-legend-item">
            <span className="graph-legend-line is-focus-blended" />
            focus blended
          </span>
          <span className="graph-legend-item">
            <span className="graph-legend-line is-focus-structure" />
            focus structure
          </span>
        </div>
        <div className="graph-legend-section">
          <span className="graph-legend-label">badge</span>
          <span className="graph-legend-item">
            <span className="graph-legend-dot is-warning" />
            warning badge
          </span>
        </div>
      </div>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeClick={onNodeClick}
        onNodeMouseEnter={onNodeMouseEnter}
        onPaneClick={onPaneClick}
        onInit={onFlowInit}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        minZoom={0.1}
        maxZoom={2}
        defaultEdgeOptions={{
          type: "smoothstep",
          style: { stroke: graphColors.edgeStructure, strokeWidth: 1.5 },
        }}
      >
        {renderViewportZones(
          diffBandZones,
          "diff-bands-layer",
          () => "diff-band-zone",
          "diff-band-zone-label",
          (zone) => zone.label
        )}
        {renderViewportZones(
          diffLaneZones,
          "diff-lanes-layer",
          () => "diff-lane-zone",
          "diff-lane-zone-label",
          (zone) => zone.label
        )}
        {renderViewportZones(
          cycleZones,
          "cycle-zones-layer",
          () => "cycle-zone",
          "cycle-zone-label",
          (zone) => (
            <>
              {zone.label} <span>{zone.count}</span>
            </>
          )
        )}
        {renderViewportZones(
          folderZones,
          "folder-zones-layer",
          (zone) => `folder-zone folder-zone-depth-${Math.min(zone.depth, 3)}`,
          "folder-zone-label",
          (zone) => (
            <>
              {zone.label}/ <span>{zone.count}</span>
            </>
          )
        )}
        <Background color={graphColors.grid} gap={20} />
        <Controls />
        <MiniMap
          nodeColor={(n) => minimapNodeColor(n.type)}
          onClick={onMiniMapClick}
          pannable
          style={{ background: graphColors.minimapBackground }}
        />
      </ReactFlow>
      {diffDock.open && (
        <aside className="diff-dock" aria-label="Diff dock">
          <div className="diff-dock-header">
            <div className="diff-dock-title">{diffDock.title}</div>
            <button
              type="button"
              className="diff-dock-close"
              onClick={closeDiffDock}
            >
              close
            </button>
          </div>
          {diffDock.loading && <div className="diff-dock-loading">Loading diff…</div>}
          {!diffDock.loading && diffDock.error && (
            <div className="diff-dock-error">{diffDock.error}</div>
          )}
          {!diffDock.loading && !diffDock.error && diffDock.noChanges && (
            <div className="diff-dock-empty">No changes for this node.</div>
          )}
          {!diffDock.loading && !diffDock.error && !diffDock.noChanges && (
            <div className="diff-dock-body">
              {diffDock.response?.truncated && (
                <div className="diff-dock-warning">
                  Diff output was truncated to keep rendering responsive.
                </div>
              )}
              <div className="diff-dock-file-list">
                {diffFiles.map((file, idx) => (
                  <button
                    key={file.path}
                    type="button"
                    className={`diff-dock-file ${idx === safeActiveDiffFile ? "is-active" : ""}`}
                    onClick={() => {
                      setActiveDiffFile(idx);
                      setActiveDiffHunk(0);
                    }}
                  >
                    <span className={`diff-dock-file-status is-${file.status}`}>{file.status}</span>
                    <span className="diff-dock-file-path">{file.path}</span>
                  </button>
                ))}
              </div>
              {(() => {
                if (diffFiles.length === 0 || !activeDiffFileDoc) {
                  return <div className="diff-dock-empty">No diff content returned.</div>;
                }
                return (
                  <div className="diff-dock-content">
                    <div className="diff-dock-meta">
                      <span>{activeDiffFileDoc.path}</span>
                      {activeDiffFileDoc.truncated && (
                        <span className="diff-dock-truncated-tag">file truncated</span>
                      )}
                      <span>
                        hunk {activeDiffHunks.length === 0 ? 0 : safeActiveDiffHunk + 1}/
                        {activeDiffHunks.length}
                      </span>
                    </div>
                    {activeDiffHunkDoc ? (
                      <div className="diff-dock-hunk">
                        <div className="diff-dock-hunk-header">{activeDiffHunkDoc.header}</div>
                        <div className="diff-dock-lines">
                          {activeDiffHunkDoc.lines.map((line, idx) => (
                            <div key={idx} className={`diff-dock-line is-${line.kind}`}>
                              {line.text}
                            </div>
                          ))}
                        </div>
                      </div>
                    ) : (
                      <div className="diff-dock-empty">No hunks for this file.</div>
                    )}
                    <div className="diff-dock-hint">Left/Right files • Up/Down hunks</div>
                  </div>
                );
              })()}
            </div>
          )}
        </aside>
      )}
    </div>
  );
}
