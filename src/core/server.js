// The HTTP server.
//
// Backend-agnostic: every route resolves a project, asks its storage backend
// for data, and returns JSON. Nothing below knows whether the bytes came from
// the filesystem or the GitHub API.

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

import {
  listProjects,
  getProject,
  addProject,
  removeProject,
  listDirectories,
  searchProjects,
  suggestProjects,
  loadConfig,
  saveConfig,
} from "../projects/registry.js";
import { join, dirname, extname, resolve } from "node:path";
import { homedir } from "node:os";
import {
  AuthError,
  NotFoundError,
  ValidationError,
  ConflictError,
} from "./storage.js";
import {
  validateQuestionnaireId,
  validateVersion,
  validateAnswers,
  validateComments,
} from "./validate.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB_DIR = join(__dirname, "..", "web");

const BODY_LIMIT_BYTES = 2 * 1024 * 1024;
const SESSION_COOKIE = "oq_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const AUTH_DEBUG = process.env.OPENQUESTION_DEBUG !== "0";

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
};

const sessions = new Map();

function log(event, detail) {
  if (AUTH_DEBUG) console.log(`[openquestion] ${event}${detail ? " " + detail : ""}`);
}

function sendJson(res, status, payload) {
  if (res.headersSent) return;
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || "").split(";")) {
    const index = part.indexOf("=");
    if (index <= 0) continue;
    const name = part.slice(0, index).trim();
    out[name] = part.slice(index + 1).trim();
  }
  return out;
}

function getSession(req, res) {
  const cookies = parseCookies(req.headers.cookie);
  let id = cookies[SESSION_COOKIE];
  let session = id ? sessions.get(id) : null;
  if (!session) {
    id = randomBytes(32).toString("base64url");
    session = {
      id,
      createdAt: Date.now(),
      identity: null,
      githubToken: null,
      // Fresh per session and compared on callback, so a forged callback cannot
      // bind someone else's token.
      oauthState: randomBytes(16).toString("base64url"),
    };
    sessions.set(id, session);
    const secure = process.env.OPENQUESTION_SECURE_COOKIE === "1" ? "; Secure" : "";
    res.setHeader(
      "Set-Cookie",
      `${SESSION_COOKIE}=${id}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}${secure}`,
    );
  }
  return session;
}

// Local mode has no accounts, so the "identity" is simply a label the user picks
// (their name, an agent name, "default"). It scopes the answer file on disk.
function respondentFor(session, project, requested) {
  const label = String(requested || session.identity || project.defaultRespondent || "local")
    .trim()
    .slice(0, 64);
  return label || "local";
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > BODY_LIMIT_BYTES) {
      throw new ValidationError("Request body is too large.", "body_too_large", 413);
    }
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new ValidationError("Request body must be valid JSON.", "invalid_json");
  }
}

function securityHeaders(res) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader(
    "Content-Security-Policy",
    [
      "default-src 'self'",
      "connect-src 'self'",
      "img-src 'self' data:",
      "style-src 'self'",
      "script-src 'self'",
      "base-uri 'none'",
      "form-action 'self'",
      "frame-ancestors 'none'",
      "object-src 'none'",
    ].join("; "),
  );
}

async function serveStatic(res, urlPath) {
  const relative = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
  const filePath = join(WEB_DIR, relative);
  if (!filePath.startsWith(WEB_DIR)) {
    sendJson(res, 404, { error: "not_found" });
    return;
  }
  try {
    const body = await readFile(filePath);
    res.writeHead(200, {
      "Content-Type": CONTENT_TYPES[extname(filePath)] || "application/octet-stream",
      "Content-Length": body.length,
      "Cache-Control": "no-cache",
    });
    res.end(body);
  } catch {
    sendJson(res, 404, { error: "not_found" });
  }
}

function errorStatus(error) {
  return Number.isInteger(error?.status) ? error.status : 500;
}

/**
 * Builds the storage backend for a project. Held in module scope because every
 * route needs it, but assigned by createApp() rather than imported, so an
 * embedder can supply its own backends.
 */
let localFactory = null;
let githubFactory = null;
let githubOAuth = null;

