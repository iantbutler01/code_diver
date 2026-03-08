import type { Node, Edge } from "@xyflow/react";
import type {
  GraphData,
  GitDiffStatus,
  NavEntry,
  ModuleDoc,
  FileDiveDoc,
  OverviewDoc,
  ComponentEntry,
  StaticEdge,
} from "../types";
import { graphColors } from "./colors";

const CLUSTER_THRESHOLD = 8;
const MAX_STATIC_EDGE_INSERTIONS = 9000;

interface ComponentRecord {
  key: string;
  sourceIndex: number;
  name: string;
  description: string;
  target: string | null;
  normName: string;
}

interface BuildOptions {
  parentSummary?: {
    groupId: string;
    label: string;
    totalComponents: number;
    componentNames: string[];
    folderHints: string[];
  };
  fileGroupsAreLeaf?: boolean;
}

interface ParsedRel {
  src: string;
  tgt: string;
  label: string;
  raw: string;
}

interface ComponentGroup {
  id: string;
  label: string;
}

interface ModuleComponentBucket {
  id: string;
  label: string;
  comps: ComponentRecord[];
}

interface EdgeData extends Record<string, unknown> {
  kind?: "structure" | "relationship";
  layout?: boolean;
  bundledCount?: number;
  ambiguous?: boolean;
  raw?: string;
  evidence?: string[];
  staticKind?: string;
  staticConfidence?: number;
  policyScore?: number;
  policySelected?: boolean;
  policySuppressed?: boolean;
  policyReason?: string[];
  parallelCentered?: number;
  parallelCount?: number;
  collapsedLabels?: string[];
  collapsedEdgeCount?: number;
}

interface WeightedDirectedEdge {
  source: string;
  target: string;
  weight: number;
}

interface FlowStats {
  incoming: number;
  outgoing: number;
  degree: number;
  net: number;
}

interface PlannerNodeData {
  name?: string;
  groupId?: string;
  path?: string;
  target?: string | null;
  moduleId?: string | null;
  dirPath?: string | null;
  children?: string[];
}

interface RelationCandidate {
  index: number;
  source: string;
  target: string;
  score: number;
  weight: number;
  hasSemantic: boolean;
  hasStatic: boolean;
  reasons: string[];
}

export interface GraphScopeCoverage {
  staticFiles: number;
  representedFiles: number;
  missingFiles: number;
  representedPct: number;
  missingSample: string[];
}

const TEST_SEGMENTS = new Set([
  "test",
  "tests",
  "__tests__",
  "e2e",
  "integration",
  "unit",
  "bench",
  "benches",
]);

const SPEC_SEGMENTS = new Set([
  "spec",
  "specs",
]);

const SCRIPT_SEGMENTS = new Set([
  "script",
  "scripts",
  "bin",
  "tools",
  "tooling",
  "hack",
]);

const DOC_SEGMENTS = new Set([
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
]);

const CONFIG_SEGMENTS = new Set([
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
]);

const MODULE_CLUSTER_PREFIX = "modulecluster::";
const MODULE_DIR_FILTER_PREFIX = "moduledir::";

/** Strip common markdown wrappers and whitespace from target tokens. */
function cleanTarget(t: string | null): string | null {
  if (!t) return null;
  let out = t.trim();

  const mdLink = out.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
  if (mdLink) {
    out = mdLink[2].trim();
  }

  if (out.startsWith("`") && out.endsWith("`") && out.length > 1) {
    out = out.slice(1, -1).trim();
  }

  if (out.startsWith("<") && out.endsWith(">") && out.length > 1) {
    out = out.slice(1, -1).trim();
  }

  out = out.trim();
  return out || null;
}

function normalizeName(value: string): string {
  return value.toLowerCase().replace(/[\s_-]+/g, "");
}

function unwrapEntityToken(value: string): string {
  let out = value.trim();

  const mdLink = out.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
  if (mdLink) {
    out = mdLink[1].trim() || mdLink[2].trim();
  }

  if (out.startsWith("`") && out.endsWith("`") && out.length > 1) {
    out = out.slice(1, -1).trim();
  }

  if (out.startsWith("<") && out.endsWith(">") && out.length > 1) {
    out = out.slice(1, -1).trim();
  }

  return out.replace(/^[-–:>\s]+|[-–:<\s]+$/g, "").trim();
}

function normalizeTargetPath(value: string): string {
  return value
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/^\/+/, "")
    .replace(/\/+/g, "/");
}

function getPathSegments(target: string): string[] {
  const normalized = normalizeTargetPath(target);
  return normalized
    .split("/")
    .map((segment) => segment.trim().toLowerCase())
    .filter(Boolean);
}

function gitStatusRank(status: GitDiffStatus | null | undefined): number {
  if (status === "deleted") return 3;
  if (status === "added") return 2;
  if (status === "modified") return 1;
  return 0;
}

function mergeGitStatus(
  current: GitDiffStatus | undefined,
  next: GitDiffStatus | undefined
): GitDiffStatus | undefined {
  if (!next) return current;
  if (!current) return next;
  return gitStatusRank(next) > gitStatusRank(current) ? next : current;
}

function isDirectoryLikePath(path: string): boolean {
  if (!path) return false;
  if (path.endsWith("/")) return true;
  const last = path.split("/").pop() || "";
  return !last.includes(".");
}

function gitStatusForPath(
  gitStatus: Record<string, GitDiffStatus> | undefined,
  path: string | null | undefined
): GitDiffStatus | undefined {
  if (!gitStatus || !path) return undefined;
  const normalized = normalizeTargetPath(path);
  if (!normalized) return undefined;

  const exact = gitStatus[normalized];
  if (exact) return exact;

  if (!isDirectoryLikePath(normalized)) {
    return undefined;
  }

  const prefix = `${normalized.replace(/\/+$/, "")}/`;
  let merged: GitDiffStatus | undefined;
  for (const [changedPath, status] of Object.entries(gitStatus)) {
    if (!changedPath.startsWith(prefix)) continue;
    merged = mergeGitStatus(merged, status);
  }
  return merged;
}

function gitStatusForTargets(
  gitStatus: Record<string, GitDiffStatus> | undefined,
  targets: Array<string | null | undefined>
): GitDiffStatus | undefined {
  let merged: GitDiffStatus | undefined;
  for (const target of targets) {
    merged = mergeGitStatus(merged, gitStatusForPath(gitStatus, target));
  }
  return merged;
}

function hasAnySegment(
  segments: string[],
  candidates: Set<string>
): boolean {
  return segments.some((segment) => candidates.has(segment));
}

function classifyComponentGroup(target: string | null): ComponentGroup {
  if (!target) {
    return { id: "other", label: "other" };
  }

  const segments = getPathSegments(target);
  if (segments.length === 0) {
    return { id: "other", label: "other" };
  }

  if (hasAnySegment(segments, TEST_SEGMENTS)) {
    return { id: "semantic:tests", label: "tests" };
  }

  if (hasAnySegment(segments, SPEC_SEGMENTS)) {
    return { id: "semantic:specs", label: "specs" };
  }

  if (hasAnySegment(segments, SCRIPT_SEGMENTS)) {
    return { id: "semantic:scripts", label: "scripts" };
  }

  if (hasAnySegment(segments, DOC_SEGMENTS)) {
    return { id: "semantic:docs", label: "docs" };
  }

  if (hasAnySegment(segments, CONFIG_SEGMENTS)) {
    return { id: "semantic:config", label: "config" };
  }

  const top = segments[0];
  if (segments.length === 1 && top.includes(".")) {
    return { id: "path:root", label: "root" };
  }

  return { id: `path:${top}`, label: top };
}

function groupLabelFromId(groupId: string): string {
  if (groupId === "__all__") return "system";
  if (groupId === "other") return "other";
  if (groupId === "semantic:tests") return "tests";
  if (groupId === "semantic:specs") return "specs";
  if (groupId === "semantic:scripts") return "scripts";
  if (groupId === "semantic:docs") return "docs";
  if (groupId === "semantic:config") return "config";
  if (groupId.startsWith("path:")) {
    const label = groupId.slice(5).trim();
    return label || "root";
  }
  return groupId;
}

function folderHintKeyForTarget(target: string, groupId?: string): string {
  const segments = getPathSegments(target);
  if (segments.length === 0) return "root";

  const groupPath = groupId?.startsWith("path:") ? groupId.slice(5) : "";
  if (groupPath && segments[0] === groupPath) {
    if (segments.length > 1) return `${segments[0]}/${segments[1]}`;
    return segments[0];
  }

  if (segments.length > 1) return `${segments[0]}/${segments[1]}`;
  return segments[0];
}

function deriveFolderHints(
  components: ComponentRecord[],
  groupId?: string,
  maxHints = 4
): string[] {
  const counts = new Map<string, number>();
  for (const comp of components) {
    if (!comp.target) continue;
    const key = folderHintKeyForTarget(comp.target, groupId);
    counts.set(key, (counts.get(key) || 0) + 1);
  }

  return [...counts.entries()]
    .sort((a, b) => {
      if (b[1] !== a[1]) return b[1] - a[1];
      return a[0].localeCompare(b[0]);
    })
    .slice(0, maxHints)
    .map(([hint, count]) => `${hint}/ (${count})`);
}

function matchesGroup(comp: ComponentRecord, groupId: string): boolean {
  if (groupId === "__all__") return true;
  const bucket = classifyComponentGroup(comp.target);
  if (bucket.id === groupId) return true;

  // Backward-compatibility for pre-semantic ids (eg "crates").
  if (!groupId.includes(":")) {
    if (!comp.target) return groupId === "other";
    return comp.target.startsWith(groupId);
  }

  return false;
}

function makeModuleClusterFilterId(baseGroupId: string, moduleBucketId: string): string {
  return `${MODULE_CLUSTER_PREFIX}${encodeURIComponent(baseGroupId)}::${encodeURIComponent(moduleBucketId)}`;
}

function parseModuleClusterFilterId(
  filterId: string
): { baseGroupId: string; moduleBucketId: string } | null {
  if (!filterId.startsWith(MODULE_CLUSTER_PREFIX)) return null;
  const payload = filterId.slice(MODULE_CLUSTER_PREFIX.length);
  const sep = payload.indexOf("::");
  if (sep < 0) return null;

  const rawGroup = payload.slice(0, sep);
  const rawBucket = payload.slice(sep + 2);
  if (!rawGroup || !rawBucket) return null;

  try {
    const baseGroupId = decodeURIComponent(rawGroup);
    const moduleBucketId = decodeURIComponent(rawBucket);
    if (!baseGroupId || !moduleBucketId) return null;
    return { baseGroupId, moduleBucketId };
  } catch {
    return null;
  }
}

function makeModuleDirFilterId(moduleId: string, dirPrefix: string): string {
  return `${MODULE_DIR_FILTER_PREFIX}${encodeURIComponent(moduleId)}::${encodeURIComponent(dirPrefix)}`;
}

function parseModuleDirFilterId(
  raw: string
): { moduleId: string; dirPrefix: string } | null {
  if (!raw.startsWith(MODULE_DIR_FILTER_PREFIX)) return null;
  const payload = raw.slice(MODULE_DIR_FILTER_PREFIX.length);
  const sep = payload.indexOf("::");
  if (sep < 0) return null;

  const left = payload.slice(0, sep);
  const right = payload.slice(sep + 2);
  if (!left || !right) return null;

  try {
    const moduleId = decodeURIComponent(left);
    const dirPrefix = normalizeTargetPath(decodeURIComponent(right));
    if (!moduleId || !dirPrefix) return null;
    return { moduleId, dirPrefix };
  } catch {
    return null;
  }
}

interface PathPattern {
  kind: "exact" | "prefix";
  value: string;
}

function isLikelyPathToken(value: string | null | undefined): boolean {
  if (!value) return false;
  const normalized = normalizeTargetPath(value);
  if (!normalized) return false;
  if (normalized.includes("/")) return true;
  const last = normalized.split("/").pop() || normalized;
  return /\.[a-z0-9]{1,8}$/i.test(last);
}

function toPathPattern(rawToken: string): PathPattern | null {
  const normalized = normalizeTargetPath(rawToken);
  if (!normalized) return null;

  if (normalized.includes("*")) {
    const prefix = normalizeTargetPath(normalized.split("*")[0] || "");
    if (!prefix) return null;
    return { kind: "prefix", value: prefix.replace(/\/+$/, "") };
  }

  if (isDirectoryLikePath(normalized)) {
    return {
      kind: "prefix",
      value: normalized.replace(/\/+$/, ""),
    };
  }

  return {
    kind: "exact",
    value: normalized,
  };
}

function pathMatchesPattern(path: string, pattern: PathPattern): boolean {
  if (!pattern.value) return false;
  if (pattern.kind === "exact") return path === pattern.value;
  return path === pattern.value || path.startsWith(`${pattern.value}/`);
}

function staticPaths(data: GraphData): string[] {
  const dedup = new Set<string>();
  for (const facts of data.static_analysis?.file_facts || []) {
    const path = normalizeTargetPath(facts.path);
    if (path) dedup.add(path);
  }
  return [...dedup].sort((a, b) => a.localeCompare(b));
}

function representedPathSet(data: GraphData, staticList: string[]): Set<string> {
  const represented = new Set<string>();
  const exact = new Set<string>();
  const patterns: PathPattern[] = [];

  for (const file of data.files || []) {
    const path = normalizeTargetPath(file.path);
    if (path) {
      exact.add(path);
      patterns.push({ kind: "exact", value: path });
    }
  }

  for (const mod of data.modules || []) {
    for (const file of mod.files || []) {
      const token = normalizeTargetPath(file.path);
      if (!token) continue;
      const pattern = toPathPattern(token);
      if (pattern) patterns.push(pattern);
    }
  }

  const overview = data.overview;
  if (overview) {
    for (const comp of overview.components || []) {
      const target = cleanTarget(comp.target);
      if (!isLikelyPathToken(target)) continue;
      const pattern = toPathPattern(target!);
      if (pattern) patterns.push(pattern);
    }
  }

  for (const path of staticList) {
    if (exact.has(path)) {
      represented.add(path);
      continue;
    }
    if (patterns.some((pattern) => pathMatchesPattern(path, pattern))) {
      represented.add(path);
    }
  }

  return represented;
}

function modulePathPatterns(data: GraphData, moduleId: string): PathPattern[] {
  const patterns: PathPattern[] = [];
  const mod = findModule(data, moduleId);
  if (mod) {
    for (const file of mod.files || []) {
      const pattern = toPathPattern(file.path);
      if (pattern) patterns.push(pattern);
    }
    const basePattern = toPathPattern(`${mod.name}/`);
    if (basePattern) patterns.push(basePattern);
    return patterns;
  }

  const fallback = toPathPattern(`${moduleId}/`);
  if (fallback) patterns.push(fallback);
  return patterns;
}

