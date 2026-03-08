use regex::Regex;
use serde::Serialize;
use std::cmp::Ordering;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::OnceLock;
use tree_sitter::{Language, Node, Parser, Tree};

const MAX_STATIC_EDGES: usize = 16_000;
const MAX_CALL_TARGETS: usize = 2;
const MAX_STEM_MATCHES: usize = 6;

#[derive(Debug, Clone, Serialize, Default)]
pub struct StaticAnalysis {
    pub files_analyzed: usize,
    pub file_facts: Vec<StaticFileFacts>,
    pub edges: Vec<StaticEdge>,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct StaticFileFacts {
    pub path: String,
    pub language: String,
    pub symbol_count: usize,
    pub import_count: usize,
    pub call_count: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct StaticEdge {
    pub source_path: String,
    pub target_path: String,
    pub kind: String,
    pub weight: usize,
    pub confidence: f32,
}

#[derive(Debug, Clone)]
pub struct FileStaticFactsInput {
    pub path: String,
    pub language: StaticLanguage,
    pub definitions: Vec<SymbolDef>,
    pub imports: Vec<String>,
    pub calls: HashMap<String, usize>,
}

#[derive(Debug, Clone)]
pub struct SymbolDef {
    pub name: String,
    pub kind: &'static str,
    pub line: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StaticLanguage {
    Rust,
    TypeScript,
    JavaScript,
    Python,
    Go,
    Java,
    Kotlin,
    CFamily,
    Shell,
    Other,
}

impl StaticLanguage {
    fn from_path(path: &str) -> Self {
        let lower = path.to_ascii_lowercase();
        if lower.ends_with(".rs") {
            return Self::Rust;
        }
        if lower.ends_with(".ts") || lower.ends_with(".tsx") {
            return Self::TypeScript;
        }
        if lower.ends_with(".js") || lower.ends_with(".jsx") || lower.ends_with(".mjs") {
            return Self::JavaScript;
        }
        if lower.ends_with(".py") {
            return Self::Python;
        }
        if lower.ends_with(".go") {
            return Self::Go;
        }
        if lower.ends_with(".java") {
            return Self::Java;
        }
        if lower.ends_with(".kt") || lower.ends_with(".kts") {
            return Self::Kotlin;
        }
        if lower.ends_with(".c")
            || lower.ends_with(".cc")
            || lower.ends_with(".cpp")
            || lower.ends_with(".h")
            || lower.ends_with(".hpp")
        {
            return Self::CFamily;
        }
        if lower.ends_with(".sh") || lower.ends_with(".bash") || lower.ends_with(".zsh") {
            return Self::Shell;
        }
        Self::Other
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Rust => "rust",
            Self::TypeScript => "typescript",
            Self::JavaScript => "javascript",
            Self::Python => "python",
            Self::Go => "go",
            Self::Java => "java",
            Self::Kotlin => "kotlin",
            Self::CFamily => "c-family",
            Self::Shell => "shell",
            Self::Other => "other",
        }
    }

    fn import_extension_candidates(self) -> &'static [&'static str] {
        match self {
            Self::Rust => &[".rs"],
            Self::TypeScript => &[".ts", ".tsx", ".js", ".jsx"],
            Self::JavaScript => &[".js", ".jsx", ".ts", ".tsx"],
            Self::Python => &[".py"],
            Self::Go => &[".go"],
            Self::Java => &[".java"],
            Self::Kotlin => &[".kt", ".kts"],
            Self::CFamily => &[".c", ".cc", ".cpp", ".h", ".hpp"],
            Self::Shell => &[".sh", ".bash", ".zsh"],
            Self::Other => &[
                ".rs", ".ts", ".tsx", ".js", ".jsx", ".py", ".go", ".java", ".kt", ".kts", ".c",
                ".cc", ".cpp", ".h", ".hpp",
            ],
        }
    }

    fn tree_sitter_language(self, path: &str) -> Option<Language> {
        match self {
            Self::Rust => Some(tree_sitter_rust::LANGUAGE.into()),
            Self::TypeScript => {
                let lower = path.to_ascii_lowercase();
                if lower.ends_with(".tsx") {
                    Some(tree_sitter_typescript::LANGUAGE_TSX.into())
                } else {
                    Some(tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into())
                }
            }
            Self::JavaScript => Some(tree_sitter_javascript::LANGUAGE.into()),
            Self::Python => Some(tree_sitter_python::LANGUAGE.into()),
            Self::Go => Some(tree_sitter_go::LANGUAGE.into()),
            Self::Java | Self::Kotlin | Self::CFamily | Self::Shell | Self::Other => None,
        }
    }
}

#[derive(Debug, Clone)]
struct DefinitionRef {
    path: String,
    kind: &'static str,
    line: usize,
}

#[derive(Debug, Default)]
struct EdgeAccumulator {
    weight: usize,
    confidence_weighted: f32,
    hits: usize,
}

#[derive(Debug)]
struct ImportIndex {
    path_set: HashSet<String>,
    by_stem: HashMap<String, Vec<String>>,
    by_no_ext: HashMap<String, Vec<String>>,
}

pub fn analyze_static_file(path: &str, content: &str) -> FileStaticFactsInput {
    let language = StaticLanguage::from_path(path);
    let normalized_path = normalize_rel_path(path);

    let mut definitions = Vec::new();
    let mut imports = Vec::new();
    let mut calls = HashMap::new();

    if let Some(tree) = parse_with_tree_sitter(language, &normalized_path, content) {
        collect_facts_from_tree(
            language,
            content,
            &tree,
            &mut definitions,
            &mut imports,
            &mut calls,
        );
    } else {
        collect_facts_from_lines(
            language,
            content,
            &mut definitions,
            &mut imports,
            &mut calls,
        );
    }

    FileStaticFactsInput {
        path: normalized_path,
        language,
        definitions,
        imports,
        calls,
    }
}

pub fn build_static_analysis(files: &[FileStaticFactsInput]) -> StaticAnalysis {
    if files.is_empty() {
        return StaticAnalysis::default();
    }

    let mut file_facts = files
        .iter()
        .map(|file| StaticFileFacts {
            path: file.path.clone(),
            language: file.language.as_str().to_string(),
            symbol_count: file.definitions.len(),
            import_count: file.imports.len(),
            call_count: file.calls.values().sum(),
        })
        .collect::<Vec<_>>();
    file_facts.sort_by(|a, b| a.path.cmp(&b.path));

    let index = build_import_index(files);
    let mut edges = HashMap::<(String, String, String), EdgeAccumulator>::new();
    add_import_edges(files, &index, &mut edges);
    add_call_edges(files, &mut edges);

    let mut edge_list = edges
        .into_iter()
        .filter_map(|((source_path, target_path, kind), acc)| {
            if source_path == target_path || acc.weight == 0 {
                return None;
            }
            let confidence = if acc.hits == 0 {
                0.0
            } else {
                (acc.confidence_weighted / acc.hits as f32).clamp(0.0, 1.0)
            };
            Some(StaticEdge {
                source_path,
                target_path,
                kind,
                weight: acc.weight,
                confidence: round_3(confidence),
            })
        })
        .collect::<Vec<_>>();

    edge_list.sort_by(compare_static_edges);
    let truncated = edge_list.len() > MAX_STATIC_EDGES;
    if truncated {
        edge_list.truncate(MAX_STATIC_EDGES);
    }

    StaticAnalysis {
        files_analyzed: files.len(),
        file_facts,
        edges: edge_list,
        truncated,
    }
}

fn parse_with_tree_sitter(language: StaticLanguage, path: &str, content: &str) -> Option<Tree> {
    let ts_language = language.tree_sitter_language(path)?;
    let mut parser = Parser::new();
    parser.set_language(&ts_language).ok()?;
    parser.parse(content, None)
}

fn collect_facts_from_tree(
    language: StaticLanguage,
    content: &str,
    tree: &Tree,
    definitions: &mut Vec<SymbolDef>,
    imports: &mut Vec<String>,
    calls: &mut HashMap<String, usize>,
) {
    let bytes = content.as_bytes();
    let mut stack = vec![tree.root_node()];

    while let Some(node) = stack.pop() {
        collect_node_facts(language, node, bytes, definitions, imports, calls);

        for idx in (0..node.child_count()).rev() {
            if let Some(child) = node.child(idx) {
                stack.push(child);
            }
        }
    }
}

fn collect_node_facts(
    language: StaticLanguage,
    node: Node,
    source: &[u8],
    definitions: &mut Vec<SymbolDef>,
    imports: &mut Vec<String>,
    calls: &mut HashMap<String, usize>,
) {
    let kind = node.kind();

    match language {
        StaticLanguage::Rust => match kind {
            "use_declaration" => {
                if let Ok(text) = node.utf8_text(source) {
                    for token in extract_rust_use_tokens(text) {
                        push_import_token(&token, imports);
                    }
                }
            }
            "mod_item" => {
                if let Some(name_node) = node.child_by_field_name("name") {
                    if let Ok(name) = name_node.utf8_text(source) {
                        push_import_token(name, imports);
                    }
                }
            }
            "function_item" => {
                push_definition_from_field(node, source, "name", "function", definitions);
            }
            "struct_item" | "enum_item" | "trait_item" => {
                push_definition_from_field(node, source, "name", "type", definitions);
            }
            "call_expression" => {
                if let Some(name) = call_name_from_node(node, source) {
                    *calls.entry(name).or_insert(0) += 1;
                }
            }
            "macro_invocation" => {
                if let Some(name_node) = node.child_by_field_name("macro") {
                    if let Ok(text) = name_node.utf8_text(source) {
                        if let Some(name) = extract_identifier_token(text) {
                            *calls.entry(name).or_insert(0) += 1;
                        }
                    }
                }
            }
            _ => {}
        },
        StaticLanguage::TypeScript | StaticLanguage::JavaScript => match kind {
            "import_statement" => {
                if let Ok(text) = node.utf8_text(source) {
                    for token in extract_quoted_tokens(text) {
                        push_import_token(&token, imports);
                    }
                }
            }
            "function_declaration" => {
                push_definition_from_field(node, source, "name", "function", definitions);
            }
            "class_declaration" => {
                push_definition_from_field(node, source, "name", "type", definitions);
            }
            "method_definition" => {
                push_definition_from_field(node, source, "name", "method", definitions);
            }
            "variable_declarator" => {
                push_definition_from_field(node, source, "name", "value", definitions);
            }
            "call_expression" => {
                if let Some(name) = call_name_from_node(node, source) {
                    *calls.entry(name).or_insert(0) += 1;
                }
            }
            _ => {}
        },
        StaticLanguage::Python => match kind {
            "import_statement" | "import_from_statement" => {
                if let Ok(text) = node.utf8_text(source) {
                    for token in extract_python_import_tokens(text) {
                        push_import_token(&token, imports);
                    }
                }
            }
            "function_definition" => {
                push_definition_from_field(node, source, "name", "function", definitions);
            }
            "class_definition" => {
                push_definition_from_field(node, source, "name", "type", definitions);
            }
            "call" => {
                if let Some(name) = call_name_from_node(node, source) {
                    *calls.entry(name).or_insert(0) += 1;
                }
            }
            _ => {}
        },
        StaticLanguage::Go => match kind {
            "import_spec" => {
                if let Ok(text) = node.utf8_text(source) {
                    for token in extract_quoted_tokens(text) {
                        push_import_token(&token, imports);
                    }
                }
            }
            "function_declaration" | "method_declaration" => {
                push_definition_from_field(node, source, "name", "function", definitions);
            }
            "type_spec" => {
                push_definition_from_field(node, source, "name", "type", definitions);
            }
            "call_expression" => {
                if let Some(name) = call_name_from_node(node, source) {
                    *calls.entry(name).or_insert(0) += 1;
                }
            }
            _ => {}
        },
        StaticLanguage::Java
        | StaticLanguage::Kotlin
        | StaticLanguage::CFamily
        | StaticLanguage::Shell
        | StaticLanguage::Other => {}
    }
}

fn collect_facts_from_lines(
    language: StaticLanguage,
    content: &str,
    definitions: &mut Vec<SymbolDef>,
    imports: &mut Vec<String>,
    calls: &mut HashMap<String, usize>,
) {
    for (line_idx, line) in content.lines().enumerate() {
        let line_number = line_idx + 1;
        let trimmed = line.trim();
        if trimmed.is_empty() || is_comment_line(trimmed, language) {
            continue;
        }

        parse_imports_for_line(language, trimmed, imports);
        let before_defs = definitions.len();
        parse_definitions_for_line(language, trimmed, line_number, definitions);
        let line_has_definition = definitions.len() > before_defs;
        parse_calls_for_line(trimmed, line_has_definition, calls);
    }
}

fn push_definition_from_field(
    node: Node,
    source: &[u8],
    field: &str,
    kind: &'static str,
    out: &mut Vec<SymbolDef>,
) {
    let Some(name_node) = node.child_by_field_name(field) else {
        return;
    };
    let Ok(raw_name) = name_node.utf8_text(source) else {
        return;
    };
    let Some(name) = extract_identifier_token(raw_name) else {
        return;
    };

    out.push(SymbolDef {
        name,
        kind,
        line: name_node.start_position().row + 1,
    });
}

fn call_name_from_node(node: Node, source: &[u8]) -> Option<String> {
    let callee = node
        .child_by_field_name("function")
        .or_else(|| node.child_by_field_name("name"))
        .or_else(|| node.child(0))
        .unwrap_or(node);

    let text = callee.utf8_text(source).ok()?;
    extract_identifier_token(text)
}

fn extract_identifier_token(raw: &str) -> Option<String> {
    let mut token = raw.trim();
    if token.is_empty() {
        return None;
    }

    if let Some((_, right)) = token.rsplit_once("::") {
        token = right;
    }
    if let Some((_, right)) = token.rsplit_once("->") {
        token = right;
    }
    if let Some((_, right)) = token.rsplit_once('.') {
        token = right;
    }

    token = token.trim().trim_end_matches('!').trim();

    let caps = re_identifier().captures(token)?;
    let ident = caps.get(1)?.as_str();
    if ident.is_empty() || is_call_keyword(ident) {
        return None;
    }

    Some(ident.to_string())
}

fn extract_quoted_tokens(text: &str) -> Vec<String> {
    re_quoted()
        .captures_iter(text)
        .filter_map(|caps| {
            caps.get(1)
                .or_else(|| caps.get(2))
                .map(|m| m.as_str().to_string())
        })
        .collect()
}

fn extract_rust_use_tokens(text: &str) -> Vec<String> {
    let cleaned = text
        .trim()
        .trim_start_matches("use")
        .trim_end_matches(';')
        .trim();
    if cleaned.is_empty() {
        return Vec::new();
    }

    // `use foo::{bar, baz};` => keep both `foo` and `foo/bar` style inference hints.
    if let Some((prefix, rest)) = cleaned.split_once("::{") {
        let prefix = prefix.trim();
        let inner = rest.trim_end_matches('}');
        let mut out = vec![prefix.to_string()];
        for part in inner.split(',') {
            let name = part.trim();
            if name.is_empty() || name == "self" {
                continue;
            }
            out.push(format!("{prefix}::{name}"));
        }
        return out;
    }

    vec![cleaned.to_string()]
}

fn extract_python_import_tokens(text: &str) -> Vec<String> {
    let line = text.trim();
    if let Some(rest) = line.strip_prefix("from ") {
        if let Some((module, _tail)) = rest.split_once(" import") {
            return vec![module.trim().to_string()];
        }
    }
    if let Some(rest) = line.strip_prefix("import ") {
        return rest
            .split(',')
            .map(|part| part.trim())
            .filter(|part| !part.is_empty())
            .map(|part| part.split_whitespace().next().unwrap_or(part).to_string())
            .collect();
    }
    Vec::new()
}

fn build_import_index(files: &[FileStaticFactsInput]) -> ImportIndex {
    let mut path_set = HashSet::new();
    let mut by_stem: HashMap<String, Vec<String>> = HashMap::new();
    let mut by_no_ext: HashMap<String, Vec<String>> = HashMap::new();

    for file in files {
        let normalized = normalize_rel_path(&file.path);
        path_set.insert(normalized.clone());

        if let Some(stem) = file_stem(&normalized) {
            by_stem.entry(stem).or_default().push(normalized.clone());
        }

        let no_ext = strip_extension(&normalized);
        by_no_ext
            .entry(no_ext)
            .or_default()
            .push(normalized.clone());
    }

    for paths in by_stem.values_mut() {
        paths.sort();
        paths.dedup();
    }
    for paths in by_no_ext.values_mut() {
        paths.sort();
        paths.dedup();
    }

    ImportIndex {
        path_set,
        by_stem,
        by_no_ext,
    }
}

fn add_import_edges(
    files: &[FileStaticFactsInput],
    index: &ImportIndex,
    edges: &mut HashMap<(String, String, String), EdgeAccumulator>,
) {
    for file in files {
        for import in &file.imports {
            let targets = resolve_import_targets(&file.path, file.language, import, index);
            for (target, confidence) in targets {
                add_edge_weight(edges, &file.path, &target, "imports", 1, confidence);
            }
        }
    }
}

fn add_call_edges(
    files: &[FileStaticFactsInput],
    edges: &mut HashMap<(String, String, String), EdgeAccumulator>,
) {
    let mut defs_by_name: HashMap<String, Vec<DefinitionRef>> = HashMap::new();
    for file in files {
        for def in &file.definitions {
            defs_by_name
                .entry(normalize_symbol_name(&def.name))
                .or_default()
                .push(DefinitionRef {
                    path: file.path.clone(),
                    kind: def.kind,
                    line: def.line,
                });
        }
    }

    for defs in defs_by_name.values_mut() {
        defs.sort_by(|a, b| {
            if a.path != b.path {
                return a.path.cmp(&b.path);
            }
            a.line.cmp(&b.line)
        });
    }

    for file in files {
        for (call_name, count) in &file.calls {
            if *count == 0 {
                continue;
            }
            let key = normalize_symbol_name(call_name);
            let Some(defs) = defs_by_name.get(&key) else {
                continue;
            };

            let targets = rank_call_targets(&file.path, defs);
            if targets.is_empty() {
                continue;
            }

            for (target_path, confidence) in targets.into_iter().take(MAX_CALL_TARGETS) {
                add_edge_weight(edges, &file.path, &target_path, "calls", *count, confidence);
            }
        }
    }
}

fn rank_call_targets(source_path: &str, defs: &[DefinitionRef]) -> Vec<(String, f32)> {
    let source_dir = parent_dir(source_path);
    let source_top = top_segment(source_path);
    let mut scores = BTreeMap::<String, f32>::new();

    for def in defs {
        let mut score = 0.35;
        if def.path == source_path {
            score += 0.28;
        }
        if parent_dir(&def.path) == source_dir {
            score += 0.2;
        }
        if top_segment(&def.path) == source_top {
            score += 0.12;
        }
        if def.kind == "function" || def.kind == "method" {
            score += 0.1;
        }

        let entry = scores.entry(def.path.clone()).or_insert(0.0);
        if score > *entry {
            *entry = score;
        }
    }

    let mut ranked = scores.into_iter().collect::<Vec<_>>();
    ranked.sort_by(|a, b| {
        b.1.partial_cmp(&a.1)
            .unwrap_or(Ordering::Equal)
            .then_with(|| a.0.cmp(&b.0))
    });

    let mut out = Vec::new();
    for (idx, (path, score)) in ranked.into_iter().enumerate() {
        if idx >= MAX_CALL_TARGETS {
            break;
        }
        out.push((path, score.clamp(0.2, 0.95)));
    }
    out
}

fn resolve_import_targets(
    source_path: &str,
    language: StaticLanguage,
    raw_import: &str,
    index: &ImportIndex,
) -> Vec<(String, f32)> {
    let token = sanitize_import_token(raw_import);
    if token.is_empty() {
        return Vec::new();
    }

    let mut matches = Vec::<(String, f32)>::new();
    let source_dir = parent_dir(source_path);

    if token.starts_with("./") || token.starts_with("../") {
        let joined = normalize_join(&source_dir, &token);
        extend_path_candidates(&joined, language, index, 0.95, &mut matches);
        return dedup_targets(matches);
    }

    if language == StaticLanguage::Rust && token.contains("::") {
        let rust_mod = token
            .split("::")
            .filter(|segment| !matches!(*segment, "crate" | "self" | "super"))
            .collect::<Vec<_>>()
            .join("/");
        if !rust_mod.is_empty() {
            extend_path_candidates(&rust_mod, language, index, 0.84, &mut matches);
            extend_path_candidates(
                &format!("src/{rust_mod}"),
                language,
                index,
                0.8,
                &mut matches,
            );
            return dedup_targets(matches);
        }
    }

    if language == StaticLanguage::Python && token.contains('.') {
        let python_mod = token.replace('.', "/");
        extend_path_candidates(&python_mod, language, index, 0.82, &mut matches);
        return dedup_targets(matches);
    }

    if token.contains('/') {
        extend_path_candidates(&token, language, index, 0.8, &mut matches);
        return dedup_targets(matches);
    }

    if let Some(paths) = index.by_stem.get(&token) {
        for path in paths.iter().take(MAX_STEM_MATCHES) {
            matches.push((path.clone(), 0.56));
        }
    }

    let token_no_ext = strip_extension(&token);
    if let Some(paths) = index.by_no_ext.get(&token_no_ext) {
        for path in paths.iter().take(MAX_STEM_MATCHES) {
            matches.push((path.clone(), 0.62));
        }
    }

    dedup_targets(matches)
}

fn extend_path_candidates(
    base: &str,
    language: StaticLanguage,
    index: &ImportIndex,
    confidence: f32,
    out: &mut Vec<(String, f32)>,
) {
    let normalized = normalize_rel_path(base);
    if index.path_set.contains(&normalized) {
        out.push((normalized.clone(), confidence));
    }

    for ext in language.import_extension_candidates() {
        let candidate = if normalized.ends_with(ext) {
            normalized.clone()
        } else {
            format!("{normalized}{ext}")
        };
        if index.path_set.contains(&candidate) {
            out.push((candidate, confidence));
        }
    }

    for tail in [
        "/mod.rs",
        "/index.ts",
        "/index.tsx",
        "/index.js",
        "/__init__.py",
    ] {
        let candidate = format!("{normalized}{tail}");
        if index.path_set.contains(&candidate) {
            out.push((candidate, confidence - 0.04));
        }
    }
}

fn dedup_targets(matches: Vec<(String, f32)>) -> Vec<(String, f32)> {
    if matches.is_empty() {
        return matches;
    }

    let mut by_path = BTreeMap::<String, f32>::new();
    for (path, confidence) in matches {
        let entry = by_path.entry(path).or_insert(0.0);
        if confidence > *entry {
            *entry = confidence;
        }
    }

    let mut out = by_path.into_iter().collect::<Vec<_>>();
    out.sort_by(|a, b| {
        b.1.partial_cmp(&a.1)
            .unwrap_or(Ordering::Equal)
            .then_with(|| a.0.cmp(&b.0))
    });
    out
}

fn add_edge_weight(
    edges: &mut HashMap<(String, String, String), EdgeAccumulator>,
    source_path: &str,
    target_path: &str,
    kind: &str,
    weight: usize,
    confidence: f32,
) {
    if source_path == target_path || weight == 0 {
        return;
    }

    let key = (
        normalize_rel_path(source_path),
        normalize_rel_path(target_path),
        kind.to_string(),
    );

    let entry = edges.entry(key).or_default();
    entry.weight += weight;
    entry.confidence_weighted += confidence.clamp(0.0, 1.0) * weight as f32;
    entry.hits += weight;
}

fn compare_static_edges(a: &StaticEdge, b: &StaticEdge) -> Ordering {
    let score_a = a.weight as f32 * (0.4 + a.confidence);
    let score_b = b.weight as f32 * (0.4 + b.confidence);
    score_b
        .partial_cmp(&score_a)
        .unwrap_or(Ordering::Equal)
        .then_with(|| b.weight.cmp(&a.weight))
        .then_with(|| {
            b.confidence
                .partial_cmp(&a.confidence)
                .unwrap_or(Ordering::Equal)
        })
        .then_with(|| a.source_path.cmp(&b.source_path))
        .then_with(|| a.target_path.cmp(&b.target_path))
}

fn parse_imports_for_line(language: StaticLanguage, line: &str, out: &mut Vec<String>) {
    match language {
        StaticLanguage::Java | StaticLanguage::Kotlin => {
            if let Some(caps) = re_java_import().captures(line) {
                if let Some(value) = caps.get(1) {
                    push_import_token(value.as_str(), out);
                }
            }
        }
        StaticLanguage::CFamily => {
            if let Some(caps) = re_c_include().captures(line) {
                if let Some(value) = caps.get(1) {
                    push_import_token(value.as_str(), out);
                }
            }
        }
        StaticLanguage::Shell
        | StaticLanguage::Other
        | StaticLanguage::Rust
        | StaticLanguage::TypeScript
        | StaticLanguage::JavaScript
        | StaticLanguage::Python
        | StaticLanguage::Go => {}
    }
}

fn parse_definitions_for_line(
    language: StaticLanguage,
    line: &str,
    line_number: usize,
    out: &mut Vec<SymbolDef>,
) {
    match language {
        StaticLanguage::Java | StaticLanguage::Kotlin => {
            capture_definition(re_java_method(), line, line_number, "function", out);
            capture_definition(re_java_type(), line, line_number, "type", out);
        }
        StaticLanguage::CFamily => {
            capture_definition(re_c_func(), line, line_number, "function", out);
            capture_definition(re_c_type(), line, line_number, "type", out);
        }
        StaticLanguage::Shell
        | StaticLanguage::Other
        | StaticLanguage::Rust
        | StaticLanguage::TypeScript
        | StaticLanguage::JavaScript
        | StaticLanguage::Python
        | StaticLanguage::Go => {}
    }
}

fn parse_calls_for_line(line: &str, line_has_definition: bool, out: &mut HashMap<String, usize>) {
    if line_has_definition {
        return;
    }

    for caps in re_call_like().captures_iter(line) {
        let Some(name) = caps.get(1).map(|m| m.as_str()) else {
            continue;
        };
        if is_call_keyword(name) {
            continue;
        }
        *out.entry(name.to_string()).or_insert(0) += 1;
    }
}

fn capture_definition(
    regex: &Regex,
    line: &str,
    line_number: usize,
    kind: &'static str,
    out: &mut Vec<SymbolDef>,
) {
    let Some(caps) = regex.captures(line) else {
        return;
    };
    let Some(name) = caps.get(1).map(|m| m.as_str().trim()) else {
        return;
    };
    if name.is_empty() {
        return;
    }
    out.push(SymbolDef {
        name: name.to_string(),
        kind,
        line: line_number,
    });
}

fn push_import_token(raw: &str, out: &mut Vec<String>) {
    let token = sanitize_import_token(raw);
    if token.is_empty() {
        return;
    }
    out.push(token);
}

fn sanitize_import_token(raw: &str) -> String {
    let mut token = raw.trim().trim_matches('"').trim_matches('\'').to_string();
    if token.is_empty() {
        return String::new();
    }

    if let Some((before, _)) = token.split_once(" as ") {
        token = before.trim().to_string();
    }
    if let Some((before, _)) = token.split_once("::{") {
        token = before.trim().to_string();
    }
    token = token
        .trim_matches(|c: char| c == '{' || c == '}' || c == '(' || c == ')' || c == ';')
        .trim()
        .to_string();

    normalize_rel_path(&token)
}

fn normalize_rel_path(path: &str) -> String {
    let mut normalized = path.trim().replace('\\', "/");
    while normalized.starts_with("./") {
        normalized = normalized.trim_start_matches("./").to_string();
    }
    while normalized.contains("//") {
        normalized = normalized.replace("//", "/");
    }
    normalized.trim_start_matches('/').trim().to_string()
}

fn normalize_join(base_dir: &str, rel: &str) -> String {
    let mut parts = Vec::<String>::new();
    for part in base_dir.split('/').filter(|segment| !segment.is_empty()) {
        parts.push(part.to_string());
    }

    let rel_clean = normalize_rel_path(rel);
    for part in rel_clean.split('/').filter(|segment| !segment.is_empty()) {
        if part == "." {
            continue;
        }
        if part == ".." {
            parts.pop();
            continue;
        }
        parts.push(part.to_string());
    }

    parts.join("/")
}

fn parent_dir(path: &str) -> String {
    let normalized = normalize_rel_path(path);
    match normalized.rsplit_once('/') {
        Some((left, _)) => left.to_string(),
        None => String::new(),
    }
}

fn top_segment(path: &str) -> String {
    normalize_rel_path(path)
        .split('/')
        .next()
        .unwrap_or("")
        .to_string()
}

fn strip_extension(path: &str) -> String {
    let normalized = normalize_rel_path(path);
    let last = normalized
        .rsplit_once('/')
        .map(|(_, right)| right)
        .unwrap_or(&normalized);
    if let Some((base, ext)) = last.rsplit_once('.') {
        if !base.is_empty() && !ext.is_empty() {
            let prefix = normalized.strip_suffix(last).unwrap_or("");
            return format!("{prefix}{base}");
        }
    }
    normalized
}

fn file_stem(path: &str) -> Option<String> {
    let normalized = normalize_rel_path(path);
    let last = normalized
        .rsplit_once('/')
        .map(|(_, right)| right)
        .unwrap_or(&normalized);
    if last.is_empty() {
        return None;
    }
    let stem = last.split('.').next().unwrap_or(last).trim();
    if stem.is_empty() {
        None
    } else {
        Some(stem.to_string())
    }
}

fn normalize_symbol_name(name: &str) -> String {
    name.to_ascii_lowercase()
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric() || *ch == '_')
        .collect()
}

