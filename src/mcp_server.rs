use crate::parser::{
    ComponentEntry, FileDiveDoc, GraphData, GroupCoverage, ModuleDoc, ParseDiagnostic,
};
use reson_mcp::server::{McpServer, ServerTransport};
use reson_mcp::{CallToolResult, Content};
use serde_json::{Map, Value, json};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::sync::RwLock;

const MAX_MARKDOWN_BYTES: u64 = 2_000_000;
const DEFAULT_MAX_CHARS: usize = 24_000;

const TEST_SEGMENTS: &[&str] = &[
    "test",
    "tests",
    "__tests__",
    "e2e",
    "integration",
    "unit",
    "bench",
    "benches",
];
const SPEC_SEGMENTS: &[&str] = &["spec", "specs"];
const SCRIPT_SEGMENTS: &[&str] = &["script", "scripts", "bin", "tools", "tooling", "hack"];
const DOC_SEGMENTS: &[&str] = &[
    "doc",
    "docs",
    "example",
    "examples",
    "sample",
    "samples",
    "demo",
    "demos",
    "tutorial",
    "tutorials",
];
const CONFIG_SEGMENTS: &[&str] = &[
    "config",
    "configs",
    ".github",
    "github",
    "ci",
    ".circleci",
    ".gitlab",
    "infra",
    "deploy",
    "deployment",
];

#[derive(Debug, Clone)]
struct ParsedRelationship {
    src: String,
    tgt: String,
    label: String,
    raw: String,
    scope: String,
}

#[derive(Debug, Clone)]
struct GroupSummary {
    label: String,
    count: usize,
    samples: Vec<String>,
}

pub fn spawn_mcp_server(addr: String, project_root: PathBuf, graph: Arc<RwLock<GraphData>>) {
    tokio::spawn(async move {
        let server = build_server(project_root, graph);
        eprintln!("MCP server running at http://{addr}/mcp");
        if let Err(err) = server.serve(ServerTransport::Http(addr.clone())).await {
            eprintln!("MCP server failed on {addr}: {err:#}");
        }
    });
}