function pathInScope(path: string, data: GraphData, nav: NavEntry): boolean {
  if (nav.level === "file") {
    const target = normalizeTargetPath(nav.id || "");
    return !!target && path === target;
  }

  if (nav.level === "module") {
    const rawId = nav.id || "";
    const parsedDir = parseModuleDirFilterId(rawId);
    if (parsedDir) {
      const scopePrefix = normalizeTargetPath(parsedDir.dirPrefix);
      return path === scopePrefix || path.startsWith(`${scopePrefix}/`);
    }

    const patterns = modulePathPatterns(data, rawId);
    if (patterns.length === 0) return true;
    return patterns.some((pattern) => pathMatchesPattern(path, pattern));
  }

  if (nav.level === "system") {
    const rawGroup = (nav.id || "").trim();
    if (!rawGroup || rawGroup === "__all__") {
      return true;
    }

    const moduleFilter = parseModuleClusterFilterId(rawGroup);
    const baseGroupId = moduleFilter?.baseGroupId || rawGroup;
    let inBaseGroup = true;
    if (baseGroupId && baseGroupId !== "__all__") {
      inBaseGroup = classifyComponentGroup(path).id === baseGroupId;
      if (!inBaseGroup && !baseGroupId.includes(":")) {
        inBaseGroup = path === baseGroupId || path.startsWith(`${baseGroupId}/`);
      }
    }
    if (!inBaseGroup) return false;

    if (!moduleFilter || moduleFilter.moduleBucketId === "__unmapped__") {
      return true;
    }

    const modulePatterns = modulePathPatterns(data, moduleFilter.moduleBucketId);
    if (modulePatterns.length === 0) return true;
    return modulePatterns.some((pattern) => pathMatchesPattern(path, pattern));
  }

  return true;
}

function pct(represented: number, total: number): number {
  if (total <= 0) return 0;
  return Math.round((represented / total) * 1000) / 10;
}

export function graphScopeCoverage(data: GraphData, nav: NavEntry): GraphScopeCoverage {
  const staticList = staticPaths(data);
  if (staticList.length === 0) {
    return {
      staticFiles: 0,
      representedFiles: 0,
      missingFiles: 0,
      representedPct: 0,
      missingSample: [],
    };
  }

  const represented = representedPathSet(data, staticList);
  let staticFiles = 0;
  let representedFiles = 0;
  const missingSample: string[] = [];

  for (const path of staticList) {
    if (!pathInScope(path, data, nav)) continue;
    staticFiles += 1;
    if (represented.has(path)) {
      representedFiles += 1;
    } else if (missingSample.length < 5) {
      missingSample.push(path);
    }
  }

  const missingFiles = Math.max(0, staticFiles - representedFiles);
  return {
    staticFiles,
    representedFiles,
    missingFiles,
    representedPct: pct(representedFiles, staticFiles),
    missingSample,
  };
}

function attachUnannotatedBucket(
  nodes: Node[],
  edges: Edge[],
  coverage: GraphScopeCoverage,
  nav: NavEntry
) {
  if (coverage.missingFiles <= 0 || nav.level === "file" || nav.level === "diff") return;

  const scopeId = `${nav.level}:${nav.id || "__root__"}`;
  const nodeId = `group:coverage:unannotated:${scopeId}`;
  if (nodes.some((node) => node.id === nodeId)) return;

  nodes.push({
    id: nodeId,
    type: "group",
    position: { x: 0, y: 0 },
    data: {
      name: "Unannotated files",
      count: coverage.missingFiles,
      children: coverage.missingSample,
      groupId: "__coverage_unannotated__",
      folderHints: [`coverage ${coverage.representedFiles}/${coverage.staticFiles} represented`],
      nonNavigable: true,
    },
  });

  const anchor =
    nodes.find((node) => {
      const d = node.data as { isSummary?: boolean };
      return node.id !== nodeId && d?.isSummary;
    }) || nodes.find((node) => node.id !== nodeId);

  if (anchor) {
    addStructuralEdge(edges, anchor.id, nodeId);
  }
}

function changedPaths(data: GraphData): string[] {
  const out = new Set<string>();
  for (const path of Object.keys(data.git_status || {})) {
    const normalized = normalizeTargetPath(path);
    if (!normalized) continue;
    out.add(normalized);
  }
  return [...out].sort((a, b) => a.localeCompare(b));
}

function moduleTokenPatterns(data: GraphData, moduleId: string): string[] {
  const out = new Set<string>();
  const mod = findModule(data, moduleId);
  if (mod) {
    out.add(`${mod.name}/`);
    for (const file of mod.files || []) {
      const normalized = normalizeTargetPath(file.path);
      if (!normalized) continue;
      out.add(normalized);
    }
  } else if (moduleId) {
    out.add(`${normalizeTargetPath(moduleId)}/`);
  }
  return [...out];
}

function changedMatchesToken(
  token: string | null | undefined,
  changed: string[]
): string[] {
  if (!token) return [];
  const pattern = toPathPattern(token);
  if (!pattern) return [];
  return changed.filter((path) => pathMatchesPattern(path, pattern));
}

function changedMatchesChildren(children: unknown, changed: string[]): string[] {
  if (!Array.isArray(children)) return [];
  const matches = new Set<string>();
  for (const raw of children) {
    if (typeof raw !== "string") continue;
    if (!isLikelyPathToken(raw)) continue;
    for (const path of changedMatchesToken(raw, changed)) {
      matches.add(path);
    }
  }
  return [...matches];
}

function nodeDiffPaths(
  node: Node,
  data: GraphData,
  changed: string[]
): string[] {
  const d = node.data as Record<string, unknown>;
  const found = new Set<string>();

  const addMatches = (token: string | null | undefined) => {
    for (const path of changedMatchesToken(token, changed)) {
      found.add(path);
    }
  };

  const addMatchesList = (values: string[]) => {
    for (const value of values) addMatches(value);
  };

  const rawPath = typeof d.path === "string" ? d.path : null;
  const rawTarget = typeof d.target === "string" ? d.target : null;
  const rawDirPath = typeof d.dirPath === "string" ? d.dirPath : null;
  const rawModuleId = typeof d.moduleId === "string" ? d.moduleId : null;
  const rawGroupId = typeof d.groupId === "string" ? d.groupId : null;

  addMatches(rawPath);
  addMatches(rawTarget);
  addMatches(rawDirPath);
  addMatchesList(changedMatchesChildren(d.children, changed));

  if (rawModuleId && rawModuleId.trim()) {
    addMatchesList(moduleTokenPatterns(data, rawModuleId));
  }

  if (rawGroupId && rawGroupId.trim()) {
    if (rawGroupId.startsWith("path:")) {
      addMatches(`${rawGroupId.slice(5)}/`);
    } else if (rawGroupId.startsWith(MODULE_DIR_FILTER_PREFIX)) {
      const parsed = parseModuleDirFilterId(rawGroupId);
      if (parsed) {
        addMatches(`${parsed.dirPrefix}/`);
      }
    } else if (rawGroupId.startsWith(MODULE_CLUSTER_PREFIX)) {
      const parsed = parseModuleClusterFilterId(rawGroupId);
      if (parsed && parsed.moduleBucketId !== "__unmapped__") {
        addMatchesList(moduleTokenPatterns(data, parsed.moduleBucketId));
      }
    } else if (!rawGroupId.includes(":")) {
      addMatches(`${rawGroupId}/`);
      addMatches(rawGroupId);
    }
  }

  if (node.type === "tag") {
    const absPath = typeof d.absPath === "string" ? d.absPath : "";
    const project = normalizeTargetPath(data.project_root);
    if (absPath && project && absPath.startsWith(project)) {
      const rel = normalizeTargetPath(absPath.slice(project.length));
      addMatches(rel);
    }
  }

  return [...found].sort((a, b) => a.localeCompare(b));
}

function annotateNodesWithDiffPaths(data: GraphData, nodes: Node[]): Node[] {
  const changed = changedPaths(data);
  if (changed.length === 0) {
    return nodes.map((node) => ({
      ...node,
      data: {
        ...(node.data as Record<string, unknown>),
        diffPaths: [],
        hasChanges: false,
      },
    }));
  }

  return nodes.map((node) => {
    const diffPaths = nodeDiffPaths(node, data, changed);
    return {
      ...node,
      data: {
        ...(node.data as Record<string, unknown>),
        diffPaths,
        hasChanges: diffPaths.length > 0,
      },
    };
  });
}

function buildModuleBuckets(
  data: GraphData,
  components: ComponentRecord[]
): Map<string, ModuleComponentBucket> {
  const buckets = new Map<string, ModuleComponentBucket>();

  for (const comp of components) {
    const byTarget = comp.target ? findModuleByTarget(data, comp.target) : undefined;
    const byName = byTarget ? undefined : findModule(data, comp.name);
    const moduleRef = byTarget || byName;
    const bucketId = moduleRef?.name || "__unmapped__";
    const bucketLabel = moduleRef?.title?.trim() || moduleRef?.name || "unmapped";
    const bucket = buckets.get(bucketId) || {
      id: bucketId,
      label: bucketLabel,
      comps: [],
    };
    bucket.comps.push(comp);
    buckets.set(bucketId, bucket);
  }

  return buckets;
}

function shouldUseModuleClusters(
  components: ComponentRecord[],
  buckets: Map<string, ModuleComponentBucket>
): boolean {
  if (components.length < 2) return false;
  if (buckets.size < 2) return false;

  let mappedBuckets = 0;
  for (const bucket of buckets.values()) {
    if (bucket.id === "__unmapped__") continue;
    if (bucket.comps.length > 0) mappedBuckets += 1;
  }

  return mappedBuckets >= 2;
}

function prepareComponents(components: ComponentEntry[]): ComponentRecord[] {
  return components.map((comp, sourceIndex) => {
    const target = cleanTarget(comp.target);
    const normName = normalizeName(comp.name);
    const key = `${normName}:${target || "(none)"}:${sourceIndex}`;
    return {
      key,
      sourceIndex,
      name: comp.name,
      description: comp.description,
      target,
      normName,
    };
  });
}

function duplicateNameSet(components: ComponentRecord[]): Set<string> {
  const counts = new Map<string, number>();
  for (const comp of components) {
    counts.set(comp.normName, (counts.get(comp.normName) || 0) + 1);
  }
  return new Set(
    [...counts.entries()]
      .filter(([, count]) => count > 1)
      .map(([normName]) => normName)
  );
}

function addNameNodeMapping(
  map: Map<string, Set<string>>,
  normName: string,
  nodeId: string
) {
  const existing = map.get(normName) || new Set<string>();
  existing.add(nodeId);
  map.set(normName, existing);
}

function addStructuralEdge(edges: Edge[], source: string, target: string) {
  edges.push({
    id: `e-struct-${source}-${target}`,
    source,
    target,
    data: {
      layout: true,
      kind: "structure",
    },
  });
}

function addRelationshipEdge(
  edges: Edge[],
  seen: Set<string>,
  source: string,
  target: string,
  label: string,
  raw: string,
  ambiguous: boolean
) {
  const normLabel = label.toLowerCase().trim();
  const key = `${source}->${target}:${normLabel}`;
  if (seen.has(key)) return;
  seen.add(key);

  edges.push({
    id: `e-rel-${seen.size}`,
    source,
    target,
    label,
    animated: true,
    style: ambiguous
      ? { stroke: graphColors.edgeAmbiguous, strokeWidth: 1.5, strokeDasharray: "5,4" }
      : { stroke: graphColors.edgeRelationship, strokeWidth: 1.5 },
    data: {
      layout: false,
      kind: "relationship",
      ambiguous,
      raw,
      evidence: ["semantic"],
    },
  });
}

function pushBundledRelationshipEdges(
  edges: Edge[],
  aggregated: Map<
    string,
    {
      source: string;
      target: string;
      count: number;
      labels: Set<string>;
      ambiguous: boolean;
    }
  >
) {
  let index = 0;
  for (const entry of aggregated.values()) {
    const labels = [...entry.labels].filter((label) => label.trim().length > 0);

    let label = "";
    if (entry.count > 1) {
      label = `x${entry.count}`;
    }
    if (labels.length === 1) {
      label = label ? `${label} ${labels[0]}` : labels[0];
    } else if (labels.length > 1) {
      const suffix = `${labels.length} rel types`;
      label = label ? `${label} (${suffix})` : suffix;
    }

    edges.push({
      id: `e-grp-bundle-${index}`,
      source: entry.source,
      target: entry.target,
      label: label || undefined,
      animated: true,
      style: entry.ambiguous
        ? { stroke: graphColors.edgeAmbiguous, strokeWidth: 1.5, strokeDasharray: "5,4" }
        : { stroke: graphColors.edgeRelationship, strokeWidth: 1.5 },
      data: {
        layout: false,
        kind: "relationship",
        bundledCount: entry.count,
        ambiguous: entry.ambiguous,
      },
    });
    index += 1;
  }
}

function relationLayoutWeight(edge: Edge): number {
  const data = edge.data as EdgeData | undefined;
  if (typeof data?.bundledCount === "number" && Number.isFinite(data.bundledCount)) {
    return Math.max(1, Math.round(data.bundledCount));
  }
  return 1;
}

function relationVisibilityBudget(
  level: NavEntry["level"],
  nodeCount: number,
  relationCount: number
): number {
  const n = Math.max(1, nodeCount);
  const base =
    level === "system"
      ? Math.round(n * 1.75)
      : level === "module"
        ? Math.round(n * 2.25)
        : Math.round(n * 3);
  const floor = level === "system" ? 14 : level === "module" ? 18 : 10;
  const cap = level === "system" ? 72 : level === "module" ? 120 : 80;
  return Math.max(floor, Math.min(cap, Math.min(base, relationCount)));
}

function pathHintForNode(node: Node): string | null {
  const data = node.data as PlannerNodeData;
  const rawPath =
    data.path?.trim() ||
    data.target?.trim() ||
    data.dirPath?.trim() ||
    "";
  if (!rawPath) return null;
  const segments = normalizeTargetPath(rawPath)
    .split("/")
    .filter(Boolean);
  if (segments.length === 0) return null;
  return segments.length >= 2 ? `${segments[0]}/${segments[1]}` : segments[0];
}

function hasStructuralLayoutEdge(edges: Edge[]): boolean {
  return edges.some((edge) => {
    const data = edge.data as EdgeData | undefined;
    return data?.layout !== false;
  });
}

function directedEdgeKey(source: string, target: string): string {
  return `${source}->${target}`;
}

