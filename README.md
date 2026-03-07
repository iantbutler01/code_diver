# Code Diver

Code Diver is a local system-mapping tool for code handoff and review.  
It blends `.dive` semantic metadata with static code signals, then renders an explorable graph and exposes the same context through MCP.

## Prerequisites

- Rust (`rust stable`; typically via `asdf`)
- Node.js (for `web/` build)

If you use `asdf`, run through shell init so shims resolve:

```bash
source ~/.zshrc
```

## Run

Build frontend:

```bash
source ~/.zshrc
ASDF_NODEJS_VERSION=24.13.1 npm --prefix web install
ASDF_NODEJS_VERSION=24.13.1 npm --prefix web run build
```

Start server:

```bash
source ~/.zshrc
cargo run -- --port 4000 --mcp-addr 127.0.0.1:4100
```

Optional project path (default is current directory):

```bash
cargo run -- /path/to/project --port 4000 --mcp-addr 127.0.0.1:4100
```

## Endpoints

- UI: `http://127.0.0.1:4000/`
- Graph JSON: `http://127.0.0.1:4000/api/graph`
- Live updates (SSE): `http://127.0.0.1:4000/api/events`
- Markdown render source: `http://127.0.0.1:4000/api/markdown?path=<project-relative.md>`
- MCP: `http://127.0.0.1:4100/mcp` (or your `--mcp-addr`)

## What Exists Today

- `.dive` parser for overview/modules/file tags + diagnostics for unparsed lines/duplicates.
- Tree-sitter-backed static extraction for Rust/TypeScript/JavaScript/Python/Go.
- Static edges from import/call evidence with confidence/weight scoring.
- Graph transform that blends static and semantic edges for display policy.
- Read-only MCP tools for overview, group drilldown, module/file context, relationship trace, markdown, and parser diagnostics.

## What This Is Not (Yet)

- Not a full compiler-grade program graph.
- Not full symbol resolution across crate/workspace boundaries.
- Not interprocedural control-flow/data-flow analysis.
- Not alias-aware type-driven call resolution.
- Not a perfect “ground truth” of architectural connectivity.

Current graph connectivity is an informed heuristic blend:
- semantic relationships from `.dive` (the stated “why”)
- static evidence from parser-derived refs/calls/imports (the observed “what”)
- layout/display policies to keep it explorable

## Code Analysis: Already Done vs Next Steps

What is already implemented:
- Added real parser libraries (Tree-sitter language grammars) instead of regex-only extraction.
- Added static-analysis payload into the API and frontend graph policy path.
- Kept `.dive` format untouched and merged it as guidance/hints rather than replacing it.

Next steps:
- Move from file-level inferred edges toward richer graph structure (symbol-level and relation-type aware).
- Add stronger cross-reference indexing (definitions/references/calls) per language where reliable libraries exist.
- Improve mid-layer blending logic so semantic hints shape query planning and grouping without hard layer boundaries.
- Add better confidence/explainability on each displayed edge so reviewers can see why two nodes are connected.

## LLM Skills

- Skill definition: `skills/dive-tag/SKILL.md`
- Format: standard `SKILL.md`
- Compatible with agent harnesses that support `SKILL.md`-style skills

## Useful Commands

```bash
source ~/.zshrc && cargo check
source ~/.zshrc && ASDF_NODEJS_VERSION=24.13.1 npm --prefix web run lint
source ~/.zshrc && ASDF_NODEJS_VERSION=24.13.1 npm --prefix web run build
```
