// Optional local git integration.
//
// In local mode the app can commit answer files on the user's behalf, so they
// keep history without ever pushing or pulling. Everything here shells out to
// the local git binary and treats the repository as untrusted input: paths are
// passed with -- and never interpolated into a command string.

import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";

const run = promisify(execFile);

async function git(cwd, args, { allowFailure = false } = {}) {
  try {
    const { stdout } = await run("git", args, {
      cwd,
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
    });
    return { ok: true, out: stdout.trim() };
  } catch (error) {
    if (allowFailure) {
      return {
        ok: false,
        out: String(error.stdout || "").trim(),
        message: String(error.stderr || error.message).trim(),
      };
    }
    throw error;
  }
}

// One-time capability check at startup, not a hot path, so a synchronous call
// keeps the caller a simple boolean.
export function isGitRepo(root) {
  if (!existsSync(root)) return false;
  try {
    execFileSync("git", ["rev-parse", "--git-dir"], { cwd: root, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Commits one path. Returns a small result object rather than throwing when git
 * is unavailable or the project is not a repository: local file writes must
 * still succeed when there is no git around.
 */
export async function commitFile(root, relativePath, message) {
  const status = await git(root, ["status", "--porcelain", "--", relativePath], {
    allowFailure: true,
  });
  if (!status.ok) {
    return { ok: false, reason: "git_failed", detail: status.message };
  }
  if (!status.out) {
    // Nothing changed, so there is nothing to commit.
    return { ok: true, reason: "unchanged" };
  }

  const added = await git(root, ["add", "--", relativePath], {
    allowFailure: true,
  });
  if (!added.ok) {
    return { ok: false, reason: "git_add_failed", detail: added.message };
  }

  const commit = await git(
    root,
    ["commit", "-m", message || "docs: update questionnaire answers", "--", relativePath],
    { allowFailure: true },
  );
  if (!commit.ok) {
    return { ok: false, reason: "git_commit_failed", detail: commit.message };
  }

  const head = await git(root, ["rev-parse", "HEAD"], { allowFailure: true });
  return {
    ok: true,
    reason: "committed",
    sha: head.ok ? head.out : null,
  };
}

export { git };
