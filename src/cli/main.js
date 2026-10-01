#!/usr/bin/env node
// openquestion CLI.
//
// Everything is scriptable so a local agent can drive the tool without opening a
// browser. Project management, discovery, and the config file are all reachable
// from the command line, and every command emits JSON with `--json`.

import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";

import { createApp } from "../core/server.js";
import { createLocalStorage } from "../storage/local.js";
import { createGitHubStorage } from "../storage/github.js";
import { isGitRepo } from "../storage/git.js";
import {
  listProjects,
  addProject,
  removeProject,
  discoverProjects,
  listDirectories,
  configPath,
  loadConfig,
  saveConfig,
} from "../projects/registry.js";
import { answerPath, contentHash } from "../storage/local.js";

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));

// Read the version from the package rather than hardcoding it, so `oq update`
// and `oq --version` cannot drift from what was published.
const VERSION = (() => {
  try {
    return JSON.parse(
      readFileSync(resolve(__dirname, "..", "..", "package.json"), "utf8"),
    ).version;
  } catch {
    return "0.0.0";
  }
})();

function out(data) {
  process.stdout.write(JSON.stringify(data, null, 2) + "\n");
}

function fail(message) {
  process.stderr.write(`openquestion: ${message}\n`);
  process.exitCode = 1;
}

function flag(args, name, fallback = null) {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  const next = args[index + 1];
  if (next === undefined || next.startsWith("--")) return true;
  return next;
}

const help = `
oq ${VERSION} - schema-driven questionnaires

Usage
  oq serve [--port 4321] [--host 127.0.0.1] [--project <path>] [--git]
  oq projects list
  oq projects add <path> [--name <name>] [--git] [--scan <parent>]
  oq projects add <path> --github <owner/name> [--branch main]
  oq projects remove <id>
  oq projects discover <parent>
  oq browse [<path>]
  oq config
  oq update [--check]

Every command accepts --json for machine-readable output.

Storage
  A project is a directory containing questionnaire/manifest.json (or
  questionnaire/questions/). Answers are written to answers/<id>/<label>.json.
  With --git, saving also commits the file locally. Nothing is ever pushed.

Config
  ${configPath()}
`;

/**
 * Self-update. Only works for an install created by install.sh, which is a git
 * checkout: the command pulls the latest ref and re-verifies that the tree is
 * still parseable. A source checkout someone is working in is left alone unless
 * they pass --force, because resetting it would discard their work.
 */
async function cmdUpdate(args) {
  const root = installRoot();
  const gitDir = join(root, ".git");

  if (!existsSync(gitDir)) {
    return fail(
      `No git checkout found at ${root}.
      oq update only works for an install made by install.sh.
      Re-run the installer to get the latest version.`,
    );
  }

  // Refuse to self-update a working checkout. A developer running from a clone
  // would otherwise have their working tree reset by their own tool, and
  // "update" is not something you want triggering in the middle of editing.
  if (!isInstallDir(root) && !args.includes("--allow-source")) {
    return fail(
      `${root} is a source checkout, not an install.
      oq update only manages installs made by install.sh, so it will not
      reset a working copy.

      To update this checkout instead:
        git -C ${root} pull

      Re-run with --allow-source to override.`,
    );
  }

  const branch = (await run("git", ["rev-parse", "--abbrev-ref", "HEAD"], root))
    .trim();

  const status = await run("git", ["status", "--porcelain"], root);
  if (status.trim()) {
    if (!args.includes("--force")) {
      return fail(
        `${root} has local changes.
      Commit or stash them first, or re-run with --force to discard.`,
      );
    }
    console.log("Discarding local changes (--force).");
  }

  const before = (await run("git", ["rev-parse", "HEAD"], root)).trim();
  const currentVersion = readVersion(root);

  if (args.includes("--check")) {
    const { stdout } = await run(
      "git",
      ["fetch", "origin", branch],
      root,
      true,
    );
    const behind = (
      await run("git", ["rev-list", "--count", `HEAD..origin/${branch}`], root, true)
    ).trim();
    console.log(`current: ${currentVersion} (${before.slice(0, 7)})`);
    if (behind === "0") {
      console.log("up to date");
    } else {
      console.log(`${behind} commit(s) behind origin/${branch}`);
    }
    return;
  }

  console.log(`Updating ${root} from origin/${branch}...`);
  await run("git", ["fetch", "origin", branch], root);
  await run("git", ["reset", "--hard", `origin/${branch}`], root);

  const after = (await run("git", ["rev-parse", "HEAD"], root)).trim();
  const nextVersion = readVersion(root);

  // A broken update would leave the user with no working tool, so check before
  // declaring success.
  let healthy = true;
  try {
    await run("node", ["--check", join(root, "src", "cli", "main.js")], root);
  } catch {
    healthy = false;
  }

  if (!healthy) {
    return fail(
      `Updated to ${after.slice(0, 7)} but the CLI failed to parse.
      Roll back with:
        git -C ${root} reset --hard ${before}`,
    );
  }

  if (before === after) {
    console.log(`Already up to date (${currentVersion}).`);
    return;
  }
  console.log(`Updated ${currentVersion} -> ${nextVersion} (${after.slice(0, 7)}).`);
  const log = await run(
    "git",
    ["log", "--oneline", `${before}..${after}`],
    root,
    true,
  );
  if (log.trim()) {
    console.log("\nChanges:");
    for (const line of log.trim().split("\n").slice(0, 15)) {
      console.log("  " + line);
    }
  }
}

