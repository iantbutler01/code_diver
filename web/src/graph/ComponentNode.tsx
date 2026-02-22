import { Handle, Position } from "@xyflow/react";
import type { NodeProps } from "@xyflow/react";

interface ComponentData {
  name: string;
  description: string;
  target: string | null;
  hasChildren: boolean;
}

export function ComponentNode({ data }: NodeProps) {
  const d = data as unknown as ComponentData;
  return (
    <div className="node node-component">
      <Handle type="target" position={Position.Top} />
      <div className="node-title">{d.name}</div>
      {d.description && <div className="node-desc">{d.description}</div>}
      {d.target && <div className="node-path">{d.target}</div>}
      {d.hasChildren && <div className="node-hint">click to explore</div>}
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}
