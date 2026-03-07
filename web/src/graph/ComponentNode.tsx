import { Handle, Position } from "@xyflow/react";
import type { NodeProps } from "@xyflow/react";
import { CopyButton } from "./CopyButton";

interface ComponentData {
  name: string;
  description: string;
  target: string | null;
  hasChildren: boolean;
  hasNameCollision?: boolean;
  relIn?: number;
  relOut?: number;
  relTotal?: number;
  relRole?: "entry" | "sink" | "hub" | "isolated" | "flow";
}

function roleLabel(role: ComponentData["relRole"]): string {
  if (role === "entry") return "entry";
  if (role === "sink") return "sink";
  if (role === "hub") return "hub";
  if (role === "isolated") return "isolated";
  return "flow";
}

export function ComponentNode({ data }: NodeProps) {
  const d = data as unknown as ComponentData;
  const copyText = [
    `Component: ${d.name}`,
    d.target ? `Target: ${d.target}` : null,
    d.description ? `Description: ${d.description}` : null,
    d.hasChildren ? "Has children: true" : "Has children: false",
    typeof d.relIn === "number" ? `Xrefs in: ${d.relIn}` : null,
    typeof d.relOut === "number" ? `Xrefs out: ${d.relOut}` : null,
    d.relRole ? `Flow role: ${roleLabel(d.relRole)}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  return (
    <div className="node node-component">
      <Handle type="target" position={Position.Top} />
      <div className="node-header">
        <div className="node-title">{d.name}</div>
        <CopyButton text={copyText} />
      </div>
      {d.hasNameCollision && (
        <div className="node-badge">name collision</div>
      )}
      {typeof d.relIn === "number" && typeof d.relOut === "number" && (
        <div className="node-xrefs">
          <span className="node-xref-chip">in {d.relIn}</span>
          <span className="node-xref-chip">out {d.relOut}</span>
          <span className={`node-xref-role node-xref-role-${d.relRole || "flow"}`}>
            {roleLabel(d.relRole)}
          </span>
        </div>
      )}
      {d.description && <div className="node-desc">{d.description}</div>}
      {d.target && <div className="node-path">{d.target}</div>}
      {d.hasChildren && <div className="node-hint">click to explore</div>}
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}
