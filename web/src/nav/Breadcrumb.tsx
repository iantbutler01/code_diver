import type { NavEntry } from "../types";

interface Props {
  stack: NavEntry[];
  onNavigate: (index: number) => void;
}

export function Breadcrumb({ stack, onNavigate }: Props) {
  return (
    <nav className="breadcrumb">
      {stack.map((entry, i) => (
        <span key={i}>
          {i > 0 && <span className="crumb-sep">/</span>}
          {i < stack.length - 1 ? (
            <button className="crumb" onClick={() => onNavigate(i)}>
              {entry.label}
            </button>
          ) : (
            <span className="crumb crumb-current">{entry.label}</span>
          )}
        </span>
      ))}
    </nav>
  );
}