fn round_3(value: f32) -> f32 {
    (value * 1000.0).round() / 1000.0
}

fn is_comment_line(line: &str, language: StaticLanguage) -> bool {
    let trimmed = line.trim_start();
    if trimmed.starts_with("//")
        || trimmed.starts_with('#')
        || trimmed.starts_with("/*")
        || trimmed.starts_with('*')
        || trimmed.starts_with("--")
    {
        return true;
    }
    if language == StaticLanguage::Python && trimmed.starts_with("\"\"\"") {
        return true;
    }
    false
}

fn is_call_keyword(token: &str) -> bool {
    matches!(
        token,
        "if" | "else"
            | "for"
            | "while"
            | "loop"
            | "match"
            | "switch"
            | "catch"
            | "return"
            | "sizeof"
            | "typeof"
            | "new"
            | "fn"
            | "def"
            | "class"
            | "struct"
            | "enum"
            | "trait"
            | "impl"
            | "import"
            | "from"
            | "await"
            | "yield"
            | "assert"
            | "println"
            | "format"
            | "vec"
            | "some"
            | "none"
            | "ok"
            | "err"
    )
}

fn re_quoted() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r#"\"([^\"]+)\"|'([^']+)'"#).expect("valid regex"))
}

fn re_identifier() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"([A-Za-z_][A-Za-z0-9_]*)").expect("valid regex"))
}

