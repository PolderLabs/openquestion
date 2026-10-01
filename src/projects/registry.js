// Project registry.
//
// A project is a directory (or a GitHub repository) that contains questionnaires.
// Projects come from three places, in increasing priority:
//
//   1. projects.json in the config directory - explicit, authoritative
//   2. auto-discovered sibling directories that look like projects
//   3. whatever the user adds at runtime through the UI or the CLI
//
// A project always has a local root. GitHub is optional and adds a second,
// remote-backed view of the same questionnaires.

import { readFile, writeFile, mkdir, readdir, stat, realpath } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve, basename } from "node:path";
import { homedir } from "node:os";

// The index build is the one slow operation in the picker, so it can be traced
// separately from the per-request logging in the server.
const AUTH_TRACE = process.env.OPENQUESTION_DEBUG !== "0";
import { randomUUID } from "node:crypto";

const CONFIG_DIR =
  process.env.OPENQUESTION_CONFIG_DIR ||
  join(homedir(), ".config", "openquestion");
const CONFIG_FILE = join(CONFIG_DIR, "projects.json");

// A directory is considered a project if it holds a manifest or a questions
// directory. Cheap to check, and it avoids listing every unrelated repo.
const PROJECT_MARKERS = [
  "questionnaire/manifest.json",
  "questionnaire/manifests/index.json",
  "questionnaire/questions",
  "questionnaire/questionnaires/index.json",
];