function buildFlowStats(
  component: string[],
  adjacency: Map<string, Map<string, number>>,
  directedEdges: WeightedDirectedEdge[]
): Map<string, FlowStats> {
  const inComponent = new Set(component);
  const stats = new Map<string, FlowStats>();

  for (const nodeId of component) {
    const neighbors = adjacency.get(nodeId);
    let degree = 0;
    if (neighbors) {
      for (const weight of neighbors.values()) {
        degree += weight;
      }
    }
    stats.set(nodeId, {
      incoming: 0,
      outgoing: 0,
      degree,
      net: 0,
    });
  }

  for (const edge of directedEdges) {
    if (!inComponent.has(edge.source) || !inComponent.has(edge.target)) continue;
    const src = stats.get(edge.source);
    const tgt = stats.get(edge.target);
    if (!src || !tgt) continue;
    src.outgoing += edge.weight;
    tgt.incoming += edge.weight;
  }

  for (const record of stats.values()) {
    record.net = record.outgoing - record.incoming;
  }

  return stats;
}

function pickBackboneRoot(component: string[], stats: Map<string, FlowStats>): string {
  const ranked = [...component].sort((a, b) => {
    const sa = stats.get(a);
    const sb = stats.get(b);
    const netA = sa?.net || 0;
    const netB = sb?.net || 0;
    if (netA !== netB) return netB - netA;

    const outA = sa?.outgoing || 0;
    const outB = sb?.outgoing || 0;
    if (outA !== outB) return outB - outA;

    const degreeA = sa?.degree || 0;
    const degreeB = sb?.degree || 0;
    if (degreeA !== degreeB) return degreeB - degreeA;

    return a.localeCompare(b);
  });

  return ranked[0];
}

function buildConnectedComponents(
  nodeIds: string[],
  adjacency: Map<string, Map<string, number>>
): string[][] {
  const remaining = new Set(nodeIds);
  const components: string[][] = [];

  while (remaining.size > 0) {
    const seed = remaining.values().next().value as string;
    remaining.delete(seed);

    const stack = [seed];
    const component: string[] = [];

    while (stack.length > 0) {
      const current = stack.pop();
      if (!current) continue;
      component.push(current);
      const neighbors = adjacency.get(current);
      if (!neighbors) continue;
      for (const neighbor of neighbors.keys()) {
        if (!remaining.has(neighbor)) continue;
        remaining.delete(neighbor);
        stack.push(neighbor);
      }
    }

    components.push(component);
  }

  return components.sort((a, b) => b.length - a.length);
}

function buildMaxSpanningTree(
  component: string[],
  root: string,
  adjacency: Map<string, Map<string, number>>
): Array<[string, string]> {
  const componentSet = new Set(component);
  const visited = new Set<string>([root]);
  const tree: Array<[string, string]> = [];

  while (visited.size < componentSet.size) {
    let best:
      | {
          from: string;
          to: string;
          weight: number;
        }
      | null = null;

    for (const from of visited) {
      const neighbors = adjacency.get(from);
      if (!neighbors) continue;
      for (const [to, weight] of neighbors) {
        if (!componentSet.has(to) || visited.has(to)) continue;
        if (
          !best ||
          weight > best.weight ||
          (weight === best.weight &&
            (from.localeCompare(best.from) < 0 ||
              (from === best.from && to.localeCompare(best.to) < 0)))
        ) {
          best = { from, to, weight };
        }
      }
    }

    if (!best) {
      const unattached = component
        .filter((id) => !visited.has(id))
        .sort((a, b) => a.localeCompare(b))[0];
      if (!unattached) break;

      const anchor = [...visited].sort((a, b) => a.localeCompare(b))[0];
      if (!anchor) break;
      tree.push([anchor, unattached]);
      visited.add(unattached);
      continue;
    }

    tree.push([best.from, best.to]);
    visited.add(best.to);
  }

  return tree;
}

function orientBackboneEdge(
  a: string,
  b: string,
  directedWeights: Map<string, number>,
  stats: Map<string, FlowStats>
): { source: string; target: string } {
  const ab = directedWeights.get(directedEdgeKey(a, b)) || 0;
  const ba = directedWeights.get(directedEdgeKey(b, a)) || 0;

  if (ab > ba) return { source: a, target: b };
  if (ba > ab) return { source: b, target: a };

  const sa = stats.get(a);
  const sb = stats.get(b);
  const scoreA = (sa?.net || 0) * 100 + (sa?.outgoing || 0) * 10 + (sa?.degree || 0);
  const scoreB = (sb?.net || 0) * 100 + (sb?.outgoing || 0) * 10 + (sb?.degree || 0);

  if (scoreA > scoreB) return { source: a, target: b };
  if (scoreB > scoreA) return { source: b, target: a };

  return a.localeCompare(b) <= 0 ? { source: a, target: b } : { source: b, target: a };
}

function buildRelationBackbone(
  nodeIds: string[],
  relationEdges: WeightedDirectedEdge[]
): Array<{ source: string; target: string }> {
  if (nodeIds.length < 2 || relationEdges.length === 0) return [];

  const adjacency = new Map<string, Map<string, number>>();
  const directedWeights = new Map<string, number>();
  const dedupDirected = new Map<string, WeightedDirectedEdge>();

  const addAdjacency = (from: string, to: string, weight: number) => {
    const links = adjacency.get(from) || new Map<string, number>();
    links.set(to, (links.get(to) || 0) + weight);
    adjacency.set(from, links);
  };

  for (const edge of relationEdges) {
    if (edge.source === edge.target) continue;
    const key = directedEdgeKey(edge.source, edge.target);
    const existing = dedupDirected.get(key);
    if (existing) {
      existing.weight += edge.weight;
    } else {
      dedupDirected.set(key, { ...edge });
    }
  }

  const dedupEdges = [...dedupDirected.values()];
  for (const edge of dedupEdges) {
    const dKey = directedEdgeKey(edge.source, edge.target);
    directedWeights.set(dKey, (directedWeights.get(dKey) || 0) + edge.weight);
    addAdjacency(edge.source, edge.target, edge.weight);
    addAdjacency(edge.target, edge.source, edge.weight);
  }

  const components = buildConnectedComponents(nodeIds, adjacency);
  const seenDirected = new Set<string>();
  const backbone: Array<{ source: string; target: string }> = [];

  for (const component of components) {
    if (component.length < 2) continue;
    const stats = buildFlowStats(component, adjacency, dedupEdges);
    const root = pickBackboneRoot(component, stats);
    const treePairs = buildMaxSpanningTree(component, root, adjacency);

    for (const [a, b] of treePairs) {
      const oriented = orientBackboneEdge(a, b, directedWeights, stats);
      const directed = directedEdgeKey(oriented.source, oriented.target);
      if (seenDirected.has(directed)) continue;
      seenDirected.add(directed);
      backbone.push(oriented);
    }
  }

  return backbone;
}

function plannerHintForNode(node: Node): string | null {
  const data = node.data as PlannerNodeData;
  const groupId = data.groupId?.trim();
  if (groupId) return `group:${groupId}`;

  const rawPath =
    data.path?.trim() ||
    data.target?.trim() ||
    data.dirPath?.trim() ||
    "";
  if (rawPath) {
    const segments = normalizeTargetPath(rawPath)
      .split("/")
      .filter(Boolean);
    if (segments.length >= 2) return `path:${segments[0]}/${segments[1]}`;
    if (segments.length === 1) return `path:${segments[0]}`;
  }

  const moduleId = data.moduleId?.trim();
  if (moduleId) return `module:${moduleId}`;

  const name = data.name?.trim();
  if (name) return `name:${normalizeName(name)}`;

  return null;
}

function buildPlannerHintEdges(nodes: Node[]): WeightedDirectedEdge[] {
  const buckets = new Map<string, Set<string>>();
  for (const node of nodes) {
    const hint = plannerHintForNode(node);
    if (!hint) continue;
    const set = buckets.get(hint) || new Set<string>();
    set.add(node.id);
    buckets.set(hint, set);
  }

  const hintedEdges: WeightedDirectedEdge[] = [];
  const representatives: Array<{ id: string; size: number; hint: string }> = [];

  for (const [hint, idsSet] of buckets) {
    const ids = [...idsSet].sort((a, b) => a.localeCompare(b));
    if (ids.length === 0) continue;
    representatives.push({ id: ids[0], size: ids.length, hint });
    if (ids.length < 2) continue;

    for (let i = 1; i < ids.length; i += 1) {
      const prev = ids[i - 1];
      const next = ids[i];
      hintedEdges.push({ source: prev, target: next, weight: 1 });
      hintedEdges.push({ source: next, target: prev, weight: 1 });
    }
  }

  representatives.sort((a, b) => {
    if (b.size !== a.size) return b.size - a.size;
    return a.hint.localeCompare(b.hint);
  });

  for (let i = 1; i < representatives.length; i += 1) {
    const prev = representatives[i - 1];
    const next = representatives[i];
    hintedEdges.push({ source: prev.id, target: next.id, weight: 1 });
    hintedEdges.push({ source: next.id, target: prev.id, weight: 1 });
  }

  return hintedEdges;
}

function addGeneratedLayoutBackbone(
  nodes: Node[],
  edges: Edge[]
): Edge[] {
  if (nodes.length < 2 || hasStructuralLayoutEdge(edges)) return edges;

  const nodeIds = nodes.map((node) => node.id);
  const nodeIdSet = new Set(nodeIds);
  const hintByNodeId = new Map<string, string | null>();
  for (const node of nodes) {
    hintByNodeId.set(node.id, plannerHintForNode(node));
  }

  const hardEdges = edges
    .filter((edge) => {
      const data = edge.data as EdgeData | undefined;
      return data?.kind === "relationship";
    })
    .map((edge) => ({
      source: edge.source,
      target: edge.target,
      weight: relationLayoutWeight(edge),
    }))
    .filter((edge) => nodeIdSet.has(edge.source) && nodeIdSet.has(edge.target));

  const relationEdges = hardEdges.map((edge) => {
    const sourceHint = hintByNodeId.get(edge.source);
    const targetHint = hintByNodeId.get(edge.target);
    const sameHint = sourceHint && targetHint && sourceHint === targetHint;
    return {
      ...edge,
      weight: edge.weight + (sameHint ? 1 : 0),
    };
  });

  const plannerHintEdges = buildPlannerHintEdges(nodes).filter(
    (edge) => nodeIdSet.has(edge.source) && nodeIdSet.has(edge.target)
  );

  const planningEdges =
    relationEdges.length > 0
      ? [...relationEdges, ...plannerHintEdges]
      : plannerHintEdges;

  let backbone = buildRelationBackbone(nodeIds, planningEdges);
  if (backbone.length === 0 && nodeIds.length > 1) {
    const chain = [...nodeIds].sort((a, b) => a.localeCompare(b));
    backbone = [];
    for (let i = 1; i < chain.length; i += 1) {
      backbone.push({ source: chain[i - 1], target: chain[i] });
    }
  }
  if (backbone.length === 0) return edges;

  const existingStructural = new Set(
    edges
      .filter((edge) => {
        const data = edge.data as EdgeData | undefined;
        return data?.layout !== false;
      })
      .map((edge) => directedEdgeKey(edge.source, edge.target))
  );

  const generated: Edge[] = [];
  let index = 0;
  for (const edge of backbone) {
    const key = directedEdgeKey(edge.source, edge.target);
    if (existingStructural.has(key)) continue;
    existingStructural.add(key);

    generated.push({
      id: `e-layout-${edge.source}-${edge.target}-${index}`,
      source: edge.source,
      target: edge.target,
      hidden: true,
      selectable: false,
      data: {
        kind: "structure",
        layout: true,
      },
    });
    index += 1;
  }

  if (generated.length === 0) return edges;
  return [...edges, ...generated];
}

function relationPairKey(source: string, target: string): string {
  return `${source}->${target}`;
}

function buildRelationEdgePairIndex(edges: Edge[]): Map<string, number> {
  const pairToIndex = new Map<string, number>();
  for (let i = 0; i < edges.length; i += 1) {
    const edge = edges[i];
    const data = edge.data as EdgeData | undefined;
    if (data?.kind !== "relationship") continue;
    const key = relationPairKey(edge.source, edge.target);
    if (!pairToIndex.has(key)) {
      pairToIndex.set(key, i);
    }
  }
  return pairToIndex;
}

function edgeEvidence(data: EdgeData | undefined): Set<string> {
  const values = Array.isArray(data?.evidence) ? data?.evidence : [];
  return new Set(values.filter((value): value is string => typeof value === "string"));
}

function isLikelyFilePathToken(value: string): boolean {
  const normalized = normalizeTargetPath(value);
  const last = normalized.split("/").pop() || "";
  if (!last) return false;
  return /\.[a-z0-9]+$/i.test(last);
}

function nodePathCandidates(node: Node): string[] {
  const data = node.data as PlannerNodeData;
  const candidates = new Set<string>();

  const add = (raw: string | null | undefined) => {
    if (!raw) return;
    const normalized = normalizeTargetPath(raw);
    if (!normalized || !isLikelyFilePathToken(normalized)) return;
    candidates.add(normalized);
  };

  add(data.path);
  add(data.target || undefined);
  if (Array.isArray(data.children)) {
    for (const child of data.children) {
      add(child);
    }
  }

  return [...candidates];
}

function buildPathNodeMap(nodes: Node[]): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  for (const node of nodes) {
    for (const path of nodePathCandidates(node)) {
      const set = map.get(path) || new Set<string>();
      set.add(node.id);
      map.set(path, set);
    }
  }
  return map;
}

function staticEdgeSortScore(edge: StaticEdge): number {
  return edge.weight * (0.4 + Math.max(0, Math.min(1, edge.confidence)));
}

function applyEdgeEvidenceStyle(
  edge: Edge,
  evidenceSet: Set<string>,
  ambiguous: boolean,
  staticConfidence: number
): Edge {
  const hasSemantic = evidenceSet.has("semantic");
  const hasStatic = evidenceSet.has("static");

  let stroke: string = graphColors.edgeRelationship;
  if (hasStatic && hasSemantic) stroke = graphColors.edgeBlended;
  else if (hasStatic) stroke = graphColors.edgeStatic;

  const baseWidth = hasStatic && !hasSemantic
    ? 1.2 + Math.max(0, Math.min(1, staticConfidence)) * 1.2
    : hasStatic && hasSemantic
      ? 2.1
      : 1.5;

  return {
    ...edge,
    style: {
      ...(edge.style || {}),
      stroke,
      strokeWidth: Number(baseWidth.toFixed(2)),
      strokeDasharray: ambiguous ? "5,4" : undefined,
    },
  };
}