/** The install root: two levels up from this file (src/cli -> root). */
function installRoot() {
  return resolve(__dirname, "..", "..");
}

// install.sh writes this marker. Its absence means the user is running from a
// clone they may be editing, which oq update must not touch.
function isInstallDir(root) {
  return existsSync(join(root, ".openquestion-install"));
}

function readVersion(root) {
  try {
    return JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
  } catch {
    return "unknown";
  }
}

async function run(bin, argv, cwd, allowFailure = false) {
  try {
    const { stdout } = await execFileAsync(bin, argv, {
      cwd,
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
    });
    return stdout;
  } catch (error) {
    if (allowFailure) return "";
    fail(
      `\`${bin} ${argv.join(" ")}\` failed in ${cwd}: ${
        String(error.stderr || error.message).trim()
      }`,
    );
    return "";
  }
}

async function cmdServe(args) {
  const port = Number(flag(args, "--port", process.env.OPENQUESTION_PORT || 4321));
  const host = String(flag(args, "--host", process.env.OPENQUESTION_HOST || "127.0.0.1"));
  const projectPath = flag(args, "--project", null);

  // `--project <path>` is the agent-friendly shorthand: point the tool at a
  // directory and get straight to answering, with no config to write first.
  if (projectPath && typeof projectPath === "string") {
    const root = projectPath.replace(/^~(?=$|\/)/, process.env.HOME);
    if (!existsSync(root)) fail(`No such directory: ${root}`);
    await addProject({ root, commitOnWrite: args.includes("--git") });
  }

  const app = createApp({
    storageFactory: {
      local: (project) => createLocalStorage({ commitOnWrite: project.commitOnWrite }),
      github: (project, session) =>
        createGitHubStorage({
          session,
          repository: project.github?.repository,
          branch: project.github?.branch,
          manifestPath: project.github?.manifestPath,
          token: process.env.GITHUB_TOKEN,
          clientId: process.env.GITHUB_CLIENT_ID,
          clientSecret: process.env.GITHUB_CLIENT_SECRET,
        }),
    },
    github: githubOAuthConfig(),
  });

  const server = createServer(app);
  server.listen(port, host, () => {
    const projects = [];
    listProjects()
      .then((list) => {
        projects.push(...list);
      })
      .finally(() => {
        console.log(`oq ${VERSION}`);
        console.log(`  http://${host}:${port}`);
        if (projects.length === 0) {
          console.log("  no projects yet - add one:");
          console.log(`    oq projects add ~/code/my-project`);
        } else {
          console.log(`  projects: ${projects.map((p) => p.name).join(", ")}`);
        }
        const mode = [];
        if (process.env.GITHUB_TOKEN) mode.push("github: GITHUB_TOKEN");
        if (githubOAuthConfig()) mode.push("github: OAuth app");
        if (mode.length) console.log(`  ${mode.join(" | ")}`);
        else console.log("  github: not configured (local mode only)");
      });
  });
}

/**
 * GitHub OAuth is optional. A project on GitHub storage works with a token alone,
 * so the tool stays usable for agents and CI with no app registered.
 */
function githubOAuthConfig() {
  const clientId = process.env.GITHUB_CLIENT_ID;
  const clientSecret = process.env.GITHUB_CLIENT_SECRET;
  const base = process.env.OPENQUESTION_PUBLIC_URL || `http://localhost:${process.env.OPENQUESTION_PORT || 4321}`;
  if (!clientId || !clientSecret) return null;
  return {
    clientId,
    clientSecret,
    authorizeUrl: `https://github.com/login/oauth/authorize?client_id=${encodeURIComponent(clientId)}&scope=repo`,
    callbackUrl: `${base.replace(/\/+$/, "")}/api/github/callback`,
  };
}

