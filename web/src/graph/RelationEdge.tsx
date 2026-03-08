import { BaseEdge, EdgeLabelRenderer, getSmoothStepPath, type EdgeProps } from "@xyflow/react";

interface RelationEdgeData {
  parallelCentered?: number;
  collapsedLabels?: string[];
  collapsedEdgeCount?: number;
}

export function RelationEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  markerEnd,
  markerStart,
  style,
  label,
  interactionWidth,
  data,
}: EdgeProps) {
  const edgeData = (data as RelationEdgeData | undefined) || {};
  const centered = typeof edgeData.parallelCentered === "number"
    ? edgeData.parallelCentered
    : 0;
  const useCurvedLane =
    Math.abs(centered) > 0.001 && (sourceX !== targetX || sourceY !== targetY);

  let edgePath = "";
  let labelX = (sourceX + targetX) / 2;
  let labelY = (sourceY + targetY) / 2;

  if (useCurvedLane) {
    const dx = targetX - sourceX;
    const dy = targetY - sourceY;
    const length = Math.hypot(dx, dy) || 1;
    const nx = -dy / length;
    const ny = dx / length;
    const laneMagnitude = centered * 28;
    const cx = (sourceX + targetX) / 2 + nx * laneMagnitude;
    const cy = (sourceY + targetY) / 2 + ny * laneMagnitude;

    edgePath = `M ${sourceX},${sourceY} Q ${cx},${cy} ${targetX},${targetY}`;
    labelX = 0.25 * sourceX + 0.5 * cx + 0.25 * targetX;
    labelY = 0.25 * sourceY + 0.5 * cy + 0.25 * targetY;
  } else {
    const [path, lx, ly] = getSmoothStepPath({
      sourceX,
      sourceY,
      sourcePosition,
      targetX,
      targetY,
      targetPosition,
      borderRadius: 10,
      offset: 24,
    });
    edgePath = path;
    labelX = lx;
    labelY = ly;
  }

  const labels = (() => {
    const fromData = Array.isArray(edgeData.collapsedLabels)
      ? edgeData.collapsedLabels
          .map((item) => (typeof item === "string" ? item.trim() : ""))
          .filter(Boolean)
      : [];
    if (fromData.length > 0) return fromData;
    const raw = typeof label === "string" ? label.trim() : "";
    return raw ? [raw] : [];
  })();

  const labelOffsetY = centered * 9;

  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        markerEnd={markerEnd}
        markerStart={markerStart}
        style={style}
        interactionWidth={interactionWidth}
      />
      {labels.length > 0 && (
        <EdgeLabelRenderer>
          <div
            className="edge-meta-label"
            style={{
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY + labelOffsetY}px)`,
            }}
          >
            {labels.map((item, idx) => (
              <div key={`${id}:${idx}`} className="edge-meta-label-item">
                {item}
              </div>
            ))}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}
