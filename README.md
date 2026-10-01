# openquestion

Schema-driven questionnaires and decision intake. Point it at a project, answer
in the browser, and the answers land as a reviewable file in that project's repo.

Two storage modes, one interface:

- **Local** — plain JSON files in a directory, with an optional local `git commit`.
  No network, no account, no tokens. Usable by a local agent that has no business
  pushing and pulling.
- **GitHub** — the same files, read and written through the repository contents
  API, committed to a branch.

No dependencies. Node 20+.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/PolderLabs/openquestion/main/install.sh | sh
```

That installs to `~/.local/share/openquestion` and puts an `oq` launcher in
`~/.local/bin`. No account and no GitHub credentials are needed. If you happen to
be signed in with `gh`, the installer uses it; otherwise it falls back to a plain
`git clone`.

Add the launcher to your PATH if it is not already:

```bash
export PATH="$HOME/.local/bin:$PATH"
```

Overrides:

```bash
curl -fsSL .../install.sh | PREFIX=/opt sh      # install elsewhere
curl -fsSL .../install.sh | REPO=owner/name sh  # fork or mirror
curl -fsSL .../install.sh | VERSION=v0.1.0 sh   # pin a release
```

Or clone it yourself, with no install at all:

```bash
git clone https://github.com/PolderLabs/openquestion.git
cd openquestion
node src/cli/main.js serve
```

### Updating

```bash
oq update           # pull the latest release
oq update --check   # compare installed against latest, change nothing
```

```
$ oq update --check
installed  v0.2.1  (34147c2)
latest     v0.2.2

