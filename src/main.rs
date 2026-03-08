mod mcp_server;
mod parser;
mod static_analysis;

use anyhow::{Context, Result, anyhow};
use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::response::Sse;
use axum::response::sse::{Event as SseEvent, KeepAlive};
use axum::routing::{get, post};
use axum::{Json, Router};
use clap::Parser;
use notify::{Config, Event, PollWatcher, RecursiveMode, Watcher};
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::convert::Infallible;
use std::net::{Ipv6Addr, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;
use std::sync::OnceLock;
use std::time::Duration;
use tokio::sync::{RwLock, broadcast, mpsc};
use tokio::time::sleep;
use tokio_stream::StreamExt as _;
use tokio_stream::wrappers::BroadcastStream;
use tower_http::services::{ServeDir, ServeFile};

use crate::parser::{GraphData, build_graph};

#[derive(Debug, Parser)]
#[command(
    name = "code_diver",
    version,
    about = "Drill-down viewer for @dive metadata"
)]
struct Cli {
    #[arg(value_name = "PROJECT_PATH", default_value = ".")]
    project: PathBuf,

    #[arg(short, long, default_value_t = 4000)]
    port: u16,

    #[arg(long, default_value = "127.0.0.1:4100")]
    mcp_addr: String,
}

const DEFAULT_MCP_PORT: u16 = 4100;

#[derive(Clone)]
struct AppState {
    project_root: PathBuf,
    graph: Arc<RwLock<GraphData>>,
    events: broadcast::Sender<()>,
}

#[derive(Debug, Deserialize)]
struct MarkdownQuery {
    path: String,
}

#[derive(Debug, Serialize)]
struct MarkdownDoc {
    path: String,
    content: String,
}

const DIFF_BASELINE_HEAD_WORKTREE: &str = "head_worktree";
const MAX_DIFF_FILES: usize = 120;
const MAX_DIFF_TOTAL_LINES: usize = 14_000;
const MAX_DIFF_FILE_LINES: usize = 2_600;
const MAX_HUNKS_PER_FILE: usize = 240;
const MAX_HUNK_LINES: usize = 420;
const GIT_STATUS_ADDED: &str = "added";
const GIT_STATUS_DELETED: &str = "deleted";
const GIT_STATUS_UNKNOWN: &str = "unknown";

#[derive(Debug, Deserialize)]
struct DiffRequest {
    paths: Vec<String>,
    baseline: Option<String>,
}

#[derive(Debug, Serialize)]
struct DiffResponse {
    baseline: String,
    files: Vec<DiffFileDoc>,
    truncated: bool,
    file_count: usize,
}

#[derive(Debug, Serialize)]
struct DiffFileDoc {
    path: String,
    status: String,
    patch: String,
    hunks: Vec<DiffHunkDoc>,
    truncated: bool,
}

#[derive(Debug, Serialize)]
struct DiffHunkDoc {
    header: String,
    old_start: usize,
    old_lines: usize,
    new_start: usize,
    new_lines: usize,
    lines: Vec<DiffHunkLineDoc>,
}

#[derive(Debug, Serialize)]
struct DiffHunkLineDoc {
    kind: String,
    text: String,
}

#[tokio::main]
async fn main() -> Result<()> {
    let cli = Cli::parse();
    let mcp_bind_addr = normalize_mcp_bind_addr(&cli.mcp_addr, DEFAULT_MCP_PORT)?;
    let project_root = cli
        .project
        .canonicalize()
        .with_context(|| format!("Could not resolve {}", cli.project.display()))?;

    let initial_graph = build_graph(&project_root)
        .with_context(|| format!("Failed to parse {}", project_root.display()))?;

    let graph = Arc::new(RwLock::new(initial_graph));
    let (events, _) = broadcast::channel(256);

    spawn_watcher(project_root.clone(), graph.clone(), events.clone());
    mcp_server::spawn_mcp_server(mcp_bind_addr.clone(), project_root.clone(), graph.clone());

    // Serve the React frontend from web/dist/
    let web_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("web/dist");
    let index_file = web_dir.join("index.html");

    let app = Router::new()
        .route("/api/graph", get(graph_handler))
        .route("/api/diff", post(diff_handler))
        .route("/api/markdown", get(markdown_handler))
        .route("/api/events", get(events_handler))
        .with_state(AppState {
            project_root: project_root.clone(),
            graph,
            events,
        })
        .fallback_service(ServeDir::new(&web_dir).fallback(ServeFile::new(&index_file)));

    let listener = tokio::net::TcpListener::bind(("127.0.0.1", cli.port))
        .await
        .with_context(|| format!("Failed to bind 127.0.0.1:{}", cli.port))?;

    println!("Code Diver running at http://127.0.0.1:{}/", cli.port);
    println!("MCP endpoint: http://{}/mcp", mcp_bind_addr);
    println!("Watching: {}", project_root.display());

    axum::serve(listener, app).await.context("Server exited")?;
    Ok(())
}

