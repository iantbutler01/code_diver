import { Handle, Position } from "@xyflow/react";
import type { NodeProps } from "@xyflow/react";

interface GroupData {
  name: string;
  count: number;
  children: string[];
}

export function GroupNode({ data }: NodeProps) {
  const d = data as unknown as GroupData;
  return (
    <div className="node node-group">
      <Handle type="target" position={Position.Top} />
      <div className="node-group-title">{d.name}/</div>
      <div className="node-group-count">{d.count} components</div>
      <div className="node-group-list">
        {d.children.slice(0, 5).map((name) => (
          <div key={name} className="node-group-item">
            {name}
          </div>
        ))}
        {d.children.length > 5 && (
          <div className="node-group-item node-group-more">
            +{d.children.length - 5} more
          </div>
        )}
      </div>
      <div className="node-hint">click to explore</div>
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}
