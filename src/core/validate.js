// Validation shared by every storage backend and by the HTTP layer.
//
// These rules are the app's contract with questionnaire authors. Changing one
// here changes what a questionnaire may contain, so each check names the reason
// it exists.

import { ValidationError } from "./storage.js";

const QUESTIONNAIRE_ID = /^[a-z0-9][a-z0-9-]{1,79}$/;
const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?$/;
const QUESTION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;

const SUPPORTED_TYPES = new Set([
  "text",
  "textarea",
  "number",
  "single",
  "multi",
  "select",
  "boolean",
  "info",
]);

export const COMMENT_MAX_LENGTH = 2000;
export const MAX_COMMENT_KEYS = 500;

export function validateQuestionnaireId(value) {
  if (typeof value !== "string" || !QUESTIONNAIRE_ID.test(value)) {
    throw new ValidationError(
      "Invalid questionnaire ID.",
      "invalid_questionnaire_id",
    );
  }
  return value;
}

export function validateVersion(value) {
  if (typeof value !== "string" || !VERSION.test(value)) {
    throw new ValidationError(
      "Invalid questionnaire version.",
      "invalid_questionnaire_version",
    );
  }
  return value;
}

export function validateQuestionId(value) {
  if (typeof value !== "string" || !QUESTION_ID.test(value)) {
    throw new ValidationError("Invalid question id.", "invalid_question_id");
  }
  return value;
}

// Questionnaire paths are relative and must stay inside the project. Rejecting
// absolute paths, "..", backslashes, and control characters keeps a crafted path
// from escaping the project directory.
export function validateRelativePath(path) {
  if (typeof path !== "string") {
    throw new ValidationError("Invalid path.", "invalid_path");
  }
  const value = path.trim().replace(/^\/+/, "");
  if (
    !value ||
    value.length > 512 ||
    value.includes("..") ||
    value.includes("\\") ||
    /[\x00-\x1f]/.test(value) ||
    /^[A-Za-z]:/.test(value)
  ) {
    throw new ValidationError("Invalid path.", "invalid_path");
  }
  return value;
}

export function parseJson(text, label = "document") {
  try {
    return JSON.parse(text);
  } catch {
    throw new ValidationError(
      `Invalid JSON in ${label}.`,
      "invalid_json",
    );
  }
}

// A full questionnaire document, as authored. Called on read so a malformed
// file surfaces as a clear message instead of a broken form.
export function validateQuestionnaire(document) {
  if (
    !document ||
    document.schemaVersion !== 1 ||
    typeof document.id !== "string" ||
    typeof document.version !== "string" ||
    typeof document.title !== "string" ||
    !Array.isArray(document.sections)
  ) {
    throw new ValidationError(
      "Unsupported questionnaire document.",
      "unsupported_questionnaire",
    );
  }

  const seen = new Set();
  for (const section of document.sections) {
    if (
      !section ||
      typeof section.id !== "string" ||
      typeof section.title !== "string" ||
      !Array.isArray(section.questions)
    ) {
      throw new ValidationError(
        "Questionnaire contains an invalid section.",
        "invalid_section",
      );
    }
    for (const question of section.questions) {
      if (
        !question ||
        typeof question.id !== "string" ||
        !SUPPORTED_TYPES.has(question.type)
      ) {
        throw new ValidationError(
          "Questionnaire contains an invalid question.",
          "invalid_question",
        );
      }
      if (seen.has(question.id)) {
        // Ids are the key answers are stored under, so a duplicate would make a
        // respondent's saved answer ambiguous.
        throw new ValidationError(
          `Duplicate question id: ${question.id}`,
          "duplicate_question_id",
        );
      }
      seen.add(question.id);

      if (
        ["single", "multi", "select"].includes(question.type) &&
        !Array.isArray(question.options)
      ) {
        throw new ValidationError(
          `Question ${question.id} requires options.`,
          "missing_options",
        );
      }
    }
  }
  return document;
}

/**
 * Per-question notes. Blank notes are dropped so a cleared note never persists
 * as an empty string, and the result is what gets written to the answer file.
 */
export function validateComments(value) {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new ValidationError("Comments must be an object.", "invalid_comments");
  }

  const keys = Object.keys(value);
  if (keys.length > MAX_COMMENT_KEYS) {
    throw new ValidationError(
      "Too many comments in one submission.",
      "invalid_comments",
    );
  }

  const comments = {};
  for (const key of keys) {
    const comment = value[key];
    if (comment === undefined || comment === null) continue;
    if (typeof comment !== "string") {
      throw new ValidationError(
        "Each comment must be a string.",
        "invalid_comments",
      );
    }
    const trimmed = comment.trim();
    if (!trimmed) continue;
    if (trimmed.length > COMMENT_MAX_LENGTH) {
      throw new ValidationError(
        "A comment exceeds the maximum length.",
        "invalid_comments",
      );
    }
    // Control characters would make the committed file hard to read and diff.
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(trimmed)) {
      throw new ValidationError(
        "A comment contains unsupported control characters.",
        "invalid_comments",
      );
    }
    comments[validateQuestionId(key)] = trimmed;
  }
  return comments;
}

/** Answers must be a plain object of JSON values. */
export function validateAnswers(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ValidationError("Answers must be an object.", "invalid_answers");
  }
  return value;
}

export { SUPPORTED_TYPES };
