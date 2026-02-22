use anyhow::{Context, Result};
use chrono::Utc;
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use walkdir::{DirEntry, WalkDir};

const IGNORED_DIRS: &[&str] = &[
    ".dive",
    ".git",
    ".hg",
    ".svn",
    ".vscode",
    ".idea",
    "target",
    "node_modules",
    "dist",
    "build",
];

#[derive(Debug, Clone, Serialize, Default)]
pub struct GraphData {
    pub project_root: String,
    pub generated_at: String,
    pub overview: Option<OverviewDoc>,
    pub modules: Vec<ModuleDoc>,
    pub files: Vec<FileDiveDoc>,
}

#[derive(Debug, Clone, Serialize)]
pub struct OverviewDoc {
    pub path: String,
    pub description: String,
    pub components: Vec<ComponentEntry>,
    pub relationships: Vec<String>,
    pub raw_markdown: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ComponentEntry {
    pub name: String,
    pub description: String,
    pub target: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ModuleDoc {
    pub name: String,
    pub title: String,
    pub path: String,
    pub description: String,
    pub files: Vec<ModuleFileEntry>,
    pub relationships: Vec<String>,
    pub raw_markdown: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ModuleFileEntry {
    pub path: String,
    pub description: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct FileDiveDoc {
    pub path: String,
    pub abs_path: String,
    pub dive_file: Option<String>,
    pub dive_rel: Vec<String>,
    pub tags: Vec<DiveTag>,
}

#[derive(Debug, Clone, Serialize)]
pub struct DiveTag {
    pub line: usize,
    pub description: String,
}

pub fn build_graph(project_root: &Path) -> Result<GraphData> {
    let overview = parse_overview(project_root)?;
    let mut modules = parse_modules(project_root)?;
    modules.sort_by(|a, b| a.name.cmp(&b.name));

    let mut files = scan_source_files(project_root)?;
    files.sort_by(|a, b| a.path.cmp(&b.path));

    Ok(GraphData {
        project_root: normalize_path(project_root),
        generated_at: Utc::now().to_rfc3339(),
        overview,
        modules,
        files,
    })
}

fn parse_overview(project_root: &Path) -> Result<Option<OverviewDoc>> {
    let overview_path = project_root.join(".dive").join("overview.md");
    if !overview_path.exists() {
        return Ok(None);
    }

    let raw_markdown = fs::read_to_string(&overview_path)
        .with_context(|| format!("Failed to read {}", overview_path.display()))?;

    let mut description_lines = Vec::new();
    let mut components = Vec::new();
    let mut relationships = Vec::new();
    let mut section = MdSection::None;

    for line in raw_markdown.lines() {
        let trimmed = line.trim();

        // Skip dive tags embedded in metadata files
        if is_dive_tag_line(trimmed) {
            continue;
        }

        if let Some(next_section) = MdSection::from_heading(trimmed) {
            section = next_section;
            continue;
        }

        if trimmed.starts_with('#') {
            continue;
        }

        match section {
            MdSection::None => {
                if !trimmed.is_empty() {
                    description_lines.push(trimmed.to_string());
                }
            }
            MdSection::Components => {
                if let Some(component) = parse_component_line(trimmed) {
                    components.push(component);
                }
            }
            MdSection::Relationships => {
                if let Some(item) = parse_bullet_line(trimmed) {
                    relationships.push(item);
                }
            }
            MdSection::Files => {}
        }
    }

    Ok(Some(OverviewDoc {
        path: relative_path_string(&overview_path, project_root),
        description: description_lines.join(" ").trim().to_string(),
        components,
        relationships,
        raw_markdown,
    }))
}

fn parse_modules(project_root: &Path) -> Result<Vec<ModuleDoc>> {
    let modules_dir = project_root.join(".dive").join("modules");
    if !modules_dir.exists() {
        return Ok(Vec::new());
    }

    let mut modules = Vec::new();
    for entry in fs::read_dir(&modules_dir)
        .with_context(|| format!("Failed to read {}", modules_dir.display()))?
    {
        let entry = entry?;
        let path = entry.path();
        if path.extension().and_then(|ext| ext.to_str()) != Some("md") {
            continue;
        }

        let raw_markdown = fs::read_to_string(&path)
            .with_context(|| format!("Failed to read {}", path.display()))?;

        let mut description_lines = Vec::new();
        let mut files = Vec::new();
        let mut relationships = Vec::new();
        let mut section = MdSection::None;
        let mut title = String::new();

        for line in raw_markdown.lines() {
            let trimmed = line.trim();

            // Skip dive tags embedded in metadata files
            if is_dive_tag_line(trimmed) {
                continue;
            }

            if trimmed.starts_with("# ") && title.is_empty() {
                title = trimmed.trim_start_matches("# ").trim().to_string();
                continue;
            }

            if let Some(next_section) = MdSection::from_heading(trimmed) {
                section = next_section;
                continue;
            }

            match section {
                MdSection::None => {
                    if !trimmed.is_empty() && !trimmed.starts_with('#') {
                        description_lines.push(trimmed.to_string());
                    }
                }
                MdSection::Files => {
                    if let Some(file_entry) = parse_module_file_line(trimmed) {
                        files.push(file_entry);
                    }
                }
                MdSection::Relationships => {
                    if let Some(item) = parse_bullet_line(trimmed) {
                        relationships.push(item);
                    }
                }
                MdSection::Components => {}
            }
        }

        let fallback_title = path
            .file_stem()
            .and_then(|name| name.to_str())
            .unwrap_or("module")
            .to_string();

        modules.push(ModuleDoc {
            name: fallback_title.clone(),
            title: if title.is_empty() {
                fallback_title
            } else {
                title
            },
            path: relative_path_string(&path, project_root),
            description: description_lines.join(" ").trim().to_string(),
            files,
            relationships,
            raw_markdown,
        });
    }

    Ok(modules)
}

fn scan_source_files(project_root: &Path) -> Result<Vec<FileDiveDoc>> {
    let mut files_with_tags = Vec::new();

    for entry in WalkDir::new(project_root)
        .into_iter()
        .filter_entry(|entry| should_traverse(entry, project_root))
    {
        let entry = match entry {
            Ok(entry) => entry,
            Err(_) => continue,
        };

        if !entry.file_type().is_file() {
            continue;
        }

        if !is_likely_source_file(entry.path()) {
            continue;
        }

        let bytes = match fs::read(entry.path()) {
            Ok(bytes) => bytes,
            Err(_) => continue,
        };

        if bytes.contains(&0) {
            continue;
        }

        let content = String::from_utf8_lossy(&bytes);
        let parsed = parse_file_content(entry.path(), &content, project_root);
        if parsed.dive_file.is_some() || !parsed.dive_rel.is_empty() || !parsed.tags.is_empty() {
            files_with_tags.push(parsed);
        }
    }

    Ok(files_with_tags)
}

fn parse_file_content(path: &Path, content: &str, project_root: &Path) -> FileDiveDoc {
    let mut dive_file = None;
    let mut dive_rel = Vec::new();
    let mut tags = Vec::new();

    for (idx, line) in content.lines().enumerate() {
        let line_number = idx + 1;
        let trimmed = line.trim();

        if let Some(text) = extract_directive(trimmed, "@dive-file:") {
            if dive_file.is_none() {
                dive_file = Some(text);
            }
            continue;
        }

        if let Some(text) = extract_directive(trimmed, "@dive-rel:") {
            dive_rel.push(text);
            continue;
        }

        if trimmed.contains("@dive-file:") || trimmed.contains("@dive-rel:") {
            continue;
        }

        if let Some(text) = extract_directive(trimmed, "@dive:") {
            tags.push(DiveTag {
                line: line_number,
                description: text,
            });
        }
    }

    FileDiveDoc {
        path: relative_path_string(path, project_root),
        abs_path: normalize_path(path),
        dive_file,
        dive_rel,
        tags,
    }
}

fn parse_component_line(line: &str) -> Option<ComponentEntry> {
    let bullet = parse_bullet_line(line)?;
    let mut text = bullet.as_str();

    let (name, remainder) = if text.starts_with("**") {
        let after_prefix = &text[2..];
        let end = after_prefix.find("**")?;
        let name = after_prefix[..end].trim();
        let remainder = after_prefix[end + 2..].trim();
        (name, remainder)
    } else {
        let (name, remainder) = split_once_any(text, &[" - ", ": "])?;
        (name.trim(), remainder.trim())
    };

    text = remainder.trim_start_matches('-').trim();

    let (description, target) = match split_once_any(text, &[" -> ", " → "]) {
        Some((left, right)) => {
            let target = right.trim();
            let target = if target.is_empty() {
                None
            } else {
                Some(target.to_string())
            };
            (left.trim().to_string(), target)
        }
        None => (text.to_string(), None),
    };

    if name.is_empty() {
        return None;
    }

    Some(ComponentEntry {
        name: name.to_string(),
        description,
        target,
    })
}

fn parse_module_file_line(line: &str) -> Option<ModuleFileEntry> {
    let bullet = parse_bullet_line(line)?;
    let trimmed = bullet.trim();

    if let Some(after_tick) = trimmed.strip_prefix('`') {
        let tick_end = after_tick.find('`')?;
        let path = after_tick[..tick_end].trim();
        let rest = after_tick[tick_end + 1..].trim();
        let description = rest.trim_start_matches('-').trim();
        return Some(ModuleFileEntry {
            path: path.to_string(),
            description: description.to_string(),
        });
    }

    if let Some((path, description)) = split_once_any(trimmed, &[" - ", ": "]) {
        return Some(ModuleFileEntry {
            path: path.trim().to_string(),
            description: description.trim().to_string(),
        });
    }

    Some(ModuleFileEntry {
        path: trimmed.to_string(),
        description: String::new(),
    })
}

fn parse_bullet_line(line: &str) -> Option<String> {
    let trimmed = line.trim();
    if let Some(rest) = trimmed.strip_prefix("- ") {
        return Some(rest.trim().to_string());
    }
    if let Some(rest) = trimmed.strip_prefix("* ") {
        return Some(rest.trim().to_string());
    }
    None
}

fn split_once_any<'a>(text: &'a str, delimiters: &[&str]) -> Option<(&'a str, &'a str)> {
    let mut best: Option<(&str, &str, usize)> = None;
    for delimiter in delimiters {
        if let Some(index) = text.find(delimiter) {
            match best {
                Some((_, _, best_index)) if index >= best_index => {}
                _ => best = Some((delimiter, text, index)),
            }
        }
    }

    let (delimiter, whole, index) = best?;
    let left = &whole[..index];
    let right = &whole[index + delimiter.len()..];
    Some((left, right))
}

fn extract_directive(line: &str, marker: &str) -> Option<String> {
    let start = line.find(marker)?;
    let prefix = line[..start].trim_end();
    if !looks_like_comment_prefix(prefix) {
        return None;
    }

    let raw = line[start + marker.len()..].trim();
    if raw.is_empty() {
        return None;
    }

    let cleaned = raw
        .trim_end_matches("*/")
        .trim_end_matches("-->")
        .trim()
        .to_string();

    if cleaned.is_empty() {
        None
    } else {
        Some(cleaned)
    }
}

fn is_dive_tag_line(line: &str) -> bool {
    // Matches lines like: <!-- @dive-file: ... -->, // @dive-rel: ..., # @dive: ..., etc.
    let stripped = line
        .trim_start_matches("<!--")
        .trim_start_matches("//")
        .trim_start_matches('#')
        .trim_start_matches("/*")
        .trim_start_matches('*')
        .trim_start_matches("--")
        .trim();

    stripped.starts_with("@dive-file:")
        || stripped.starts_with("@dive-rel:")
        || stripped.starts_with("@dive:")
}

fn looks_like_comment_prefix(prefix: &str) -> bool {
    if prefix.is_empty() {
        return false;
    }

    prefix.ends_with("//")
        || prefix.ends_with('#')
        || prefix.ends_with("/*")
        || prefix.ends_with('*')
        || prefix.ends_with("<!--")
        || prefix.ends_with("--")
}

fn should_traverse(entry: &DirEntry, project_root: &Path) -> bool {
    if !entry.file_type().is_dir() {
        return true;
    }

    if entry.path() == project_root {
        return true;
    }

    let Some(name) = entry.file_name().to_str() else {
        return true;
    };

    !IGNORED_DIRS.contains(&name)
}

fn is_likely_source_file(path: &Path) -> bool {
    let Some(file_name) = path.file_name().and_then(|name| name.to_str()) else {
        return false;
    };

    let Some(metadata) = fs::metadata(path).ok() else {
        return false;
    };

    if metadata.len() > 1024 * 1024 {
        return false;
    }

    if matches!(file_name, "Dockerfile" | "Makefile" | "Justfile") {
        return true;
    }

    let extension = path.extension().and_then(|ext| ext.to_str()).unwrap_or("");
    matches!(
        extension,
        "rs" | "js"
            | "ts"
            | "tsx"
            | "jsx"
            | "py"
            | "go"
            | "java"
            | "kt"
            | "kts"
            | "scala"
            | "c"
            | "cc"
            | "cpp"
            | "h"
            | "hpp"
            | "cs"
            | "php"
            | "rb"
            | "swift"
            | "lua"
            | "sh"
            | "bash"
            | "zsh"
            | "fish"
            | "yaml"
            | "yml"
            | "toml"
            | "json"
            | "html"
            | "xml"
            | "sql"
    )
}

fn relative_path_string(path: &Path, project_root: &Path) -> String {
    path.strip_prefix(project_root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

fn normalize_path(path: &Path) -> String {
    let canonical = path.canonicalize().unwrap_or_else(|_| PathBuf::from(path));
    canonical.to_string_lossy().replace('\\', "/")
}

#[derive(Copy, Clone, Debug, Eq, PartialEq)]
enum MdSection {
    None,
    Components,
    Files,
    Relationships,
}

impl MdSection {
    fn from_heading(line: &str) -> Option<Self> {
        if !line.starts_with("## ") {
            return None;
        }

        let heading = line.trim_start_matches("## ").trim().to_lowercase();
        if heading.starts_with("components") {
            return Some(Self::Components);
        }
        if heading.starts_with("files") {
            return Some(Self::Files);
        }
        if heading.starts_with("relationships") {
            return Some(Self::Relationships);
        }
        Some(Self::None)
    }
}
