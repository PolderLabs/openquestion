// GitHub storage backend.
//
// Reads and writes questionnaire files through the GitHub REST API. Answers are
// committed to a branch as ordinary file commits, so the same optimistic-locking
// scheme as the local backend works here: the caller passes the blob SHA it read,
// and the write is rejected if the file changed underneath.
//
// Two ways to authenticate:
//   - OAuth device/web flow via GITHUB_CLIENT_ID + GITHUB_CLIENT_SECRET
//   - GITHUB_TOKEN from the environment, for agents and CI
//
// The token never reaches the browser. The server holds it and the client only
// ever receives a cookie.


import {
  AuthError,
  ConflictError,
  NotFoundError,
  normalizeManifest,
  normalizeAnswerFile,
} from "../core/storage.js";
import { validateQuestionnaire, parseJson } from "../core/validate.js";

const API = "https://api.github.com";
const OAUTH = "https://github.com/login/oauth";

export function createGitHubStorage({
  token,
  repository,
  branch = "main",
  manifestPath,
  clientId,
  clientSecret,
  session,
} = {}) {
  if (!repository) {
    throw new Error("A GitHub project needs `repository` (owner/name).");
  }
  const [owner, name] = String(repository).split("/");
  if (!owner || !name) {
    throw new Error(`Invalid repository: ${repository}`);
  }
  const manifest = manifestPath || `questionnaire/questionnaires/index.json`;

  async function call(path, options = {}) {
    const auth = options.token || token || session?.githubToken;
    if (!auth) {
      throw new AuthError(
        "Not signed in to GitHub for this project.",
        "github_not_authenticated",
      );
    }

    const response = await fetch(API + path, {
      ...options,
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        Authorization: `Bearer ${auth}`,
        ...(options.headers || {}),
      },
    });

    const text = await response.text();
    let payload = null;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = text;
      }
    }

    if (response.status === 401) {
      throw new AuthError("GitHub rejected the token. Sign in again.", "github_unauthorized");
    }
    if (response.status === 404) {
      throw new NotFoundError(payload?.message || "Not found on GitHub.");
    }
    if (!response.ok) {
      throw new Error(
        payload?.message || `GitHub returned HTTP ${response.status}.`,
      );
    }
    return payload;
  }

  async function readFile(path) {
    const result = await call(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}` +
        `/contents/${path}?ref=${encodeURIComponent(branch)}`,
    );
    if (result?.type !== "file" || typeof result.content !== "string") {
      throw new NotFoundError(`Expected a file at ${path}.`);
    }
    return {
      sha: result.sha,
      document: JSON.parse(Buffer.from(result.content.replace(/\s/g, ""), "base64").toString("utf8")),
    };
  }

  return {
    id: "github",
    label: "GitHub",
    writable: true,
    requiresAuth: true,
    identity: owner,

    async init() {
      if (token) session.githubToken = token;
    },

    async getManifest() {
      const { document } = await readFile(manifest);
      return normalizeManifest(document);
    },

    async readQuestionnaire(_project, path) {
      const { document } = await readFile(path);
      return validateQuestionnaire(document);
    },

    async readAnswers(_project, { questionnaireId, respondent }) {
      const path = answerPath(questionnaireId, respondent);
      try {
        const { sha, document } = await readFile(path);
        return { path, sha, document: normalizeAnswerFile(document) };
      } catch (error) {
        if (error instanceof NotFoundError) return null;
        throw error;
      }
    },

    async writeAnswers(_project, input) {
      const path = answerPath(input.questionnaireId, input.respondent);

      // A stale expectedSha means someone else committed. Re-read to report the
      // current version so the client can pull and compare.
      let currentSha = null;
      try {
        currentSha = (await readFile(path)).sha;
      } catch (error) {
        if (!(error instanceof NotFoundError)) throw error;
      }

      if ((input.expectedSha || null) !== currentSha) {
        throw new ConflictError(
          "The answer file changed on GitHub. Pull before saving.",
          currentSha,
        );
      }

      const document = {
        schemaVersion: 1,
        questionnaire: {
          id: input.questionnaireId,
          version: input.questionnaireVersion,
          sourcePath: input.sourcePath,
          repository,
          branch,
        },
        respondent: { githubLogin: input.respondent },
        updatedAt: new Date().toISOString(),
        answers: input.answers,
        ...(Object.keys(input.comments || {}).length > 0
          ? { comments: input.comments }
          : {}),
      };

      const payload = {
        message: input.message || `docs: update ${input.questionnaireId} answers`,
        content: Buffer.from(
          JSON.stringify(document, null, 2) + "\n",
          "utf8",
        ).toString("base64"),
        branch,
      };
      if (currentSha) payload.sha = currentSha;

      const response = await call(
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}` +
          `/contents/${path}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        },
      );

      return {
        ok: true,
        path,
        sha: response?.content?.sha || null,
        commitSha: response?.commit?.sha || null,
      };
    },
  };
}

function answerPath(questionnaireId, respondent) {
  const id = String(questionnaireId).toLowerCase().replace(/[^a-z0-9-]/g, "-");
  const label = String(respondent || "local")
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .slice(0, 64) || "local";
  return `questionnaire/answers/${id}/${label}.json`;
}

export { answerPath };
