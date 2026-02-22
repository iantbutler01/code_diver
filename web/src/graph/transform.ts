import type { Node, Edge } from "@xyflow/react";
import type {
  GraphData,
  NavEntry,
  ModuleDoc,
  FileDiveDoc,
  OverviewDoc,
  ComponentEntry,
} from "../types";

const CLUSTER_THRESHOLD = 8;

/** Strip markdown backticks and whitespace from component targets. */
function cleanTarget(t: string | null): string | null {
  if (!t) return null;
  return t.replace(/^`|`$/g, "").trim() || null;
}

export function transformGraph(
  data: GraphData,
  nav: NavEntry
): { nodes: Node[]; edges: Edge[] } {
  console.log("[transform] nav:", nav.level, nav.id);
  console.log("[transform] files count:", data.files.length);
  console.log("[transform] file paths:", data.files.map((f) => f.path));
  if (data.overview) {
    console.log("[transform] component targets:", data.overview.components.map((c) => ({ name: c.name, target: c.target })));
  }
  let result: { nodes: Node[]; edges: Edge[] };

  if (nav.level === "system") result = systemLevel(data, nav.id);
  else if (nav.level === "module") result = moduleLevel(data, nav.id!);
  else if (nav.level === "file") result = fileLevel(data, nav.id!);
  else result = { nodes: [], edges: [] };

  if (result.nodes.length === 0) {
    result.nodes.push({
      id: "empty-placeholder",
      type: "component",
      position: { x: 0, y: 0 },
      data: {
        name: "No data found",
        description:
          nav.level === "system"
            ? "No .dive/ metadata found. Run an agent with the dive-tag skill to generate it."
            : `No metadata found for "${nav.label}". The module may not have been tagged yet.`,
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

  // Filtered view: show only components in a specific subsystem group
  if (filterId && ov) {
    return filteredSystemLevel(data, ov, filterId);
  }

  // If overview has many components, aggregate into subsystem groups
  if (ov && ov.components.length > CLUSTER_THRESHOLD) {
    return aggregatedSystemLevel(data, ov);
  }

  // Otherwise show the flat component view
  return flatSystemLevel(data);
}

function aggregatedSystemLevel(
  _data: GraphData,
  ov: OverviewDoc
): { nodes: Node[]; edges: Edge[] } {
  const nodes: Node[] = [];
  const edges: Edge[] = [];

  // Group components by first directory segment of their target
  const groups = new Map<string, ComponentEntry[]>();
  for (const raw of ov.components) {
    const comp = { ...raw, target: cleanTarget(raw.target) };
    const dir = comp.target ? comp.target.split("/")[0] : "other";
    const list = groups.get(dir) || [];
    list.push(comp);
    groups.set(dir, list);
  }

  // Create group nodes
  for (const [dir, comps] of groups) {
    nodes.push({
      id: `group:${dir}`,
      type: "group",
      position: { x: 0, y: 0 },
      data: {
        name: dir,
        count: comps.length,
        children: comps.map((c) => c.name),
        groupId: dir,
      },
    });
  }

  // Create edges between groups based on inter-group component relationships
  const compToGroup = new Map<string, string>();
  for (const [dir, comps] of groups) {
    for (const comp of comps) {
      compToGroup.set(comp.name.toLowerCase().replace(/[\s_-]+/g, ""), dir);
    }
  }

  const rels = parseRelationships(ov.relationships);
  const seenEdges = new Set<string>();

  for (const r of rels) {
    const srcNorm = r.src.toLowerCase().replace(/[\s_-]+/g, "");
    const tgtNorm = r.tgt.toLowerCase().replace(/[\s_-]+/g, "");
    const srcGroup = compToGroup.get(srcNorm);
    const tgtGroup = compToGroup.get(tgtNorm);

    if (srcGroup && tgtGroup && srcGroup !== tgtGroup) {
      const edgeKey = `${srcGroup}->${tgtGroup}`;
      if (!seenEdges.has(edgeKey)) {
        seenEdges.add(edgeKey);
        edges.push({
          id: `e-grp-${srcGroup}-${tgtGroup}`,
          source: `group:${srcGroup}`,
          target: `group:${tgtGroup}`,
          animated: true,
        });
      }
    }
  }

  return { nodes, edges };
}

function filteredSystemLevel(
  data: GraphData,
  ov: OverviewDoc,
  groupId: string
): { nodes: Node[]; edges: Edge[] } {
  const cleaned = ov.components.map((c) => ({ ...c, target: cleanTarget(c.target) }));
  const filtered = cleaned.filter((c) => {
    if (!c.target) return groupId === "other";
    return c.target.startsWith(groupId);
  });

  return buildComponentNodes(data, ov, filtered);
}

/**
 * Shared builder for component-level views (both filtered and flat).
 *
 * 1. Detects directory containment: if a component targets a directory
 *    that contains other components' target files, it becomes a "group"
 *    node and its children are excluded from this level (click to drill in).
 * 2. Groups components that share the same target file into "filegroup" nodes.
 * 3. Everything else becomes a normal "component" node.
 */
function buildComponentNodes(
  data: GraphData,
  ov: OverviewDoc,
  components: ComponentEntry[]
): { nodes: Node[]; edges: Edge[] } {
  const nodes: Node[] = [];
  const edges: Edge[] = [];

  // Deduplicate first
  const all = deduplicateComponents(components);

  // Step 1: Detect directory containment
  const containers = detectContainers(all);
  const childNames = new Set<string>();
  for (const { children } of containers) {
    for (const c of children) childNames.add(c.name.toLowerCase());
  }

  // Step 2: Map component names → node IDs (for edge routing)
  const compToNodeId = new Map<string, string>();

  // Build container group nodes
  for (const { parent, children } of containers) {
    const dirPath = parent.target!.endsWith("/")
      ? parent.target!
      : parent.target! + "/";
    const nodeId = `group:${dirPath}`;

    nodes.push({
      id: nodeId,
      type: "group",
      position: { x: 0, y: 0 },
      data: {
        name: parent.name,
        count: children.length,
        children: children.map((c) => c.name),
        groupId: dirPath,
      },
    });

    compToNodeId.set(
      parent.name.toLowerCase().replace(/[\s_-]+/g, ""),
      nodeId
    );
    for (const c of children) {
      compToNodeId.set(
        c.name.toLowerCase().replace(/[\s_-]+/g, ""),
        nodeId
      );
    }
  }

  // Step 3: Build nodes for remaining components (not children of containers)
  const remaining = all.filter(
    (c) => !childNames.has(c.name.toLowerCase()) &&
      !containers.some((ct) => ct.parent.name === c.name)
  );

  // Group remaining by target file
  const byTarget = new Map<string, ComponentEntry[]>();
  for (const comp of remaining) {
    const key = comp.target || `unnamed:${comp.name}`;
    const list = byTarget.get(key) || [];
    list.push(comp);
    byTarget.set(key, list);
  }

  for (const [target, comps] of byTarget) {
    if (comps.length === 1) {
      const comp = comps[0];
      const resolvedModule = findModule(data, comp.name);
      const matchingFiles = findComponentFiles(data, comp.name, comp.target);

      const nodeId = `comp:${comp.name}`;
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
        },
      });

      compToNodeId.set(
        comp.name.toLowerCase().replace(/[\s_-]+/g, ""),
        nodeId
      );
    } else {
      const fileDoc = data.files.find((f) => f.path === target);
      const mod = findModuleByTarget(data, target);

      console.log(`[filegroup] target="${target}" fileDoc found=${!!fileDoc}`);
      if (fileDoc) {
        console.log(`[filegroup] tags=${fileDoc.tags.length} dive_file="${fileDoc.dive_file}" dive_rel=${fileDoc.dive_rel.length}`);
      } else {
        console.log(`[filegroup] NO MATCH. Available paths:`, data.files.map((f) => f.path).filter((p) => p.includes(target.split("/").pop() || "")));
      }

      const nodeId = `filegroup:${target}`;
      nodes.push({
        id: nodeId,
        type: "filegroup",
        position: { x: 0, y: 0 },
        data: {
          path: target,
          absPath:
            fileDoc?.abs_path || data.project_root + "/" + target,
          concepts: comps.map((c) => ({
            name: c.name,
            description: c.description,
          })),
          diveFile: fileDoc?.dive_file || "",
          diveRels: fileDoc?.dive_rel || [],
          tags: (fileDoc?.tags || []).map((t: any) => ({
            line: t.line,
            description: t.description,
          })),
          tagCount: fileDoc?.tags.length || 0,
          moduleId: mod?.name || null,
        },
      });

      for (const comp of comps) {
        compToNodeId.set(
          comp.name.toLowerCase().replace(/[\s_-]+/g, ""),
          nodeId
        );
      }
    }
  }

  // Step 4: Build edges, routing through compToNodeId
  const rels = parseRelationships(ov.relationships);
  const seenEdges = new Set<string>();

  for (const r of rels) {
    const srcNorm = r.src.toLowerCase().replace(/[\s_-]+/g, "");
    const tgtNorm = r.tgt.toLowerCase().replace(/[\s_-]+/g, "");
    const srcId = compToNodeId.get(srcNorm);
    const tgtId = compToNodeId.get(tgtNorm);

    if (srcId && tgtId && srcId !== tgtId) {
      const edgeKey = `${srcId}->${tgtId}`;
      if (!seenEdges.has(edgeKey)) {
        seenEdges.add(edgeKey);
        edges.push({
          id: `e-sys-${edges.length}`,
          source: srcId,
          target: tgtId,
          label: r.label,
          animated: true,
        });
      }
    }
  }

  return { nodes, edges };
}

/**
 * Detect components whose target is a directory that contains other
 * components' target files. Returns parent-children groupings.
 */
function detectContainers(
  components: ComponentEntry[]
): { parent: ComponentEntry; children: ComponentEntry[] }[] {
  const result: { parent: ComponentEntry; children: ComponentEntry[] }[] = [];
  const claimed = new Set<string>(); // child names already claimed

  // Sort so shorter target paths are checked first (broader directories first)
  const sorted = [...components].sort(
    (a, b) => (a.target?.length || 0) - (b.target?.length || 0)
  );

  for (const potential of sorted) {
    if (!potential.target) continue;
    if (claimed.has(potential.name)) continue;

    // Only consider directory-like targets
    if (!isLikelyDirectory(potential.target)) continue;

    const dirPath = potential.target.endsWith("/")
      ? potential.target
      : potential.target + "/";

    const children: ComponentEntry[] = [];
    for (const other of components) {
      if (other === potential) continue;
      if (claimed.has(other.name)) continue;
      if (!other.target) continue;
      if (other.target.startsWith(dirPath)) {
        children.push(other);
      }
    }

    if (children.length > 0) {
      result.push({ parent: potential, children });
      for (const c of children) claimed.add(c.name);
    }
  }

  return result;
}

function isLikelyDirectory(path: string): boolean {
  if (path.endsWith("/")) return true;
  const lastSegment = path.split("/").pop() || "";
  return !lastSegment.includes(".");
}

function deduplicateComponents(comps: ComponentEntry[]): ComponentEntry[] {
  const seen = new Set<string>();
  return comps.filter((c) => {
    const key = c.name.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function flatSystemLevel(data: GraphData): { nodes: Node[]; edges: Edge[] } {
  const ov = data.overview;

  if (ov && ov.components.length > 0) {
    const cleaned = ov.components.map((c) => ({ ...c, target: cleanTarget(c.target) }));
    return buildComponentNodes(data, ov, cleaned);
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
          },
        });
      }
    } else {
      for (const f of data.files) {
        nodes.push({
          id: `file:${f.path}`,
          type: "file",
          position: { x: 0, y: 0 },
          data: {
            path: f.path,
            absPath: f.abs_path,
            description: f.dive_file || `${f.tags.length} tags`,
            tagCount: f.tags.length,
          },
        });
      }
      addDiveRelEdges(data, nodes, edges);
    }
  }

  return { nodes, edges };
}

