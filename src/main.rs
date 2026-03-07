mod mcp_server;
mod parser;
mod static_analysis;

use anyhow::{Context, Result, anyhow};
use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::response::Sse;
use axum::response::sse::{Event as SseEvent, KeepAlive};
use axum::routing::get;
use axum::{Json, Router};
use clap::Parser;
use notify::{Config, Event, PollWatcher, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use std::convert::Infallible;
use std::net::{Ipv6Addr, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::sync::Arc;
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
