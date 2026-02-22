import { Handle, Position } from "@xyflow/react";
import type { NodeProps } from "@xyflow/react";

interface Concept {
  name: string;
  description: string;
}

interface Tag {
  line: number;
  description: string;
}

interface FileGroupData {
  path: string;
  concepts: Concept[];
  diveFile: string;
  diveRels: string[];
  tags: Tag[];
  tagCount: number;
  isSummary?: boolean;
}

export function FileGroupNode({ data }: NodeProps) {
  const d = data as unknown as FileGroupData;
  const fileName = d.path.split("/").pop() || d.path;

  return (
    <div className="node node-file-group">
      <Handle type="target" position={Position.Top} />
      <div className="node-title">{fileName}</div>
      <div className="node-path">{d.path}</div>
      {d.diveFile && (
        <div className="node-desc">{d.diveFile}</div>
      )}
      <div className="node-concepts">
        {d.concepts.map((c) => (
          <div key={c.name} className="node-concept">
            <span className="node-concept-name">{c.name}</span>
            {c.description && (
              <div className="node-concept-desc">{c.description}</div>
            )}
          </div>
        ))}
      </div>
      {d.diveRels && d.diveRels.length > 0 && (
        <div className="node-rels">
          {d.diveRels.map((rel, i) => (
            <div key={i} className="node-rel">{rel}</div>
          ))}
        </div>
      )}
      {!d.isSummary && d.tags && d.tags.length > 0 && (
        <div className="node-tags">
          {d.tags.map((t) => (
            <div key={t.line} className="node-tag-item">
              <span className="node-tag-line">L{t.line}</span>
              <span className="node-tag-text">{t.description}</span>
            </div>
          ))}
        </div>
      )}
      {!d.isSummary && d.tagCount > 0 && (
        <div className="node-hint">{d.tagCount} tags - click to explore</div>
      )}
      {!d.isSummary && d.tagCount === 0 && (
        <div className="node-hint">click to open in VS Code</div>
      )}
      {d.isSummary && (
        <div className="node-hint">click to open in VS Code</div>
      )}
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}