// ─── Module Level ──────────────────────────────────────────────────────

function moduleLevel(
  data: GraphData,
  moduleId: string
): { nodes: Node[]; edges: Edge[] } {
  const nodes: Node[] = [];
  const edges: Edge[] = [];

  const mod = findModule(data, moduleId);

  if (mod) {
    buildModuleNodes(data, mod, nodes, edges);
    return { nodes, edges };
  }

  const dirFiles = data.files.filter(
    (f) =>
      f.path.startsWith(moduleId + "/") || f.path.startsWith(moduleId)
  );

  if (dirFiles.length > 0) {
    for (const f of dirFiles) {
      addFileNode(nodes, f);
    }
    addDiveRelEdges(data, nodes, edges);
    return { nodes, edges };
  }

  // Strategy 3: Use component target from overview
  const rawComp = data.overview?.components.find(
    (c) => c.name.toLowerCase() === moduleId.toLowerCase()
  );
  const comp = rawComp ? { ...rawComp, target: cleanTarget(rawComp.target) } : undefined;
  if (comp) {
    const files = findComponentFiles(data, comp.name, comp.target);
    if (files.length > 0) {
      for (const f of files) {
        addFileNode(nodes, f);
      }
      addDiveRelEdges(data, nodes, edges);
      return { nodes, edges };
    }

    // Strategy 3b: Find module whose file list overlaps with target path
    if (comp.target) {
      const mod = findModuleByTarget(data, comp.target);
      if (mod) {
        buildModuleNodes(data, mod, nodes, edges);
        return { nodes, edges };
      }
    }

    // Strategy 3c: Create a node for the target itself (untagged file)
    if (comp.target) {
      nodes.push({
        id: `file:${comp.target}`,
        type: "file",
        position: { x: 0, y: 0 },
        data: {
          path: comp.target,
          absPath: data.project_root + "/" + comp.target,
          description: comp.description || "No dive tags in this file yet",
          tagCount: 0,
        },
      });
      return { nodes, edges };
    }
  }

  // Strategy 4: Fuzzy file path matching
  const lower = moduleId.toLowerCase().replace(/[\s_-]+/g, "");
  for (const f of data.files) {
    const pathNorm = f.path.toLowerCase().replace(/[\s_-]+/g, "");
    if (pathNorm.includes(lower)) {
      addFileNode(nodes, f);
    }
  }
  addDiveRelEdges(data, nodes, edges);

  return { nodes, edges };
}