async fn graph_handler(State(state): State<AppState>) -> Json<GraphData> {
    Json(state.graph.read().await.clone())
}

async fn diff_handler(
    State(state): State<AppState>,
    Json(request): Json<DiffRequest>,
) -> Result<Json<DiffResponse>, (StatusCode, String)> {
    let baseline = request
        .baseline
        .as_deref()
        .unwrap_or(DIFF_BASELINE_HEAD_WORKTREE);

    if baseline != DIFF_BASELINE_HEAD_WORKTREE {
        return Err((
            StatusCode::BAD_REQUEST,
            format!("Unsupported baseline: {baseline}"),
        ));
    }

    let unique = sanitize_diff_paths(request.paths);

    if unique.is_empty() {
        return Ok(build_diff_response(Vec::new(), false));
    }

    let graph = state.graph.read().await;
    let git_status = graph.git_status.clone();
    drop(graph);

    let mut files = Vec::<DiffFileDoc>::new();
    let mut truncated = false;
    let mut total_lines = 0usize;

    let iter_cap = unique.len().min(MAX_DIFF_FILES);
    if unique.len() > MAX_DIFF_FILES {
        truncated = true;
    }

    for path in unique.into_iter().take(iter_cap) {
        let status = git_status
            .get(&path)
            .cloned()
            .unwrap_or_else(|| GIT_STATUS_UNKNOWN.to_string());

        let mut doc = match build_diff_file_doc(&state.project_root, &path, &status) {
            Ok(Some(doc)) => doc,
            Ok(None) => continue,
            Err(err) => {
                return Err((
                    StatusCode::INTERNAL_SERVER_ERROR,
                    format!("Diff build failed for {path}: {err}"),
                ));
            }
        };

        let patch_lines = doc.patch.lines().count();
        total_lines += patch_lines;
        if total_lines > MAX_DIFF_TOTAL_LINES {
            truncated = true;
            break;
        }

        enforce_doc_limits(&mut doc, patch_lines, &mut truncated);

        files.push(doc);
    }

    Ok(build_diff_response(files, truncated))
}

async fn markdown_handler(
    State(state): State<AppState>,
    Query(query): Query<MarkdownQuery>,
) -> Result<Json<MarkdownDoc>, (StatusCode, String)> {
    let request_path = query.path.trim();
    if request_path.is_empty() {
        return Err((
            StatusCode::BAD_REQUEST,
            "Missing 'path' query parameter".to_string(),
        ));
    }

    let joined = state.project_root.join(request_path);
    let canonical = joined.canonicalize().map_err(|_| {
        (
            StatusCode::NOT_FOUND,
            format!("Markdown file not found: {request_path}"),
        )
    })?;

    if !canonical.starts_with(&state.project_root) {
        return Err((
            StatusCode::FORBIDDEN,
            "Path escapes project root".to_string(),
        ));
    }

    if !is_markdown_path(&canonical) {
        return Err((
            StatusCode::BAD_REQUEST,
            "Only .md and .markdown files are supported".to_string(),
        ));
    }

    let metadata = tokio::fs::metadata(&canonical).await.map_err(|_| {
        (
            StatusCode::NOT_FOUND,
            format!("Markdown file not found: {request_path}"),
        )
    })?;
    if !metadata.is_file() {
        return Err((StatusCode::NOT_FOUND, format!("Not a file: {request_path}")));
    }
    if metadata.len() > 1_000_000 {
        return Err((
            StatusCode::PAYLOAD_TOO_LARGE,
            format!("Markdown file is too large to render: {request_path}"),
        ));
    }

    let content = tokio::fs::read_to_string(&canonical).await.map_err(|err| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("Could not read markdown: {err}"),
        )
    })?;

    let rel = canonical
        .strip_prefix(&state.project_root)
        .ok()
        .and_then(|path| path.to_str())
        .map(|path| path.replace('\\', "/"))
        .unwrap_or_else(|| request_path.to_string());

    Ok(Json(MarkdownDoc { path: rel, content }))
}

