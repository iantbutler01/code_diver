import { useMemo, useCallback, useEffect, useRef, useState, type MouseEvent } from "react";
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

import type { GraphData, NavEntry } from "../types";
import { transformGraph } from "./transform";
import { estimateLayoutNodeSize, layoutGraph } from "./layout";
import { ComponentNode } from "./ComponentNode";
import { FileNode } from "./FileNode";
import { TagNode } from "./TagNode";
import { GroupNode } from "./GroupNode";
import { FileGroupNode } from "./FileGroupNode";
import { RelationEdge } from "./RelationEdge";
import { openInVscode } from "../api";
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
  const flowRef = useRef<ReactFlowInstance<Node, Edge> | null>(null);
  const pendingFitScopeRef = useRef<string | null>(null);

  const navScopeKey = `${nav.level}:${nav.id || ""}`;
  const defaultRelationFocus = nav.level === "system";
  const relationFocusEnabled = relationFocusOverride ?? defaultRelationFocus;

  const { layoutNodes, layoutEdges } = useMemo(() => {
    try {
      const { nodes, edges } = transformGraph(data, nav);
      const relationCount = edges.filter(
        (edge) => (edge.data as EdgeData | undefined)?.kind === "relationship"
      ).length;
      const structuralCount = edges.filter(
        (edge) => (edge.data as EdgeData | undefined)?.layout !== false
      ).length;
      const layoutDirection =
        nav.level === "system" || relationCount > structuralCount ? "LR" : "TB";
      const positioned = layoutGraph(nodes, edges, layoutDirection);
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

  const folderZones = useMemo(() => {
    if (!folderZonesEnabled) return [];
    if (nav.level === "file") return [];
    return buildFolderZones(enrichedLayoutNodes);
  }, [enrichedLayoutNodes, nav.level, folderZonesEnabled]);

  const cycleZones = useMemo(() => {
    if (!cycleZonesEnabled) return [];
    if (nav.level === "file") return [];
    return buildCycleZones(enrichedLayoutNodes, layoutEdges);
  }, [enrichedLayoutNodes, layoutEdges, nav.level, cycleZonesEnabled]);

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

  const onNodeClick: NodeMouseHandler = useCallback(
    (event, node: Node) => {
      const d = node.data as GraphNodeData;
      const wantsNavigate = event.metaKey || event.ctrlKey || event.shiftKey;
      const markdownNav = markdownNavEntry(node, d);

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
    [onNavigate, relationFocusEnabled]
  );

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
        {relationFocusEnabled && (
          <span className="graph-toolbar-hint">
            click node to isolate 1-hop relations, click canvas to clear, hold cmd/ctrl to navigate
          </span>
        )}
      </div>
      <div className="graph-legend" aria-label="Graph color legend">
        <span className="graph-legend-item">
          <span className="graph-legend-dot is-component" />
          component
        </span>
        <span className="graph-legend-item">
          <span className="graph-legend-dot is-file" />
          file
        </span>
        <span className="graph-legend-item">
          <span className="graph-legend-dot is-group" />
          group
        </span>
        <span className="graph-legend-item">
          <span className="graph-legend-dot is-tag" />
          tag
        </span>
        <span className="graph-legend-item">
          <span className="graph-legend-line is-relationship" />
          semantic rel
        </span>
        <span className="graph-legend-item">
          <span className="graph-legend-line is-static" />
          static rel
        </span>
        <span className="graph-legend-item">
          <span className="graph-legend-line is-blended" />
          blended rel
        </span>
        <span className="graph-legend-item">
          <span className="graph-legend-line is-ambiguous" />
          ambiguous rel
        </span>
        <span className="graph-legend-item">
          <span className="graph-legend-dot is-warning" />
          warning
        </span>
      </div>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeClick={onNodeClick}
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
        {cycleZones.length > 0 && (
          <ViewportPortal>
            <div className="cycle-zones-layer">
              {cycleZones.map((zone) => (
                <div
                  key={zone.key}
                  className="cycle-zone"
                  style={{
                    width: `${zone.width}px`,
                    height: `${zone.height}px`,
                    transform: `translate(${zone.x}px, ${zone.y}px)`,
                  }}
                >
                  <div className="cycle-zone-label">
                    {zone.label} <span>{zone.count}</span>
                  </div>
                </div>
              ))}
            </div>
          </ViewportPortal>
        )}
        {folderZones.length > 0 && (
          <ViewportPortal>
            <div className="folder-zones-layer">
              {folderZones.map((zone) => (
                <div
                  key={zone.key}
                  className={`folder-zone folder-zone-depth-${Math.min(zone.depth, 3)}`}
                  style={{
                    width: `${zone.width}px`,
                    height: `${zone.height}px`,
                    transform: `translate(${zone.x}px, ${zone.y}px)`,
                  }}
                >
                  <div className="folder-zone-label">
                    {zone.label}/ <span>{zone.count}</span>
                  </div>
                </div>
              ))}
            </div>
          </ViewportPortal>
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
    </div>
  );
}