export function createApp({ storageFactory, github } = {}) {
  if (typeof storageFactory?.local !== "function") {
    throw new Error("createApp requires a local storage factory.");
  }
  localFactory = storageFactory.local;
  // GitHub storage is per-user, so the factory is carried at module scope but
  // receives the session, which is where the token lives.
  githubFactory = storageFactory.github || null;
  githubOAuth = github || null;

  return async function handle(req, res) {
    try {
      securityHeaders(res);
      const url = new URL(req.url || "/", "http://localhost");
      const session = getSession(req, res);

      if (url.pathname.startsWith("/api/")) {
        await handleApi(req, res, url, session);
        return;
      }

      if (req.method === "GET") {
        await serveStatic(res, url.pathname);
        return;
      }
      sendJson(res, 405, { error: "method_not_allowed" });
    } catch (error) {
      const status = errorStatus(error);
      if (status >= 500) console.error(error);
      sendJson(res, status, {
        error: error.code || "server_error",
        message: status >= 500 ? "Internal server error." : error.message,
      });
    }
  };
}

/**
 * Resolves the storage backend for a project. Local projects are the default;
 * a project that declares a GitHub repository routes through the GitHub backend,
 * which the embedder supplies.
 */
function makeStorage(project, session) {
  if (project.storage === "github") {
    if (typeof githubFactory !== "function") {
      throw new AuthError(
        "This project needs GitHub storage, which is not available in this build.",
        "github_unavailable",
      );
    }
    return githubFactory(project, session);
  }
  return localFactory(project);
}