fn build_server(project_root: PathBuf, graph: Arc<RwLock<GraphData>>) -> McpServer {
    let graph_for_overview = graph.clone();
    let graph_for_group = graph.clone();
    let graph_for_module = graph.clone();
    let graph_for_file = graph.clone();
    let graph_for_trace = graph.clone();
    let graph_for_diagnostics = graph.clone();
    let graph_for_markdown = graph.clone();
    let project_root_for_markdown = project_root.clone();

    McpServer::builder("code-diver-review")
        .with_version(env!("CARGO_PKG_VERSION"))
        .with_description(
            "Read-only project review MCP server backed by Code Diver graph + markdown context",
        )
        .with_tool(
            "code_graph_overview",
            "Get high-level graph counts and semantic groups",
            json!({
                "type": "object",
                "properties": {
                    "max_groups": { "type": "integer", "minimum": 1, "maximum": 200, "default": 20 },
                    "sample_per_group": { "type": "integer", "minimum": 0, "maximum": 20, "default": 5 }
                }
            }),
            move |_name, args| {
                let graph = graph_for_overview.clone();
                Box::pin(async move {
                    let args = args.unwrap_or_default();
                    let max_groups = get_usize_arg(&args, "max_groups", 20, 1, 200);
                    let sample_per_group = get_usize_arg(&args, "sample_per_group", 5, 0, 20);

                    let graph = graph.read().await;
                    let groups = summarize_groups(
                        graph.overview
                            .as_ref()
                            .map(|o| o.components.as_slice())
                            .unwrap_or(&[]),
                        max_groups,
                        sample_per_group,
                    );

                    Ok(CallToolResult::structured(json!({
                        "project_root": graph.project_root,
                        "generated_at": graph.generated_at,
                        "counts": {
                            "components": graph.overview.as_ref().map(|o| o.components.len()).unwrap_or(0),
                            "relationships": graph.overview.as_ref().map(|o| o.relationships.len()).unwrap_or(0),
                            "modules": graph.modules.len(),
                            "files": graph.files.len(),
                            "diagnostics": graph.diagnostics.len()
                        },
                        "coverage": graph_coverage_json(&graph),
                        "groups": groups
                    })))
                })
            },
        )
        .with_tool(
            "code_group_drilldown",
            "Get components/relationships for one semantic group (tests/specs/scripts/docs/config/path:<dir>)",
            json!({
                "type": "object",
                "properties": {
                    "group_id": { "type": "string", "description": "semantic:tests | semantic:specs | semantic:scripts | semantic:docs | semantic:config | path:<dir> | other" },
                    "max_components": { "type": "integer", "minimum": 1, "maximum": 500, "default": 200 },
                    "max_relationships": { "type": "integer", "minimum": 1, "maximum": 500, "default": 120 }
                },
                "required": ["group_id"]
            }),
            move |_name, args| {
                let graph = graph_for_group.clone();
                Box::pin(async move {
                    let args = args.unwrap_or_default();
                    let Some(group_id) = get_string_arg(&args, "group_id") else {
                        return Ok(tool_error("Missing required argument: group_id"));
                    };
                    let max_components = get_usize_arg(&args, "max_components", 200, 1, 500);
                    let max_relationships = get_usize_arg(&args, "max_relationships", 120, 1, 500);

                    let graph = graph.read().await;
                    let Some(overview) = graph.overview.as_ref() else {
                        return Ok(tool_error("No overview metadata available"));
                    };

                    let matched_components: Vec<&ComponentEntry> = overview
                        .components
                        .iter()
                        .filter(|component| group_matches(component.target.as_deref(), &group_id))
                        .collect();

                    let component_name_norms: HashSet<String> = matched_components
                        .iter()
                        .map(|component| normalize_name(&component.name))
                        .collect();

                    let relationships: Vec<ParsedRelationship> = overview
                        .relationships
                        .iter()
                        .filter_map(|raw| parse_relationship_line(raw, "overview"))
                        .filter(|rel| {
                            component_name_norms.contains(&normalize_name(&rel.src))
                                || component_name_norms.contains(&normalize_name(&rel.tgt))
                        })
                        .take(max_relationships)
                        .collect();
                    let group_coverage = graph
                        .coverage
                        .group_coverage
                        .iter()
                        .find(|item| item.group_id == group_id)
                        .map(group_coverage_json)
                        .unwrap_or_else(|| {
                            json!({
                                "group_id": group_id,
                                "static_files": 0,
                                "represented_files": 0,
                                "missing_files": 0,
                                "represented_pct": 0.0
                            })
                        });

                    Ok(CallToolResult::structured(json!({
                        "group_id": group_id,
                        "group_label": group_label_from_id(&group_id),
                        "coverage": group_coverage,
                        "component_count": matched_components.len(),
                        "components": matched_components
                            .iter()
                            .take(max_components)
                            .map(|component| json!({
                                "name": component.name,
                                "description": component.description,
                                "target": component.target
                            }))
                            .collect::<Vec<_>>(),
                        "relationship_count": relationships.len(),
                        "relationships": relationships
                            .into_iter()
                            .map(|rel| json!({
                                "source": rel.src,
                                "target": rel.tgt,
                                "label": rel.label,
                                "raw": rel.raw
                            }))
                            .collect::<Vec<_>>(),
                        "available_groups": summarize_groups(overview.components.as_slice(), 30, 0)
                    })))
                })
            },
        )
        .with_tool(
            "code_module_context",
            "Get module metadata, file list, and module-level relationships",
            json!({
                "type": "object",
                "properties": {
                    "module_id": { "type": "string", "description": "Module name or title" },
                    "max_files": { "type": "integer", "minimum": 1, "maximum": 1000, "default": 200 },
                    "max_relationships": { "type": "integer", "minimum": 1, "maximum": 500, "default": 200 }
                },
                "required": ["module_id"]
            }),
            move |_name, args| {
                let graph = graph_for_module.clone();
                Box::pin(async move {
                    let args = args.unwrap_or_default();
                    let Some(module_id) = get_string_arg(&args, "module_id") else {
                        return Ok(tool_error("Missing required argument: module_id"));
                    };
                    let max_files = get_usize_arg(&args, "max_files", 200, 1, 1000);
                    let max_relationships = get_usize_arg(&args, "max_relationships", 200, 1, 500);

                    let graph = graph.read().await;
                    let Some(module) = find_module(&graph, &module_id) else {
                        return Ok(tool_error(format!("Module not found: {module_id}")));
                    };

                    Ok(CallToolResult::structured(json!({
                        "module": {
                            "name": module.name,
                            "title": module.title,
                            "path": module.path,
                            "description": module.description,
                        },
                        "coverage": graph_coverage_json(&graph),
                        "file_count": module.files.len(),
                        "files": module.files.iter().take(max_files).map(|file| json!({
                            "path": file.path,
                            "description": file.description
                        })).collect::<Vec<_>>(),
                        "relationship_count": module.relationships.len(),
                        "relationships": module.relationships.iter().take(max_relationships).collect::<Vec<_>>()
                    })))
                })
            },
        )
        .with_tool(
            "code_file_context",
            "Get @dive metadata for one file path",
            json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "File path (relative preferred)" },
                    "max_tags": { "type": "integer", "minimum": 1, "maximum": 2000, "default": 400 },
                    "max_relationships": { "type": "integer", "minimum": 1, "maximum": 500, "default": 200 }
                },
                "required": ["path"]
            }),
            move |_name, args| {
                let graph = graph_for_file.clone();
                Box::pin(async move {
                    let args = args.unwrap_or_default();
                    let Some(path) = get_string_arg(&args, "path") else {
                        return Ok(tool_error("Missing required argument: path"));
                    };
                    let max_tags = get_usize_arg(&args, "max_tags", 400, 1, 2000);
                    let max_relationships = get_usize_arg(&args, "max_relationships", 200, 1, 500);

                    let graph = graph.read().await;
                    let Some(file) = find_file(&graph, &path) else {
                        return Ok(tool_error(format!(
                            "File not found in indexed dive data: {path}"
                        )));
                    };

                    Ok(CallToolResult::structured(json!({
                        "path": file.path,
                        "abs_path": file.abs_path,
                        "is_markdown": is_markdown_path(Path::new(&file.path)),
                        "dive_file": file.dive_file,
                        "dive_rel_count": file.dive_rel.len(),
                        "dive_rel": file.dive_rel.iter().take(max_relationships).collect::<Vec<_>>(),
                        "tag_count": file.tags.len(),
                        "tags": file.tags.iter().take(max_tags).map(|tag| json!({
                            "line": tag.line,
                            "description": tag.description
                        })).collect::<Vec<_>>()
                    })))
                })
            },
        )
        .with_tool(
            "code_markdown",
            "Read markdown content from the project (specs/docs/module maps)",
            json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "Project-relative markdown path" },
                    "max_chars": { "type": "integer", "minimum": 1000, "maximum": 200000, "default": 24000 }
                },
                "required": ["path"]
            }),
            move |_name, args| {
                let graph = graph_for_markdown.clone();
                let project_root = project_root_for_markdown.clone();
                Box::pin(async move {
                    let args = args.unwrap_or_default();
                    let Some(path) = get_string_arg(&args, "path") else {
                        return Ok(tool_error("Missing required argument: path"));
                    };
                    let max_chars = get_usize_arg(&args, "max_chars", DEFAULT_MAX_CHARS, 1_000, 200_000);

                    let _graph_guard = graph.read().await;

                    let (resolved_path, mut content) = match read_markdown_file(&project_root, &path) {
                        Ok(result) => result,
                        Err(err) => return Ok(tool_error(err)),
                    };

                    let mut truncated = false;
                    if content.chars().count() > max_chars {
                        content = content.chars().take(max_chars).collect::<String>();
                        truncated = true;
                    }

                    Ok(CallToolResult::structured(json!({
                        "path": resolved_path,
                        "truncated": truncated,
                        "max_chars": max_chars,
                        "content": content
                    })))
                })
            },
        )
        .with_tool(
            "code_relationship_trace",
            "Trace relationships around a node name through overview/module relationship graph",
            json!({
                "type": "object",
                "properties": {
                    "node": { "type": "string", "description": "Component/module/file concept name" },
                    "hops": { "type": "integer", "minimum": 1, "maximum": 3, "default": 1 },
                    "max_edges": { "type": "integer", "minimum": 1, "maximum": 1000, "default": 120 }
                },
                "required": ["node"]
            }),
            move |_name, args| {
                let graph = graph_for_trace.clone();
                Box::pin(async move {
                    let args = args.unwrap_or_default();
                    let Some(node_query) = get_string_arg(&args, "node") else {
                        return Ok(tool_error("Missing required argument: node"));
                    };
                    let hops = get_usize_arg(&args, "hops", 1, 1, 3);
                    let max_edges = get_usize_arg(&args, "max_edges", 120, 1, 1000);

                    let graph = graph.read().await;
                    let relationships = collect_relationships(&graph);
                    if relationships.is_empty() {
                        return Ok(tool_error("No relationships available in overview/modules"));
                    }

                    let query_norm = normalize_name(&node_query);
                    if query_norm.is_empty() {
                        return Ok(tool_error("Argument 'node' is empty"));
                    }

                    let mut label_by_norm: HashMap<String, String> = HashMap::new();
                    let mut rel_norms = Vec::with_capacity(relationships.len());
                    for rel in &relationships {
                        let src_norm = normalize_name(&rel.src);
                        let tgt_norm = normalize_name(&rel.tgt);
                        label_by_norm
                            .entry(src_norm.clone())
                            .or_insert_with(|| rel.src.clone());
                        label_by_norm
                            .entry(tgt_norm.clone())
                            .or_insert_with(|| rel.tgt.clone());
                        rel_norms.push((src_norm, tgt_norm));
                    }

                    let mut seed_norms = BTreeSet::new();
                    for (src_norm, tgt_norm) in &rel_norms {
                        if node_matches_query(src_norm, &query_norm) {
                            seed_norms.insert(src_norm.clone());
                        }
                        if node_matches_query(tgt_norm, &query_norm) {
                            seed_norms.insert(tgt_norm.clone());
                        }
                    }

                    if seed_norms.is_empty() {
                        let suggestions = label_by_norm
                            .values()
                            .take(20)
                            .cloned()
                            .collect::<Vec<_>>();
                        return Ok(tool_error(format!(
                            "No relationship node matched '{node_query}'. Try one of: {}",
                            suggestions.join(", ")
                        )));
                    }

                    let mut selected_edge_indices = Vec::new();
                    let mut selected_edge_set = HashSet::new();
                    let mut visited = seed_norms.clone();
                    let mut frontier = seed_norms;

                    for _ in 0..hops {
                        if frontier.is_empty() || selected_edge_indices.len() >= max_edges {
                            break;
                        }
                        let mut next_frontier = BTreeSet::new();
                        for (idx, (src_norm, tgt_norm)) in rel_norms.iter().enumerate() {
                            let connected =
                                frontier.contains(src_norm) || frontier.contains(tgt_norm);
                            if !connected {
                                continue;
                            }
                            if selected_edge_indices.len() < max_edges && selected_edge_set.insert(idx) {
                                selected_edge_indices.push(idx);
                            }
                            if frontier.contains(src_norm) && !visited.contains(tgt_norm) {
                                next_frontier.insert(tgt_norm.clone());
                            }
                            if frontier.contains(tgt_norm) && !visited.contains(src_norm) {
                                next_frontier.insert(src_norm.clone());
                            }
                        }
                        visited.extend(next_frontier.iter().cloned());
                        frontier = next_frontier;
                    }

                    let edges = selected_edge_indices
                        .iter()
                        .map(|idx| {
                            let rel = &relationships[*idx];
                            json!({
                                "source": rel.src,
                                "target": rel.tgt,
                                "label": rel.label,
                                "scope": rel.scope,
                                "raw": rel.raw
                            })
                        })
                        .collect::<Vec<_>>();

                    let nodes = visited
                        .into_iter()
                        .map(|norm| {
                            label_by_norm
                                .get(&norm)
                                .cloned()
                                .unwrap_or(norm)
                        })
                        .collect::<Vec<_>>();

                    Ok(CallToolResult::structured(json!({
                        "query": node_query,
                        "hops": hops,
                        "edge_count": edges.len(),
                        "node_count": nodes.len(),
                        "truncated": edges.len() >= max_edges,
                        "nodes": nodes,
                        "edges": edges
                    })))
                })
            },
        )
        .with_tool(
            "code_parser_diagnostics",
            "Return parser warnings about unparsed lines and duplicates",
            json!({
                "type": "object",
                "properties": {
                    "limit": { "type": "integer", "minimum": 1, "maximum": 2000, "default": 500 }
                }
            }),
            move |_name, args| {
                let graph = graph_for_diagnostics.clone();
                Box::pin(async move {
                    let args = args.unwrap_or_default();
                    let limit = get_usize_arg(&args, "limit", 500, 1, 2000);

                    let graph = graph.read().await;
                    let diagnostics = graph
                        .diagnostics
                        .iter()
                        .take(limit)
                        .map(diagnostic_to_json)
                        .collect::<Vec<_>>();

                    Ok(CallToolResult::structured(json!({
                        "count": graph.diagnostics.len(),
                        "diagnostics": diagnostics
                    })))
                })
            },
        )
        .build()
}

