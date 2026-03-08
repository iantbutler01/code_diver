import { Handle, Position } from "@xyflow/react";
import type { NodeProps } from "@xyflow/react";
import { CopyButton } from "./CopyButton";

interface GroupData {
  name: string;
  count: number;
  children: string[];
  folderHints?: string[];
  isSummary?: boolean;
  nonNavigable?: boolean;
  hasNameCollision?: boolean;
  relIn?: number;
  relOut?: number;
  relTotal?: number;
  relRole?: "entry" | "sink" | "hub" | "isolated" | "flow";
}

function roleLabel(role: GroupData["relRole"]): string {
  if (role === "entry") return "entry";
  if (role === "sink") return "sink";
  if (role === "hub") return "hub";
  if (role === "isolated") return "isolated";
  return "flow";
}

export function GroupNode({ data }: NodeProps) {
  const d = data as unknown as GroupData;
  const title = d.name.endsWith("/") ? d.name : `${d.name}/`;
  const copyText = [
    `Group: ${title}`,
    `Components: ${d.count}`,
    d.folderHints?.length ? `Folder hints: ${d.folderHints.join(", ")}` : null,
    typeof d.relIn === "number" ? `Xrefs in: ${d.relIn}` : null,
    typeof d.relOut === "number" ? `Xrefs out: ${d.relOut}` : null,
    d.relRole ? `Flow role: ${roleLabel(d.relRole)}` : null,
    "Children:",
    ...d.children.map((child) => `- ${child}`),
  ]
    .filter(Boolean)
    .join("\n");

  return (
    <div className={`node node-group ${d.isSummary ? "node-group-summary" : ""} ${d.nonNavigable ? "node-group-anchor" : ""}`}>
      <Handle type="target" position={Position.Top} />
      <div className="node-header">
        <div className="node-group-title">{title}</div>
        <CopyButton text={copyText} />
      </div>
      <div className="node-group-count">{d.count} components</div>
      {typeof d.relIn === "number" && typeof d.relOut === "number" && (
        <div className="node-xrefs">
          <span className="node-xref-chip">in {d.relIn}</span>
          <span className="node-xref-chip">out {d.relOut}</span>
          <span className={`node-xref-role node-xref-role-${d.relRole || "flow"}`}>
            {roleLabel(d.relRole)}
          </span>
        </div>
      )}
      {d.folderHints && d.folderHints.length > 0 && (
        <div className="node-group-hints">
          {d.folderHints.map((hint) => (
            <span key={hint} className="node-group-hint-chip">
              {hint}
            </span>
          ))}
        </div>
      )}
      {d.hasNameCollision && (
        <div className="node-badge">name collision</div>
      )}
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
      {!d.nonNavigable && <div className="node-hint">click to explore</div>}
      {d.nonNavigable && <div className="node-hint">context anchor (not clickable)</div>}
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}
