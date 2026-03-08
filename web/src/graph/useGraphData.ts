import { useEffect, useState, useCallback } from "react";
import type { GraphData } from "../types";
import { fetchGraph, subscribeToUpdates } from "../api";

function normalizeGraph(raw: GraphData): GraphData {
  return {
    ...raw,
    static_analysis: raw.static_analysis || {
      files_analyzed: 0,
      file_facts: [],
      edges: [],
      truncated: false,
    },
    coverage: raw.coverage || {
      static_files: 0,
      represented_files: 0,
      missing_files: 0,
      represented_pct: 0,
      group_coverage: [],
    },
    diagnostics: raw.diagnostics || [],
    git_status: raw.git_status || {},
  };
}

export function useGraphData() {
  const [data, setData] = useState<GraphData | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const g = await fetchGraph();
      setData(normalizeGraph(g));
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void load();
    }, 0);
    const unsub = subscribeToUpdates(load);
    return () => {
      window.clearTimeout(timer);
      unsub();
    };
  }, [load]);

  return { data, error, reload: load };
}
