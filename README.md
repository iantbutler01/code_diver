# Code Diver

Code Diver is a local system-mapping tool for code handoff and review.
It combines `.dive` semantic metadata with static code signals, renders an explorable graph UI, and exposes the same read-only context through MCP.

## Prerequisites

- Rust (`stable`)
- Node.js (for `web/` build)
- If using `asdf`, load shell init before running commands:

```bash
source ~/.zshrc
```

## Build and Run

Install and build frontend:

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

Project root scope:
- Start `code_diver` from the root of the project being analyzed, or pass that root as `PROJECT_PATH`.
- Graph discovery is scoped to that root. Launching from a subdirectory will exclude metadata and source files outside that subtree.
- Metadata discovery expects `.dive/overview.md` and `.dive/modules/*.md` under the selected root.

## Endpoints

- UI: `http://127.0.0.1:4000/`
- Graph JSON: `http://127.0.0.1:4000/api/graph`
- Live updates (SSE): `http://127.0.0.1:4000/api/events`
- Markdown render source: `http://127.0.0.1:4000/api/markdown?path=<project-relative.md>`
- MCP: `http://127.0.0.1:4100/mcp` (or your `--mcp-addr`)

## Current Implementation

- `.dive` parser for overview/modules/file tags, with diagnostics for unparsed lines and duplicate component names.
- Tree-sitter-backed static extraction for Rust, TypeScript, JavaScript, Python, and Go.
- Static relation inference from import and call evidence with weight/confidence scoring.
- Graph transformation pipeline that blends semantic and static relations for rendering policy.
- Read-only MCP surface for overview, group drilldown, module/file context, relationship trace, markdown, and parser diagnostics.

## Dive Format (Consumed by Code Diver)

Overview metadata:
- Location: `.dive/overview.md`
- Sections: `Components`, `Relationships`
- Component entries support patterns like `**Name** - description -> target` or `Name: description -> target`
- Relationship entries are bullet items under `Relationships`

Module metadata:
- Location: `.dive/modules/<module>.md`
- Sections: `Files`, `Relationships`
- File entries support patterns like `` `path/to/file` - description `` or `path/to/file - description`
- Relationship entries are bullet items under `Relationships`

In-source directives:
- `@dive-file:` file-level narrative summary (first occurrence used)
- `@dive-rel:` semantic relationship statement (multiple supported)
- `@dive:` line-level annotation captured with line number
- Directive markers are read from common comment styles (`//`, `#`, `/* */`, `<!-- -->`, etc.)

## Current Limitations

- Not a full compiler-grade program graph.
- Not full symbol resolution across crate/workspace boundaries.
- Not interprocedural control-flow/data-flow analysis.
- Not alias-aware type-driven call resolution.
- Not a perfect “ground truth” of architectural connectivity.

Current connectivity is heuristic:
- Semantic relationships from `.dive` provide intent-level context.
- Static parser evidence (refs/calls/imports) provides observed structure.
- Rendering policy prunes and highlights relations for navigability.

## Planned Work

- Move from file-level inferred edges toward richer symbol-level graph structure.
- Add stronger cross-reference indexing (definitions/references/calls) per language where reliable libraries exist.
- Improve mid-layer blending so semantic hints guide grouping/query planning without hard layer boundaries.
- Add explicit edge evidence and confidence presentation to improve review explainability.

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
