import { useGraphData } from "./graph/useGraphData";
import { useNavigation } from "./nav/useNavigation";
import { Breadcrumb } from "./nav/Breadcrumb";
import { GraphView } from "./graph/GraphView";
import { MarkdownView } from "./markdown/MarkdownView";
import type { ParseDiagnostic } from "./types";

interface DiagnosticsProps {
  diagnostics: ParseDiagnostic[];
}

function DiagnosticsBanner({ diagnostics }: DiagnosticsProps) {
  if (diagnostics.length === 0) return null;

  return (
    <div className="diagnostics-banner">
      <details>
        <summary>
          {diagnostics.length} parser warning{diagnostics.length === 1 ? "" : "s"}
        </summary>
        <div className="diagnostics-list">
          {diagnostics.map((diag, idx) => (
            <div key={`${diag.path}:${diag.scope}:${diag.code}:${idx}`} className="diagnostics-item">
              <div className="diagnostics-line">
                <code>{diag.path}</code>
                {diag.line != null && <span>:{diag.line}</span>}
              </div>
              <div className="diagnostics-meta">
                <strong>{diag.code}</strong> - {diag.message}
              </div>
              <div className="diagnostics-raw">{diag.raw}</div>
              {diag.related.length > 0 && (
                <div className="diagnostics-related">
                  {diag.related.map((item, relIdx) => (
                    <div key={`${idx}:${relIdx}`}>{item}</div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      </details>
    </div>
  );
}

export default function App() {
  const { data, error } = useGraphData();
  const { stack, current, push, goTo } = useNavigation();

  return (
    <div className="app">
      <header className="app-header">
        <h1 className="app-title">Code Diver</h1>
        {data && <span className="app-root">{data.project_root}</span>}
        <span className="app-live" title="Live updating" />
      </header>

      <Breadcrumb stack={stack} onNavigate={goTo} />
      {data && <DiagnosticsBanner diagnostics={data.diagnostics || []} />}

      <div className="graph-canvas">
        {error && <div className="error">{error}</div>}
        {!data && !error && <div className="loading">Loading graph...</div>}
        {data && current.level !== "doc" && (
          <GraphView data={data} nav={current} onNavigate={push} />
        )}
        {data && current.level === "doc" && current.id && (
          <MarkdownView key={current.id} path={current.id} />
        )}
      </div>
    </div>
  );
}