function buildModuleNodes(
  data: GraphData,
  mod: ModuleDoc,
  nodes: Node[],
  edges: Edge[]
) {
  const seen = new Set<string>();

  for (const fileRef of mod.files) {
    const fileDoc = data.files.find(
      (f) => f.path === fileRef.path || f.path.endsWith(fileRef.path)
    );
    const id = `file:${fileRef.path}`;
    if (seen.has(id)) continue;
    seen.add(id);

    nodes.push({
      id,
      type: "file",
      position: { x: 0, y: 0 },
      data: {
        path: fileRef.path,
        absPath: fileDoc?.abs_path || (data.project_root + "/" + fileRef.path),
        description: fileRef.description || fileDoc?.dive_file || "",
        tagCount: fileDoc?.tags.length || 0,
      },
    });
  }

  const modLower = mod.name.toLowerCase().replace(/[\s_-]+/g, "");
  for (const f of data.files) {
    const id = `file:${f.path}`;
    if (seen.has(id)) continue;

    const pathNorm = f.path.toLowerCase().replace(/[\s_-]+/g, "");
    if (pathNorm.includes(modLower)) {
      seen.add(id);
      nodes.push({
        id,
        type: "file",
        position: { x: 0, y: 0 },
        data: {
          path: f.path,
          absPath: f.abs_path,
          description: f.dive_file || `${f.tags.length} tags`,
          tagCount: f.tags.length,
        },
      });
    }
  }

  const rels = parseRelationships(mod.relationships);
  for (let i = 0; i < rels.length; i++) {
    const r = rels[i];
    const srcNode = findNodeByPath(nodes, r.src);
    const tgtNode = findNodeByPath(nodes, r.tgt);
    if (srcNode && tgtNode) {
      edges.push({
        id: `e-mod-${i}`,
        source: srcNode.id,
        target: tgtNode.id,
        label: r.label,
        animated: true,
      });
    }
  }

  addDiveRelEdges(data, nodes, edges);
}

