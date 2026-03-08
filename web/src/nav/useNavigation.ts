import { useState, useCallback } from "react";
import type { NavEntry } from "../types";

const ROOT: NavEntry = { level: "system", label: "System" };

function sameTarget(a: NavEntry, b: NavEntry): boolean {
  if (a.level !== b.level) return false;
  if ((a.id || "") !== (b.id || "")) return false;
  if (a.level === "system" && !a.id && !b.id) return true;
  return true;
}

export function useNavigation() {
  const [stack, setStack] = useState<NavEntry[]>([ROOT]);

  const current = stack[stack.length - 1];

  const push = useCallback((entry: NavEntry) => {
    setStack((s) => {
      const last = s[s.length - 1];
      if (last && sameTarget(last, entry)) return s;

      const existingIndex = s.findIndex((item) => sameTarget(item, entry));
      if (existingIndex >= 0) {
        return s.slice(0, existingIndex + 1);
      }

      return [...s, entry];
    });
  }, []);

  const goTo = useCallback((index: number) => {
    setStack((s) => s.slice(0, index + 1));
  }, []);

  const goHome = useCallback(() => {
    setStack([ROOT]);
  }, []);

  return { stack, current, push, goTo, goHome };
}