async function cmdProjects(args) {
  const sub = args[0];

  if (sub === "list" || !sub) {
    const projects = await listProjects();
    if (args.includes("--json")) return out({ projects });
    if (projects.length === 0) {
      console.log("No projects configured.");
      console.log("Add one: oq projects add <path>");
      return;
    }
    for (const p of projects) {
      const git = isGitRepo(p.root) ? "git" : "   ";
      const commit = p.commitOnWrite ? "commit" : "      ";
      console.log(
        `${p.id.padEnd(24)} ${p.storage.padEnd(7)} ${git} ${commit}  ${p.root}`,
      );
    }
    return;
  }

  if (sub === "add") {
    const path = args[1];
    if (!path) return fail("Usage: oq projects add <path>");
    const root = path.replace(/^~(?=$|\/)/, process.env.HOME);
    if (!existsSync(root)) return fail(`No such directory: ${root}`);

    const project = await addProject({
      root,
      name: typeof flag(args, "--name") === "string" ? flag(args, "--name") : undefined,
      commitOnWrite: args.includes("--git"),
      // --github owner/name switches the project to repository-backed storage.
      // A local root is still recorded so the same folder can be used offline.
      storage: flag(args, "--github") ? "github" : undefined,
      github: flag(args, "--github")
        ? {
            repository: flag(args, "--github"),
            branch: typeof flag(args, "--branch") === "string" ? flag(args, "--branch") : "main",
            manifestPath:
              typeof flag(args, "--manifest") === "string"
                ? flag(args, "--manifest")
                : undefined,
          }
        : undefined,
    });

    // --scan registers a parent for automatic sibling discovery.
    const scan = flag(args, "--scan");
    if (typeof scan === "string") {
      const config = await loadConfig();
      config.settings = config.settings || {};
      const parents = new Set(config.settings.scanParents || []);
      parents.add(scan.replace(/^~(?=$|\/)/, process.env.HOME));
      config.settings.scanParents = [...parents];
      await saveConfig(config);
    }

    if (args.includes("--json")) return out({ project });
    console.log(`Added ${project.id} -> ${project.root}`);
    if (project.commitOnWrite) {
      console.log(isGitRepo(project.root)
        ? "Saving will also commit to git locally."
        : "Note: not a git repository, so --git has no effect here.");
    }
    return;
  }

  if (sub === "remove") {
    const id = args[1];
    if (!id) return fail("Usage: oq projects remove <id>");
    await removeProject(id);
    if (args.includes("--json")) return out({ ok: true, removed: id });
    console.log(`Removed ${id}`);
    return;
  }

  if (sub === "discover") {
    const parent = args[1] || process.cwd();
    const found = await discoverProjects(parent.replace(/^~(?=$|\/)/, process.env.HOME));
    if (args.includes("--json")) return out({ projects: found });
    if (found.length === 0) return console.log(`No projects found under ${parent}`);
    for (const p of found) console.log(`${p.id.padEnd(24)} ${p.root}`);
    return;
  }

  return fail(`Unknown projects subcommand: ${sub}`);
}

async function cmdBrowse(args) {
  const target = args[0] || process.env.HOME;
  const listing = await listDirectories(target.replace(/^~(?=$|\/)/, process.env.HOME));
  if (args.includes("--json")) return out(listing);
  console.log(listing.path);
  for (const d of listing.directories) {
    console.log(`  ${d.isProject ? "*" : " "} ${d.name}`);
  }
  return;
}

async function cmdConfig(args) {
  const config = await loadConfig();
  if (args.includes("--json")) return out({ path: configPath(), ...config });
  console.log(configPath());
  console.log(JSON.stringify(config, null, 2));
}

async function main() {
  const argv = process.argv.slice(2);

  // Bare `oq` starts the server. The dashboard lists every configured project,
  // so the command needs no project argument and does not care which directory
  // it was run from.
  if (argv.length === 0) {
    return cmdServe([]);
  }

  const [command, ...args] = argv;

  switch (command) {
    case "serve":
      return cmdServe(args);
    case "projects":
      return cmdProjects(args);
    case "browse":
      return cmdBrowse(args);
    case "config":
      return cmdConfig(args);
    case "update":
      return cmdUpdate(args);
    case "--version":
    case "-v":
      return console.log(VERSION);
    case "--help":
    case "-h":
    case undefined:
      return console.log(help);
    default:
      return fail(`Unknown command: ${command}\n\n${help}`);
  }
}

main().catch((error) => {
  fail(error.message);
  if (process.env.OPENQUESTION_DEBUG) console.error(error);
});
