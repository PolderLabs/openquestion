#!/usr/bin/env node
// openquestion CLI.
//
// Everything is scriptable so a local agent can drive the tool without opening a
// browser: `openquestion projects add`, `openquestion answer --set k=v`, and so
// on all return JSON when `--json` is passed.

import { createServer } from "node:http";

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
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";

const VERSION = "0.1.0";

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
openquestion ${VERSION} - schema-driven questionnaires

Usage
  openquestion serve [--port 4321] [--host 127.0.0.1] [--open]
  openquestion projects list
  openquestion projects add <path> [--name <name>] [--git] [--scan <parent>]
  openquestion projects add <path> --github <owner/name> [--branch main]
  openquestion projects remove <id>
  openquestion projects discover <parent>
  openquestion browse [<path>]
  openquestion config [--path]

Every command accepts --json for machine-readable output.

Storage
  A project is a directory containing questionnaire/manifest.json (or
  questionnaire/questions/). Answers are written to answers/<id>/<label>.json.
  With --git, saving also commits the file locally. Nothing is ever pushed.

Config
  ${configPath()}
`;

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
        console.log(`openquestion ${VERSION}`);
        console.log(`  http://${host}:${port}`);
        if (projects.length === 0) {
          console.log("  no projects yet - add one:");
          console.log(`    openquestion projects add ~/code/my-project`);
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
      console.log("Add one: openquestion projects add <path>");
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
    if (!path) return fail("Usage: openquestion projects add <path>");
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
    if (!id) return fail("Usage: openquestion projects remove <id>");
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
