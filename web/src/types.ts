// Matches Rust GraphData from parser.rs

export interface GraphData {
  project_root: string;
  generated_at: string;
  overview: OverviewDoc | null;
  modules: ModuleDoc[];
  files: FileDiveDoc[];
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

export interface DiveTag {
  line: number;
  description: string;
}

// Navigation

export type NavLevel = "system" | "module" | "file";

export interface NavEntry {
  level: NavLevel;
  label: string;
  /** Module name or file path, undefined for system */
  id?: string;
}
