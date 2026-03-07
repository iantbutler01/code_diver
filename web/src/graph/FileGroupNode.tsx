import { Handle, Position } from "@xyflow/react";
import type { NodeProps } from "@xyflow/react";
import type { MouseEvent } from "react";
import { openInVscode } from "../api";
import { CopyButton } from "./CopyButton";

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
  absPath?: string;
  concepts: Concept[];
  diveFile: string;
  diveRels: string[];
  tags: Tag[];
  tagCount: number;
  isSummary?: boolean;
  collapsedCount?: number;
  collapsedNames?: string[];
  parentGroupId?: string | null;
  parentTotalComponents?: number | null;
  isLeaf?: boolean;
  hasNameCollision?: boolean;
}

export function FileGroupNode({ data }: NodeProps) {
  const d = data as unknown as FileGroupData;
  const fileName = d.path.split("/").pop() || d.path;
  const hasCollapseInfo = (d.collapsedCount || 0) > 1;
  const parentScope =
    d.parentGroupId && d.parentTotalComponents
      ? `${d.collapsedCount} of ${d.parentTotalComponents} in ${d.parentGroupId}`
      : null;

  const onTagClick = (line: number) => (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    if (d.absPath) openInVscode(d.absPath, line);
  };

  const copyText = [
    `File Group: ${fileName}`,
    `Path: ${d.path}`,
    d.collapsedCount ? `Collapsed components: ${d.collapsedCount}` : null,
    d.parentGroupId && d.parentTotalComponents
      ? `Coverage: ${d.collapsedCount} of ${d.parentTotalComponents} in ${d.parentGroupId}`
      : null,
    d.diveFile ? `Dive file: ${d.diveFile}` : null,
    d.concepts.length > 0 ? "Concepts:" : null,
    ...d.concepts.map((c) => `- ${c.name}${c.description ? `: ${c.description}` : ""}`),
    d.diveRels.length > 0 ? "Relations:" : null,
    ...d.diveRels.map((rel) => `- ${rel}`),
    d.tags.length > 0 ? "Tags:" : null,
    ...d.tags.map((tag) => `- L${tag.line}: ${tag.description}`),
  ]
    .filter(Boolean)
    .join("\n");

  return (
    <div className="node node-file-group">
      <Handle type="target" position={Position.Top} />
      <div className="node-header">
        <div className="node-title">{fileName}</div>
        <CopyButton text={copyText} />
      </div>
      <div className="node-path">{d.path}</div>
      {d.hasNameCollision && (
        <div className="node-badge">name collision</div>
      )}
      {hasCollapseInfo && (
        <div className="node-collapse-meta">
          Collapsed {d.collapsedCount} components into this target.
          {parentScope && <div>{parentScope}</div>}
        </div>
      )}
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
            <button
              key={t.line}
              type="button"
              className="node-tag-item node-tag-item-button"
              onClick={onTagClick(t.line)}
            >
              <span className="node-tag-line">L{t.line}</span>
              <span className="node-tag-text">{t.description}</span>
            </button>
          ))}
        </div>
      )}
      {!d.isSummary && d.isLeaf && d.tagCount > 0 && (
        <div className="node-hint">
          click card to open file, or click a tag row for exact line
        </div>
      )}
      {!d.isSummary && !d.isLeaf && d.tagCount > 0 && (
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
