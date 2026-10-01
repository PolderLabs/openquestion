# Authoring questionnaires

How to write a questionnaire openquestion can serve: the manifest, the document format, every validation rule, versioning, and where answers are stored.

## The short version

1. Create `questionnaire/questions/<id>.json`.
2. Add an entry for it to `questionnaire/manifest.json`.
3. Commit and push to the configured branch.
4. Reload openquestion, or restart the server.

The app reads both files at request time, so publishing is just a file change. There is no build step.

## The two files

**Manifest** — `questionnaire/manifest.json`

Lists which questionnaires exist. Its path is configurable via `GITHUB_MANIFEST_PATH`, but it defaults to the above.

```json
{
  "schemaVersion": 1,
  "questionnaires": [
    {
      "id": "game-design-v1",
      "version": "1.0.0",
      "title": "GlobalFrontIO Game Design",
      "description": "Core product, warfare, faction, economy, intelligence, diplomacy, map generation, and coordination decisions.",
      "path": "questionnaire/questions/economy-model-v1.json",
      "status": "active"
    }
  ]
}
```

Only `id`, `version`, `title`, and `path` are required. `description` and `status` are optional; `status: "active"` marks the questionnaire the UI opens by default and appends " · Active" to its selector label.

**Definition** — `questionnaire/questions/<anything>.json`

The questions themselves.

```json
{
  "schemaVersion": 1,
  "id": "economy-model-v1",
  "version": "1.0.0",
  "title": "GlobalFrontIO Economy Model",
  "description": "Resource, production, and trade decisions.",
  "sections": [
    {
      "id": "resources",
      "title": "Resources",
      "description": "Optional, shown under the section heading.",
      "questions": [
        {
          "id": "resource_count",
          "type": "number",
          "label": "How many resource types should a player track directly?",
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

## Format rules

These are enforced at runtime, not by a linter. An invalid file is rejected with a dialog naming the problem.

### Questionnaire

| Field | Required | Rules |
| --- | --- | --- |
| `schemaVersion` | yes | Must be exactly `1`. |
| `id` | yes | Lowercase alphanumeric and dashes, 2–80 characters, must start alphanumeric: `^[a-z0-9][a-z0-9-]{1,79}$`. Used in the answer file path, so it is permanent once published. |
| `version` | yes | Semantic version: `MAJOR.MINOR.PATCH` with an optional `-prerelease` or `+build`. |
| `title` | yes | String. |
| `description` | no | String. |
| `sections` | yes | Array. May be empty. |

### Section

| Field | Required | Rules |
| --- | --- | --- |
| `id` | yes | String. Also becomes the `#section-<id>` anchor target. |
| `title` | yes | String. |
| `description` | no | String, rendered under the heading. |
| `questions` | yes | Array. |

### Question

| Field | Required | Rules |
| --- | --- | --- |
| `id` | yes | String, **unique across the whole questionnaire** — duplicates are a hard error. This is the durable key in the answer file. Never reuse an ID for a different meaning. |
| `type` | yes | One of the eight types below. |
| `label` | yes for non-`info` | The question text. |
| `required` | no | `true` to block pushing until answered. |
| `options` | for choice types | Array of `{ "value", "label" }`. Required for `single`, `multi`, and `select`. |
| `help` | no | Hint text under the label. |
| `placeholder` | `text`, `textarea` | Placeholder in the input. |
| `maxLength` | `text`, `textarea` | Character cap. |
| `min`, `max`, `step` | `number` | Numeric bounds. |
| `text` | `info` | Body copy for an `info` block. |

`label` is not required on `info` because that type renders prose, not a prompt.

## Question types

| Type | Renders | Answer value | Needs `options` |
| --- | --- | --- | --- |
| `text` | Single-line input | string | no |
| `textarea` | Multi-line input | string | no |
| `number` | Numeric input with bounds | number | no |
| `single` | Radio list, one choice | string (`value`) | yes |
| `multi` | Checkbox list, many | string[] | yes |
| `select` | Dropdown | string (`value`) | yes |
| `boolean` | Yes/No dropdown | boolean | no |
| `info` | Read-only prose block | none | no |

