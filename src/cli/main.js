#!/usr/bin/env node
// openquestion CLI.
//
// Everything is scriptable so a local agent can drive the tool without opening a
// browser. Project management, discovery, and the config file are all reachable
// from the command line, and every command emits JSON with `--json`.

import { createServer } from "node:http";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { connect } from "node:net";
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
  oq [serve] [--port 4731] [--host 127.0.0.1] [--project <path>] [--git]
  oq serve --new            force a second instance
  oq serve --open           always open the browser
  oq projects list
  oq projects add <path> [--name <name>] [--git] [--scan <parent>]
  oq projects add <path> --github <owner/name> [--branch main]
  oq projects remove <id>
  oq projects discover <parent>
  oq browse [<path>]
  oq config
  oq update [--check]
  oq release <patch|minor|major> [--push]
  oq release status

Bare oq starts the server on port 4731. If oq is already running it
opens that one in your browser instead of starting a second copy. If the
port belongs to something else, the next free port is used.

Every command accepts --json for machine-readable output.

Storage
  A project is a directory containing questionnaire/manifest.json (or
  questionnaire/questions/). Answers are written to answers/<id>/<label>.json.
  With --git, saving also commits the file locally. Nothing is ever pushed.

Config
  ${configPath()}
`;

/**
 * Releases are git tags (`v0.2.0`), and package.json carries the same number.
 * The tag is the authority: it is what `oq update` compares against, so a
 * release is unambiguous even if the two ever disagree.
 */

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)/;

function parseVersion(text) {
  const match = SEMVER.exec(String(text || ""));
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

function formatVersion(version) {
  return `v${version.major}.${version.minor}.${version.patch}`;
}

function compareVersions(a, b) {
  return (
    a.major - b.major || a.minor - b.minor || a.patch - b.patch
  );
}

/**
 * The version of the checkout: its own package.json, annotated with the nearest
 * tag and the distance to it. A commit past a release reports the commits since,
 * which is exactly the case where a bare number is ambiguous.
 */
async function describeCheckout(root) {
  const pkg = readVersion(root);
  const parsed = parseVersion(pkg);
  const sha = (await run("git", ["rev-parse", "HEAD"], root, true)).trim();

  const described = (
    await run("git", ["describe", "--tags", "--always", "--dirty"], root, true)
  ).trim();

  return { version: parsed, raw: pkg, sha, describe: described };
}

function renderVersion(info) {
  if (!info.version) return info.raw || "unknown";
  const base = formatVersion(info.version);
  // git describe appends -N-g<sha> when HEAD is ahead of the last tag.
  return info.describe && info.describe !== base
    ? `${base} (${info.describe})`
    : base;
}

/** The newest version tag available on the remote. */
async function latestRelease(root, branch) {
  await run("git", ["fetch", "--tags", "--force", "origin"], root, true);
  const tags = (
    await run("git", ["tag", "--list", "v*", "--sort=-v:refname"], root, true)
  )
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  for (const tag of tags) {
    const parsed = parseVersion(tag);
    if (parsed) return { tag, parsed };
  }
  return null;
}

/** Whether the current branch already contains the given tag. */
async function hasTag(root, tag) {
  const result = await run(
    "git",
    ["tag", "--points-at", "HEAD", "--list", tag],
    root,
    true,
  );
  return result.trim().includes(tag);
}
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
  const beforeInfo = await describeCheckout(root);

  // Fetch tags as well as the branch: without them, "latest version" is
  // unknowable, because a release is a tag rather than a commit.
  await run("git", ["fetch", "origin", branch, "--tags", "--force"], root, true);
  const release = await latestRelease(root, branch);
  const behind = (
    await run("git", ["rev-list", "--count", `HEAD..origin/${branch}`], root, true)
  ).trim() || "0";

  if (args.includes("--check")) {
    console.log(`installed  ${renderVersion(beforeInfo)}  (${before.slice(0, 7)})`);
    if (!release) {
      console.log("latest     no release tag found on origin");
      if (behind !== "0") {
        console.log(`\n${behind} commit(s) on origin/${branch} are not released yet.`);
        console.log("Run: oq update");
      }
      return;
    }

    const current = beforeInfo.version;
    const newer = !current || compareVersions(release.parsed, current) > 0;
    console.log(`latest     ${release.tag}`);

    if (!newer) {
      console.log("\nYou are on the latest release.");
      return;
    }

    // Count distance from the installed commit to the release commit, not to
    // the branch tip. On a detached HEAD (a tag checkout) there is no local
    // branch to be behind, and comparing against the tip would wrongly report
    // "already contains it".
    const releaseSha = (
      await run("git", ["rev-list", "-n", "1", release.tag], root, true)
    ).trim();
    const toRelease = (
      await run("git", ["rev-list", "--count", `${before}..${release.tag}`], root, true)
    ).trim() || "0";

    console.log(
      `\nUpdate available: ${release.tag}` +
        (toRelease !== "0" ? ` (${toRelease} commit(s) away)` : ""),
    );
    console.log(`installed ${formatVersion(current)}, latest ${release.tag}.`);
    if (releaseSha && before !== releaseSha) console.log("Run: oq update");
    return;
  }

  if (before === (await run("git", ["rev-parse", "origin/" + branch], root, true)).trim()) {
    console.log(`Already up to date (${renderVersion(beforeInfo)}).`);
    return;
  }

  // A checkout sitting on a tag has a detached HEAD, and resetting one would
  // leave it stranded. Move it back onto the tracked branch first.
  let target = branch;
  if (branch === "HEAD") {
    const remoteHead = (
      await run("git", ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], root, true)
    ).trim();
    target = remoteHead
      ? remoteHead.replace(/^origin\//, "")
      : (
          await run("git", ["remote", "show", "origin"], root, true)
        )
        .split("\n")
        .find((line) => line.includes("HEAD branch:"))
        ?.split(":")[1]
        ?.trim();

    if (!target) {
      return fail(
        "This checkout has a detached HEAD and no default branch could be\n" +
          "determined. Re-run the installer instead:\n" +
          "  curl -fsSL https://raw.githubusercontent.com/PolderLabs/openquestion/main/install.sh | sh",
      );
    }

    console.log(`Detached HEAD; moving onto ${target}.`);
    const checkout = await run("git", ["checkout", target], root, true);
    if (!checkout.ok) {
      return fail(
        `Could not move the detached checkout onto ${target}.\n` +
          "Re-run the installer instead.",
      );
    }
  } else {
    console.log(`Updating ${root} from origin/${target}...`);
  }
  await run("git", ["reset", "--hard", `origin/${target}`], root);

  const after = (await run("git", ["rev-parse", "HEAD"], root)).trim();
  const afterInfo = await describeCheckout(root);

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

  const released =
    release && (await hasTag(root, release.tag));
  const from = beforeInfo.version;
  const to = afterInfo.version;
  const changed =
    !from || !to ? before !== after : compareVersions(to, from) !== 0;

  if (changed) {
    const arrow = from && to && compareVersions(to, from) > 0
      ? formatVersion(from) + " -> " + formatVersion(to)
      : `${renderVersion(beforeInfo)} -> ${renderVersion(afterInfo)}`;
    console.log(`\nUpdated ${arrow}`);
  } else if (before !== after) {
    // Same version, newer commit: say so plainly instead of implying a release.
    console.log(`\nUpdated to ${renderVersion(afterInfo)}`);
    console.log("(same version, newer commits - no new release tag yet)");
  } else {
    console.log(`\nAlready up to date (${renderVersion(afterInfo)}).`);
  }

  if (released) console.log(`on release ${release.tag}`);

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

// 4731 is unusual enough not to collide with the usual dev-server ports
// (3000, 4200, 4321, 5173, 8000, 8080) that another tool is likely to hold.
const DEFAULT_PORT = 4731;
// Walk forward from the preferred port rather than failing, so a second tool on
// the machine does not block the app entirely.
const PORT_PROBE_RANGE = 20;

/**
 * Asks a port whether something answers, and whether that something is us.
 * The identity header is what distinguishes "oq is already running" from "some
 * other program grabbed the port".
 */
async function probePort(port, host) {
  return new Promise((resolve) => {
    const socket = connect(
      { port, host, timeout: 400 },
      () => {
        socket.destroy();
        resolve("open");
      },
    );
    socket.on("timeout", () => {
      socket.destroy();
      resolve("closed");
    });
    socket.on("error", () => {
      socket.destroy();
      resolve("closed");
    });
  });
}

async function identifyOq(port, host) {
  try {
    const response = await fetch(`http://${host}:${port}/api/health`, {
      signal: AbortSignal.timeout(500),
    });
    if (!response.ok) return false;
    const body = await response.json();
    return body?.ok === true && body?.service === "openquestion";
  } catch {
    return false;
  }
}