async fn events_handler(
    State(state): State<AppState>,
) -> Sse<impl tokio_stream::Stream<Item = Result<SseEvent, Infallible>>> {
    let stream = BroadcastStream::new(state.events.subscribe()).filter_map(|message| {
        message
            .ok()
            .map(|_| Ok(SseEvent::default().event("graph-updated").data("refresh")))
    });

    Sse::new(stream).keep_alive(
        KeepAlive::new()
            .interval(Duration::from_secs(15))
            .text("ping"),
    )
}

fn build_diff_file_doc(
    project_root: &Path,
    rel_path: &str,
    status: &str,
) -> Result<Option<DiffFileDoc>> {
    let mut patch = git_diff_head_to_worktree(project_root, rel_path)?;
    let head_exists = git_head_path_exists(project_root, rel_path);
    let abs = project_root.join(rel_path);
    let worktree_exists = abs.exists();

    if patch.trim().is_empty() && status == GIT_STATUS_ADDED && !head_exists && worktree_exists {
        patch = synthesize_added_patch(project_root, rel_path)?;
    }

    if patch.trim().is_empty() && status == GIT_STATUS_DELETED && head_exists && !worktree_exists {
        patch = synthesize_deleted_patch(project_root, rel_path)?;
    }

    if patch.trim().is_empty() {
        return Ok(None);
    }

    let hunks = parse_patch_hunks(&patch);
    Ok(Some(DiffFileDoc {
        path: rel_path.to_string(),
        status: status.to_string(),
        patch,
        hunks,
        truncated: false,
    }))
}

fn git_diff_head_to_worktree(project_root: &Path, rel_path: &str) -> Result<String> {
    git_text_output(
        project_root,
        &["diff", "--no-color", "--unified=4", "HEAD", "--", rel_path],
        "git diff",
        rel_path,
    )
}

fn git_head_path_exists(project_root: &Path, rel_path: &str) -> bool {
    let head_ref = format!("HEAD:{rel_path}");
    git_command_ok(project_root, &["cat-file", "-e", &head_ref])
}

fn git_show_head_file(project_root: &Path, rel_path: &str) -> Result<String> {
    let head_ref = format!("HEAD:{rel_path}");
    git_text_output(project_root, &["show", &head_ref], "git show", rel_path)
}

fn synthesize_added_patch(project_root: &Path, rel_path: &str) -> Result<String> {
    let content = std::fs::read_to_string(project_root.join(rel_path))
        .with_context(|| format!("Could not read added file {}", rel_path))?;
    let lines = content.lines().collect::<Vec<_>>();
    Ok(synthesize_patch_text(rel_path, &lines, GIT_STATUS_ADDED))
}

fn synthesize_deleted_patch(project_root: &Path, rel_path: &str) -> Result<String> {
    let content = git_show_head_file(project_root, rel_path)?;
    let lines = content.lines().collect::<Vec<_>>();
    Ok(synthesize_patch_text(rel_path, &lines, GIT_STATUS_DELETED))
}

fn synthesize_patch_text(rel_path: &str, lines: &[&str], status: &str) -> String {
    let mut out = String::new();
    out.push_str(&format!("diff --git a/{rel_path} b/{rel_path}\n"));
    if status == GIT_STATUS_ADDED {
        out.push_str("new file mode 100644\n");
    } else {
        out.push_str("deleted file mode 100644\n");
    }
    out.push_str("index 0000000..0000000\n");
    if status == GIT_STATUS_ADDED {
        out.push_str("--- /dev/null\n");
        out.push_str(&format!("+++ b/{rel_path}\n"));
        out.push_str(&format!("@@ -0,0 +1,{} @@\n", lines.len()));
    } else {
        out.push_str(&format!("--- a/{rel_path}\n"));
        out.push_str("+++ /dev/null\n");
        out.push_str(&format!("@@ -1,{} +0,0 @@\n", lines.len()));
    }
    for line in lines {
        out.push(if status == GIT_STATUS_ADDED { '+' } else { '-' });
        out.push_str(line);
        out.push('\n');
    }
    out
}

