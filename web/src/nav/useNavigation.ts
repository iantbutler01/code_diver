import { useState, useCallback } from "react";
import type { NavEntry } from "../types";

const ROOT: NavEntry = { level: "system", label: "System" };

export function useNavigation() {
  const [stack, setStack] = useState<NavEntry[]>([ROOT]);

  const current = stack[stack.length - 1];

  const push = useCallback((entry: NavEntry) => {
    setStack((s) => [...s, entry]);
  }, []);

  const goTo = useCallback((index: number) => {
    setStack((s) => s.slice(0, index + 1));
  }, []);

  const goHome = useCallback(() => {
    setStack([ROOT]);
  }, []);

  return { stack, current, push, goTo, goHome };
}
