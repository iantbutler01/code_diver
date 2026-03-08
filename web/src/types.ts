// Matches Rust GraphData from parser.rs

export type GitDiffStatus = "added" | "modified" | "deleted";

export interface GraphData {
  project_root: string;
  generated_at: string;
  overview: OverviewDoc | null;
  modules: ModuleDoc[];
  files: FileDiveDoc[];
  static_analysis: StaticAnalysis;
  coverage: GraphCoverage;
  diagnostics: ParseDiagnostic[];
  git_status: Record<string, GitDiffStatus>;
}

export interface GraphCoverage {
  static_files: number;
  represented_files: number;
  missing_files: number;
  represented_pct: number;
  group_coverage: GroupCoverage[];
}

export interface GroupCoverage {
  group_id: string;
  static_files: number;
  represented_files: number;
  missing_files: number;
  represented_pct: number;
}

export interface OverviewDoc {
  path: string;
  description: string;
  components: ComponentEntry[];
  relationships: string[];
  raw_markdown: string;
}

export interface ComponentEntry {
  name: string;
  description: string;
  target: string | null;
}

export interface ModuleDoc {
  name: string;
  title: string;
  path: string;
  description: string;
  files: ModuleFileEntry[];
  relationships: string[];
  raw_markdown: string;
}

export interface ModuleFileEntry {
  path: string;
  description: string;
}

export interface FileDiveDoc {
  path: string;
  abs_path: string;
  dive_file: string | null;
  dive_rel: string[];
  tags: DiveTag[];
}

export interface StaticAnalysis {
  files_analyzed: number;
  file_facts: StaticFileFacts[];
  edges: StaticEdge[];
  truncated: boolean;
}

export interface StaticFileFacts {
  path: string;
  language: string;
  symbol_count: number;
  import_count: number;
  call_count: number;
}

export interface StaticEdge {
  source_path: string;
  target_path: string;
  kind: string;
  weight: number;
  confidence: number;
}

export interface DiveTag {
  line: number;
  description: string;
}

export type ParseDiagnosticScope =
  | "overview.components"
  | "overview.relationships"
  | "module.files"
  | "module.relationships";

export type ParseDiagnosticCode =
  | "unparsed_component_line"
  | "unparsed_relationship_line"
  | "unparsed_module_file_line"
  | "duplicate_component_name";

export interface ParseDiagnostic {
  path: string;
  scope: ParseDiagnosticScope;
  line: number | null;
  code: ParseDiagnosticCode;
  message: string;
  raw: string;
  related: string[];
}

export interface MarkdownDoc {
  path: string;
  content: string;
}

// Navigation

export type NavLevel = "system" | "module" | "file" | "doc";

export interface NavEntry {
  level: NavLevel;
  label: string;
  /** Module name or file path, undefined for system */
  id?: string;
}
