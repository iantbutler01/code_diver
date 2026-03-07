import type { GraphData, MarkdownDoc } from "./types";

const API_BASE = "/api";
const GRAPH_FETCH_TIMEOUT_MS = 15000;

export async function fetchGraph(): Promise<GraphData> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), GRAPH_FETCH_TIMEOUT_MS);

  const r = await fetch(`${API_BASE}/graph`, { signal: controller.signal }).finally(() => {
    window.clearTimeout(timeout);
  });
  if (!r.ok) throw new Error(`Graph fetch failed: ${r.status}`);
  return r.json();
}

export async function fetchMarkdown(path: string): Promise<MarkdownDoc> {
  const query = new URLSearchParams({ path }).toString();
  const response = await fetch(`${API_BASE}/markdown?${query}`);
  if (!response.ok) {
    throw new Error(`Markdown fetch failed: ${response.status}`);
  }
  return response.json();
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
