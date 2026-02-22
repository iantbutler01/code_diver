import { useGraphData } from "./graph/useGraphData";
import { useNavigation } from "./nav/useNavigation";
import { Breadcrumb } from "./nav/Breadcrumb";
import { GraphView } from "./graph/GraphView";

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

      <div className="graph-canvas">
        {error && <div className="error">{error}</div>}
        {!data && !error && <div className="loading">Loading graph...</div>}
        {data && <GraphView data={data} nav={current} onNavigate={push} />}
      </div>
    </div>
  );
}