/** Scans forward from `preferred` for a free port, or returns null. */
async function findFreePort(preferred, host, range) {
  for (let port = preferred; port < preferred + range; port += 1) {
    if ((await probePort(port, host)) === "closed") return port;
  }
  return null;
}

/** Returns the port of a running oq instance, or null. */
async function findRunningInstance(preferred, host) {
  for (let port = preferred; port < preferred + PORT_PROBE_RANGE; port += 1) {
    if ((await probePort(port, host)) === "open" && (await identifyOq(port, host))) {
      return { port };
    }
  }
  return null;
}

/**
 * Opens a URL in the user's browser. Best effort: this runs on a headless
 * machine or over ssh just as often as on a desktop, and a failure to launch
 * must never stop the server from running.
 */
function openBrowser(url) {
  const opener =
    process.platform === "darwin" ? "open"
    : process.platform === "win32" ? "start"
    : "xdg-open";
  try {
    const child = spawn(opener, [url], {
      stdio: "ignore",
      detached: true,
    });
    child.on("error", () => {});
    child.unref();
  } catch {
    /* no browser available; the URL is printed either way */
  }
}

async function cmdServe(args) {
  const preferred = Number(flag(args, "--port", process.env.OPENQUESTION_PORT || DEFAULT_PORT));
  const host = String(flag(args, "--host", process.env.OPENQUESTION_HOST || "127.0.0.1"));
  const projectPath = flag(args, "--project", null);

  // `--project <path>` is the agent-friendly shorthand: point the tool at a
  // directory and get straight to answering, with no config to write first.
  if (projectPath && typeof projectPath === "string") {
    const root = projectPath.replace(/^~(?=$|\/)/, process.env.HOME);
    if (!existsSync(root)) fail(`No such directory: ${root}`);
    await addProject({ root, commitOnWrite: args.includes("--git") });
  }

  // A second `oq` should not fight the first. If our own server already answers
  // on a port, open the browser at it and exit instead of starting a duplicate.
  // This applies whether or not --port was given: asking for the port that is
  // already serving is the clearest possible request to reuse it.
  if (!args.includes("--new")) {
    const explicit = args.includes("--port");
    const existing = await findRunningInstance(preferred, host);
    if (existing && (!explicit || existing.port === preferred)) {
      const url = `http://${host}:${existing.port}/`;
      console.log(`oq is already running on ${url}`);
      openBrowser(url);
      return;
    }
  }

  const port = await findFreePort(preferred, host, PORT_PROBE_RANGE);
  if (port === null) {
    return fail(
      `No free port in ${preferred}-${preferred + PORT_PROBE_RANGE} on ${host}.\n` +
        `Free one up, or pass --port <n>.`,
    );
  }
  if (port !== preferred) {
    const reason = (await probePort(preferred, host)) === "open"
      ? "already in use"
      : "in use by something else";
    console.log(`Port ${preferred} is ${reason}; using ${port}.`);
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

  // A failed bind is handled below, so a race with another process landing on
  // the port between the probe and the listen does not crash with a stack trace.
  server.on("error", (error) => {
    if (error.code === "EADDRINUSE") {
      return fail(
        `Port ${port} was taken between the check and the bind.\n` +
          `Re-run \`oq\` and it will pick another port.`,
      );
    }
    fail(`Could not start the server: ${error.message}`);
    process.exit(1);
  });

  server.listen(port, host, () => {
    const url = `http://${host}:${port}/`;
    listProjects()
      .then((list) => {
        console.log(`oq ${VERSION}`);
        console.log(`  ${url}`);
        if (list.length === 0) {
          console.log("  no projects yet - add one:");
          console.log(`    oq projects add ~/code/my-project`);
        } else {
          console.log(`  projects: ${list.map((p) => p.name).join(", ")}`);
        }
        const mode = [];
        if (process.env.GITHUB_TOKEN) mode.push("github: GITHUB_TOKEN");
        if (githubOAuthConfig()) mode.push("github: OAuth app");
        if (mode.length) console.log(`  ${mode.join(" | ")}`);
        else console.log("  github: not configured (local mode only)");

        if (args.includes("--open") || process.stdout.isTTY) {
          openBrowser(url);
        }
      })
      .catch((error) => {
        // The server is already up; a failure to list projects is not fatal.
        console.log(`oq ${VERSION}`);
        console.log(`  ${url}`);
        console.log(`  (could not read projects: ${error.message})`);
        if (args.includes("--open") || process.stdout.isTTY) openBrowser(url);
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

/**
 * Cut a release. Bumps package.json, commits, tags, and pushes, so a release is
 * a single command and the tag can never drift from the manifest.
 *
 * `oq release patch|minor|major`  - bump, tag, push
 * `oq release status`             - show the version, tag, and whether a release
 *                                    is actually cut for the current commit
 */
async function cmdRelease(args) {
  const root = installRoot();
  if (!existsSync(join(root, ".git"))) {
    return fail("oq release must run inside the repository.");
  }

  const action = args[0] || "status";
  const currentRaw = readVersion(root);
  const current = parseVersion(currentRaw);
  if (!current) return fail(`Cannot parse version from package.json: ${currentRaw}`);

  if (action === "status") {
    const info = await describeCheckout(root);
    const release = await latestRelease(root, "main");
    console.log(`version    ${currentRaw}`);
    console.log(`latest tag ${release ? release.tag : "(none)"}`);
    console.log(`describe   ${info.describe}`);
    if (!release) {
      // No tag at all: nothing is a release yet, whatever the version says.
      console.log("state      never released (no tag on origin)");
      return;
    }
    const tagAtHead = await hasTag(root, release.tag);
    console.log(
      tagAtHead ? "state      released" : "state      unreleased commits on top of the last tag",
    );
    if (info.version && compareVersions(info.version, release.parsed) !== 0) {
      console.log(
        `\nwarning    package.json (${currentRaw}) does not match tag ${release.tag}.`,
      );
    }
    return;
  }

  const bumps = { patch: [0, 0, 1], minor: [0, 1, 0], major: [1, 0, 0] };
  const bump = bumps[action];
  if (!bump) {
    return fail(`Usage: oq release <patch|minor|major|status>`);
  }

  const status = await run("git", ["status", "--porcelain"], root);
  if (status.trim()) {
    return fail(
      "The working tree is not clean. Commit or stash first, so a tag always\n" +
        "points at an intentional state.",
    );
  }

  const branch = (await run("git", ["rev-parse", "--abbrev-ref", "HEAD"], root)).trim();
  if (branch === "HEAD") return fail("Detached HEAD; check out a branch first.");

  // Never tag the same version twice: it would make the release ambiguous.
  const existing = await run("git", ["tag", "--list", "v" + currentRaw], root, true);
  if (existing.trim()) {
    return fail(
      `v${currentRaw} is already tagged.\n` +
        `Bump package.json first, or use oq release status to see where you are.`,
    );
  }

  const next = `${current.major + bump[0]}.${current.minor + bump[1]}.${current.patch + bump[2]}`;
  const tag = `v${next}`;

  await run("node", [
    "-e",
    `const fs=require("fs");const p="package.json";` +
      `const j=JSON.parse(fs.readFileSync(p,"utf8"));j.version="${next}";` +
      `fs.writeFileSync(p,JSON.stringify(j,null,2)+"\\n");`,
  ], root);

  console.log(`bumping ${currentRaw} -> ${next}`);
  await run("git", ["add", "package.json"], root);
  await run("git", ["commit", "-m", `release: ${tag}`], root);
  await run("git", ["tag", "-a", tag, "-m", tag], root);

  if (args.includes("--push")) {
    await run("git", ["push", "origin", branch, "--follow-tags"], root);
    console.log(`pushed ${tag}`);
  } else {
    console.log(`tagged ${tag} locally. Push it with:`);
    console.log(`  git -C ${root} push origin ${branch} --follow-tags`);
  }
}

async function main() {
  const argv = process.argv.slice(2);

  // Informational flags belong to oq itself, not to `serve`.
  if (argv.includes("--version") || argv.includes("-v")) {
    return console.log(VERSION);
  }
  if (argv.includes("--help") || argv.includes("-h")) {
    return console.log(help);
  }

  // Bare `oq` starts the server. The dashboard lists every configured project,
  // so the command needs no project argument and does not care which directory
  // it was run from. `oq --port 1234` is `oq serve --port 1234`.
  const KNOWN = new Set([
    "serve", "projects", "browse", "config", "update", "release", "help",
  ]);
  // A leading flag means serve. A bare word that is not a command is a typo,
  // and silently starting a server would hide it.
  if (argv.length === 0 || argv[0].startsWith("-")) {
    return cmdServe(argv);
  }
  if (!KNOWN.has(argv[0])) {
    return fail(`Unknown command: ${argv[0]}\n\n${help}`);
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
    case "release":
      return cmdRelease(args);
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