fn parse_patch_hunks(patch: &str) -> Vec<DiffHunkDoc> {
    let mut out = Vec::<DiffHunkDoc>::new();
    let mut current: Option<DiffHunkDoc> = None;

    for raw_line in patch.lines() {
        if let Some(next_hunk) = parse_hunk_header(raw_line) {
            if let Some(existing) = current.take() {
                out.push(existing);
            }
            current = Some(next_hunk);
            continue;
        }

        let Some(hunk) = current.as_mut() else {
            continue;
        };

        let (kind, text) = classify_patch_line(raw_line);

        hunk.lines.push(DiffHunkLineDoc {
            kind: kind.to_string(),
            text: text.to_string(),
        });
    }

    if let Some(existing) = current.take() {
        out.push(existing);
    }

    out
}

fn hunk_header_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@").expect("valid hunk regex")
    })
}

fn parse_hunk_header(raw_line: &str) -> Option<DiffHunkDoc> {
    let caps = hunk_header_re().captures(raw_line)?;
    let old_start = capture_usize(&caps, 1, 0);
    let old_lines = capture_usize(&caps, 2, 1);
    let new_start = capture_usize(&caps, 3, 0);
    let new_lines = capture_usize(&caps, 4, 1);
    Some(DiffHunkDoc {
        header: raw_line.to_string(),
        old_start,
        old_lines,
        new_start,
        new_lines,
        lines: Vec::new(),
    })
}

fn capture_usize(caps: &regex::Captures<'_>, index: usize, fallback: usize) -> usize {
    caps.get(index)
        .and_then(|m| m.as_str().parse::<usize>().ok())
        .unwrap_or(fallback)
}

fn classify_patch_line(raw_line: &str) -> (&'static str, &str) {
    if raw_line.starts_with('+') && !raw_line.starts_with("+++") {
        return ("add", raw_line.trim_start_matches('+'));
    }
    if raw_line.starts_with('-') && !raw_line.starts_with("---") {
        return ("del", raw_line.trim_start_matches('-'));
    }
    if raw_line.starts_with(' ') {
        return ("context", raw_line.trim_start_matches(' '));
    }
    ("meta", raw_line)
}

fn trim_text_lines(text: &str, max_lines: usize) -> String {
    let mut out = text.lines().take(max_lines).collect::<Vec<_>>().join("\n");
    out.push_str("\n... [truncated]\n");
    out
}

fn build_diff_response(files: Vec<DiffFileDoc>, truncated: bool) -> Json<DiffResponse> {
    Json(DiffResponse {
        baseline: DIFF_BASELINE_HEAD_WORKTREE.to_string(),
        file_count: files.len(),
        files,
        truncated,
    })
}

fn enforce_doc_limits(doc: &mut DiffFileDoc, patch_lines: usize, truncated: &mut bool) {
    if patch_lines > MAX_DIFF_FILE_LINES {
        doc.patch = trim_text_lines(&doc.patch, MAX_DIFF_FILE_LINES);
        mark_doc_truncated(doc, truncated);
    }

    if doc.hunks.len() > MAX_HUNKS_PER_FILE {
        doc.hunks.truncate(MAX_HUNKS_PER_FILE);
        mark_doc_truncated(doc, truncated);
    }

    let mut hunks_truncated = false;
    for hunk in &mut doc.hunks {
        if hunk.lines.len() > MAX_HUNK_LINES {
            hunk.lines.truncate(MAX_HUNK_LINES);
            hunks_truncated = true;
        }
    }
    if hunks_truncated {
        mark_doc_truncated(doc, truncated);
    }
}

fn mark_doc_truncated(doc: &mut DiffFileDoc, truncated: &mut bool) {
    doc.truncated = true;
    *truncated = true;
}

fn sanitize_diff_paths(paths: Vec<String>) -> Vec<String> {
    let mut unique = Vec::<String>::new();
    let mut seen = HashSet::<String>::new();
    for raw in paths {
        let normalized = normalize_rel_path_input(&raw);
        if normalized.is_empty() || normalized.contains('\0') {
            continue;
        }
        if path_escapes_root(&normalized) {
            continue;
        }
        if seen.insert(normalized.clone()) {
            unique.push(normalized);
        }
    }
    unique
}

