// Local filesystem storage.
//
// Reads and writes plain files inside a project directory. No network, no
// authentication, no tokens. This is what makes the tool usable from a local
// agent: it can read a project, answer, and write back without any remote
// round trip.
//
// Layout inside a project (all paths are relative to the project root):
//   questionnaire/manifest.json   or questionnaire/manifests/index.json
//   questionnaire/questions/*.json
//   answers/<questionnaire-id>/<respondent>.json
//
// Directories are configurable per project, so an existing repository can point
// at the layout it already uses.

import { readFile, writeFile, mkdir, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve, relative, isAbsolute, dirname } from "node:path";
import { createHash } from "node:crypto";

import {
  NotFoundError,
  ConflictError,
  normalizeManifest,
  normalizeAnswerFile,
} from "../core/storage.js";
import {
  validateRelativePath,
  parseJson,
  validateQuestionnaire,
} from "../core/validate.js";
import { commitFile } from "./git.js";

const DEFAULT_LAYOUT = {
  manifest: "questionnaire/manifest.json",
  questions: "questionnaire/questions",
  answers: "answers",
};

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolves a relative path inside the project root and refuses anything that
 * escapes it. This is the only place filesystem paths are built, so one check
 * covers every read and write.
 */
function inside(root, relativePath) {
  const safe = validateRelativePath(relativePath);
  const full = resolve(root, safe);
  const rel = relative(root, full);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new NotFoundError("Path is outside the project.");
  }
  return { full, rel };
}

export function createLocalStorage(options = {}) {
  const commitOnWrite = options.commitOnWrite === true;

  return {
    id: "local",
    label: "Local files",
    writable: true,
    requiresAuth: false,

    async init() {
      /* nothing to warm up */
    },

    async getManifest(project) {
      const layout = { ...DEFAULT_LAYOUT, ...(project.layout || {}) };
      const candidates = [
        layout.manifest,
        "questionnaire/manifests/index.json",
        "questionnaire/questionnaires/index.json",
        "questionnaire/index.json",
      ];

      for (const candidate of candidates) {
        const { full } = inside(project.root, candidate);
        if (!(await exists(full))) continue;
        const raw = parseJson(await readFile(full, "utf8"), candidate);
        return normalizeManifest(raw);
      }

      throw new NotFoundError(
        `No questionnaire manifest found in ${project.name}. Expected ${layout.manifest}.`,
      );
    },

    async readQuestionnaire(project, path) {
      const { full } = inside(project.root, path);
      if (!(await exists(full))) {
        throw new NotFoundError(`No questionnaire at ${path}.`);
      }
      return validateQuestionnaire(
        parseJson(await readFile(full, "utf8"), path),
      );
    },

    async listQuestionnaires(project) {
      const layout = { ...DEFAULT_LAYOUT, ...(project.layout || {}) };
      const dir = inside(project.root, layout.questions).full;
      if (!(await exists(dir))) return [];
      const entries = await readdir(dir, { withFileTypes: true });
      return entries
        .filter((e) => e.isFile() && e.name.endsWith(".json"))
        .map((e) => `${layout.questions}/${e.name}`)
        .sort();
    },

    async readAnswers(project, { questionnaireId, respondent }) {
      const path = answerPath(project, questionnaireId, respondent);
      const { full } = inside(project.root, path);
      if (!(await exists(full))) return null;

      const text = await readFile(full, "utf8");
      return {
        path,
        // A content hash stands in for GitHub's blob SHA so the same
        // optimistic-locking logic works in both backends.
        sha: contentHash(text),
        document: normalizeAnswerFile(parseJson(text, path)),
      };
    },

    async writeAnswers(project, input) {
      const path = answerPath(
        project,
        input.questionnaireId,
        input.respondent,
      );
      const { full } = inside(project.root, path);
      const current = (await exists(full))
        ? await readFile(full, "utf8")
        : null;

      if ((input.expectedSha || null) !== (current ? contentHash(current) : null)) {
        throw new ConflictError(
          "The answer file changed on disk. Reload before saving.",
          current ? contentHash(current) : null,
        );
      }

      const document = {
        schemaVersion: 1,
        questionnaire: {
          id: input.questionnaireId,
          version: input.questionnaireVersion,
          sourcePath: input.sourcePath,
        },
        respondent: { label: input.respondent },
        updatedAt: new Date().toISOString(),
        answers: input.answers,
        // Omitted entirely when there are no notes, so answer files without
        // notes keep the same shape as before.
        ...(Object.keys(input.comments || {}).length > 0
          ? { comments: input.comments }
          : {}),
      };

      const text = JSON.stringify(document, null, 2) + "\n";
      await mkdir(dirname(full), { recursive: true });
      await writeFile(full, text, "utf8");

      let committed = null;
      if (commitOnWrite) {
        committed = await commitFile(project.root, path, input.message);
      }

      return { ok: true, path, sha: contentHash(text), committed };
    },
  };
}

function contentHash(text) {
  return createHash("sha256").update(text).digest("hex").slice(0, 40);
}

/**
 * Where a respondent's answers live. The respondent label is sanitized to a
 * safe filename so a display name can never steer the write out of the folder.
 */
function answerPath(project, questionnaireId, respondent) {
  const layout = { ...DEFAULT_LAYOUT, ...(project.layout || {}) };
  const safeId = String(questionnaireId).toLowerCase().replace(/[^a-z0-9-]/g, "-");
  const safeLabel = String(respondent || "local")
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .slice(0, 64) || "local";
  return `${layout.answers}/${safeId}/${safeLabel}.json`;
}

export { DEFAULT_LAYOUT, answerPath, contentHash, inside };
