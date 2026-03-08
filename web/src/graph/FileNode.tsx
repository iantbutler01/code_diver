import { Handle, Position } from "@xyflow/react";
import type { NodeProps } from "@xyflow/react";
import { CopyButton } from "./CopyButton";

interface FileData {
  path: string;
  absPath: string;
  description: string;
  tagCount: number;
  isHeader?: boolean;
  isReference?: boolean;
  diveRels?: string[];
  gitStatus?: "added" | "modified" | "deleted";
}

export function FileNode({ data }: NodeProps) {
  const d = data as unknown as FileData;
  const fileName = d.path.split("/").pop() || d.path;
  const copyText = [
    `File: ${fileName}`,
    `Path: ${d.path}`,
    d.gitStatus ? `Git status: ${d.gitStatus}` : null,
    d.description ? `Description: ${d.description}` : null,
    ...(d.diveRels || []).map((rel) => `Relation: ${rel}`),
    `Tag count: ${d.tagCount}`,
  ]
    .filter(Boolean)
    .join("\n");

  const className = [
    "node",
    d.isHeader ? "node-file-header" : "node-file",
    d.isReference ? "node-file-ref" : "",
    d.gitStatus ? `node-git-${d.gitStatus}` : "",
  ]
    .filter(Boolean)
    .join(" ");
  const isDeleted = d.gitStatus === "deleted";

  return (
    <div className={className}>
      <Handle type="target" position={Position.Top} />
      <div className="node-header">
        <div className="node-title">{fileName}</div>
        <CopyButton text={copyText} />
      </div>
      <div className="node-path">{d.path}</div>
      {d.gitStatus && (
        <div className={`node-badge node-badge-git node-badge-git-${d.gitStatus}`}>
          git: {d.gitStatus}
        </div>
      )}
      {d.description && <div className="node-desc">{d.description}</div>}
      {d.diveRels && d.diveRels.length > 0 && (
        <div className="node-rels">
          {d.diveRels.map((rel, i) => (
            <div key={i} className="node-rel">
              {rel}
            </div>
          ))}
        </div>
      )}
      {isDeleted && (
        <div className="node-hint">removed in working tree</div>
      )}
      {!isDeleted && d.tagCount > 0 && !d.isHeader && (
        <div className="node-hint">{d.tagCount} tags - click to explore</div>
      )}
      {!isDeleted && d.tagCount === 0 && !d.isHeader && !d.isReference && (
        <div className="node-hint">click to open in VS Code</div>
      )}
      {!isDeleted && d.isHeader && (
        <div className="node-hint">click to open in VS Code</div>
      )}
      {!isDeleted && d.isReference && (
        <div className="node-hint">click to explore</div>
      )}
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}
