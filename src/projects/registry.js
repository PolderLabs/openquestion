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

import { readFile, writeFile, mkdir, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve, basename } from "node:path";
import { homedir } from "node:os";
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

export { CONFIG_DIR, looksLikeProject, projectId, normalizeProject };