function upsertStaticRelationshipEdge(
  edges: Edge[],
  pairToIndex: Map<string, number>,
  source: string,
  target: string,
  staticKind: string,
  weight: number,
  confidence: number
): boolean {
  if (!source || !target || source === target) return false;
  const pair = relationPairKey(source, target);
  const safeWeight = Math.max(1, Math.round(weight || 1));
  const safeConfidence = Math.max(0, Math.min(1, confidence || 0.5));

  const existingIndex = pairToIndex.get(pair);
  if (existingIndex != null) {
    const current = edges[existingIndex];
    const data = (current.data as EdgeData | undefined) || {};
    const evidenceSet = edgeEvidence(data);
    evidenceSet.add("static");

    const existingKinds = (data.staticKind || "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    const kindSet = new Set(existingKinds);
    kindSet.add(staticKind);

    const mergedData: EdgeData = {
      ...data,
      evidence: [...evidenceSet],
      staticKind: [...kindSet].join(","),
      staticConfidence: Math.max(
        typeof data.staticConfidence === "number" ? data.staticConfidence : 0,
        safeConfidence
      ),
      bundledCount: Math.max(
        safeWeight,
        typeof data.bundledCount === "number" ? data.bundledCount + safeWeight : safeWeight
      ),
    };

    let next: Edge = {
      ...current,
      data: mergedData,
    };

    const labelParts = [...kindSet].sort((a, b) => a.localeCompare(b));
    const totalWeight = typeof mergedData.bundledCount === "number"
      ? mergedData.bundledCount
      : safeWeight;
    if (!current.label || String(current.label).trim().length === 0) {
      next.label = totalWeight > 1 ? `${labelParts.join("+")} x${totalWeight}` : labelParts.join("+");
    }

    next = applyEdgeEvidenceStyle(next, evidenceSet, !!data.ambiguous, mergedData.staticConfidence || safeConfidence);
    edges[existingIndex] = next;
    return true;
  }

  const label = safeWeight > 1 ? `${staticKind} x${safeWeight}` : staticKind;
  const evidenceSet = new Set<string>(["static"]);
  const newEdge = applyEdgeEvidenceStyle(
    {
      id: `e-static-${pairToIndex.size + 1}`,
      source,
      target,
      label,
      animated: false,
      data: {
        layout: false,
        kind: "relationship",
        evidence: ["static"],
        staticKind,
        staticConfidence: safeConfidence,
        bundledCount: safeWeight,
      },
    },
    evidenceSet,
    false,
    safeConfidence
  );

  const nextIndex = edges.length;
  edges.push(newEdge);
  pairToIndex.set(pair, nextIndex);
  return true;
}

function addStaticEdgesToVisibleNodes(
  staticEdges: StaticEdge[],
  nodePathMap: Map<string, Set<string>>,
  edges: Edge[],
  pairToIndex: Map<string, number>
): number {
  if (nodePathMap.size === 0 || staticEdges.length === 0) return 0;

  const ranked = [...staticEdges].sort((a, b) => staticEdgeSortScore(b) - staticEdgeSortScore(a));
  let added = 0;

  for (const staticEdge of ranked) {
    if (added >= MAX_STATIC_EDGE_INSERTIONS) break;

    const src = nodePathMap.get(normalizeTargetPath(staticEdge.source_path));
    const tgt = nodePathMap.get(normalizeTargetPath(staticEdge.target_path));
    if (!src || !tgt) continue;

    for (const sourceNodeId of src) {
      if (added >= MAX_STATIC_EDGE_INSERTIONS) break;
      for (const targetNodeId of tgt) {
        if (added >= MAX_STATIC_EDGE_INSERTIONS) break;
        if (sourceNodeId === targetNodeId) continue;
        if (
          upsertStaticRelationshipEdge(
            edges,
            pairToIndex,
            sourceNodeId,
            targetNodeId,
            staticEdge.kind,
            staticEdge.weight,
            staticEdge.confidence
          )
        ) {
          added += 1;
        }
      }
    }
  }

  return added;
}

function addStaticEdgesToAggregatedGroups(
  staticEdges: StaticEdge[],
  nodes: Node[],
  edges: Edge[],
  pairToIndex: Map<string, number>
): number {
  if (staticEdges.length === 0 || nodes.length === 0) return 0;

  const availableGroups = new Set(
    nodes
      .filter((node) => node.id.startsWith("group:"))
      .map((node) => node.id)
  );
  if (availableGroups.size < 2) return 0;

  const aggregates = new Map<
    string,
    {
      source: string;
      target: string;
      weight: number;
      confidence: number;
      calls: number;
      imports: number;
    }
  >();

  for (const staticEdge of staticEdges) {
    const srcGroup = `group:${classifyComponentGroup(staticEdge.source_path).id}`;
    const tgtGroup = `group:${classifyComponentGroup(staticEdge.target_path).id}`;
    if (srcGroup === tgtGroup) continue;
    if (!availableGroups.has(srcGroup) || !availableGroups.has(tgtGroup)) continue;

    const key = relationPairKey(srcGroup, tgtGroup);
    const entry = aggregates.get(key) || {
      source: srcGroup,
      target: tgtGroup,
      weight: 0,
      confidence: 0,
      calls: 0,
      imports: 0,
    };
    entry.weight += Math.max(1, Math.round(staticEdge.weight || 1));
    entry.confidence = Math.max(entry.confidence, staticEdge.confidence || 0);
    if (staticEdge.kind === "calls") entry.calls += staticEdge.weight;
    if (staticEdge.kind === "imports") entry.imports += staticEdge.weight;
    aggregates.set(key, entry);
  }

  const ranked = [...aggregates.values()].sort((a, b) => {
    const scoreA = a.weight * (0.5 + a.confidence);
    const scoreB = b.weight * (0.5 + b.confidence);
    return scoreB - scoreA;
  });

  let added = 0;
  for (const entry of ranked) {
    if (added >= MAX_STATIC_EDGE_INSERTIONS) break;
    const kind =
      entry.calls > 0 && entry.imports > 0
        ? "calls+imports"
        : entry.calls > 0
          ? "calls"
          : "imports";
    if (
      upsertStaticRelationshipEdge(
        edges,
        pairToIndex,
        entry.source,
        entry.target,
        kind,
        entry.weight,
        entry.confidence
      )
    ) {
      added += 1;
    }
  }

  return added;
}

function addStaticRelationships(
  data: GraphData,
  nav: NavEntry,
  nodes: Node[],
  baseEdges: Edge[]
): Edge[] {
  const staticEdges = data.static_analysis?.edges || [];
  if (staticEdges.length === 0 || nodes.length === 0) return baseEdges;

  const edges = [...baseEdges];
  const pairToIndex = buildRelationEdgePairIndex(edges);
  const nodePathMap = buildPathNodeMap(nodes);
  const pathAdded = addStaticEdgesToVisibleNodes(staticEdges, nodePathMap, edges, pairToIndex);

  if (pathAdded > 0) {
    return edges;
  }

  if (nav.level === "system") {
    addStaticEdgesToAggregatedGroups(staticEdges, nodes, edges, pairToIndex);
  }

  return edges;
}

function applyConnectivityPolicy(
  nodes: Node[],
  edges: Edge[],
  nav: NavEntry
): Edge[] {
  const relationIndices: number[] = [];
  for (let i = 0; i < edges.length; i += 1) {
    const data = edges[i].data as EdgeData | undefined;
    if (data?.kind === "relationship") {
      relationIndices.push(i);
    }
  }

  if (relationIndices.length <= 2) return edges;

  const nodeById = new Map<string, Node>();
  for (const node of nodes) {
    nodeById.set(node.id, node);
  }

  const hintByNodeId = new Map<string, string | null>();
  const pathHintByNodeId = new Map<string, string | null>();
  for (const node of nodes) {
    hintByNodeId.set(node.id, plannerHintForNode(node));
    pathHintByNodeId.set(node.id, pathHintForNode(node));
  }

  const degree = new Map<string, number>();
  for (const index of relationIndices) {
    const edge = edges[index];
    const weight = relationLayoutWeight(edge);
    degree.set(edge.source, (degree.get(edge.source) || 0) + weight);
    degree.set(edge.target, (degree.get(edge.target) || 0) + weight);
  }
  let maxDegree = 1;
  for (const value of degree.values()) {
    if (value > maxDegree) maxDegree = value;
  }

  const candidates: RelationCandidate[] = [];
  for (const index of relationIndices) {
    const edge = edges[index];
    if (!nodeById.has(edge.source) || !nodeById.has(edge.target)) continue;
    const data = edge.data as EdgeData | undefined;
    const weight = relationLayoutWeight(edge);
    const reasons: string[] = [];
    let score = Math.min(5, weight) * 0.9;
    reasons.push(`weight:${weight}`);
    const evidenceSet = edgeEvidence(data);
    const hasStatic = evidenceSet.has("static");
    const hasSemantic = evidenceSet.has("semantic");

    if (hasSemantic) {
      score += 2.6;
      reasons.push("semantic");
    }
    if (hasStatic) {
      score += hasSemantic ? 0.55 : 0.45;
      reasons.push("static");
    }
    if (hasStatic && hasSemantic) {
      score += 0.6;
      reasons.push("blended");
    }
    if (typeof data?.staticConfidence === "number") {
      const confidence = Math.max(0, Math.min(1, data.staticConfidence));
      score += confidence * (hasSemantic ? 0.35 : 0.8);
      reasons.push(`confidence:${Number(data.staticConfidence).toFixed(2)}`);
    }
    if (typeof data?.staticKind === "string" && data.staticKind.length > 0) {
      if (data.staticKind.includes("calls")) {
        score += hasSemantic ? 0.22 : 0.18;
        reasons.push("calls");
      }
      if (data.staticKind.includes("imports")) {
        score += 0.12;
        reasons.push("imports");
      }
    }

    const sourceHint = hintByNodeId.get(edge.source);
    const targetHint = hintByNodeId.get(edge.target);
    if (sourceHint && targetHint && sourceHint === targetHint) {
      score += 1.0;
      reasons.push("same-hint");
    }

    const sourcePathHint = pathHintByNodeId.get(edge.source);
    const targetPathHint = pathHintByNodeId.get(edge.target);
    if (sourcePathHint && targetPathHint && sourcePathHint === targetPathHint) {
      score += 0.6;
      reasons.push("same-path");
    }

    const labelText = typeof edge.label === "string" ? edge.label.trim().toLowerCase() : "";
    if (labelText.length > 0 && labelText !== "relates to") {
      score += labelText.startsWith("x") ? 0.25 : 0.45;
      reasons.push("labeled");
    }

    if (data?.ambiguous) {
      score -= 0.5;
      reasons.push("ambiguous");
    }

    const centrality =
      ((degree.get(edge.source) || 0) + (degree.get(edge.target) || 0)) / (2 * maxDegree);
    score += centrality * 0.9;
    reasons.push(`centrality:${centrality.toFixed(2)}`);

    candidates.push({
      index,
      source: edge.source,
      target: edge.target,
      score,
      weight,
      hasSemantic,
      hasStatic,
      reasons,
    });
  }

  if (candidates.length <= 2) return edges;

  const ranked = [...candidates].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.weight !== a.weight) return b.weight - a.weight;
    const aKey = `${a.source}->${a.target}`;
    const bKey = `${b.source}->${b.target}`;
    return aKey.localeCompare(bKey);
  });

  const budget = relationVisibilityBudget(nav.level, nodes.length, ranked.length);
  const semanticRanked = ranked.filter((candidate) => candidate.hasSemantic);
  const effectiveBudget = Math.max(budget, semanticRanked.length);

  const selected = new Set<number>();
  for (const candidate of semanticRanked) {
    selected.add(candidate.index);
  }
  for (const candidate of ranked) {
    if (selected.size >= effectiveBudget) break;
    selected.add(candidate.index);
  }

  const nodesWithRelations = new Set<string>();
  for (const c of candidates) {
    nodesWithRelations.add(c.source);
    nodesWithRelations.add(c.target);
  }

  const coveredNodes = new Set<string>();
  for (const c of candidates) {
    if (!selected.has(c.index)) continue;
    coveredNodes.add(c.source);
    coveredNodes.add(c.target);
  }

  for (const nodeId of nodesWithRelations) {
    if (coveredNodes.has(nodeId)) continue;
    const fallback = ranked.find(
      (candidate) =>
        !selected.has(candidate.index) &&
        (candidate.source === nodeId || candidate.target === nodeId)
    );
    if (!fallback) continue;
    selected.add(fallback.index);
    coveredNodes.add(fallback.source);
    coveredNodes.add(fallback.target);
  }

  const maxSelected = effectiveBudget + Math.ceil(nodesWithRelations.size * 0.2);
  if (selected.size > maxSelected) {
    const selectedIncident = new Map<string, number>();
    for (const c of candidates) {
      if (!selected.has(c.index)) continue;
      selectedIncident.set(c.source, (selectedIncident.get(c.source) || 0) + 1);
      selectedIncident.set(c.target, (selectedIncident.get(c.target) || 0) + 1);
    }

    const selectedByAscendingScore = ranked
      .filter((candidate) => selected.has(candidate.index))
      .sort((a, b) => a.score - b.score);

    for (const candidate of selectedByAscendingScore) {
      if (selected.size <= maxSelected) break;
      if (candidate.hasSemantic) continue;
      const sourceCount = selectedIncident.get(candidate.source) || 0;
      const targetCount = selectedIncident.get(candidate.target) || 0;
      if (sourceCount <= 1 || targetCount <= 1) continue;
      selected.delete(candidate.index);
      selectedIncident.set(candidate.source, sourceCount - 1);
      selectedIncident.set(candidate.target, targetCount - 1);
    }
  }

  const hideSuppressed =
    ranked.length > Math.max(26, Math.round(budget * 1.55)) && nav.level !== "file";
  const maxScore = ranked[0]?.score || 1;
  const byIndex = new Map<number, RelationCandidate>();
  for (const candidate of candidates) {
    byIndex.set(candidate.index, candidate);
  }

  return edges.map((edge, index) => {
    const candidate = byIndex.get(index);
    if (!candidate) return edge;

    const data = edge.data as EdgeData | undefined;
    const evidenceSet = edgeEvidence(data);
    const hasStatic = evidenceSet.has("static");
    const hasSemantic = evidenceSet.has("semantic");
    const baseStroke = data?.ambiguous
      ? graphColors.edgeAmbiguous
      : hasStatic && hasSemantic
        ? graphColors.edgeBlended
        : hasStatic
          ? graphColors.edgeStatic
          : graphColors.edgeRelationship;
    const normalizedScore =
      maxScore > 0 ? Math.max(0, Math.min(1, candidate.score / maxScore)) : 0;
    const selectedByPolicy = selected.has(index);

    const nextData: EdgeData = {
      ...(data || {}),
      policyScore: Number(candidate.score.toFixed(2)),
      policySelected: selectedByPolicy,
      policySuppressed: !selectedByPolicy,
      policyReason: candidate.reasons,
    };

    if (selectedByPolicy) {
      return {
        ...edge,
        hidden: false,
        animated: normalizedScore > 0.72,
        style: {
          ...(edge.style || {}),
          stroke: baseStroke,
          strokeWidth: Number((1.5 + normalizedScore * 1.7).toFixed(2)),
          opacity: 0.95,
        },
        data: nextData,
      };
    }

    return {
      ...edge,
      hidden: hideSuppressed ? true : edge.hidden,
      selectable: hideSuppressed ? false : edge.selectable,
      animated: false,
      style: {
        ...(edge.style || {}),
        stroke: baseStroke,
        strokeWidth: 1,
        strokeDasharray: (edge.style && "strokeDasharray" in edge.style)
          ? edge.style.strokeDasharray
          : "4,4",
        opacity: hideSuppressed ? 0 : 0.18,
      },
      labelStyle: {
        ...(edge.labelStyle || {}),
        opacity: hideSuppressed ? 0 : 0.24,
      },
      data: nextData,
    };
  });
}

