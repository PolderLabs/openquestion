// Storage contract.
//
// A storage backend answers one question: "given a project, what questionnaires
// exist, and what has this respondent answered?" Everything above this line
// (HTTP routing, validation, the web UI) is backend-agnostic.
//
// Backends:
//   - local  : plain files on disk, optional git commit. No network, no auth.
//   - github : repository contents API, OAuth or a token from the environment.
//
// Every method may reject. Errors carry `.status` and `.code` so the HTTP layer
// can map them without knowing which backend produced them.

/**
 * @typedef {Object} StorageBackend
 * @property {string} id            stable backend id, e.g. "local" | "github"
 * @property {string} label         human-readable name for the UI
 * @property {boolean} writable     false means answers can be read but not saved
 * @property {boolean} requiresAuth true means the user must sign in first
 * @property {string} [identity]    who the current user is, if known
 * @property {() => Promise<unknown>} [init]  called once at startup
 * @property {() => Promise<void>} [close]  called once at shutdown
 *
 * @property {(project: object) => Promise<Manifest>} getManifest
 * @property {(project: object, path: string) => Promise<Document>} readQuestionnaire
 * @property {(project: object, options: AnswerQuery) => Promise<AnswerFile|null>} readAnswers
 * @property {(project: object, input: AnswerInput) => Promise<WriteResult>} writeAnswers
 * @property {(project: object) => Promise<Array<object>>} listProjects
 */

export const NOT_FOUND = "not_found";

/**
 * Raised when a questionnaire, answer file, or manifest cannot be found.
 * The HTTP layer turns this into a 404.
 */
export class NotFoundError extends Error {
  constructor(message = "Not found.") {
    super(message);
    this.name = "NotFoundError";
    this.status = 404;
    this.code = NOT_FOUND;
  }
}

/**
 * Raised when a write is rejected because the stored copy changed underneath us.
 * `remoteSha` is the current stored version so the caller can pull, compare, and
 * retry without losing local work.
 */
export class ConflictError extends Error {
  constructor(message, remoteSha = null) {
    super(message);
    this.name = "ConflictError";
    this.status = 409;
    this.code = "answer_conflict";
    this.remoteSha = remoteSha;
  }
}

/** Raised for input the caller can fix: bad ids, malformed documents, and so on. */
export class ValidationError extends Error {
  constructor(message, code = "invalid_request", status = 400) {
    super(message);
    this.name = "ValidationError";
    this.status = status;
    this.code = code;
  }
}

/** Raised when authentication is required but absent, or the token is no good. */
export class AuthError extends Error {
  constructor(message, code = "not_authenticated") {
    super(message);
    this.name = "AuthError";
    this.status = 401;
    this.code = code;
  }
}

/**
 * Normalizes whatever a backend read off disk or out of GitHub into the shape
 * the rest of the app expects. Tolerates missing optional fields so answer files
 * written by older versions still load.
 */
export function normalizeManifest(raw) {
  if (!raw || raw.schemaVersion !== 1 || !Array.isArray(raw.questionnaires)) {
    throw new ValidationError("Unsupported questionnaire manifest.");
  }
  return {
    schemaVersion: 1,
    questionnaires: raw.questionnaires.map((item) => ({
      id: String(item.id),
      version: String(item.version),
      title: String(item.title),
      description: item.description ? String(item.description) : "",
      path: String(item.path),
      status: item.status ? String(item.status) : "",
    })),
  };
}

export function normalizeAnswerFile(raw) {
  return {
    questionnaireId: raw?.questionnaire?.id ?? null,
    questionnaireVersion: raw?.questionnaire?.version ?? null,
    respondent: raw?.respondent?.githubLogin ?? raw?.respondent?.label ?? null,
    updatedAt: raw?.updatedAt ?? null,
    answers:
      raw?.answers && typeof raw.answers === "object" && !Array.isArray(raw.answers)
        ? raw.answers
        : {},
    comments:
      raw?.comments &&
      typeof raw.comments === "object" &&
      !Array.isArray(raw.comments)
        ? raw.comments
        : {},
  };
}