fn get_string_arg(args: &Map<String, Value>, key: &str) -> Option<String> {
    args.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn get_usize_arg(
    args: &Map<String, Value>,
    key: &str,
    default: usize,
    min: usize,
    max: usize,
) -> usize {
    let value = args.get(key).and_then(|raw| match raw {
        Value::Number(number) => number
            .as_u64()
            .and_then(|n| usize::try_from(n).ok())
            .or_else(|| number.as_f64().map(|n| n.max(0.0) as usize)),
        _ => None,
    });
    value.unwrap_or(default).clamp(min, max)
}

fn graph_coverage_json(graph: &GraphData) -> Value {
    json!({
        "static_files": graph.coverage.static_files,
        "represented_files": graph.coverage.represented_files,
        "missing_files": graph.coverage.missing_files,
        "represented_pct": graph.coverage.represented_pct,
        "group_count": graph.coverage.group_coverage.len()
    })
}

fn group_coverage_json(group: &GroupCoverage) -> Value {
    json!({
        "group_id": group.group_id,
        "static_files": group.static_files,
        "represented_files": group.represented_files,
        "missing_files": group.missing_files,
        "represented_pct": group.represented_pct
    })
}

fn normalize_name(value: &str) -> String {
    value
        .to_lowercase()
        .chars()
        .filter(|ch| !ch.is_whitespace() && *ch != '_' && *ch != '-')
        .collect()
}

fn normalize_target_path(value: &str) -> String {
    value
        .trim()
        .replace('\\', "/")
        .trim_start_matches("./")
        .trim_start_matches('/')
        .split('/')
        .filter(|segment| !segment.is_empty())
        .collect::<Vec<_>>()
        .join("/")
}

fn group_label_from_id(group_id: &str) -> String {
    if group_id == "other" {
        return "other".to_string();
    }
    if group_id == "semantic:tests" {
        return "tests".to_string();
    }
    if group_id == "semantic:specs" {
        return "specs".to_string();
    }
    if group_id == "semantic:scripts" {
        return "scripts".to_string();
    }
    if group_id == "semantic:docs" {
        return "docs".to_string();
    }
    if group_id == "semantic:config" {
        return "config".to_string();
    }
    if let Some(label) = group_id.strip_prefix("path:") {
        return if label.trim().is_empty() {
            "root".to_string()
        } else {
            label.to_string()
        };
    }
    group_id.to_string()
}

fn path_segments(target: &str) -> Vec<String> {
    normalize_target_path(target)
        .split('/')
        .filter(|segment| !segment.is_empty())
        .map(|segment| segment.to_lowercase())
        .collect()
}

fn has_segment(segments: &[String], candidates: &[&str]) -> bool {
    segments
        .iter()
        .any(|segment| candidates.iter().any(|candidate| segment == candidate))
}

fn classify_group(target: Option<&str>) -> (String, String) {
    let Some(target) = target else {
        return ("other".to_string(), "other".to_string());
    };
    let segments = path_segments(target);
    if segments.is_empty() {
        return ("other".to_string(), "other".to_string());
    }

    if has_segment(&segments, TEST_SEGMENTS) {
        return ("semantic:tests".to_string(), "tests".to_string());
    }
    if has_segment(&segments, SPEC_SEGMENTS) {
        return ("semantic:specs".to_string(), "specs".to_string());
    }
    if has_segment(&segments, SCRIPT_SEGMENTS) {
        return ("semantic:scripts".to_string(), "scripts".to_string());
    }
    if has_segment(&segments, DOC_SEGMENTS) {
        return ("semantic:docs".to_string(), "docs".to_string());
    }
    if has_segment(&segments, CONFIG_SEGMENTS) {
        return ("semantic:config".to_string(), "config".to_string());
    }

    let top = segments
        .first()
        .cloned()
        .unwrap_or_else(|| "other".to_string());
    if segments.len() == 1 && top.contains('.') {
        return ("path:root".to_string(), "root".to_string());
    }
    (format!("path:{top}"), top)
}

fn group_matches(target: Option<&str>, query: &str) -> bool {
    let query = query.trim().to_lowercase();
    if query.is_empty() {
        return false;
    }

    let (id, label) = classify_group(target);
    if query == id || query == label {
        return true;
    }

    // Backward-compatible path prefix matching for legacy IDs.
    if !query.contains(':') {
        let Some(target) = target else {
            return query == "other";
        };
        let path = normalize_target_path(target);
        if path == query {
            return true;
        }
        if path.starts_with(&format!("{query}/")) {
            return true;
        }
        if let Some(first) = path.split('/').next() {
            return first == query;
        }
    }

    false
}

fn summarize_groups(
    components: &[ComponentEntry],
    max_groups: usize,
    sample_per_group: usize,
) -> Vec<Value> {
    let mut groups: BTreeMap<String, GroupSummary> = BTreeMap::new();
    for component in components {
        let (id, label) = classify_group(component.target.as_deref());
        let summary = groups.entry(id).or_insert_with(|| GroupSummary {
            label,
            count: 0,
            samples: Vec::new(),
        });
        summary.count += 1;
        if sample_per_group > 0 && summary.samples.len() < sample_per_group {
            summary.samples.push(component.name.clone());
        }
    }

    let mut entries = groups
        .into_iter()
        .map(|(id, summary)| {
            json!({
                "id": id,
                "label": summary.label,
                "count": summary.count,
                "sample_components": summary.samples
            })
        })
        .collect::<Vec<_>>();

    entries.sort_by(|a, b| {
        let ac = a.get("count").and_then(Value::as_u64).unwrap_or(0);
        let bc = b.get("count").and_then(Value::as_u64).unwrap_or(0);
        bc.cmp(&ac)
    });
    entries.truncate(max_groups);
    entries
}

fn find_module<'a>(graph: &'a GraphData, module_id: &str) -> Option<&'a ModuleDoc> {
    let query = module_id.trim();
    let query_lower = query.to_lowercase();
    let query_norm = normalize_name(query);

    graph.modules.iter().find(|module| {
        module.name == query
            || module.name.eq_ignore_ascii_case(query)
            || module.title.eq_ignore_ascii_case(query)
            || normalize_name(&module.name) == query_norm
            || normalize_name(&module.title) == query_norm
            || module.name.to_lowercase().contains(&query_lower)
            || module.title.to_lowercase().contains(&query_lower)
    })
}

