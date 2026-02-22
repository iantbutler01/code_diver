import type { GraphData } from "./types";

const API_BASE = "/api";

export async function fetchGraph(): Promise<GraphData> {
  const r = await fetch(`${API_BASE}/graph`);
  if (!r.ok) throw new Error(`Graph fetch failed: ${r.status}`);
  return r.json();
}

export function subscribeToUpdates(onUpdate: () => void): () => void {
  const es = new EventSource(`${API_BASE}/events`);
  es.addEventListener("graph-updated", () => onUpdate());
  es.onerror = () => console.warn("SSE interrupted, auto-reconnecting...");
  return () => es.close();
}

export function openInVscode(absPath: string, line: number) {
  const encoded = absPath
    .replace(/\\/g, "/")
    .split("/")
    .map((s) => encodeURIComponent(s))
    .join("/");
  window.location.href = `vscode://file/${encoded}:${line}:1`;
}