async function handleApi(req, res, url, session) {
  const path = url.pathname;

  if (req.method === "GET" && path === "/api/health") {
    // `service` lets the CLI recognize its own instance, so a second `oq`
    // reuses it instead of starting a duplicate on the same port.
    sendJson(res, 200, { ok: true, service: "openquestion" });
    return;
  }

  if (req.method === "GET" && path === "/api/projects") {
    sendJson(res, 200, { projects: await listProjects() });
    return;
  }

  if (req.method === "POST" && path === "/api/projects") {
    const body = await readBody(req);
    // The API speaks `path`; the registry stores `root`. Translating here keeps
    // one name on the wire and one in config, instead of making every caller
    // know both.
    const requested = body.path || body.root;
    if (!requested || typeof requested !== "string") {
      throw new ValidationError("A project path is required.", "invalid_project");
    }
    const project = await addProject({
      name: body.name,
      root: expandHome(requested.trim()),
      storage: body.storage,
      layout: body.layout,
      github: body.github,
      commitOnWrite: body.commitOnWrite === true,
    });
    log("project added", project.id);
    sendJson(res, 201, { project });
    return;
  }

  if (req.method === "DELETE" && path.startsWith("/api/projects/")) {
    const id = decodeURIComponent(path.slice("/api/projects/".length));
    await removeProject(id);
    sendJson(res, 200, { ok: true });
    return;
  }

  // Directory browser for the "add project" picker.
  if (req.method === "GET" && path === "/api/directories") {
    sendJson(res, 200, await listDirectories(url.searchParams.get("path")));
    return;
  }

  // Suggestions for the picker. The root is whatever the user is currently
  // looking at, so it starts at their home folder and can be moved into any
  // subfolder they travel into. Cached per root, so it is cheap after the first
  // call.
  if (req.method === "GET" && path === "/api/suggest") {
    const root = expandHome(url.searchParams.get("root") || "");
    const all = await suggestProjects(root || undefined);
    const query = (url.searchParams.get("q") || "").trim();
    const limit = Math.min(Number(url.searchParams.get("limit") || 8) || 8, 40);
    const results = query ? filterSuggestions(all, query, limit) : all.slice(0, limit);
    // The immediate children, so the user can step into a folder rather than
    // being limited to whatever the index happened to find below the root.
    const folders = (await listDirectories(root || undefined)).directories.map(
      (dir) => ({ name: dir.name, path: dir.path, isProject: dir.isProject }),
    );
    sendJson(res, 200, {
      // `root` is what was searched; `homeDir` is always the real home, so the
      // UI can abbreviate the label and know when "up" should stop.
      root: root || homedir(),
      homeDir: homedir(),
      total: all.length,
      results,
      folders,
    });
    return;
  }

  if (req.method === "GET" && path === "/api/search") {
    const root = url.searchParams.get("root");
    if (!root) {
      throw new ValidationError("A root directory is required.", "invalid_path");
    }
    const query = (url.searchParams.get("q") || "").trim().toLowerCase();
    const matches = await searchProjects(root);

    // Filter here as well as in the UI so a large result set does not have to
    // cross the wire to be discarded.
    const filtered = query
      ? matches.filter((m) => m.name.toLowerCase().includes(query))
      : matches;
    sendJson(res, 200, { root: resolve(root), results: filtered });
    return;
  }

  // Persisted UI settings. Only the projects folder is stored today; it is
  // remembered so the picker reopens where the user last worked, and it is
  // never used to auto-add anything without an explicit pick.
  if (req.method === "GET" && path === "/api/settings") {
    const config = await loadConfig();
    sendJson(res, 200, {
      defaultProjectDir: config.settings?.defaultProjectDir || null,
    });
    return;
  }

  if (req.method === "POST" && path === "/api/settings") {
    const body = await readBody(req);
    const config = await loadConfig();
    config.settings = config.settings || {};
    if (typeof body.defaultProjectDir === "string") {
      config.settings.defaultProjectDir = body.defaultProjectDir.trim() || null;
    }
    await saveConfig(config);
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "POST" && path === "/api/identity") {
    const body = await readBody(req);
    session.identity = String(body.label || "").trim().slice(0, 64) || null;
    sendJson(res, 200, { identity: session.identity });
    return;
  }

  // GitHub sign-in. The token stays server-side; the browser only gets the
  // session cookie, so a compromised page cannot read the token.
  if (req.method === "POST" && path === "/api/github/login") {
    const body = await readBody(req);
    if (!githubOAuth) {
      throw new AuthError(
        "GitHub sign-in is not configured on this server.",
        "github_not_configured",
      );
    }
    const url = new URL(githubOAuth.authorizeUrl);
    url.searchParams.set("state", session.oauthState);
    sendJson(res, 200, { url: url.toString() });
    return;
  }

  if (req.method === "GET" && path === "/api/github/callback") {
    await handleGithubCallback(req, res, url, session);
    return;
  }

  if (req.method === "POST" && path === "/api/github/token") {
    // Agent / CI path: hand the server a token that lives in the environment.
    const body = await readBody(req);
    const supplied = String(body.token || "").trim();
    if (!supplied) {
      throw new AuthError("A token is required.", "invalid_token");
    }
    session.githubToken = supplied;
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "DELETE" && path === "/api/github/token") {
    session.githubToken = null;
    sendJson(res, 200, { ok: true });
    return;
  }

  const projectId = url.searchParams.get("project");
  let project = projectId ? await getProject(projectId) : null;

  if (path === "/api/manifest" || path === "/api/questionnaire" || path === "/api/answers") {
    // No implicit fallback to the first project. Guessing here would silently
    // serve the wrong project's answers, so the client must name one.
    if (!project) {
      throw new NotFoundError(
        "No project selected. Pass ?project=<id> from the projects list.",
      );
    }
  }

  if (req.method === "GET" && path === "/api/manifest") {
    const storage = makeStorage(project, session);
    const manifest = await storage.getManifest(project);
    sendJson(res, 200, {
      project: { id: project.id, name: project.name, storage: project.storage },
      respondent: respondentFor(session, project, url.searchParams.get("as")),
      manifest,
    });
    return;
  }

  if (req.method === "GET" && path === "/api/questionnaire") {
    const storage = makeStorage(project, session);
    const filePath = url.searchParams.get("path");
    if (!filePath) {
      throw new ValidationError("A questionnaire path is required.", "invalid_path");
    }
    const document = await storage.readQuestionnaire(project, filePath);
    sendJson(res, 200, { document, path: filePath });
    return;
  }

  if (req.method === "GET" && path === "/api/answers") {
    const storage = makeStorage(project, session);
    const questionnaireId = validateQuestionnaireId(
      url.searchParams.get("questionnaireId") || "",
    );
    const respondent = respondentFor(session, project, url.searchParams.get("as"));
    const result = await storage.readAnswers(project, { questionnaireId, respondent });
    sendJson(res, 200, {
      exists: Boolean(result),
      path: result?.path || null,
      sha: result?.sha || null,
      document: result?.document || null,
    });
    return;
  }

  if (req.method === "PUT" && path === "/api/answers") {
    const storage = makeStorage(project, session);
    if (storage.writable === false) {
      throw new AuthError("This project is read-only.");
    }
    const body = await readBody(req);
    const questionnaireId = validateQuestionnaireId(body.questionnaireId);
    const questionnaireVersion = validateVersion(body.questionnaireVersion);
    const answers = validateAnswers(body.answers);
    const comments = validateComments(body.comments);
    const respondent = respondentFor(session, project, body.respondent);

    // The manifest is the authority on what exists, so a stale or hand-edited
    // answer file cannot introduce a questionnaire that is not published.
    const manifest = await storage.getManifest(project);
    const entry = manifest.questionnaires.find(
      (item) =>
        item.id === questionnaireId &&
        item.version === questionnaireVersion &&
        item.path === body.sourcePath,
    );
    if (!entry) {
      throw new ConflictError(
        "That questionnaire changed on the server. Reload it before saving.",
      );
    }

    const result = await storage.writeAnswers(project, {
      questionnaireId,
      questionnaireVersion,
      sourcePath: body.sourcePath,
      respondent,
      answers,
      comments,
      expectedSha: body.expectedSha || null,
      message: body.message || null,
    });
    log("answers saved", `${project.id} ${questionnaireId} ${result.path}`);
    sendJson(res, 200, result);
    return;
  }

  sendJson(res, 404, { error: "not_found" });
}