fn find_file<'a>(graph: &'a GraphData, path: &str) -> Option<&'a FileDiveDoc> {
    let query = normalize_target_path(path);
    graph.files.iter().find(|file| {
        let file_path = normalize_target_path(&file.path);
        file_path == query || file_path.ends_with(&query) || query.ends_with(&file_path)
    })
}

fn unwrap_entity_token(value: &str) -> String {
    let mut out = value.trim().to_string();

    if out.starts_with('[') && out.ends_with(')') {
        if let Some(idx) = out.find("](") {
            let label = out.get(1..idx).unwrap_or("").trim();
            let target = out
                .get((idx + 2)..out.len().saturating_sub(1))
                .unwrap_or("")
                .trim();
            out = if !label.is_empty() {
                label.to_string()
            } else {
                target.to_string()
            };
        }
    }

    if out.starts_with('`') && out.ends_with('`') && out.len() > 1 {
        out = out[1..out.len() - 1].trim().to_string();
    }

    if out.starts_with('<') && out.ends_with('>') && out.len() > 1 {
        out = out[1..out.len() - 1].trim().to_string();
    }

    out.trim_matches(|ch: char| "-–:>< ".contains(ch))
        .trim()
        .to_string()
}

fn split_target_and_label(text: &str) -> (String, String) {
    if let Some(idx) = text.find(':') {
        let target = text[..idx].trim().to_string();
        let label = text[idx + 1..].trim().to_string();
        return (target, label);
    }
    (text.trim().to_string(), String::new())
}