function separateParallelRelationEdges(edges: Edge[]): Edge[] {
  const relationGroups = new Map<string, number[]>();
  const next = edges.map((edge) => {
    const data = edge.data as EdgeData | undefined;
    if (data?.kind !== "relationship") return edge;
    return {
      ...edge,
      type: "relation",
      labelShowBg: true,
      labelBgPadding: [7, 4] as [number, number],
      labelBgBorderRadius: 4,
      labelStyle: {
        ...(edge.labelStyle || {}),
        fontSize: 11,
        whiteSpace: "normal",
        maxWidth: 300,
      },
      data: {
        ...(data || {}),
        parallelCentered: 0,
        parallelCount: 1,
      },
    };
  });

  for (let i = 0; i < next.length; i += 1) {
    const edge = next[i];
    const data = edge.data as EdgeData | undefined;
    if (data?.kind !== "relationship") continue;
    if (edge.hidden) continue;
    const key = `${edge.source}->${edge.target}`;
    const group = relationGroups.get(key) || [];
    group.push(i);
    relationGroups.set(key, group);
  }

  if (![...relationGroups.values()].some((group) => group.length > 1)) {
    return next;
  }

  for (const group of relationGroups.values()) {
    if (group.length <= 1) continue;

    for (let lane = 0; lane < group.length; lane += 1) {
      const edgeIndex = group[lane];
      const edge = next[edgeIndex];
      if (!edge) continue;

      const centered = lane - (group.length - 1) / 2;
      next[edgeIndex] = {
        ...edge,
        data: {
          ...((edge.data as EdgeData | undefined) || {}),
          parallelCentered: centered,
          parallelCount: group.length,
        },
      };
    }
  }

  return next;
}

function collapseParallelRelationEdges(edges: Edge[]): Edge[] {
  const relationGroups = new Map<string, Edge[]>();
  const passthrough: Edge[] = [];

  for (const edge of edges) {
    const data = edge.data as EdgeData | undefined;
    if (data?.kind !== "relationship") {
      passthrough.push(edge);
      continue;
    }

    const evidenceSet = edgeEvidence(data);
    const hasStatic = evidenceSet.has("static");
    const hasSemantic = evidenceSet.has("semantic");
    const relationType = data?.ambiguous
      ? "ambiguous"
      : hasStatic && hasSemantic
        ? "blended"
        : hasStatic
          ? "static"
          : "semantic";
    const key = `${edge.source}->${edge.target}|${relationType}`;
    const bucket = relationGroups.get(key) || [];
    bucket.push(edge);
    relationGroups.set(key, bucket);
  }

  const collapsed: Edge[] = [];
  for (const bucket of relationGroups.values()) {
    if (bucket.length === 0) continue;
    if (bucket.length === 1) {
      collapsed.push(bucket[0]);
      continue;
    }

    const base = bucket[0];
    const baseData = (base.data as EdgeData | undefined) || {};
    const mergedEvidence = new Set<string>();
    const labels: string[] = [];
    const seenLabels = new Set<string>();

    for (const edge of bucket) {
      const data = (edge.data as EdgeData | undefined) || {};
      for (const evidence of edgeEvidence(data)) {
        mergedEvidence.add(evidence);
      }

      const text = typeof edge.label === "string" ? edge.label.trim() : "";
      if (!text) continue;
      const norm = text.toLowerCase();
      if (seenLabels.has(norm)) continue;
      seenLabels.add(norm);
      labels.push(text);
    }

    const summaryLabel =
      labels.length <= 1
        ? labels[0] || (typeof base.label === "string" ? base.label : "")
        : `${labels[0]} (+${labels.length - 1})`;

    collapsed.push({
      ...base,
      id: `e-rel-collapsed-${base.source}-${base.target}-${collapsed.length}`,
      animated: bucket.some((edge) => !!edge.animated),
      label: summaryLabel || undefined,
      data: {
        ...baseData,
        evidence: [...mergedEvidence],
        collapsedLabels: labels,
        collapsedEdgeCount: bucket.length,
      },
    });
  }

  return [...passthrough, ...collapsed];
}

export function transformGraph(
  data: GraphData,
  nav: NavEntry
): { nodes: Node[]; edges: Edge[] } {
  let result: { nodes: Node[]; edges: Edge[] };

  if (nav.level === "system") result = systemLevel(data, nav.id);
  else if (nav.level === "module") result = moduleLevel(data, nav.id!, nav.label);
  else if (nav.level === "file") result = fileLevel(data, nav.id!);
  else if (nav.level === "diff") result = diffLevel(data, nav);
  else result = { nodes: [], edges: [] };

  const coverage = graphScopeCoverage(data, nav);
  attachUnannotatedBucket(result.nodes, result.edges, coverage, nav);
  result.nodes = annotateNodesWithDiffPaths(data, result.nodes);

  if (result.nodes.length > 0) {
    if (nav.level === "diff") {
      result = {
        nodes: result.nodes,
        edges: separateParallelRelationEdges(collapseParallelRelationEdges(result.edges)),
      };
    } else {
      const withStatic = addStaticRelationships(data, nav, result.nodes, result.edges);
      const withCollapsedParallels = collapseParallelRelationEdges(withStatic);
      const withBackbone = addGeneratedLayoutBackbone(result.nodes, withCollapsedParallels);
      const withPolicy = applyConnectivityPolicy(result.nodes, withBackbone, nav);
      result = {
        nodes: result.nodes,
        edges: separateParallelRelationEdges(withPolicy),
      };
    }
  }

  if (result.nodes.length === 0) {
    result.nodes.push({
      id: "empty-placeholder",
      type: "component",
      position: { x: 0, y: 0 },
      data: {
        name: "No data found",
        description:
          nav.level === "system"
            ? "No .dive/ metadata found."
            : `No metadata found for "${nav.label}".`,
        target: null,
        hasChildren: false,
      },
    });
  }

  return result;
}

// ─── System Level ──────────────────────────────────────────────────────

function systemLevel(
  data: GraphData,
  filterId?: string
): { nodes: Node[]; edges: Edge[] } {
  const ov = data.overview;

  if (filterId && ov) {
    return filteredSystemLevel(data, ov, filterId);
  }

  if (ov && ov.components.length > CLUSTER_THRESHOLD) {
    return aggregatedSystemLevel(data, ov);
  }

  return flatSystemLevel(data);
}

function aggregatedSystemLevel(
  data: GraphData,
  ov: OverviewDoc
): { nodes: Node[]; edges: Edge[] } {
  const gitStatus = data.git_status || {};
  const components = prepareComponents(ov.components);
  const moduleBuckets = buildModuleBuckets(data, components);
  if (shouldUseModuleClusters(components, moduleBuckets)) {
    return moduleClusterSystemLevel(data, ov, "__all__", "system", components, moduleBuckets);
  }

  const nodes: Node[] = [];
  const edges: Edge[] = [];

  const groups = new Map<string, { label: string; comps: ComponentRecord[] }>();
  for (const comp of components) {
    const bucket = classifyComponentGroup(comp.target);
    const existing = groups.get(bucket.id) || { label: bucket.label, comps: [] };
    existing.comps.push(comp);
    groups.set(bucket.id, existing);
  }

  for (const [groupId, group] of groups) {
    const { label, comps } = group;
    nodes.push({
      id: `group:${groupId}`,
      type: "group",
      position: { x: 0, y: 0 },
      data: {
        name: label,
        count: comps.length,
        children: comps.map((c) => c.name),
        groupId,
        folderHints: deriveFolderHints(comps, groupId),
        gitStatus: gitStatusForTargets(gitStatus, comps.map((c) => c.target)),
      },
    });
  }

  const nameToGroups = new Map<string, Set<string>>();
  for (const [groupId, group] of groups) {
    const { comps } = group;
    for (const comp of comps) {
      const set = nameToGroups.get(comp.normName) || new Set<string>();
      set.add(`group:${groupId}`);
      nameToGroups.set(comp.normName, set);
    }
  }

  const rels = parseRelationships(ov.relationships);
  const aggregated = new Map<
    string,
    {
      source: string;
      target: string;
      count: number;
      labels: Set<string>;
      ambiguous: boolean;
    }
  >();

  for (const rel of rels) {
    const srcGroups = [...(nameToGroups.get(normalizeName(rel.src)) || [])];
    const tgtGroups = [...(nameToGroups.get(normalizeName(rel.tgt)) || [])];

    if (srcGroups.length === 0 || tgtGroups.length === 0) continue;

    const ambiguous = srcGroups.length > 1 || tgtGroups.length > 1;
    for (const src of srcGroups) {
      for (const tgt of tgtGroups) {
        if (src === tgt) continue;
        const key = `${src}->${tgt}`;
        const entry = aggregated.get(key) || {
          source: src,
          target: tgt,
          count: 0,
          labels: new Set<string>(),
          ambiguous: false,
        };

        entry.count += 1;
        if (rel.label) {
          entry.labels.add(rel.label);
        }
        entry.ambiguous = entry.ambiguous || ambiguous;
        aggregated.set(key, entry);
      }
    }
  }

  pushBundledRelationshipEdges(edges, aggregated);

  return { nodes, edges };
}

function filteredSystemLevel(
  data: GraphData,
  ov: OverviewDoc,
  groupId: string
): { nodes: Node[]; edges: Edge[] } {
  const moduleFilter = parseModuleClusterFilterId(groupId);
  const baseGroupId = moduleFilter?.baseGroupId || groupId;
  const prepared = prepareComponents(ov.components);
  const allComponents =
    baseGroupId === "__all__"
      ? prepared
      : prepared.filter((c) => matchesGroup(c, baseGroupId));
  const baseLabel = groupLabelFromId(baseGroupId);

  if (moduleFilter) {
    const buckets = buildModuleBuckets(data, allComponents);
    const selected = buckets.get(moduleFilter.moduleBucketId);
    const components = selected?.comps || [];
    const moduleLabel = selected?.label || moduleFilter.moduleBucketId;
    return buildComponentNodes(data, ov, components, {
      parentSummary: {
        groupId,
        label: `${baseLabel} · ${moduleLabel}`,
        totalComponents: components.length,
        componentNames: components.map((c) => c.name),
        folderHints: deriveFolderHints(components, baseGroupId),
      },
      fileGroupsAreLeaf: true,
    });
  }

  const moduleBuckets = buildModuleBuckets(data, allComponents);
  if (shouldUseModuleClusters(allComponents, moduleBuckets)) {
    return moduleClusterSystemLevel(data, ov, baseGroupId, baseLabel, allComponents, moduleBuckets);
  }

  return buildComponentNodes(data, ov, allComponents, {
    parentSummary: {
      groupId: baseGroupId,
      label: baseLabel,
      totalComponents: allComponents.length,
      componentNames: allComponents.map((c) => c.name),
      folderHints: deriveFolderHints(allComponents, baseGroupId),
    },
    fileGroupsAreLeaf: true,
  });
}

function moduleClusterSystemLevel(
  data: GraphData,
  ov: OverviewDoc,
  baseGroupId: string,
  baseLabel: string,
  allComponents: ComponentRecord[],
  moduleBuckets: Map<string, ModuleComponentBucket>
): { nodes: Node[]; edges: Edge[] } {
  const gitStatus = data.git_status || {};
  const nodes: Node[] = [];
  const edges: Edge[] = [];

  const summaryNodeId = `summary-group:${baseGroupId}:modules`;
  nodes.push({
    id: summaryNodeId,
    type: "group",
    position: { x: 0, y: 0 },
    data: {
      name: `${baseLabel} modules`,
      count: allComponents.length,
      children: allComponents.map((c) => c.name),
      groupId: baseGroupId,
      folderHints: deriveFolderHints(allComponents, baseGroupId),
      gitStatus: gitStatusForTargets(gitStatus, allComponents.map((c) => c.target)),
      isSummary: true,
      nonNavigable: true,
    },
  });

  const orderedBuckets = [...moduleBuckets.values()].sort((a, b) => {
    if (a.id === "__unmapped__" && b.id !== "__unmapped__") return 1;
    if (b.id === "__unmapped__" && a.id !== "__unmapped__") return -1;
    if (b.comps.length !== a.comps.length) return b.comps.length - a.comps.length;
    return a.label.localeCompare(b.label);
  });

  const nameToGroups = new Map<string, Set<string>>();
  for (const bucket of orderedBuckets) {
    if (bucket.comps.length === 0) continue;

    const filterId = makeModuleClusterFilterId(baseGroupId, bucket.id);
    const nodeId = `group:${filterId}`;
    nodes.push({
      id: nodeId,
      type: "group",
      position: { x: 0, y: 0 },
      data: {
        name: bucket.label,
        count: bucket.comps.length,
        children: bucket.comps.map((c) => c.name),
        groupId: filterId,
        moduleId: bucket.id === "__unmapped__" ? null : bucket.id,
        folderHints: deriveFolderHints(bucket.comps, baseGroupId),
        gitStatus: gitStatusForTargets(gitStatus, bucket.comps.map((c) => c.target)),
      },
    });
    addStructuralEdge(edges, summaryNodeId, nodeId);

    for (const comp of bucket.comps) {
      addNameNodeMapping(nameToGroups, comp.normName, nodeId);
    }
  }

  const rels = parseRelationships(ov.relationships);
  const aggregated = new Map<
    string,
    {
      source: string;
      target: string;
      count: number;
      labels: Set<string>;
      ambiguous: boolean;
    }
  >();

  for (const rel of rels) {
    const srcGroups = [...(nameToGroups.get(normalizeName(rel.src)) || [])];
    const tgtGroups = [...(nameToGroups.get(normalizeName(rel.tgt)) || [])];
    if (srcGroups.length === 0 || tgtGroups.length === 0) continue;

    const ambiguous = srcGroups.length > 1 || tgtGroups.length > 1;
    for (const src of srcGroups) {
      for (const tgt of tgtGroups) {
        if (src === tgt) continue;
        const key = `${src}->${tgt}`;
        const entry = aggregated.get(key) || {
          source: src,
          target: tgt,
          count: 0,
          labels: new Set<string>(),
          ambiguous: false,
        };
        entry.count += 1;
        if (rel.label) entry.labels.add(rel.label);
        entry.ambiguous = entry.ambiguous || ambiguous;
        aggregated.set(key, entry);
      }
    }
  }

  pushBundledRelationshipEdges(edges, aggregated);
  return { nodes, edges };
}

