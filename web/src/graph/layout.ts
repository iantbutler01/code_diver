import dagre from "dagre";
import type { Node, Edge } from "@xyflow/react";

const NODE_WIDTH = 280;

// Estimate rendered height per node type so dagre doesn't overlap them.
function estimateNodeHeight(node: Node): number {
  const d = node.data as any;

  if (node.type === "filegroup") {
    const concepts = d.concepts || [];
    const conceptHeight = concepts.reduce((sum: number, c: any) => {
      const hasDesc = !!(c.description && c.description.length > 0);
      return sum + (hasDesc ? 56 : 24);
    }, 0);
    const diveFileHeight = d.diveFile ? 40 : 0;
    const relCount = d.diveRels?.length || 0;
    const relHeight = relCount > 0 ? 12 + relCount * 18 : 0;
    const tagCount = d.tags?.length || 0;
    const tagHeight = tagCount > 0 ? 12 + tagCount * 20 : 0;
    // title + path + diveFile + concepts + rels + tags + hint + padding
    return 60 + diveFileHeight + conceptHeight + relHeight + tagHeight + 30;
  }

  if (node.type === "group") {
    const childCount = Math.min((d.children?.length || 0), 5);
    const hasMore = (d.children?.length || 0) > 5;
    // title + count + children list + hint + padding
    return 60 + childCount * 22 + (hasMore ? 20 : 0) + 30;
  }

  if (node.type === "tag") {
    return 80;
  }

  // component / file nodes
  const hasDesc = !!(d.description && d.description.length > 0);
  const hasPath = !!(d.path || d.target);
  const hasRels = (d.diveRels?.length || 0) > 0;
  const relLines = Math.min((d.diveRels?.length || 0), 3);

  let h = 40; // title + padding
  if (hasDesc) h += 44; // ~3 lines clamped
  if (hasPath) h += 20;
  if (d.tagCount > 0 || d.hasChildren) h += 20; // hint
  if (hasRels) h += 12 + relLines * 18; // rel section

  return h;
}

export function layoutGraph(
  nodes: Node[],
  edges: Edge[],
  direction: "TB" | "LR" = "TB"
): Node[] {
  if (nodes.length === 0) return nodes;

  if (edges.length === 0) {
    return gridLayout(nodes);
  }

  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({
    rankdir: direction,
    nodesep: 80,
    ranksep: 120,
    marginx: 60,
    marginy: 60,
    ranker: "network-simplex",
  });

  for (const node of nodes) {
    const h = estimateNodeHeight(node);
    g.setNode(node.id, { width: NODE_WIDTH, height: h });
  }

  for (const edge of edges) {
    g.setEdge(edge.source, edge.target);
  }

  dagre.layout(g);

  return nodes.map((node) => {
    const info = g.node(node.id);
    return {
      ...node,
      position: {
        x: info.x - NODE_WIDTH / 2,
        y: info.y - info.height / 2,
      },
    };
  });
}

function gridLayout(nodes: Node[]): Node[] {
  const cols = Math.max(1, Math.ceil(Math.sqrt(nodes.length)));
  const gapX = NODE_WIDTH + 80;

  return nodes.map((node, i) => {
    const h = estimateNodeHeight(node);
    const gapY = h + 60;
    return {
      ...node,
      position: {
        x: (i % cols) * gapX,
        y: Math.floor(i / cols) * gapY,
      },
    };
  });
}