fn parse_relationship_line(raw: &str, scope: &str) -> Option<ParsedRelationship> {
    let arrows = [("->", false), ("→", false), ("<-", true), ("←", true)];
    let mut best: Option<(usize, &str, bool)> = None;
    for (token, reverse) in arrows {
        if let Some(idx) = raw.find(token) {
            match best {
                Some((best_idx, _, _)) if idx >= best_idx => {}
                _ => best = Some((idx, token, reverse)),
            }
        }
    }

    let (idx, token, reverse) = best?;
    let left = raw[..idx].trim();
    let right = raw[idx + token.len()..].trim();
    if left.is_empty() || right.is_empty() {
        return None;
    }

    let (right_target, label) = split_target_and_label(right);
    let src_raw = if reverse { right_target.as_str() } else { left };
    let tgt_raw = if reverse { left } else { right_target.as_str() };

    let src = unwrap_entity_token(src_raw);
    let tgt = unwrap_entity_token(tgt_raw);
    if src.is_empty() || tgt.is_empty() {
        return None;
    }

    Some(ParsedRelationship {
        src,
        tgt,
        label,
        raw: raw.to_string(),
        scope: scope.to_string(),
    })
}

fn collect_relationships(graph: &GraphData) -> Vec<ParsedRelationship> {
    let mut out = Vec::new();
    if let Some(overview) = graph.overview.as_ref() {
        out.extend(
            overview
                .relationships
                .iter()
                .filter_map(|raw| parse_relationship_line(raw, "overview")),
        );
    }
    for module in &graph.modules {
        let scope = format!("module:{}", module.name);
        out.extend(
            module
                .relationships
                .iter()
                .filter_map(|raw| parse_relationship_line(raw, &scope)),
        );
    }
    out
}