function buildComponentNodes(
  data: GraphData,
  ov: OverviewDoc,
  components: ComponentRecord[],
  options: BuildOptions = {}
): { nodes: Node[]; edges: Edge[] } {
  const gitStatus = data.git_status || {};
  const nodes: Node[] = [];
  const edges: Edge[] = [];
  const duplicateNames = duplicateNameSet(components);

  let summaryNodeId: string | null = null;
  if (options.parentSummary) {
    summaryNodeId = `summary-group:${options.parentSummary.groupId}`;
    nodes.push({
      id: summaryNodeId,
      type: "group",
      position: { x: 0, y: 0 },
      data: {
        name: options.parentSummary.label,
        count: options.parentSummary.totalComponents,
        children: options.parentSummary.componentNames,
        groupId: options.parentSummary.groupId,
        folderHints: options.parentSummary.folderHints,
        gitStatus: gitStatusForTargets(gitStatus, components.map((c) => c.target)),
        isSummary: true,
        nonNavigable: true,
      },
    });
  }

  const connectSummary = (nodeId: string) => {
    if (!summaryNodeId) return;
    addStructuralEdge(edges, summaryNodeId, nodeId);
  };

  const containers = detectContainers(components);
  const childKeys = new Set<string>();
  const containerParentKeys = new Set<string>();
  for (const { parent, children } of containers) {
    containerParentKeys.add(parent.key);
    for (const child of children) {
      childKeys.add(child.key);
    }
  }

  const compToNodeIds = new Map<string, Set<string>>();

  for (const { parent, children } of containers) {
    const dirPath = parent.target!.endsWith("/")
      ? parent.target!
      : `${parent.target!}/`;
    const nodeId = `group:${parent.key}`;
    const resolvedModule = findModuleByTarget(data, dirPath) || findModule(data, parent.name);

    nodes.push({
      id: nodeId,
      type: "group",
      position: { x: 0, y: 0 },
      data: {
        name: parent.name,
        count: children.length,
        children: children.map((c) => c.name),
        groupId: dirPath,
        moduleId: resolvedModule?.name || null,
        folderHints: deriveFolderHints([parent, ...children], dirPath),
        hasNameCollision: duplicateNames.has(parent.normName),
        gitStatus: gitStatusForTargets(gitStatus, [
          dirPath,
          parent.target,
          ...children.map((c) => c.target),
        ]),
      },
    });

    connectSummary(nodeId);

    addNameNodeMapping(compToNodeIds, parent.normName, nodeId);
    for (const child of children) {
      addNameNodeMapping(compToNodeIds, child.normName, nodeId);
    }
  }

  const remaining = components.filter(
    (comp) => !childKeys.has(comp.key) && !containerParentKeys.has(comp.key)
  );

  const byTarget = new Map<string, { target: string | null; comps: ComponentRecord[] }>();
  for (const comp of remaining) {
    const key = comp.target ? `target:${comp.target}` : `orphan:${comp.key}`;
    const existing = byTarget.get(key) || { target: comp.target, comps: [] };
    existing.comps.push(comp);
    byTarget.set(key, existing);
  }

  for (const { target, comps } of byTarget.values()) {
    if (comps.length === 1) {
      const comp = comps[0];
      const resolvedModule = findModule(data, comp.name);
      const matchingFiles = findComponentFiles(data, comp.name, comp.target);

      const nodeId = `comp:${comp.key}`;
      nodes.push({
        id: nodeId,
        type: "component",
        position: { x: 0, y: 0 },
        data: {
          name: comp.name,
          description: comp.description,
          target: comp.target,
          moduleId: resolvedModule?.name || null,
          hasChildren: !!(resolvedModule || matchingFiles.length > 0),
          hasNameCollision: duplicateNames.has(comp.normName),
          gitStatus: gitStatusForPath(gitStatus, comp.target),
        },
      });

      connectSummary(nodeId);
      addNameNodeMapping(compToNodeIds, comp.normName, nodeId);
      continue;
    }

    const fileDoc = target
      ? data.files.find((f) => f.path === target || f.path.endsWith(target))
      : undefined;
    const mod = target ? findModuleByTarget(data, target) : undefined;

    const nodeId = `filegroup:${target || comps[0].key}`;
    nodes.push({
      id: nodeId,
      type: "filegroup",
      position: { x: 0, y: 0 },
      data: {
        path: target || comps[0].name,
        absPath: fileDoc?.abs_path || (target ? `${data.project_root}/${target}` : data.project_root),
        concepts: comps.map((c) => ({
          name: c.name,
          description: c.description,
        })),
        diveFile: fileDoc?.dive_file || "",
        diveRels: fileDoc?.dive_rel || [],
        tags: (fileDoc?.tags || []).map((t) => ({
          line: t.line,
          description: t.description,
        })),
        tagCount: fileDoc?.tags.length || 0,
        hasDiveMeta:
          !!fileDoc && (!!fileDoc.dive_file || fileDoc.dive_rel.length > 0 || fileDoc.tags.length > 0),
        moduleId: mod?.name || null,
        collapsedCount: comps.length,
        collapsedNames: comps.map((c) => c.name),
        parentGroupId: options.parentSummary?.label || null,
        parentTotalComponents: options.parentSummary?.totalComponents || null,
        isLeaf: !!options.fileGroupsAreLeaf,
        hasNameCollision: comps.some((c) => duplicateNames.has(c.normName)),
        gitStatus: gitStatusForTargets(gitStatus, [
          target,
          ...comps.map((c) => c.target),
        ]),
      },
    });

    connectSummary(nodeId);

    for (const comp of comps) {
      addNameNodeMapping(compToNodeIds, comp.normName, nodeId);
    }
  }

  const rels = parseRelationships(ov.relationships);
  const seenRelEdges = new Set<string>();

  for (const rel of rels) {
    const srcIds = [...(compToNodeIds.get(normalizeName(rel.src)) || [])];
    const tgtIds = [...(compToNodeIds.get(normalizeName(rel.tgt)) || [])];

    if (srcIds.length === 0 || tgtIds.length === 0) continue;

    const ambiguous = srcIds.length > 1 || tgtIds.length > 1;
    for (const srcId of srcIds) {
      for (const tgtId of tgtIds) {
        if (srcId === tgtId) continue;
        addRelationshipEdge(
          edges,
          seenRelEdges,
          srcId,
          tgtId,
          rel.label,
          rel.raw,
          ambiguous
        );
      }
    }
  }

  return { nodes, edges };
}

function detectContainers(
  components: ComponentRecord[]
): { parent: ComponentRecord; children: ComponentRecord[] }[] {
  const result: { parent: ComponentRecord; children: ComponentRecord[] }[] = [];
  const claimed = new Set<string>();

  const sorted = [...components].sort(
    (a, b) => (a.target?.length || 0) - (b.target?.length || 0)
  );

  for (const potential of sorted) {
    if (!potential.target) continue;
    if (claimed.has(potential.key)) continue;
    if (!isLikelyDirectory(potential.target)) continue;

    const dirPath = potential.target.endsWith("/")
      ? potential.target
      : `${potential.target}/`;

    const children: ComponentRecord[] = [];
    for (const other of components) {
      if (other.key === potential.key) continue;
      if (claimed.has(other.key)) continue;
      if (!other.target) continue;
      if (other.target.startsWith(dirPath)) {
        children.push(other);
      }
    }

    if (children.length > 0) {
      result.push({ parent: potential, children });
      for (const child of children) {
        claimed.add(child.key);
      }
    }
  }

  return result;
}

function isLikelyDirectory(path: string): boolean {
  if (path.endsWith("/")) return true;
  const lastSegment = path.split("/").pop() || "";
  return !lastSegment.includes(".");
}

function flatSystemLevel(data: GraphData): { nodes: Node[]; edges: Edge[] } {
  const gitStatus = data.git_status || {};
  const ov = data.overview;

  if (ov && ov.components.length > 0) {
    return buildComponentNodes(data, ov, prepareComponents(ov.components));
  }

  const nodes: Node[] = [];
  const edges: Edge[] = [];

  if (data.modules.length > 0) {
    for (const mod of data.modules) {
      nodes.push({
        id: `comp:${mod.name}`,
        type: "component",
        position: { x: 0, y: 0 },
        data: {
          name: mod.title || mod.name,
          description: mod.description,
          target: null,
          moduleId: mod.name,
          hasChildren: true,
          gitStatus: gitStatusForPath(gitStatus, mod.name),
        },
      });
    }
  } else if (data.files.length > 0) {
    const groups = groupFilesByDirectory(data.files);

    if (groups.size > 1) {
      for (const [dir, files] of groups) {
        nodes.push({
          id: `dir:${dir}`,
          type: "component",
          position: { x: 0, y: 0 },
          data: {
            name: dir || "root",
            description: `${files.length} tagged file${files.length > 1 ? "s" : ""}`,
            target: dir,
            moduleId: null,
            dirPath: dir,
            hasChildren: true,
            gitStatus: gitStatusForPath(gitStatus, dir),
          },
        });
      }
    } else {
      for (const file of data.files) {
        addFileNode(nodes, file, gitStatus);
      }
      addDiveRelEdges(data, nodes, edges);
    }
  }

  return { nodes, edges };
}

interface DiffRelationRecord {
  source: string;
  target: string;
  labels: Set<string>;
  evidence: Set<"semantic" | "static">;
  staticKinds: Set<string>;
}

interface DiffGroupRecord {
  id: string;
  label: string;
  children: Set<string>;
  minHop: number;
}

interface DiffModuleRecord {
  id: string;
  label: string;
  groupId: string;
  moduleId: string | null;
  children: Set<string>;
  minHop: number;
}

function buildDiffRelationRecords(data: GraphData): Map<string, DiffRelationRecord> {
  const out = new Map<string, DiffRelationRecord>();
  const upsert = (
    source: string,
    target: string,
    evidence: "semantic" | "static",
    label?: string,
    staticKind?: string
  ) => {
    const src = normalizeTargetPath(source);
    const tgt = normalizeTargetPath(target);
    if (!src || !tgt || src === tgt) return;
    const key = `${src}->${tgt}`;
    const record = out.get(key) || {
      source: src,
      target: tgt,
      labels: new Set<string>(),
      evidence: new Set<"semantic" | "static">(),
      staticKinds: new Set<string>(),
    };
    record.evidence.add(evidence);
    if (label && label.trim()) record.labels.add(label.trim());
    if (staticKind && staticKind.trim()) record.staticKinds.add(staticKind.trim());
    out.set(key, record);
  };

  for (const edge of data.static_analysis?.edges || []) {
    upsert(edge.source_path, edge.target_path, "static", edge.kind, edge.kind);
  }

  for (const file of data.files || []) {
    for (const rel of file.dive_rel || []) {
      const refPath = extractFileRef(rel, data);
      if (!refPath) continue;
      upsert(file.path, refPath, "semantic", extractRelLabel(rel, refPath));
    }
  }

  return out;
}

function bfsDiffHops(
  seeds: string[],
  relations: Map<string, DiffRelationRecord>,
  maxHops: number
): Map<string, number> {
  const adjacency = new Map<string, Set<string>>();
  const connect = (a: string, b: string) => {
    const setA = adjacency.get(a) || new Set<string>();
    setA.add(b);
    adjacency.set(a, setA);
  };

  for (const edge of relations.values()) {
    connect(edge.source, edge.target);
    connect(edge.target, edge.source);
  }

  const hops = new Map<string, number>();
  const queue: Array<{ path: string; hop: number }> = [];
  for (const seed of seeds) {
    const normalized = normalizeTargetPath(seed);
    if (!normalized || hops.has(normalized)) continue;
    hops.set(normalized, 0);
    queue.push({ path: normalized, hop: 0 });
  }

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) continue;
    if (current.hop >= maxHops) continue;
    for (const next of adjacency.get(current.path) || new Set<string>()) {
      if (hops.has(next)) continue;
      hops.set(next, current.hop + 1);
      queue.push({ path: next, hop: current.hop + 1 });
    }
  }

  return hops;
}

function relationStyleForEvidence(
  evidence: Set<"semantic" | "static">
): { stroke: string; strokeWidth: number; strokeDasharray?: string } {
  const hasSemantic = evidence.has("semantic");
  const hasStatic = evidence.has("static");
  if (hasSemantic && hasStatic) {
    return { stroke: graphColors.edgeBlended, strokeWidth: 1.7 };
  }
  if (hasStatic) {
    return { stroke: graphColors.edgeStatic, strokeWidth: 1.55 };
  }
  return { stroke: graphColors.edgeRelationship, strokeWidth: 1.65 };
}

function sortedSetValues(values: Set<string>): string[] {
  return [...values].sort((a, b) => a.localeCompare(b));
}

function changedSubset(paths: string[], changedSet: Set<string>): string[] {
  return paths.filter((path) => changedSet.has(path));
}

function primaryDiffRelationLabel(relation: DiffRelationRecord): string {
  if (relation.labels.size > 0) return [...relation.labels][0];
  if (relation.staticKinds.size > 0) return [...relation.staticKinds][0];
  return "related";
}

function diffFileNodeId(path: string): string {
  return `diff:file:${path}`;
}

function diffTagNodeId(path: string, line: number): string {
  return `diff:tag:${path}:${line}`;
}

function makeDiffGroupNode(group: DiffGroupRecord, changedSet: Set<string>): Node {
  const children = sortedSetValues(group.children);
  const changedChildren = changedSubset(children, changedSet);
  return {
    id: group.id,
    type: "group",
    position: { x: 0, y: 0 },
    data: {
      name: group.label,
      count: children.length,
      children,
      groupId: group.label.replace(/\/$/, ""),
      nonNavigable: true,
      diffHop: group.minHop,
      diffLane: "group",
      diffPaths: changedChildren,
      hasChanges: changedChildren.length > 0,
    },
  };
}

