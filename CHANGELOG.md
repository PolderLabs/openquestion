# Changelog

All notable changes to openquestion. Releases are git tags (`vX.Y.Z`), and
`oq update` compares against them. `oq release status` shows where you are.

The version follows semantic versioning:

- **patch** — wording, documentation, bug fixes
- **minor** — new features, additive changes
- **major** — breaking changes, such as a config or answer-file format change

## v0.4.0

### Added

- A Settings dialog, opened from the sidebar, with three sections: **Projects**
  (where the picker starts looking), **Answering** (the label that names the
  answer file) and **About** (version, config path, update hint). Everything is
  written to `projects.json`, so it survives a restart.
- The picker lists folders and projects as one list, and typing filters both.
  A directory that is a project is listed once, as the project.
- Every result shows the folder it sits in, which is what tells two same-named
  results apart and where a nested match actually lives.
- `Add project` adds the folder you are in when nothing is selected, so
  choosing a directory and adding it is a single action. A folder does not have
  to contain a questionnaire to be added, and one without any shows an empty
  project instead of a red error.
- `Tab` completes the highlighted entry: it opens a folder, or fills in a
  project's name and leaves that row selected for `Enter`.
- `Up`/`Down` move through the list. The keyboard and the mouse drive the same
  list and the same selection.

### Changed

- Search answers from a local cache first and cancels the request a new
  keystroke replaces. A new query paints in under 50ms, a repeated one in 0ms.
- The picker starts in the home directory again. The projects folder is now
  only changed from Settings, never by adding a project.
- A query of three characters or fewer has to match as a real substring. As a
  subsequence, two letters matched nearly everything and the list stopped
  narrowing as you typed.
- `/api/settings` carries the answering label and reports the config path and
  version, and accepts `null` for a key to clear it.

### Fixed

- Selecting a project and pressing "Add project" did nothing. The picker wrote
  the chosen path to its element map but read it back from its state, so the add
  ran with no path and returned silently.
- "Add project" and "Cancel" defaulted to `submit` inside the dialog form, which
  closed the dialog and discarded instead of running their handlers.
- Searching matched the absolute path, so a common prefix such as
  `/home/you/code` made almost everything match any query. Matching now uses the
  path below the root.
- The highlighted row was restored by looking the new list up in itself, so it
  jumped to whatever re-ranked into that position.
- Adding a project remembered the project itself as the folder to reopen in, so
  the next search started inside the project that had just been added.
- `/api/directories` did not expand a leading `~`, so a path pasted into the
  picker or typed into Settings failed unless it was absolute.
- Clearing a setting was ignored, so the "Home" button kept the old folder.

## v0.3.0

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
