import { useEffect, useState, useCallback } from "react";
import type { GraphData } from "../types";
import { fetchGraph, subscribeToUpdates } from "../api";

export function useGraphData() {
  const [data, setData] = useState<GraphData | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const g = await fetchGraph();
      setData(g);
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    load();
    const unsub = subscribeToUpdates(load);
    return unsub;
  }, [load]);

  return { data, error, reload: load };
}