async function handleGithubCallback(req, res, url, session) {
  const code = url.searchParams.get("code") || "";
  const state = url.searchParams.get("state") || "";

  if (!githubOAuth) {
    sendJson(res, 501, { error: "github_not_configured" });
    return;
  }
  if (!code || state !== session.oauthState) {
    redirect(res, "/?github=invalid_state");
    return;
  }

  const response = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      client_id: githubOAuth.clientId,
      client_secret: githubOAuth.clientSecret,
      code,
      redirect_uri: githubOAuth.callbackUrl,
    }),
  });
  const payload = await response.json();
  if (!payload?.access_token) {
    redirect(res, "/?github=" + encodeURIComponent(payload?.error || "failed"));
    return;
  }
  session.githubToken = payload.access_token;
  redirect(res, "/?github=success");
}

function redirect(res, location) {
  res.writeHead(302, { Location: location, "Cache-Control": "no-store" });
  res.end();
}

/** Expands a leading ~ so a path typed by hand works the same as from the shell. */
function expandHome(value) {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return join(homedir(), value.slice(2));
  return value;
}

/**
 * Subsequence match, shared with the client so a suggestion and a search result
 * rank the same way. Consecutive characters and word starts score higher, so
 * "gfq" finds "globalfrontio".
 */
function fuzzyScore(text, needle) {
  const haystack = String(text).toLowerCase();
  const query = needle.toLowerCase();
  if (!query) return 1;
  if (haystack.includes(query)) return 1000 - haystack.indexOf(query);

  let score = 0;
  let index = 0;
  let streak = 0;
  for (const char of query) {
    const found = haystack.indexOf(char, index);
    if (found === -1) return 0;
    if (found === index) streak += 1;
    else streak = 0;
    score += 10 + streak * 5;
    if (found === 0 || /[-_/ ]/.test(haystack[found - 1])) score += 15;
    index = found + 1;
  }
  return score;
}

function filterSuggestions(items, query, limit) {
  const scored = [];
  for (const item of items) {
    // Match the visible name, and also the trailing path segment, so typing
    // "projects" can surface a project whose name does not contain it.
    const score = Math.max(
      fuzzyScore(item.name, query),
      fuzzyScore(item.path, query) / 2,
    );
    if (score > 0) scored.push({ item, score });
  }
  scored.sort((a, b) => b.score - a.score || a.item.depth - b.item.depth);
  return scored.slice(0, limit).map((entry) => entry.item);
}

export { sessions, respondentFor, fuzzyScore };