async function isDirectory(path) {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

function looksLikeProject(root) {
  return PROJECT_MARKERS.some((marker) => existsSync(join(root, marker)));
}

function projectId(name) {
  return String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

export async function loadConfig() {
  if (!existsSync(CONFIG_FILE)) {
    return { version: 1, projects: [], settings: {} };
  }
  try {
    const raw = JSON.parse(await readFile(CONFIG_FILE, "utf8"));
    return {
      version: 1,
      projects: Array.isArray(raw.projects) ? raw.projects : [],
      settings: raw.settings && typeof raw.settings === "object" ? raw.settings : {},
    };
  } catch (error) {
    throw new Error(
      `Could not read ${CONFIG_FILE}: ${error.message}. Fix or delete the file.`,
    );
  }
}

export async function saveConfig(config) {
  await mkdir(CONFIG_DIR, { recursive: true });
  await writeFile(CONFIG_FILE, JSON.stringify(config, null, 2) + "\n", "utf8");
  return CONFIG_FILE;
}

export function configPath() {
  return CONFIG_FILE;
}

/** Normalizes a raw project record into the shape the app relies on. */
function normalizeProject(raw) {
  const root = resolve(raw.root);
  return {
    id: raw.id || projectId(basename(root)) || randomUUID().slice(0, 8),
    name: raw.name || basename(root),
    root,
    storage: raw.storage === "github" ? "github" : "local",
    layout: raw.layout && typeof raw.layout === "object" ? raw.layout : {},
    github: raw.github
      ? {
          repository: raw.github.repository,
          branch: raw.github.branch || "main",
          manifestPath: raw.github.manifestPath,
        }
      : null,
    commitOnWrite: raw.commitOnWrite === true,
    source: raw.source || "config",
  };
}

/**
 * Lists directories under `parent` that look like projects. Used by the CLI's
 * `projects discover` and by the UI's directory picker so the user can pick from
 * a short list instead of typing a path.
 */
export async function discoverProjects(parent, { limit = 200 } = {}) {
  if (!(await isDirectory(parent))) return [];
  const entries = await readdir(parent, { withFileTypes: true });
  const found = [];
  for (const entry of entries) {
    if (found.length >= limit) break;
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const root = join(parent, entry.name);
    if (looksLikeProject(root)) {
      found.push(normalizeProject({ root, source: "discovered" }));
    }
  }
  return found;
}

/**
 * The merged project list: config entries plus any discovered siblings that are
 * not already present. Discovery only looks at `settings.scanParents`, so the
 * default behaviour stays predictable.
 */
export async function listProjects() {
  const config = await loadConfig();
  const byId = new Map();
  for (const raw of config.projects) {
    const project = normalizeProject(raw);
    byId.set(project.id, project);
  }

  for (const parent of config.settings?.scanParents || []) {
    for (const project of await discoverProjects(resolve(parent))) {
      if (!byId.has(project.id)) byId.set(project.id, project);
    }
  }

  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export async function getProject(id) {
  const projects = await listProjects();
  return projects.find((p) => p.id === id) || null;
}

export async function addProject(input) {
  const config = await loadConfig();
  const project = normalizeProject({ ...input, source: "config" });
  const existing = config.projects.findIndex(
    (p) => p.id === project.id || resolve(p.root) === project.root,
  );
  if (existing >= 0) {
    config.projects[existing] = { ...config.projects[existing], ...input };
  } else {
    config.projects.push(input);
  }
  await saveConfig(config);
  return project;
}

export async function removeProject(id) {
  const config = await loadConfig();
  const before = config.projects.length;
  config.projects = config.projects.filter(
    (p) => (p.id || projectId(basename(resolve(p.root)))) !== id,
  );
  if (config.projects.length === before) {
    throw new Error(`No project with id "${id}".`);
  }
  await saveConfig(config);
}

/** Lists directories one level up from `path`, for the picker's "go up" step. */
export async function listDirectories(path) {
  const target = resolve(path || homedir());
  if (!(await isDirectory(target))) {
    throw new Error(`Not a directory: ${target}`);
  }
  const entries = await readdir(target, { withFileTypes: true });
  const directories = entries
    .filter((e) => e.isDirectory() && !e.name.startsWith("."))
    .map((e) => ({
      name: e.name,
      path: join(target, e.name),
      isProject: looksLikeProject(join(target, e.name)),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return {
    path: target,
    parent: target === "/" ? null : resolve(target, ".."),
    directories,
  };
}

// Directories that are never worth descending into. They are large, they never
// contain a project, and walking them turns a search into a disk-thrashing
// crawl.
const SKIP_DIRECTORIES = new Set([
  "node_modules", "dist", "build", "out", "target", "vendor",
  ".git", ".cache", ".venv", "venv", "__pycache__",
  "coverage", ".next", ".nuxt", ".svelte-kit", "tmp",
]);

// Depth is deliberately capped. A project is normally a checkout one or two
// levels below where someone keeps their code, and recursing without a bound
// turns a search into a full-disk scan.
const SEARCH_MAX_DEPTH = 2;
const SEARCH_MAX_RESULTS = 200;

/**
 * Finds project directories under `root`, at most SEARCH_MAX_DEPTH levels deep.
 * Returns candidates with a depth, so the UI can show "nested one level" and
 * rank shallower hits first.
 */
export async function searchProjects(root, { maxDepth = SEARCH_MAX_DEPTH } = {}) {
  const start = resolve(root);
  if (!(await isDirectory(start))) return [];
  return (await collectEntries(start, maxDepth, false)).filter(
    (item) => item.isProject,
  );
}

// Shared by searchProjects and the picker's index: the same bounded walk, told
// whether to record plain folders as well as projects.
async function collectEntries(start, maxDepth, includeFolders) {
  const found = new Map();
  const limit = includeFolders ? INDEX_MAX_ENTRIES : SEARCH_MAX_RESULTS;
  const queue = [{ path: start, depth: 0 }];

  while (queue.length > 0 && found.size < limit) {
    const current = queue.shift();
    let entries;
    try {
      entries = await readdir(current.path, { withFileTypes: true });
    } catch {
      // An unreadable directory should not abort the whole search.
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      if (entry.name.startsWith(".")) continue;
      if (SKIP_DIRECTORIES.has(entry.name)) continue;

      const full = join(current.path, entry.name);
      // A symlink could point back up the tree; resolve it and only follow it
      // if it lands inside the search root, so the walk cannot loop.
      let real = full;
      if (entry.isSymbolicLink()) {
        try {
          real = await realpath(full);
        } catch {
          continue;
        }
        if (!real.startsWith(start)) continue;
      }

      const isProject = looksLikeProject(real);
      if (isProject || includeFolders) {
        // Keyed by path, so a directory that is both a project and a folder is
        // listed once and as the project, which is the row the user can act on.
        if (isProject || !found.has(real)) {
          found.set(real, {
            id: projectId(entry.name) || entry.name,
            name: entry.name,
            path: real,
            depth: current.depth + 1,
            isProject,
          });
        }
        if (found.size >= limit) break;
        // Keep descending: a monorepo is often a project in its own right and
        // also contains projects of its own (a/b). Stopping at the first hit
        // would hide them.
      }

      if (current.depth + 1 < maxDepth) {
        queue.push({ path: real, depth: current.depth + 1 });
      }
    }
  }

  return [...found.values()].sort(
    (a, b) => a.depth - b.depth || a.name.localeCompare(b.name),
  );
}

// The picker index looks a little deeper than the picker search, because the
// whole point is to find something without knowing where it lives. It is still
// bounded, and still skips the directories that hold thousands of files.
const SUGGEST_MAX_DEPTH = 3;

// Unlike SEARCH_MAX_RESULTS, which caps what the user is shown, this caps the
// index itself. A home directory is a few hundred folders deep, so this is a
// runaway guard rather than a number anyone should ever reach.
const INDEX_MAX_ENTRIES = 2000;

/**
 * A cached index of the directories under a root folder: every subfolder plus
 * the ones that are projects. The picker matches typed text against it, so a
 * folder and a project are found the same way. Defaults to the user's home,
 * but the user can travel into any folder, so the cache is keyed by root.
 */
const suggestionCache = new Map();
const SUGGESTION_TTL_MS = 60_000;

export async function suggestEntries(root, maxDepth = SUGGEST_MAX_DEPTH) {
  const start = resolve(root || homedir());
  // Browsing a folder and searching inside it want different depths, so they
  // are indexed and cached separately rather than evicting each other.
  const key = `${start}::${maxDepth}`;
  const cached = suggestionCache.get(key);
  const now = Date.now();
  if (cached && now - cached.at < SUGGESTION_TTL_MS) {
    return cached.items;
  }
  if (!(await isDirectory(start))) return [];

  const t0 = Date.now();
  const items = await collectEntries(start, maxDepth, true);
  suggestionCache.set(key, { at: now, items });
  if (AUTH_TRACE) {
    console.log(
      `[projects] indexed ${items.length} director${items.length === 1 ? "y" : "ies"} under ${start} (depth ${maxDepth}) in ${Date.now() - t0}ms`,
    );
  }
  return items;
}

export { CONFIG_DIR, looksLikeProject, projectId, normalizeProject };