fn node_matches_query(node_norm: &str, query_norm: &str) -> bool {
    node_norm == query_norm || node_norm.contains(query_norm) || query_norm.contains(node_norm)
}

fn diagnostic_to_json(diagnostic: &ParseDiagnostic) -> Value {
    json!({
        "path": diagnostic.path,
        "scope": diagnostic.scope,
        "line": diagnostic.line,
        "code": diagnostic.code,
        "message": diagnostic.message,
        "raw": diagnostic.raw,
        "related": diagnostic.related
    })
}

fn tool_error(message: impl Into<String>) -> CallToolResult {
    CallToolResult::error(vec![Content::text(message.into())])
}

fn is_markdown_path(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|ext| ext.to_str())
            .map(|ext| ext.to_ascii_lowercase())
            .as_deref(),
        Some("md") | Some("markdown")
    )
}

fn read_markdown_file(project_root: &Path, request_path: &str) -> Result<(String, String), String> {
    let path = request_path.trim();
    if path.is_empty() {
        return Err("Path is empty".to_string());
    }

    let joined = if Path::new(path).is_absolute() {
        PathBuf::from(path)
    } else {
        project_root.join(path)
    };

    let canonical = joined
        .canonicalize()
        .map_err(|_| format!("Markdown file not found: {path}"))?;

    if !canonical.starts_with(project_root) {
        return Err("Path escapes project root".to_string());
    }
    if !is_markdown_path(&canonical) {
        return Err("Only .md and .markdown files are supported".to_string());
    }

    let metadata =
        fs::metadata(&canonical).map_err(|_| format!("Markdown file not found: {path}"))?;
    if !metadata.is_file() {
        return Err(format!("Not a file: {path}"));
    }
    if metadata.len() > MAX_MARKDOWN_BYTES {
        return Err(format!(
            "Markdown file exceeds {MAX_MARKDOWN_BYTES} bytes: {path}"
        ));
    }

    let content = fs::read_to_string(&canonical)
        .map_err(|err| format!("Could not read markdown file: {err}"))?;
    let rel = canonical
        .strip_prefix(project_root)
        .ok()
        .and_then(|path| path.to_str())
        .map(|path| path.replace('\\', "/"))
        .unwrap_or_else(|| path.to_string());

    Ok((rel, content))
}
