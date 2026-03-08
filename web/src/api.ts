import type { DiffBaseline, DiffResponse, GraphData, MarkdownDoc } from "./types";

const API_BASE = "/api";
const GRAPH_FETCH_TIMEOUT_MS = 15000;

async function fetchJson<T>(url: string, init: RequestInit, errorPrefix: string): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    throw new Error(`${errorPrefix}: ${response.status}`);
  }
  return response.json() as Promise<T>;
}

export async function fetchGraph(): Promise<GraphData> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), GRAPH_FETCH_TIMEOUT_MS);

  try {
    return await fetchJson<GraphData>(
      `${API_BASE}/graph`,
      { signal: controller.signal },
      "Graph fetch failed"
    );
  } finally {
    window.clearTimeout(timeout);
  }
}

export async function fetchMarkdown(path: string): Promise<MarkdownDoc> {
  const query = new URLSearchParams({ path }).toString();
  return fetchJson<MarkdownDoc>(
    `${API_BASE}/markdown?${query}`,
    {},
    "Markdown fetch failed"
  );
}

export async function fetchDiff(
  paths: string[],
  baseline: DiffBaseline = "head_worktree"
): Promise<DiffResponse> {
  return fetchJson<DiffResponse>(
    `${API_BASE}/diff`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        paths,
        baseline,
      }),
    },
    "Diff fetch failed"
  );
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
