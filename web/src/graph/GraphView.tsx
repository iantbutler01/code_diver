import { useMemo, useCallback, useEffect } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  useNodesState,
  useEdgesState,
  type Node,
  type NodeMouseHandler,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import type { GraphData, NavEntry } from "../types";
import { transformGraph } from "./transform";
import { layoutGraph } from "./layout";
import { ComponentNode } from "./ComponentNode";
import { FileNode } from "./FileNode";
import { TagNode } from "./TagNode";
import { GroupNode } from "./GroupNode";
import { FileGroupNode } from "./FileGroupNode";
import { openInVscode } from "../api";

const nodeTypes = {
  component: ComponentNode,
  file: FileNode,
  tag: TagNode,
  group: GroupNode,
  filegroup: FileGroupNode,
};

interface Props {
  data: GraphData;
  nav: NavEntry;
  onNavigate: (entry: NavEntry) => void;
}

export function GraphView({ data, nav, onNavigate }: Props) {
  const { layoutNodes, layoutEdges } = useMemo(() => {
    const { nodes, edges } = transformGraph(data, nav);
    const positioned = layoutGraph(nodes, edges);
    return { layoutNodes: positioned, layoutEdges: edges };
  }, [data, nav]);

  const [nodes, setNodes, onNodesChange] = useNodesState(layoutNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(layoutEdges);

  useEffect(() => {
    setNodes(layoutNodes);
    setEdges(layoutEdges);
  }, [layoutNodes, layoutEdges, setNodes, setEdges]);

  const onNodeClick: NodeMouseHandler = useCallback(
    (_event, node: Node) => {
      const d = node.data as any;

      if (node.type === "group") {
        // Subsystem group: drill into filtered system view
        onNavigate({ level: "system", label: d.name, id: d.groupId });
      } else if (node.type === "filegroup") {
        if (d.isSummary) {
          // Summary node in file view: open in VS Code
          if (d.absPath) openInVscode(d.absPath, 1);
        } else if (d.tagCount > 0) {
          const fileName = d.path.split("/").pop() || d.path;
          onNavigate({ level: "file", label: fileName, id: d.path });
        } else if (d.absPath) {
          openInVscode(d.absPath, 1);
        }
      } else if (node.type === "component") {
        if (!d.hasChildren) return;
        const id = d.moduleId || d.dirPath || d.name;
        const label = d.name;
        onNavigate({ level: "module", label, id });
      } else if (node.type === "file") {
        if (d.isHeader) {
          openInVscode(d.absPath, 1);
        } else if (d.isReference) {
          const fileName = d.path.split("/").pop() || d.path;
          onNavigate({ level: "file", label: fileName, id: d.path });
        } else if (d.tagCount > 0) {
          // Has tags: drill into file level to see them
          const fileName = d.path.split("/").pop() || d.path;
          onNavigate({ level: "file", label: fileName, id: d.path });
        } else if (d.absPath) {
          // No tags: open in VS Code directly
          openInVscode(d.absPath, 1);
        }
      } else if (node.type === "tag") {
        openInVscode(d.absPath, d.line);
      }
    },
    [onNavigate]
  );

  return (
    <div style={{ width: "100%", height: "100%" }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeClick={onNodeClick}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        minZoom={0.1}
        maxZoom={2}
        defaultEdgeOptions={{
          type: "smoothstep",
          style: { stroke: "#4a5568", strokeWidth: 1.5 },
        }}
      >
        <Background color="#2a3a5c" gap={20} />
        <Controls />
        <MiniMap
          nodeColor={(n) => {
            if (n.type === "group") return "#8b5cf6";
            if (n.type === "filegroup") return "#6366f1";
            if (n.type === "component") return "#0f9b8e";
            if (n.type === "file") return "#3b82f6";
            if (n.type === "tag") return "#f59e0b";
            return "#666";
          }}
          style={{ background: "#1a1a2e" }}
        />
      </ReactFlow>
    </div>
  );
}