function makeDiffModuleNode(moduleRec: DiffModuleRecord, changedSet: Set<string>): Node {
  const children = sortedSetValues(moduleRec.children);
  const changedChildren = changedSubset(children, changedSet);
  return {
    id: moduleRec.id,
    type: "group",
    position: { x: 0, y: 0 },
    data: {
      name: moduleRec.label,
      count: children.length,
      children,
      groupId: moduleRec.moduleId || moduleRec.label,
      moduleId: moduleRec.moduleId,
      nonNavigable: true,
      diffHop: moduleRec.minHop,
      diffLane: "module",
      diffPaths: changedChildren,
      hasChanges: changedChildren.length > 0,
    },
  };
}

function makeDiffRelationEdge(relation: DiffRelationRecord, index: number): Edge {
  const evidence = [...relation.evidence];
  return {
    id: `e-diff-rel-${index}`,
    source: diffFileNodeId(relation.source),
    target: diffFileNodeId(relation.target),
    label: primaryDiffRelationLabel(relation),
    animated: relation.evidence.has("semantic"),
    style: relationStyleForEvidence(relation.evidence),
    data: {
      kind: "relationship",
      layout: false,
      evidence,
      staticKind: relation.staticKinds.size > 0 ? [...relation.staticKinds][0] : undefined,
    },
  };
}

function diffLevel(data: GraphData, nav: NavEntry): { nodes: Node[]; edges: Edge[] } {
  const gitStatus = data.git_status || {};
  const changed = changedPaths(data);
  const changedSet = new Set(changed);
  const navSeeds = (nav.diff?.seedPaths || []).map((path) => normalizeTargetPath(path));
  const seedPaths = navSeeds.filter((path) => !!path && changedSet.has(path));
  const seeds = seedPaths.length > 0 ? seedPaths : changed.slice(0, 1);
  const maxHops = Math.max(0, Math.min(2, nav.diff?.maxHops ?? 2));

  if (seeds.length === 0) {
    return { nodes: [], edges: [] };
  }

  const relations = buildDiffRelationRecords(data);
  const hops = bfsDiffHops(seeds, relations, maxHops);
  for (const seed of seeds) {
    if (!hops.has(seed)) hops.set(seed, 0);
  }
  const includedPaths = [...hops.keys()].sort((a, b) => a.localeCompare(b));
  if (includedPaths.length === 0) {
    return { nodes: [], edges: [] };
  }

  const fileByPath = new Map<string, FileDiveDoc>();
  for (const file of data.files || []) {
    fileByPath.set(normalizeTargetPath(file.path), file);
  }

  const nodes: Node[] = [];
  const edges: Edge[] = [];
  const groupById = new Map<string, DiffGroupRecord>();
  const moduleById = new Map<string, DiffModuleRecord>();
  const fileToModule = new Map<string, string>();

  for (const path of includedPaths) {
    const hop = Math.min(maxHops, hops.get(path) ?? maxHops);
    const segments = path.split("/").filter(Boolean);
    const top = segments[0] || "root";
    const groupId = `diff:group:${top}`;
    const group = groupById.get(groupId) || {
      id: groupId,
      label: `${top}/`,
      children: new Set<string>(),
      minHop: hop,
    };
    group.minHop = Math.min(group.minHop, hop);
    group.children.add(path);
    groupById.set(groupId, group);

    const mod = findModuleByTarget(data, path);
    const moduleKey = mod?.name || `__${top}__`;
    const moduleNodeId = `diff:module:${moduleKey}`;
    const moduleRec = moduleById.get(moduleNodeId) || {
      id: moduleNodeId,
      label: mod?.title || mod?.name || `${top} module`,
      groupId,
      moduleId: mod?.name || null,
      children: new Set<string>(),
      minHop: hop,
    };
    moduleRec.minHop = Math.min(moduleRec.minHop, hop);
    moduleRec.children.add(path);
    moduleById.set(moduleNodeId, moduleRec);
    fileToModule.set(path, moduleNodeId);

    const fileDoc = fileByPath.get(path);
    const status = gitStatus[path];
    const fileNodeId = diffFileNodeId(path);
    nodes.push({
      id: fileNodeId,
      type: "file",
      position: { x: 0, y: 0 },
      data: {
        path,
        absPath: fileDoc?.abs_path || `${data.project_root}/${path}`,
        description: fileDoc?.dive_file || "No @dive-file narrative",
        tagCount: fileDoc?.tags.length || 0,
        hasDiveMeta: !!fileDoc,
        gitStatus: status,
        diffPaths: [path],
        hasChanges: changedSet.has(path),
        diffHop: hop,
        diffLane: "file",
      },
    });

    for (const tag of (fileDoc?.tags || []).slice(0, 10)) {
      const tagNodeId = diffTagNodeId(path, tag.line);
      nodes.push({
        id: tagNodeId,
        type: "tag",
        position: { x: 0, y: 0 },
        data: {
          line: tag.line,
          description: tag.description,
          absPath: fileDoc?.abs_path || `${data.project_root}/${path}`,
          diffHop: hop,
          diffLane: "tag",
          diffPaths: [path],
          hasChanges: changedSet.has(path),
        },
      });
      addStructuralEdge(edges, fileNodeId, tagNodeId);
    }
  }

  for (const group of [...groupById.values()].sort((a, b) => a.label.localeCompare(b.label))) {
    nodes.push(makeDiffGroupNode(group, changedSet));
  }

  for (const moduleRec of [...moduleById.values()].sort((a, b) => a.label.localeCompare(b.label))) {
    nodes.push(makeDiffModuleNode(moduleRec, changedSet));
  }

  for (const [path, moduleNodeId] of fileToModule) {
    const groupId = moduleById.get(moduleNodeId)?.groupId;
    if (groupId) addStructuralEdge(edges, groupId, moduleNodeId);
    addStructuralEdge(edges, moduleNodeId, diffFileNodeId(path));
  }

  let relIndex = 0;
  for (const relation of relations.values()) {
    if (!hops.has(relation.source) || !hops.has(relation.target)) continue;
    edges.push(makeDiffRelationEdge(relation, relIndex++));
  }

  return { nodes, edges };
}

// ─── Module Level ──────────────────────────────────────────────────────

interface ModuleFileRecord {
  path: string;
  absPath: string;
  description: string;
  tagCount: number;
  hasDiveMeta: boolean;
  gitStatus?: GitDiffStatus;
}

function moduleRootPrefix(paths: string[]): string {
  const clean = paths
    .map((path) => normalizeTargetPath(path).replace(/\/\*.*$/, ""))
    .filter(Boolean)
    .map((path) => {
      const parts = path.split("/").filter(Boolean);
      if (parts.length <= 1) return path;
      const last = parts[parts.length - 1] || "";
      return last.includes(".") ? parts.slice(0, -1).join("/") : path;
    });

  if (clean.length === 0) return "";
  let prefix = clean[0];
  for (let i = 1; i < clean.length; i += 1) {
    const current = clean[i];
    while (prefix && !current.startsWith(prefix)) {
      const cut = prefix.lastIndexOf("/");
      if (cut < 0) {
        prefix = "";
        break;
      }
      prefix = prefix.slice(0, cut);
    }
  }
  return prefix;
}

function collectModuleFiles(data: GraphData, mod: ModuleDoc): ModuleFileRecord[] {
  const gitStatus = data.git_status || {};
  const files = new Map<string, ModuleFileRecord>();
  const declaredPaths = mod.files
    .map((entry) => normalizeTargetPath(entry.path).replace(/\/\*.*$/, ""))
    .filter(Boolean);
  const declaredRootPrefix = moduleRootPrefix(declaredPaths);
  const moduleNamePrefix = normalizeTargetPath(mod.name);
  const add = (path: string, description: string, fileDoc?: FileDiveDoc) => {
    const normalized = normalizeTargetPath(path);
    if (!normalized) return;
    if (files.has(normalized)) return;
    const hasDiveMetaFromFile =
      !!fileDoc && (!!fileDoc.dive_file || fileDoc.dive_rel.length > 0 || fileDoc.tags.length > 0);
    const hasDiveMetaFromModuleDoc = description.trim().length > 0;
    files.set(normalized, {
      path: normalized,
      absPath: fileDoc?.abs_path || `${data.project_root}/${normalized}`,
      description: description || fileDoc?.dive_file || "",
      tagCount: fileDoc?.tags.length || 0,
      hasDiveMeta: hasDiveMetaFromFile || hasDiveMetaFromModuleDoc,
      gitStatus: gitStatusForPath(gitStatus, normalized),
    });
  };

  for (const fileRef of mod.files) {
    const rawPath = normalizeTargetPath(fileRef.path);
    if (!rawPath) continue;
    const wildcard = rawPath.includes("*");
    if (!wildcard) {
      const fileDoc = data.files.find(
        (file) => file.path === rawPath || file.path.endsWith(rawPath)
      );
      add(rawPath, fileRef.description, fileDoc);
      continue;
    }

    const prefix = normalizeTargetPath(rawPath.replace(/\*.*$/, ""));
    if (!prefix) continue;
    for (const file of data.files) {
      if (file.path.startsWith(prefix)) {
        add(file.path, fileRef.description, file);
      }
    }
  }

  for (const file of data.files) {
    if (files.has(file.path)) continue;
    const normalizedPath = normalizeTargetPath(file.path);
    const inDeclaredRoot = declaredRootPrefix
      ? normalizedPath === declaredRootPrefix ||
        normalizedPath.startsWith(`${declaredRootPrefix}/`)
      : false;
    const inModulePrefix = moduleNamePrefix
      ? normalizedPath === moduleNamePrefix ||
        normalizedPath.startsWith(`${moduleNamePrefix}/`)
      : false;

    const shouldInclude = declaredRootPrefix
      ? inDeclaredRoot
      : inModulePrefix;
    if (shouldInclude) {
      add(normalizedPath, file.dive_file || `${file.tags.length} tags`, file);
    }
  }

  return [...files.values()].sort((a, b) => a.path.localeCompare(b.path));
}

function bucketModuleFilesByNextDir(
  files: ModuleFileRecord[],
  scopePrefix: string | null,
  rootPrefix: string
): Map<string, ModuleFileRecord[]> {
  const buckets = new Map<string, ModuleFileRecord[]>();

  for (const file of files) {
    const path = normalizeTargetPath(file.path);
    if (!path) continue;

    if (scopePrefix && !(path === scopePrefix || path.startsWith(`${scopePrefix}/`))) {
      continue;
    }

    let relative = path;
    let anchoredToRoot = false;
    if (scopePrefix) {
      relative = relative.slice(scopePrefix.length).replace(/^\/+/, "");
    } else if (rootPrefix && (relative === rootPrefix || relative.startsWith(`${rootPrefix}/`))) {
      relative = relative.slice(rootPrefix.length).replace(/^\/+/, "");
      anchoredToRoot = true;
    }

    const parts = relative.split("/").filter(Boolean);
    if (parts.length <= 1) continue;

    const next = parts[0];
    const bucketPrefix = scopePrefix
      ? `${scopePrefix}/${next}`
      : anchoredToRoot && rootPrefix
        ? `${rootPrefix}/${next}`
        : next;
    const list = buckets.get(bucketPrefix) || [];
    list.push(file);
    buckets.set(bucketPrefix, list);
  }

  return buckets;
}

function moduleLevel(
  data: GraphData,
  moduleId: string,
  navLabel?: string
): { nodes: Node[]; edges: Edge[] } {
  const gitStatus = data.git_status || {};
  const nodes: Node[] = [];
  const edges: Edge[] = [];

  const dirFilter = parseModuleDirFilterId(moduleId);
  const baseModuleId = dirFilter?.moduleId || moduleId;
  const scopePrefix = dirFilter?.dirPrefix || null;

  const mod = findModule(data, baseModuleId);
  if (mod) {
    buildModuleNodes(data, mod, nodes, edges, scopePrefix, navLabel);
    return { nodes, edges };
  }

  const dirFiles = data.files.filter(
    (file) => file.path.startsWith(`${baseModuleId}/`) || file.path.startsWith(baseModuleId)
  );

  if (dirFiles.length > 0) {
    for (const file of dirFiles) {
      addFileNode(nodes, file, gitStatus);
    }
    addDiveRelEdges(data, nodes, edges);
    return { nodes, edges };
  }

  const rawComp = data.overview?.components.find(
    (comp) => comp.name.toLowerCase() === baseModuleId.toLowerCase()
  );
  const comp = rawComp ? { ...rawComp, target: cleanTarget(rawComp.target) } : undefined;

  if (comp) {
    const files = findComponentFiles(data, comp.name, comp.target);
    if (files.length > 0) {
      for (const file of files) {
        addFileNode(nodes, file, gitStatus);
      }
      addDiveRelEdges(data, nodes, edges);
      return { nodes, edges };
    }

    if (comp.target) {
      const targetModule = findModuleByTarget(data, comp.target);
      if (targetModule) {
        buildModuleNodes(data, targetModule, nodes, edges, scopePrefix, navLabel);
        return { nodes, edges };
      }

      nodes.push({
        id: `file:${comp.target}`,
        type: "file",
        position: { x: 0, y: 0 },
        data: {
          path: comp.target,
          absPath: `${data.project_root}/${comp.target}`,
          description: comp.description || "No dive tags in this file yet",
          tagCount: 0,
          hasDiveMeta: !!comp.description,
          gitStatus: gitStatusForPath(gitStatus, comp.target),
        },
      });
      return { nodes, edges };
    }
  }

  const lower = normalizeName(baseModuleId);
  for (const file of data.files) {
    const pathNorm = normalizeName(file.path);
    if (pathNorm.includes(lower)) {
      addFileNode(nodes, file, gitStatus);
    }
  }
  addDiveRelEdges(data, nodes, edges);

  return { nodes, edges };
}