The stored answer is the option's `value`, never its `label`. Choose stable, machine-readable values like `"separate_country"` — you can reword a `label` later without invalidating anyone's committed answers.

`boolean` stores a real JSON boolean, and `number` stores a real JSON number, so consumers should not assume every answer is a string.

### Examples

```json
{ "id": "faction_name", "type": "text", "label": "What is the faction called?", "required": true, "maxLength": 60 }
```

```json
{
  "id": "tactical_pause",
  "type": "boolean",
  "label": "Should a player be able to pause while off-line?",
  "required": true
}
```

```json
{
  "id": "join_mode",
  "type": "select",
  "label": "How does a player join an existing war?",
  "required": true,
  "options": [
    { "value": "open", "label": "Anyone may join" },
    { "value": "approval", "label": "A faction member approves each player" }
  ]
}
```

```json
{
  "id": "starting_territory",
  "type": "multi",
  "label": "How can a player obtain territory when joining a war?",
  "required": true,
  "options": [
    { "value": "pick_unclaimed", "label": "Pick an unclaimed starting region" },
    { "value": "faction_assignment", "label": "Receive a faction-assigned region" }
  ]
}
```

```json
{
  "id": "first_session",
  "type": "textarea",
  "label": "Describe your ideal first 10 minutes after joining a fresh war.",
  "required": true,
  "maxLength": 3000,
  "help": "What do you click, decide, build, communicate, and react to?"
}
```

```json
{
  "id": "scope_note",
  "type": "info",
  "text": "The next section covers the map generator. Nothing here is a required answer."
}
```

## Publishing checklist

- `schemaVersion` is `1`.
- `id` matches the `^[a-z0-9][a-z0-9-]{1,79}$` pattern.
- `version` is a valid semver string.
- Every question `id` is unique within the file.
- Every `single`, `multi`, and `select` question has an `options` array.
- The manifest entry's `id` and `version` **exactly** match the definition file — the server refuses the save if they drift.
- The manifest `path` is exactly `questionnaire/questions/<file>.json` and ends in `.json`.

A quick local check before pushing:

```bash
node -e '
const q = require("./questionnaire/questions/<id>.json");
const qs = q.sections.flatMap(s => s.questions);
const ids = qs.map(x => x.id);
console.log("schemaVersion:", q.schemaVersion);
console.log("id/version:", q.id, q.version);
console.log("questions:", qs.length, "| unique ids:", new Set(ids).size);
console.log("missing options:", qs.filter(x =>
  ["single","multi","select"].includes(x.type) && !Array.isArray(x.options)
).map(x => x.id));
'
```

The mismatch between `questions` and `unique ids` is the duplicate-ID check; the last line is the missing-options check. Both should come back clean.

## Versioning

`version` is part of the identity the server checks, along with `id` and `path`. Bump it when you change a questionnaire's content:

- **Patch** — wording, descriptions, help text. No semantic change.
- **Minor** — new questions added.
- **Major** — a question was removed, retyped, or its meaning changed.

Committed answers record the version they were written against. The `questionnaire` object inside an answer file looks like this:

```jsonc
"questionnaire": {
  "id": "economy-model-v1",
  "version": "1.0.0",
  "sourcePath": "questionnaire/questions/economy-model-v1.json",
  "repository": "PolderLabs/globalfrontio",
  "branch": "main"
}
```

The localStorage draft key also includes the version, so bumping it starts a fresh draft instead of mixing answers across revisions. Answers already committed to GitHub are not touched.

**Removing a question does not delete committed answers.** Old answer files keep the removed keys. That is intentional: they are an audit trail. If a question is retired, bump the major version and note the retirement in the section description.

## Where answers go

Answers are saved by the app, not written by hand. The server computes the path, so the browser cannot target another respondent's file:

| Storage | Path |
| --- | --- |
| Local | `<project>/answers/<questionnaire-id>/<label>.json` |
| GitHub | `questionnaire/answers/<questionnaire-id>/<label>.json` |

`<label>` is the answering name, lowercased, with any character outside
`[a-z0-9-]` replaced by `-`, and truncated to 64 characters. In local mode that is
whatever you typed in "Answering as"; in GitHub mode it is the signed-in login.
For `octocat`:

```
answers/economy-model-v1/octocat.json
```

Because the label is a filename, two respondents using different names get two
files, and a local agent can answer as its own identity without colliding with you.

The committed document:

```json
{
  "schemaVersion": 1,
  "questionnaire": {
    "id": "economy-model-v1",
    "version": "1.0.0",
    "sourcePath": "questionnaire/questions/economy-model-v1.json",
    "repository": "PolderLabs/globalfrontio",
    "branch": "main"
  },
  "respondent": {
    "githubLogin": "octocat"
  },
  "updatedAt": "2026-10-01T12:00:00.000Z",
  "answers": {
    "resource_count": 5,
    "join_mode": "approval",
    "starting_territory": ["pick_unclaimed", "faction_assignment"],
    "tactical_pause": true
  }
}
```

Note that the answer types round-trip as their real JSON types: `resource_count` is a number, `tactical_pause` is a boolean, and `starting_territory` is an array of option values.

## Per-question comments

Every question gets an optional **Add a note** field. A note is free text committed alongside that question's answer, so a multiple-choice answer is never the only thing a respondent can express — they can pick an option and still explain the nuance, or leave a note with no selection at all.

Notes live in a `comments` object keyed by question id, kept separate from `answers`:

```json
{
  "schemaVersion": 1,
  "questionnaire": {
    "id": "economy-model-v1",
    "version": "1.0.0",
    "sourcePath": "questionnaire/questions/economy-model-v1.json",
    "repository": "PolderLabs/globalfrontio",
    "branch": "main"
  },
  "respondent": {
    "githubLogin": "octocat"
  },
  "updatedAt": "2026-10-01T12:00:00.000Z",
  "answers": {
    "join_mode": "approval",
    "starting_territory": ["pick_unclaimed", "faction_assignment"]
  },
  "comments": {
    "join_mode": "Approval rather than open join, but the approval queue should be capped so a faction cannot stall onboarding.",
    "starting_territory": "Assigned spawn is the primary path. Picking an unclaimed region is the fallback for late joiners."
  }
}
```

Rules:

- The `comments` key is omitted entirely when no notes exist, so answer files without notes keep their previous shape.
- A note never counts as an answer. A required question is satisfied only by an answer, so leaving a note on an unanswered question does not unblock a push.
- Note values must be strings. The server trims them, drops blank ones, rejects control characters, and caps a single note at 2000 characters.
- Answer files written before notes existed have no `comments` key and load unchanged.
- Changing only a note is still real uncommitted work: the saved hash no longer matches, so the next save is reported as a **Conflict** rather than silently overwriting.

Unsaved answers are also mirrored into the browser's localStorage under a key scoped by project, questionnaire, and version, so a reload does not lose work. The server file is the source of truth once saved.

## Saving answers

Fill the questionnaire and press **Save answers**. Before the server writes anything
it verifies:

- the questionnaire still exists in the current manifest;
- the ID, version, and source path still match the manifest entry;
- `expectedSha` matches the version currently stored.

The SHA check is what prevents a silent lost update. It is a content hash in local
mode and a GitHub blob SHA in GitHub mode, so the same check protects both. If the
stored file changed in the meantime, the save is rejected with
`409 answer_conflict` carrying the current SHA, and the UI shows **Conflict**
instead of overwriting. Pull, compare, and reapply.

In local mode with `commitOnWrite` enabled, a successful save also runs a local
`git add` and `git commit` for that one file. Nothing is pushed.

## Editing answers by hand

The answer file is ordinary JSON, so editing it directly works in either mode. Two
caveats:

- Keep `respondent` and the `questionnaire.version` you actually answered. The app
  uses the version to decide whether a saved answer matches the questionnaire
  currently open.
- If you change a committed file, the stored hash changes. The next save from that
  respondent's browser will conflict until they pull, which is the intended
  behaviour.


## Security boundaries

Every path the server touches is resolved inside the project root and rejected if it
escapes: `..`, a backslash, a drive letter, or control characters are all refused,
and the resolved path is confirmed to stay within the root. There is no API that
accepts a caller-supplied answer path, and every write is gated on the current
manifest, so a hand-edited answer file cannot introduce a questionnaire that was
never published.