// ─── File Level ────────────────────────────────────────────────────────

function fileLevel(
  data: GraphData,
  filePath: string
): { nodes: Node[]; edges: Edge[] } {
  const nodes: Node[] = [];
  const edges: Edge[] = [];

  const file = data.files.find(
    (f) => f.path === filePath || f.path.endsWith(filePath)
  );
  if (!file) return { nodes, edges };

  // Add parent summary node with overview concepts targeting this file
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
        isSummary: true,
      },
    });

    edges.push({
      id: `e-summary-file`,
      source: summaryId,
      target: `file:${file.path}`,
    });
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

    edges.push({
      id: `e-tag-${tag.line}`,
      source: `file:${file.path}`,
      target: tagId,
    });
  }

  for (let i = 0; i < file.dive_rel.length; i++) {
    const rel = file.dive_rel[i];
    const refPath = extractFileRef(rel, data);
    if (!refPath) continue;

    const refFile = data.files.find((f) => f.path === refPath);
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
      },
    });

    const label = extractRelLabel(rel, refPath);
    edges.push({
      id: `e-rel-${i}`,
      source: `file:${file.path}`,
      target: refId,
      label,
      animated: true,
      style: { stroke: "#f59e0b", strokeWidth: 1.5, strokeDasharray: "5,5" },
    });
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
  const t = target.replace(/^\.\//, "");
  for (const mod of data.modules) {
    for (const f of mod.files) {
      const fp = f.path.replace(/^\.\//, "");
      // Exact file match
      if (fp === t) return mod;
      // Module file is under the target directory
      if (fp.startsWith(t + "/") || fp.startsWith(t)) return mod;
      // Target file is in the same directory tree as a module file
      const targetDir = t.includes("/")
        ? t.substring(0, t.lastIndexOf("/"))
        : t;
      if (targetDir && fp.startsWith(targetDir + "/")) return mod;
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

  const norm = lower.replace(/[\s_-]+/g, "");
  mod = data.modules.find(
    (m) => m.name.toLowerCase().replace(/[\s_-]+/g, "") === norm
  );
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
    const t = target.replace(/^\.\//, "");
    for (const f of data.files) {
      if (
        f.path.startsWith(t + "/") ||
        f.path === t ||
        f.path.startsWith(t)
      ) {
        if (!seen.has(f.path)) {
          files.push(f);
          seen.add(f.path);
        }
      }
    }
  }

  const lower = componentName.toLowerCase().replace(/[\s_-]+/g, "");
  for (const f of data.files) {
    if (seen.has(f.path)) continue;
    const pathNorm = f.path.toLowerCase().replace(/[\s_-]+/g, "");
    if (pathNorm.includes(lower)) {
      files.push(f);
      seen.add(f.path);
    }
  }

  return files;
}


function findNodeByPath(nodes: Node[], name: string): Node | undefined {
  const lower = name.toLowerCase();
  return nodes.find((n) => {
    const path: string = (n.data as any).path || "";
    const fileName = path.split("/").pop() || "";
    const fileBase = fileName.replace(/\.\w+$/, "");
    return (
      path === name ||
      path.toLowerCase().includes(lower) ||
      fileName.toLowerCase() === lower ||
      fileBase.toLowerCase() === lower
    );
  });
}

function addFileNode(nodes: Node[], f: FileDiveDoc) {
  const id = `file:${f.path}`;
  if (nodes.some((n) => n.id === id)) return;
  nodes.push({
    id,
    type: "file",
    position: { x: 0, y: 0 },
    data: {
      path: f.path,
      absPath: f.abs_path,
      description: f.dive_file || `${f.tags.length} tags`,
      tagCount: f.tags.length,
    },
  });
}

function addDiveRelEdges(data: GraphData, nodes: Node[], edges: Edge[]) {
  const nodeIds = new Set(nodes.map((n) => n.id));
  const edgeIds = new Set(edges.map((e) => e.id));

  for (const node of [...nodes]) {
    const filePath: string = (node.data as any).path;
    if (!filePath) continue;

    const fileDoc = data.files.find((f) => f.path === filePath);
    if (!fileDoc) continue;

    for (const rel of fileDoc.dive_rel) {
      const refPath = extractFileRef(rel, data);
      if (!refPath) continue;

      const targetId = `file:${refPath}`;
      if (!nodeIds.has(targetId)) continue;
      if (targetId === node.id) continue;

      const edgeId = `e-drel-${node.id}-${targetId}`;
      if (edgeIds.has(edgeId)) continue;
      edgeIds.add(edgeId);

      const label = extractRelLabel(rel, refPath);

      edges.push({
        id: edgeId,
        source: node.id,
        target: targetId,
        label,
        animated: true,
        style: { stroke: "#f59e0b", strokeWidth: 1.5 },
      });
    }
  }
}

function extractFileRef(relText: string, data: GraphData): string | null {
  for (const f of data.files) {
    if (relText.includes(f.path)) return f.path;
  }

  const pathMatch = relText.match(/\b((?:[\w.-]+\/)+[\w.-]+\.\w+)\b/);
  if (pathMatch) {
    const found = data.files.find(
      (f) => f.path === pathMatch[1] || f.path.endsWith(pathMatch[1])
    );
    return found?.path || null;
  }

  return null;
}

function extractRelLabel(rel: string, refPath: string): string {
  let label = rel.replace(refPath, "").trim();
  label = label.replace(/^[-–:→←><\s]+|[-–:→←><\s]+$/g, "").trim();
  return label || "relates to";
}

function groupFilesByDirectory(
  files: FileDiveDoc[]
): Map<string, FileDiveDoc[]> {
  const groups = new Map<string, FileDiveDoc[]>();
  for (const f of files) {
    const parts = f.path.split("/");
    const dir = parts.length > 1 ? parts[0] : ".";
    const list = groups.get(dir) || [];
    list.push(f);
    groups.set(dir, list);
  }
  return groups;
}

interface ParsedRel {
  src: string;
  tgt: string;
  label: string;
}

function parseRelationships(rels: string[]): ParsedRel[] {
  const out: ParsedRel[] = [];
  for (const rel of rels) {
    let m = rel.match(/^(.+?)\s*(?:->|→)\s*(.+?):\s*(.*)$/);
    if (m) {
      out.push({ src: m[1].trim(), tgt: m[2].trim(), label: m[3].trim() });
      continue;
    }
    m = rel.match(/^(.+?)\s*(?:<-|←)\s*(.+?):\s*(.*)$/);
    if (m) {
      out.push({ src: m[2].trim(), tgt: m[1].trim(), label: m[3].trim() });
    }
  }
  return out;
}
