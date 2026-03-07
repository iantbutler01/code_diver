export const graphColors = {
  grid: "var(--color-grid)",
  minimapBackground: "var(--color-minimap-bg)",
  nodeGroup: "var(--color-node-group)",
  nodeFileGroup: "var(--color-node-file-group)",
  nodeComponent: "var(--color-node-component)",
  nodeFile: "var(--color-node-file)",
  nodeTag: "var(--color-node-tag)",
  nodeFallback: "var(--color-node-fallback)",
  edgeStructure: "var(--color-edge-structure)",
  edgeFocusStructure: "var(--color-edge-focus-structure)",
  edgeRelationship: "var(--color-edge-relationship)",
  edgeFocusRelationship: "var(--color-edge-focus-relationship)",
  edgeStatic: "var(--color-edge-static)",
  edgeFocusStatic: "var(--color-edge-focus-static)",
  edgeBlended: "var(--color-edge-blended)",
  edgeFocusBlended: "var(--color-edge-focus-blended)",
  edgeAmbiguous: "var(--color-edge-ambiguous)",
} as const;

export function minimapNodeColor(nodeType: string | undefined): string {
  if (nodeType === "group") return graphColors.nodeGroup;
  if (nodeType === "filegroup") return graphColors.nodeFileGroup;
  if (nodeType === "component") return graphColors.nodeComponent;
  if (nodeType === "file") return graphColors.nodeFile;
  if (nodeType === "tag") return graphColors.nodeTag;
  return graphColors.nodeFallback;
}
