# Code Diver

Code Diver is a local system-mapping tool for handoff and review. It combines `.dive` semantic metadata with static code signals, renders an explorable graph UI, and exposes the same read-only context through MCP.

https://github.com/user-attachments/assets/4f45a9e3-6665-4909-a4ce-a684846be460

## Prerequisites

Rust (`stable`) and Node.js.

## Quick Start

From the Code Diver checkout:

```bash
npm --prefix web install
npm --prefix web run build
cargo run -- <your-project-path> --port 4000 --mcp-addr 127.0.0.1:4100
```

Graph discovery is scoped to the selected root. If you point Code Diver at a subdirectory, files and metadata outside that subtree are excluded. `.dive` metadata is optional; when present, Code Diver looks for `.dive/overview.md` and `.dive/modules/*.md` under the chosen root. Without `.dive`, the static graph still renders, but semantic groups, file narratives, and relationship context will be sparse or absent.

## Endpoints

UI: `http://127.0.0.1:4000/`  
Graph JSON: `http://127.0.0.1:4000/api/graph`  
Live updates (SSE): `http://127.0.0.1:4000/api/events`  
Markdown source: `http://127.0.0.1:4000/api/markdown?path=<project-relative.md>`  
MCP: `http://127.0.0.1:4100/mcp` (or your `--mcp-addr`)

## Current Implementation

Code Diver currently ships a permissive `.dive` parser (with diagnostics), tree-sitter-backed static extraction (Rust, TypeScript, JavaScript, Python, Go), inferred static edges from imports/calls, a graph transform that blends semantic + static relations, and a read-only MCP surface for overview, group drilldown, module context, indexed `.dive` file context, relationship trace, markdown, and diagnostics.

## Dive Format (Consumed by Code Diver)

`overview.md` lives at `.dive/overview.md` and contains `Components` and `Relationships`.  
Module files live at `.dive/modules/<module>.md` and contain `Files` and `Relationships`.

In source files, the parser consumes:
- `@dive-file:` file narrative summary (first occurrence used)
- `@dive-rel:` semantic relationship statement (multiple supported)
- `@dive:` line-level annotation captured with line number

## Current Limitations

This is not a compiler-grade program graph. Cross-workspace symbol resolution, interprocedural control/data-flow, and full type-aware call resolution are not implemented. Connectivity is heuristic by design: `.dive` expresses intent, static parsing contributes observed structure, and rendering policy prunes for navigability.

## Planned Work

Next steps are richer symbol-level graph construction, stronger per-language xref indexing, better semantic/static blending in mid-level views, and clearer edge evidence/confidence presentation.

## LLM Skills

`skills/dive-tag/SKILL.md` is a standard `SKILL.md` definition and can be used by agent harnesses that support this format.

## Useful Commands

```bash
cargo check
npm --prefix web run lint
npm --prefix web run build
```