fn git_text_output(project_root: &Path, args: &[&str], op: &str, rel_path: &str) -> Result<String> {
    let output = Command::new("git")
        .arg("-C")
        .arg(project_root)
        .args(args)
        .output()
        .with_context(|| format!("Failed running {op} for {rel_path}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(anyhow!("{op} failed for {rel_path}: {}", stderr.trim()));
    }

    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

fn git_command_ok(project_root: &Path, args: &[&str]) -> bool {
    match Command::new("git")
        .arg("-C")
        .arg(project_root)
        .args(args)
        .output()
    {
        Ok(output) => output.status.success(),
        Err(_) => false,
    }
}

fn normalize_rel_path_input(raw: &str) -> String {
    raw.trim()
        .replace('\\', "/")
        .trim_start_matches("./")
        .trim_start_matches('/')
        .replace("//", "/")
}

fn path_escapes_root(path: &str) -> bool {
    path.split('/').any(|segment| segment == "..")
}

fn spawn_watcher(
    project_root: PathBuf,
    graph: Arc<RwLock<GraphData>>,
    events: broadcast::Sender<()>,
) {
    tokio::spawn(async move {
        let (tx, mut rx) = mpsc::unbounded_channel::<notify::Result<Event>>();
        let watcher = match build_watcher(&project_root, tx) {
            Ok(watcher) => watcher,
            Err(err) => {
                eprintln!("Watcher setup failed: {err:#}");
                return;
            }
        };

        while rx.recv().await.is_some() {
            // Keep watcher alive across await points in this task.
            let _watcher_guard = &watcher;

            // Debounce noisy filesystem events and refresh once per burst.
            sleep(Duration::from_millis(200)).await;
            while rx.try_recv().is_ok() {}

            match build_graph(&project_root) {
                Ok(new_graph) => {
                    *graph.write().await = new_graph;
                    let _ = events.send(());
                }
                Err(err) => {
                    eprintln!("Failed to refresh graph: {err:#}");
                }
            }
        }
    });
}

fn build_watcher(
    project_root: &Path,
    tx: mpsc::UnboundedSender<notify::Result<Event>>,
) -> Result<PollWatcher> {
    let root_for_filter = project_root.to_path_buf();

    let mut watcher = PollWatcher::new(
        move |result| {
            let should_emit = match &result {
                Ok(event) => !all_paths_ignored(event, &root_for_filter),
                Err(_) => true,
            };

            if should_emit {
                let _ = tx.send(result);
            }
        },
        Config::default().with_poll_interval(Duration::from_millis(800)),
    )
    .context("Could not create watcher")?;

    watcher
        .watch(project_root, RecursiveMode::Recursive)
        .with_context(|| format!("Could not watch {}", project_root.display()))?;

    Ok(watcher)
}

fn all_paths_ignored(event: &Event, project_root: &Path) -> bool {
    if event.paths.is_empty() {
        return false;
    }

    event
        .paths
        .iter()
        .all(|path| is_ignored_path(path, project_root))
}

fn is_ignored_path(path: &Path, project_root: &Path) -> bool {
    let ignored_roots = [".git", "target", "node_modules", ".idea", ".vscode"];
    for ignored in ignored_roots {
        if path.starts_with(project_root.join(ignored)) {
            return true;
        }
    }

    if let Some(name) = path.file_name().and_then(|name| name.to_str()) {
        if name.ends_with('~') || name.ends_with(".swp") || name.ends_with(".tmp") {
            return true;
        }
    }

    false
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

fn normalize_mcp_bind_addr(raw: &str, default_port: u16) -> Result<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(format!("127.0.0.1:{default_port}"));
    }

    let no_scheme = trimmed
        .strip_prefix("http://")
        .or_else(|| trimmed.strip_prefix("https://"))
        .unwrap_or(trimmed);
    let authority = no_scheme.split('/').next().unwrap_or("").trim();
    if authority.is_empty() {
        return Ok(format!("127.0.0.1:{default_port}"));
    }

    let normalized = if authority.starts_with('[') {
        if authority.contains("]:") {
            authority.to_string()
        } else {
            format!("{authority}:{default_port}")
        }
    } else {
        let colon_count = authority.chars().filter(|ch| *ch == ':').count();
        if colon_count == 0 {
            format!("{authority}:{default_port}")
        } else if colon_count == 1 {
            let (_, maybe_port) = authority.rsplit_once(':').expect("single colon");
            if !maybe_port.is_empty() && maybe_port.chars().all(|ch| ch.is_ascii_digit()) {
                authority.to_string()
            } else {
                format!("{authority}:{default_port}")
            }
        } else if authority.parse::<Ipv6Addr>().is_ok() {
            format!("[{authority}]:{default_port}")
        } else {
            authority.to_string()
        }
    };

    normalized.to_socket_addrs().map_err(|err| {
        anyhow!(
            "Invalid --mcp-addr '{raw}' (normalized to '{normalized}'): {err}. Use host:port, e.g. 127.0.0.1:{default_port}"
        )
    })?;

    Ok(normalized)
}