Update available: v0.2.2 (2 commit(s) away)
installed v0.2.1, latest v0.2.2.
Run: oq update
```

`oq update` only manages directories it installed — it looks for the
`.openquestion-install` marker that `install.sh` writes. Run from a clone you are
working in, it refuses rather than resetting your tree; use `git pull` there. It
also refuses to run over uncommitted changes unless you pass `--force`, checks
that the new tree still parses, and prints a rollback command if it does not.

### Releases

See [CHANGELOG.md](CHANGELOG.md) for what changed in each version.

Releases are git tags (`v0.2.2`), and `package.json` carries the same number.
The tag is what `oq update` compares against.

```bash
oq release status               # version, latest tag, and whether a release is cut
oq release patch --push         # 0.2.2 -> 0.2.3
oq release minor --push         # 0.2.2 -> 0.3.0
oq release major --push         # 0.2.2 -> 1.0.0
```

`oq release` bumps the version, commits, tags, and pushes, so a release is one
command and the tag cannot drift from the manifest. It refuses to tag a version
that is already tagged, and refuses on a dirty working tree so a tag always
points at an intentional state.

Use **patch** for wording and fixes, **minor** for new features, **major** for
a breaking change such as a config format or answer-file shape change.

## Start

```bash
oq
```

That is the whole command. It serves on port **4731** — an unusual port, chosen
so it does not collide with the usual dev servers — and opens
<http://127.0.0.1:4731>. It does not matter which directory you run it from: the
dashboard lists every configured project, and you pick one there.

If oq is **already running**, running `oq` again prints the existing URL and opens
it in your browser instead of starting a duplicate. If the port belongs to some
other program, oq walks forward to the next free one and says so. To run a second
copy deliberately:

```bash
oq --new
```

Useful flags:

```bash
oq --port 4780     # a specific port (reuses it if oq is already there)
oq --host 0.0.0.0  # bind wider than loopback
oq --open          # force opening the browser even when not a terminal
oq serve --project ~/code/my-project --git
```

`--project` registers a directory and serves it immediately, which is the shortest
path for a one-off run or an agent.

## Projects

A project is a directory containing questionnaires. oq finds them three
ways:

```bash
oq projects add ~/code/my-project   # explicit
oq projects add ~/code --scan ~/code # plus auto-discover siblings
oq projects discover ~/code         # see what looks like a project
oq projects list
oq projects remove my-project
oq browse ~/code                    # list folders, mark the projects
```

A folder counts as a project if it contains any of:

```
questionnaire/manifest.json
questionnaire/manifests/index.json
questionnaire/questions/
questionnaire/questionnaires/index.json
```

In the app, the **+** next to Projects opens a search box. The folder you are
looking at is listed straight away, before you type anything.

The list mixes folders and projects, and typing filters both, because a list
that does not change as you type reads as broken. Every row shows the folder it
sits in, which is what tells two same-named results apart and where a nested
match actually lives. Matching is fuzzy, so `gf` finds `globalfrontio`, and the
matched characters are highlighted so a hit is explainable rather than magic.
Names are matched first and paths below the root second, so a common prefix
like `/home/you/code` does not make everything match. A query of three
characters or fewer has to appear as a real substring: as a subsequence, two
letters match nearly everything and the list stops narrowing.

| Key | Does |
| --- | --- |
| `↑` `↓` | Move through the list |
| `Enter` | Select the highlighted project, or open the highlighted folder |
| `Tab` | Open a folder, or complete a project's name |

The picker starts in your **home directory**, or wherever Settings points it.
The **‹** control goes back up, and pasting a full path jumps straight to that
folder.

**Add project** adds the project you selected, or the folder you are currently
in when you have not selected one. A folder does not have to contain a
questionnaire to be added: it can be registered now and hold its questions
later.

Each folder's index is three levels deep, built once and cached: about 40ms the
first time, instant after. `node_modules`, `dist`, `.git`, `venv` and similar are
skipped, and the walk keeps descending past a monorepo so nested projects are
still found.

Typing is answered from a local cache first, so a query you have typed before
costs nothing; a new one costs one short request that the next keystroke
cancels. Measured end to end, that is under 50ms for a new query and 0ms for a
repeat.

**Browse** is the escape hatch for a folder the search does not surface.

No native form controls are used anywhere: the questionnaire picker and the
per-question dropdowns are custom listboxes, so they match the theme and work
with the keyboard.

### Settings

The gear at the foot of the sidebar opens Settings, which has three sections:

| Section | What it holds |
| --- | --- |
| Projects | Where the picker starts looking. Empty means your home folder. |
| Answering | The "Answering as" label, which names the answer file. |
| About | Version, config file path, and how to check for a newer release. |

Everything in Settings is written to `projects.json`, so it survives a restart.
The projects folder is a starting point you set once, never a rule: adding a
project does not move it, and nothing is ever added from it without an explicit
pick in the dialog. `POST /api/settings` accepts `null` for a key to clear it,
which is what the **Home** button sends.

Config lives at `~/.config/openquestion/projects.json` (override with
`OPENQUESTION_CONFIG_DIR`):

```json
{
  "version": 1,
  "projects": [
    { "root": "/home/you/code/my-project", "commitOnWrite": true }
  ],
  "settings": { "scanParents": ["/home/you/code"] }
}
```

## Local mode

Answers are written to `answers/<questionnaire-id>/<respondent>.json` inside the
project. There is no account: the "Answering as" field is just a label that names
the file, so you can answer as yourself, or as an agent, or per-client.

With `commitOnWrite`, saving also runs a local `git add` + `git commit` for that one
file. Nothing is ever pushed.

This is the mode to use from a local agent:

```bash
oq serve --project /path/to/repo
# or drive the HTTP API directly
curl -s localhost:4731/api/manifest
curl -s -X PUT localhost:4731/api/answers -H 'content-type: application/json' -d '{
  "questionnaireId": "game-design-v1",
  "questionnaireVersion": "1.0.0",
  "sourcePath": "questionnaire/questionnaires/game-design-v1.json",
  "answers": { "region_identity": "province" },
  "comments": { "region_identity": "Simplest model that still allows rebellion." }
}'
```

## GitHub mode

Register a repo-backed project:

```bash
oq projects add ~/code/my-project --github PolderLabs/globalfrontio \
  --branch main --manifest questionnaire/questionnaires/index.json
```

Authenticate either way:

- **OAuth** — set `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` for an OAuth App or
  GitHub App whose callback is `<base>/api/github/callback`. Sign in from the UI.
- **Token** — set `GITHUB_TOKEN` in the environment. Intended for agents and CI,
  where there is no browser to click through.

```bash
GITHUB_TOKEN=$(gh auth token) oq serve
```

The token never reaches the browser. The server keeps it and the client only
receives an HttpOnly session cookie.

## HTTP API

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/projects` | List projects |
| `POST` | `/api/projects` | Add a project |
| `DELETE` | `/api/projects/:id` | Remove a project |
| `GET` | `/api/directories?path=` | Browse folders for the picker |
| `GET` | `/api/suggest?root=&q=&limit=` | Picker entries: folders and projects, one list, filtered by `q` |
| `GET` | `/api/search?root=` | Find projects two levels below a folder |
| `GET`/`POST` | `/api/settings` | Stored settings; `null` clears a key |
| `GET` | `/api/manifest` | Manifest plus the resolved respondent |
| `GET` | `/api/questionnaire?path=` | One questionnaire document |
| `GET` | `/api/answers?questionnaireId=` | Saved answers, or `exists: false` |
| `PUT` | `/api/answers` | Save answers |
| `POST` | `/api/identity` | Set the answering label |
| `POST` | `/api/github/login` | Begin OAuth |
| `POST` | `/api/github/token` | Hand the server a token |