fn re_java_import() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^\s*import\s+([A-Za-z0-9_\.]+)\s*;").expect("valid regex"))
}

fn re_c_include() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r#"^\s*#include\s+[<\"]([^\">]+)[>\"]"#).expect("valid regex"))
}

fn re_java_method() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(
            r"^\s*(?:public|private|protected|internal)?\s*(?:static\s+)?(?:final\s+)?[A-Za-z0-9_<>\[\]]+\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(",
        )
        .expect("valid regex")
    })
}

fn re_java_type() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"^\s*(?:public|private|protected|internal)?\s*(?:class|interface|enum|object)\s+([A-Za-z_][A-Za-z0-9_]*)")
            .expect("valid regex")
    })
}

fn re_c_func() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"^\s*[A-Za-z_][A-Za-z0-9_\s\*]+\s+([A-Za-z_][A-Za-z0-9_]*)\s*\([^;]*\)\s*\{")
            .expect("valid regex")
    })
}

fn re_c_type() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"^\s*(?:typedef\s+)?(?:struct|enum|union|class)\s+([A-Za-z_][A-Za-z0-9_]*)")
            .expect("valid regex")
    })
}

fn re_call_like() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"\b([A-Za-z_][A-Za-z0-9_]*)\s*\(").expect("valid regex"))
}
