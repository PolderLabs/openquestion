# Changelog

All notable changes to openquestion. Releases are git tags (`vX.Y.Z`), and
`oq update` compares against them. `oq release status` shows where you are.

The version follows semantic versioning:

- **patch** — wording, documentation, bug fixes
- **minor** — new features, additive changes
- **major** — breaking changes, such as a config or answer-file format change

## v0.3.0

Not yet released.

### Added

- The project picker searches from a folder you can travel through. It starts in
  your home directory, lists subfolders so you can step into them, and has an up
  control to come back.
- Pasting a full path navigates straight to that folder.
- `oq release <patch|minor|major>` bumps the version, commits, tags, and pushes,
  so a release is one command. `oq release status` reports the current version,
  the latest tag, and whether a release is actually cut.
- `CHANGELOG.md`.

### Fixed

- The suggestion index was cached globally, so travelling into a subfolder kept
  showing the home folder's results.

## v0.2.3

### Changed

- Documentation: how search works from home, and the release workflow.

## v0.2.2

### Fixed

- `oq update --check` measured distance against the branch tip, which is always
  zero on a tag checkout. It wrongly reported a newer release as already
  present. It now measures to the release commit, and a detached checkout is
  moved back onto its branch before resetting.

## v0.2.1

### Fixed

- `oq release status` reported "released" when the repository had no tag at all.

## v0.2.0

### Added

- Project picker suggests projects as you type, seeded from your home folder.
  No full path required.
- Custom listboxes replace every native `<select>`: the questionnaire picker and
  the per-question `select` and `boolean` dropdowns. Dropdown values route
  through the shared collector, so a boolean answer is still stored as a real
  boolean.
- Bare `oq` starts the server. `oq --port N` works without typing `serve`.
- Default port **4731**, chosen to avoid the usual dev-server ports.
- The landing page is a project dashboard, so the project is chosen in the UI.
  The server no longer falls back to `projects[0]`.
- Single-instance handling: if oq is already running, print its URL and open it
  instead of starting a duplicate. `--new` forces a second instance.
- A bounded, cached project search that skips build and VCS directories.

### Fixed

- The sidebar could collapse but never reopen, from three separate defects: the
  two toggles did not clear each other, the icon swallowed clicks on its own
  button, and the collapsed rail did not clip its children.
- `renderDashboard` and `showEmpty` called each other, so an empty project list
  overflowed the stack and took the page with it.
- `POST /api/projects` passed the API's `path` to a registry that reads `root`,
  so adding a project always returned 500.
- Horizontal overflow on narrow viewports, from grid tracks defaulting to
  `min-width: auto`.

### Changed

- The repository is public, so installing needs no account or token.

## v0.1.0

First working release.

- Storage abstraction with interchangeable local and GitHub backends.
- Local filesystem backend with optional local `git commit`. No network, no
  account, usable by a local agent.
- GitHub backend over the contents API, with OAuth or a token from the
  environment. The token never reaches the browser.
- Project registry: config file, sibling auto-discovery, and a directory picker.
- CLI: `oq`, `oq projects`, `oq browse`, `oq config`, `oq update`.
- Redesigned UI: persistent left rail, single readable column, per-question
  comments.