Pass `?project=<id>` to target a project, and `?as=<label>` to override the
respondent for a single request.

### Saving

`PUT /api/answers` takes `questionnaireId`, `questionnaireVersion`, `sourcePath`,
`answers`, optional `comments`, and `expectedSha`.

The server rejects the write unless the manifest still lists that exact
`id` + `version` + `path`, and unless `expectedSha` matches what is currently
stored. That is what stops a stale tab from overwriting someone else's answers:
the browser holds the SHA it read, and a mismatch returns `409 answer_conflict`
with the current SHA so the client can pull, diff, and retry.

## Writing a questionnaire

A manifest listing them, and one file per questionnaire:

```
questionnaire/manifest.json
questionnaire/questions/economy-model-v1.json
```

```json
{
  "schemaVersion": 1,
  "id": "economy-model-v1",
  "version": "1.0.0",
  "title": "Economy Model",
  "description": "Resource, production, and trade decisions.",
  "sections": [
    {
      "id": "resources",
      "title": "Resources",
      "questions": [
        {
          "id": "resource_count",
          "type": "number",
          "label": "How many resource types should a player track?",
          "required": true,
          "min": 1,
          "max": 12,
          "step": 1
        }
      ]
    }
  ]
}
```

Question types: `text`, `textarea`, `number`, `single`, `multi`, `select`,
`boolean`, `info`. `single`, `multi`, and `select` require an `options` array of
`{ "value", "label" }`; the answer stores the **value**, so you can reword a label
without invalidating committed answers.

Question ids are the keys answers are stored under. They must be unique in a
document, and never reuse one for a different meaning.

Full reference, including the answer file format and versioning rules:
**[docs/QUESTIONNAIRES.md](docs/QUESTIONNAIRES.md)**.

## Per-question comments

Every question gets an optional free-text note, committed alongside that answer.
This exists so a multiple-choice answer is never the only thing you can express:
pick an option, and still explain the nuance.

```json
{
  "answers": { "join_mode": "approval" },
  "comments": { "join_mode": "Approval queue should be capped so a faction cannot stall onboarding." }
}
```

A note never satisfies a required question. The `comments` key is omitted entirely
when no notes exist, so answer files without notes keep their previous shape, and
older files without the key load unchanged. Notes are capped at 2000 characters
each and are validated server-side.

## Embedding

The server is a plain module:

```js
import { createQuestionnaireServer } from "openquestion";

createQuestionnaireServer({ port: 3000 }).listen(3000);
```

Or mount the request handler in an existing server:

```js
import { createApp, createLocalStorage } from "openquestion";

const app = createApp({
  storageFactory: {
    local: (project) => createLocalStorage({ commitOnWrite: true }),
  },
});
myServer.on("request", app);
```

Exports: `createApp`, `createQuestionnaireServer`, `createLocalStorage`,
`createGitHubStorage`, the project registry helpers, the validation functions, and
the `ValidationError` / `NotFoundError` / `ConflictError` / `AuthError` classes.

## Layout

```
src/
  core/       server, storage contract, validation
  storage/    local filesystem, git, GitHub
  projects/   registry, discovery, config
  cli/        command line
  web/        the browser app (plain HTML/CSS/JS, no build step)
```

The `core` layer never imports a storage backend directly; backends are injected.
Adding one means implementing five methods and passing a factory to `createApp`.

## Development

```bash
npm run check   # syntax check every module
npm start       # serve
```

## Security notes

- Answer paths are derived from the project root and the authenticated identity.
  A caller cannot supply an answer path.
- Paths containing `..`, a backslash, a drive letter, or control characters are
  rejected, and every resolved path is confirmed to sit inside the project root.
- Writes are gated on the current manifest, so a hand-edited answer file cannot
  introduce a questionnaire that was never published.
- GitHub tokens stay server-side. The browser only gets an HttpOnly, SameSite=Lax
  session cookie.
- Sessions live in memory; restarting the server signs users out.