function buildModuleNodes(
  data: GraphData,
  mod: ModuleDoc,
  nodes: Node[],
  edges: Edge[],
  scopePrefix: string | null,
  navLabel?: string
) {
  const gitStatus = data.git_status || {};
  const allFiles = collectModuleFiles(data, mod);
  const rootPrefix = moduleRootPrefix(mod.files.map((entry) => entry.path));
  const visibleFiles = scopePrefix
    ? allFiles.filter(
      (file) => file.path === scopePrefix || file.path.startsWith(`${scopePrefix}/`)
    )
    : allFiles;

  const dirBuckets = bucketModuleFilesByNextDir(allFiles, scopePrefix, rootPrefix);
  const directFiles = visibleFiles.filter((file) => {
    let relative = normalizeTargetPath(file.path);
    if (scopePrefix) {
      relative = relative.slice(scopePrefix.length).replace(/^\/+/, "");
    } else if (rootPrefix && (relative === rootPrefix || relative.startsWith(`${rootPrefix}/`))) {
      relative = relative.slice(rootPrefix.length).replace(/^\/+/, "");
    }
    const parts = relative.split("/").filter(Boolean);
    return parts.length <= 1;
  });

  if (dirBuckets.size > 0) {
    const summaryId = `summary-module:${mod.name}:${scopePrefix || rootPrefix || "root"}`;
    const preferredRootLabel = navLabel?.trim();
    const baseLabel = !scopePrefix && preferredRootLabel
      ? preferredRootLabel
      : (mod.title || mod.name);
    const summaryLabel = scopePrefix
      ? `${baseLabel} / ${scopePrefix.split("/").pop() || scopePrefix}`
      : baseLabel;

    nodes.push({
      id: summaryId,
      type: "group",
      position: { x: 0, y: 0 },
      data: {
        name: summaryLabel,
        count: visibleFiles.length,
        children: visibleFiles.map((file) => file.path),
        groupId: mod.name,
        folderHints: [],
        gitStatus: gitStatusForTargets(
          gitStatus,
          visibleFiles.map((file) => file.path)
        ),
        isSummary: true,
        nonNavigable: true,
      },
    });

    const orderedBuckets = [...dirBuckets.entries()].sort((a, b) => {
      if (b[1].length !== a[1].length) return b[1].length - a[1].length;
      return a[0].localeCompare(b[0]);
    });

    for (const [bucketPrefix, bucketFiles] of orderedBuckets) {
      const filterId = makeModuleDirFilterId(mod.name, bucketPrefix);
      const nodeId = `group:${filterId}`;
      const label = bucketPrefix.split("/").pop() || bucketPrefix;
      nodes.push({
        id: nodeId,
        type: "group",
        position: { x: 0, y: 0 },
        data: {
          name: label,
          count: bucketFiles.length,
          children: bucketFiles.map((file) => file.path),
          groupId: filterId,
          folderHints: [],
          gitStatus: gitStatusForTargets(
            gitStatus,
            bucketFiles.map((file) => file.path)
          ),
        },
      });
      addStructuralEdge(edges, summaryId, nodeId);
    }

    for (const file of directFiles) {
      const fileId = `file:${file.path}`;
      nodes.push({
        id: fileId,
        type: "file",
        position: { x: 0, y: 0 },
        data: {
          path: file.path,
          absPath: file.absPath,
          description: file.description,
          tagCount: file.tagCount,
          hasDiveMeta: file.hasDiveMeta,
          gitStatus: file.gitStatus,
        },
      });
      addStructuralEdge(edges, summaryId, fileId);
    }
  } else {
    for (const file of visibleFiles) {
      nodes.push({
        id: `file:${file.path}`,
        type: "file",
        position: { x: 0, y: 0 },
        data: {
          path: file.path,
          absPath: file.absPath,
          description: file.description,
          tagCount: file.tagCount,
          hasDiveMeta: file.hasDiveMeta,
          gitStatus: file.gitStatus,
        },
      });
    }
  }

  const rels = parseRelationships(mod.relationships);
  const seenRelEdges = new Set<string>();
  for (const rel of rels) {
    const srcNodes = findNodesByRef(nodes, rel.src);
    const tgtNodes = findNodesByRef(nodes, rel.tgt);
    if (srcNodes.length === 0 || tgtNodes.length === 0) continue;

    const ambiguous = srcNodes.length > 1 || tgtNodes.length > 1;
    for (const srcNode of srcNodes) {
      for (const tgtNode of tgtNodes) {
        if (srcNode.id === tgtNode.id) continue;
        addRelationshipEdge(
          edges,
          seenRelEdges,
          srcNode.id,
          tgtNode.id,
          rel.label,
          rel.raw,
          ambiguous
        );
      }
    }
  }

  addDiveRelEdges(data, nodes, edges);
}

// ─── File Level ────────────────────────────────────────────────────────

function fileLevel(
  data: GraphData,
  filePath: string
): { nodes: Node[]; edges: Edge[] } {
  const gitStatus = data.git_status || {};
  const nodes: Node[] = [];
  const edges: Edge[] = [];

  const file = data.files.find(
    (entry) => entry.path === filePath || entry.path.endsWith(filePath)
  );
  if (!file) return { nodes, edges };

  const concepts = findConceptsForFile(data, file.path);
  if (concepts.length > 0) {
    const summaryId = `summary:${file.path}`;
    nodes.push({
      id: summaryId,
      type: "filegroup",
      position: { x: 0, y: 0 },
      data: {
        path: file.path,
        absPath: file.abs_path,
        concepts,
        diveFile: file.dive_file || "",
        diveRels: file.dive_rel,
        tags: [],
        tagCount: file.tags.length,
        gitStatus: gitStatusForPath(gitStatus, file.path),
        isSummary: true,
      },
    });

    addStructuralEdge(edges, summaryId, `file:${file.path}`);
  }

  nodes.push({
    id: `file:${file.path}`,
    type: "file",
    position: { x: 0, y: 0 },
    data: {
      path: file.path,
      absPath: file.abs_path,
      description: file.dive_file || "",
      tagCount: file.tags.length,
      isHeader: true,
      diveRels: file.dive_rel,
      gitStatus: gitStatusForPath(gitStatus, file.path),
    },
  });

  for (const tag of file.tags) {
    const tagId = `tag:${file.path}:${tag.line}`;
    nodes.push({
      id: tagId,
      type: "tag",
      position: { x: 0, y: 0 },
      data: {
        line: tag.line,
        description: tag.description,
        absPath: file.abs_path,
      },
    });

    addStructuralEdge(edges, `file:${file.path}`, tagId);
  }

  const seenRelEdges = new Set<string>();
  for (let i = 0; i < file.dive_rel.length; i += 1) {
    const rel = file.dive_rel[i];
    const refPath = extractFileRef(rel, data);
    if (!refPath) continue;

    const refFile = data.files.find((entry) => entry.path === refPath);
    const refId = `ref:${refPath}:${i}`;

    nodes.push({
      id: refId,
      type: "file",
      position: { x: 0, y: 0 },
      data: {
        path: refPath,
        absPath: refFile?.abs_path || "",
        description: refFile?.dive_file || rel,
        tagCount: refFile?.tags.length || 0,
        isReference: true,
        gitStatus: gitStatusForPath(gitStatus, refPath),
      },
    });

    const label = extractRelLabel(rel, refPath);
    addRelationshipEdge(edges, seenRelEdges, `file:${file.path}`, refId, label, rel, false);
  }

  return { nodes, edges };
}

// ─── Helpers ───────────────────────────────────────────────────────────

function findConceptsForFile(
  data: GraphData,
  filePath: string
): { name: string; description: string }[] {
  if (!data.overview) return [];
  const results: { name: string; description: string }[] = [];
  for (const comp of data.overview.components) {
    const target = cleanTarget(comp.target);
    if (!target) continue;
    if (target === filePath || filePath.endsWith(target) || target.endsWith(filePath)) {
      results.push({ name: comp.name, description: comp.description });
    }
  }
  return results;
}

function findModuleByTarget(data: GraphData, target: string): ModuleDoc | undefined {
  const normalizedTarget = target.replace(/^\.\//, "");
  for (const mod of data.modules) {
    for (const file of mod.files) {
      const normalizedPath = file.path.replace(/^\.\//, "");
      if (normalizedPath === normalizedTarget) return mod;
      if (
        normalizedPath.startsWith(`${normalizedTarget}/`) ||
        normalizedPath.startsWith(normalizedTarget)
      ) {
        return mod;
      }
      const targetDir = normalizedTarget.includes("/")
        ? normalizedTarget.substring(0, normalizedTarget.lastIndexOf("/"))
        : normalizedTarget;
      if (targetDir && normalizedPath.startsWith(`${targetDir}/`)) return mod;
    }
  }
  return undefined;
}

function findModule(data: GraphData, id: string): ModuleDoc | undefined {
  let mod = data.modules.find((m) => m.name === id);
  if (mod) return mod;

  const lower = id.toLowerCase();

  mod = data.modules.find((m) => m.name.toLowerCase() === lower);
  if (mod) return mod;

  const norm = normalizeName(lower);
  mod = data.modules.find((m) => normalizeName(m.name) === norm);
  if (mod) return mod;

  mod = data.modules.find((m) => m.title.toLowerCase() === lower);
  if (mod) return mod;

  mod = data.modules.find((m) => m.title.toLowerCase().includes(lower));
  if (mod) return mod;

  mod = data.modules.find((m) => lower.includes(m.name.toLowerCase()));
  if (mod) return mod;

  return undefined;
}

function findComponentFiles(
  data: GraphData,
  componentName: string,
  target: string | null
): FileDiveDoc[] {
  const files: FileDiveDoc[] = [];
  const seen = new Set<string>();

  if (target) {
    const normalizedTarget = target.replace(/^\.\//, "");
    for (const file of data.files) {
      if (
        file.path.startsWith(`${normalizedTarget}/`) ||
        file.path === normalizedTarget ||
        file.path.startsWith(normalizedTarget)
      ) {
        if (!seen.has(file.path)) {
          files.push(file);
          seen.add(file.path);
        }
      }
    }
  }

  const lower = normalizeName(componentName);
  for (const file of data.files) {
    if (seen.has(file.path)) continue;
    const pathNorm = normalizeName(file.path);
    if (pathNorm.includes(lower)) {
      files.push(file);
      seen.add(file.path);
    }
  }

  return files;
}

function findNodesByRef(nodes: Node[], value: string): Node[] {
  const token = unwrapEntityToken(value);
  const lower = token.toLowerCase();
  const norm = normalizeName(token);

  return nodes.filter((node) => {
    const data = node.data as {
      path?: string;
      target?: string;
      name?: string;
      children?: string[];
    };
    const candidates: string[] = [];
    if (data.path) candidates.push(data.path);
    if (data.target) candidates.push(data.target);
    if (data.name) candidates.push(data.name);
    if (Array.isArray(data.children)) candidates.push(...data.children);
    if (candidates.length === 0) return false;

    return candidates.some((path) => {
      const fileName = path.split("/").pop() || "";
      const fileBase = fileName.replace(/\.\w+$/, "");
      return (
        path === token ||
        path.toLowerCase().includes(lower) ||
        fileName.toLowerCase() === lower ||
        fileBase.toLowerCase() === lower ||
        normalizeName(path) === norm
      );
    });
  });
}

function addFileNode(
  nodes: Node[],
  file: FileDiveDoc,
  gitStatus?: Record<string, GitDiffStatus>
) {
  const id = `file:${file.path}`;
  if (nodes.some((node) => node.id === id)) return;
  nodes.push({
    id,
    type: "file",
    position: { x: 0, y: 0 },
    data: {
      path: file.path,
      absPath: file.abs_path,
      description: file.dive_file || `${file.tags.length} tags`,
      tagCount: file.tags.length,
      hasDiveMeta: true,
      gitStatus: gitStatusForPath(gitStatus, file.path),
    },
  });
}

function addDiveRelEdges(data: GraphData, nodes: Node[], edges: Edge[]) {
  const nodeIds = new Set(nodes.map((node) => node.id));
  const seenRelEdges = new Set<string>();

  for (const node of [...nodes]) {
    const nodeData = node.data as { path?: string };
    const filePath = nodeData.path;
    if (!filePath) continue;

    const fileDoc = data.files.find((file) => file.path === filePath);
    if (!fileDoc) continue;

    for (const rel of fileDoc.dive_rel) {
      const refPath = extractFileRef(rel, data);
      if (!refPath) continue;

      const targetId = `file:${refPath}`;
      if (!nodeIds.has(targetId)) continue;
      if (targetId === node.id) continue;

      const label = extractRelLabel(rel, refPath);
      addRelationshipEdge(
        edges,
        seenRelEdges,
        node.id,
        targetId,
        label,
        rel,
        false
      );
    }
  }
}

function extractFileRef(relText: string, data: GraphData): string | null {
  for (const file of data.files) {
    if (relText.includes(file.path)) return file.path;
  }

  const pathMatch = relText.match(/\b((?:[\w.-]+\/)+[\w.-]+\.\w+)\b/);
  if (pathMatch) {
    const found = data.files.find(
      (file) => file.path === pathMatch[1] || file.path.endsWith(pathMatch[1])
    );
    return found?.path || null;
  }

  return null;
}

function extractRelLabel(rel: string, refPath: string): string {
  const removedPath = rel.replace(refPath, "").trim();
  const label = removedPath.replace(/^[-–:→←><\s]+|[-–:→←><\s]+$/g, "").trim();
  return label || "relates to";
}

function groupFilesByDirectory(
  files: FileDiveDoc[]
): Map<string, FileDiveDoc[]> {
  const groups = new Map<string, FileDiveDoc[]>();
  for (const file of files) {
    const parts = file.path.split("/");
    const dir = parts.length > 1 ? parts[0] : ".";
    const list = groups.get(dir) || [];
    list.push(file);
    groups.set(dir, list);
  }
  return groups;
}

function splitArrow(rel: string):
  | { left: string; right: string; reverse: boolean }
  | null {
  const arrows = [
    { token: "->", reverse: false },
    { token: "→", reverse: false },
    { token: "<-", reverse: true },
    { token: "←", reverse: true },
  ] as const;

  let bestIndex = -1;
  let best: (typeof arrows)[number] | null = null;

  for (const arrow of arrows) {
    const idx = rel.indexOf(arrow.token);
    if (idx === -1) continue;
    if (bestIndex === -1 || idx < bestIndex) {
      bestIndex = idx;
      best = arrow;
    }
  }

  if (!best) return null;

  const left = rel.slice(0, bestIndex).trim();
  const right = rel.slice(bestIndex + best.token.length).trim();
  if (!left || !right) return null;

  return { left, right, reverse: best.reverse };
}

function splitTargetAndLabel(text: string): { target: string; label: string } {
  const colonIdx = text.indexOf(":");
  if (colonIdx === -1) {
    return { target: text.trim(), label: "" };
  }

  const target = text.slice(0, colonIdx).trim();
  const label = text.slice(colonIdx + 1).trim();
  return { target, label };
}

function parseRelationships(rels: string[]): ParsedRel[] {
  const out: ParsedRel[] = [];
  for (const rel of rels) {
    const arrow = splitArrow(rel);
    if (!arrow) continue;

    const parsedRight = splitTargetAndLabel(arrow.right);
    const srcRaw = arrow.reverse ? parsedRight.target : arrow.left;
    const tgtRaw = arrow.reverse ? arrow.left : parsedRight.target;

    const src = unwrapEntityToken(srcRaw);
    const tgt = unwrapEntityToken(tgtRaw);
    if (!src || !tgt) continue;

    out.push({
      src,
      tgt,
      label: parsedRight.label,
      raw: rel,
    });
  }
  return out;
}
