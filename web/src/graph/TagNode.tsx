import { Handle, Position } from "@xyflow/react";
import type { NodeProps } from "@xyflow/react";

interface TagData {
  line: number;
  description: string;
  absPath: string;
}

export function TagNode({ data }: NodeProps) {
  const d = data as unknown as TagData;
  return (
    <div className="node node-tag">
      <Handle type="target" position={Position.Top} />
      <div className="node-line">line {d.line}</div>
      <div className="node-desc">{d.description}</div>
      <div className="node-hint">click to open in VS Code</div>
    </div>
  );
}
