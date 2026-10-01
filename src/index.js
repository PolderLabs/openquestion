// Public entry point for embedding openquestion in another Node server:
//
//   import { createQuestionnaireServer } from "openquestion";
//   createQuestionnaireServer({ port: 3000 }).listen(3000);

export { createApp } from "./core/server.js";
export { createLocalStorage } from "./storage/local.js";
export { commitFile, isGitRepo } from "./storage/git.js";
export {
  listProjects,
  addProject,
  removeProject,
  getProject,
  discoverProjects,
  listDirectories,
  loadConfig,
  saveConfig,
  configPath,
} from "./projects/registry.js";
export {
  ValidationError,
  NotFoundError,
  ConflictError,
  AuthError,
} from "./core/storage.js";
export {
  validateQuestionnaire,
  validateComments,
  validateAnswers,
  validateQuestionnaireId,
  validateVersion,
  SUPPORTED_TYPES,
  COMMENT_MAX_LENGTH,
} from "./core/validate.js";

import { createServer } from "node:http";
import { createApp } from "./core/server.js";
import { createLocalStorage } from "./storage/local.js";

/**
 * Convenience wrapper: builds a ready-to-listen HTTP server with local storage
 * wired up. Returns the node server, so callers can add their own handlers.
 */
export function createQuestionnaireServer({
  port = 4321,
  host = "127.0.0.1",
  githubStorage,
} = {}) {
  const app = createApp({
    storageFactory: {
      local: (project) =>
        createLocalStorage({ commitOnWrite: project.commitOnWrite }),
      github: githubStorage,
    },
  });
  const server = createServer(app);
  server.listen(port, host);
  return server;
}
