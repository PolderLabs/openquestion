(() => {
  "use strict";

  // The app has one job: show one questionnaire and save the answers. Every
  // piece of chrome either changes what is on screen or reports where the
  // answers go.

  const el = (id) => document.getElementById(id);
  const ui = {};
  for (const id of [
    "rail", "railToggle", "railOpen", "projectList", "projectEmpty",
    "addProjectBtn", "modeLocal", "modeGithub", "identityInput",
    "statusDot", "statusText", "crumbProject", "crumbQuestionnaire",
    "questionnaireSelect", "cselectTrigger", "cselectValue", "cselectMenu",
    "saveBtn", "content", "dash", "dashList",
    "emptyState", "sheet",
    "qVersion", "qTitle", "qDescription", "progress", "progressPercent",
    "progressFill", "progressDetail", "toc", "questions",
    "savebar", "saveState", "saveTarget", "reloadBtn", "saveBarBtn",
    "projectDialog", "defaultDirBrowse", "defaultDirStatus", "projectSearch",
    "pickerBack", "pickerRoot",
    "searchResults", "browseBlock", "pickerPath", "pickerUp", "pickerList",
    "projectGit", "projectSave", "projectCancel", "toastDialog", "toastTitle", "toastBody",
    "settingsBtn", "settingsDialog", "settingsClose", "settingsSave",
    "settingsDir", "settingsDirReset", "settingsDirStatus", "settingsIdentity",
    "aboutVersion", "aboutConfig", "aboutProjects",
  ]) {
    ui[id] = el(id);
  }

  const state = {
    projects: [],
    projectId: null,
    mode: "local",
    identity: "",
    manifest: null,
    questionnaire: null,
    answers: {},
    comments: {},
    remoteSha: null,
    dirty: false,
    // Where the picker starts looking. Null means the home folder; it is only
    // ever changed from the settings dialog.
    defaultProjectDir: null,
    configPath: "",
    version: "",
    // All live picker state, in one place. The picker rebuilds this on open.
    picker: { root: null, home: null, entries: [], index: 0, loaded: false },
    pickedPath: null,
    selectedQuestionnaire: null,
    selectOptions: [],
  };

  const SUPPORTED_TYPES = new Set([
    "text", "textarea", "number", "single", "multi", "select", "boolean", "info",
  ]);
  const COMMENT_MAX_LENGTH = 2000;
  const DRAFT_PREFIX = "openquestion:draft";

  // ---------- helpers ----------

  const trace = (...parts) => console.log("[openquestion]", ...parts);

  function setStatus(text, kind = "") {
    ui.statusText.textContent = text;
    ui.statusDot.className = "status-dot" + (kind ? " " + kind : "");
  }

  async function api(path, options = {}) {
    const response = await fetch(path, {
      ...options,
      credentials: "same-origin",
      headers: {
        Accept: "application/json",
        ...(options.body ? { "Content-Type": "application/json" } : {}),
      },
      cache: "no-store",
    });
    const text = await response.text();
    let payload = null;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = { message: text };
      }
    }
    if (!response.ok) {
      const error = new Error(payload?.message || `HTTP ${response.status}`);
      error.status = response.status;
      error.code = payload?.error || "request_failed";
      throw error;
    }
    return payload;
  }

  function toast(title, message) {
    ui.toastTitle.textContent = title;
    ui.toastBody.textContent = String(message || "");
    if (!ui.toastDialog.open) ui.toastDialog.showModal();
  }

  function currentProject() {
    return state.projects.find((p) => p.id === state.projectId) || null;
  }

  function questionParams() {
    const params = new URLSearchParams();
    if (state.projectId) params.set("project", state.projectId);
    if (state.identity) params.set("as", state.identity);
    return params;
  }

  // ---------- projects ----------

  /**
   * The dashboard. Shown when no project is selected: every configured project
   * as a card, with enough detail to pick the right one without leaving the
   * page. Choosing a project here is the same action as clicking it in the rail.
   *
   * This renders the dashboard only. It must not call showEmpty(), because
   * showEmpty() calls back into here for the no-project case, and the two would
   * recurse until the stack blew. Deciding which view is visible is
   * renderMain()'s job.
   */
  function renderDashboard() {
    const list = ui.dashList;
    list.replaceChildren();

    for (const project of state.projects) {
      const card = document.createElement("button");
      card.className = "dash-card";
      card.type = "button";

      const head = document.createElement("div");
      head.className = "dash-card-head";

      const name = document.createElement("span");
      name.className = "dash-card-name";
      name.textContent = project.name;

      const badge = document.createElement("span");
      badge.className = "dash-card-badge";
      badge.textContent = project.storage === "github" ? "GitHub" : "Local";
      head.append(name, badge);

      const path = document.createElement("span");
      path.className = "dash-card-path";
      path.textContent = project.root;

      card.append(head, path);

      if (project.commitOnWrite) {
        const note = document.createElement("span");
        note.className = "dash-card-note";
        note.textContent = "Saves commit to git";
        card.append(note);
      }

      card.addEventListener("click", () => selectProject(project.id));
      list.append(card);
    }
  }

  /** Decide which of dash / empty / sheet is on screen. */
  function renderMain() {
    const hasProject = Boolean(state.projectId);
    const hasQuestionnaire = Boolean(state.questionnaire);
    ui.dash.hidden = hasProject || state.projects.length === 0;
    // The empty state is the fallback for "there is nothing to show here": no
    // projects at all, or a project with no questionnaire to open. Hiding it for
    // any open project left a blank pane, which reads as a broken app.
    ui.emptyState.hidden =
      hasQuestionnaire || (state.projects.length > 0 && !hasProject);
    ui.sheet.hidden = !hasQuestionnaire;
    ui.savebar.hidden = !hasQuestionnaire;

    // The questionnaire picker and Save only mean something once a project is
    // open. Leaving a disabled "No questionnaires" dropdown and a dead Save
    // button on the dashboard reads as broken, so they are hidden instead.
    ui.questionnaireSelect.hidden = !hasProject;
    ui.saveBtn.hidden = !hasProject;

    // On the dashboard there is no project, so the breadcrumb would otherwise
    // read "No project / Select a questionnaire".
    if (!hasProject) {
      ui.crumbProject.textContent = "Projects";
      ui.crumbQuestionnaire.textContent = "";
    }
  }

  async function loadProjects() {
    const { projects } = await api("/api/projects");
    state.projects = projects;
    // No auto-select: the dashboard shows every project, and picking one is the
    // user's call. This also means the server does not have to guess a default.
    renderProjects();
    renderDashboard();
    renderMain();
    return projects;
  }

  function renderProjects() {
    ui.projectList.replaceChildren();
    ui.projectEmpty.hidden = state.projects.length > 0;

    for (const project of state.projects) {
      const button = document.createElement("button");
      button.className = "project-item";
      button.type = "button";
      button.setAttribute("aria-current", String(project.id === state.projectId));

      const dot = document.createElement("span");
      dot.className = "project-dot";
      const name = document.createElement("span");
      name.className = "project-name";
      name.textContent = project.name;
      button.append(dot, name);

      button.addEventListener("click", () => selectProject(project.id));
      ui.projectList.append(button);
    }
  }

  async function selectProject(id) {
    if (state.dirty && !confirm("You have unsaved answers. Switch projects and lose them?")) {
      return;
    }
    state.projectId = id;
    state.questionnaire = null;
    state.manifest = null;
    renderProjects();
    renderDashboard();
    renderMain();
    await loadManifest();

    // Open the first questionnaire so choosing a project lands on something
    // useful instead of an empty pane. The user still chose the project; this
    // only picks between that project's own questionnaires.
    if (state.selectedQuestionnaire) {
      await openQuestionnaire(state.selectedQuestionnaire);
    }
  }

  // ---------- manifest + questionnaire ----------

  async function loadManifest() {
    if (!state.projectId) {
      ui.crumbProject.textContent = "No project";
      return;
    }
    const project = currentProject();
    ui.crumbProject.textContent = project ? project.name : "No project";
    ui.crumbQuestionnaire.textContent = "Select a questionnaire";

    setStatus("Loading…", "busy");
    try {
      const result = await api("/api/manifest?" + questionParams());
      state.manifest = result;
      renderManifest();
      setStatus("Ready", "ok");
    } catch (error) {
      state.manifest = null;
      renderManifest();
      // A project can be a folder that holds no questionnaire yet, so a missing
      // manifest is an empty project rather than a failure to report.
      if (error.status === 404) {
        setStatus("No questionnaires yet", "ok");
        showEmpty(
          (project ? project.name : "This project") + " has no questionnaires yet.\n" +
          "Add questionnaire/manifest.json to it and reopen the project.",
        );
        return;
      }
      setStatus("Could not load the manifest", "error");
      showEmpty(error.message);
    }
  }

  function renderManifest() {
    const items = state.manifest?.manifest?.questionnaires || [];
    const previous = state.selectedQuestionnaire;

    ui.cselectTrigger.disabled = items.length === 0;

    if (items.length === 0) {
      setSelectValue("");
      setSelectLabel("No questionnaires");
      ui.saveBtn.disabled = true;
      state.selectedQuestionnaire = null;
      return;
    }

    setSelectOptions(
      items.map((item) => ({
        value: item.id,
        label: item.title,
        note: item.status === "active" ? "active" : "",
      })),
    );

    const next = items.some((i) => i.id === previous) ? previous : items[0].id;
    state.selectedQuestionnaire = next;
    setSelectValue(next);
  }

  // ---------- custom select ----------
  //
  // A native <select> renders its dropdown with the OS widget, which cannot be
  // themed and ignores the dark palette entirely. This is a listbox that looks
  // like the rest of the app, and keeps keyboard and screen-reader behaviour.

  function setSelectLabel(text) {
    ui.cselectValue.textContent = text;
  }

  function setSelectOptions(options) {
    ui.selectOptions = options;
    setSelectMenu();
  }

  function setSelectValue(value) {
    state.selectedQuestionnaire = value;
    const match = (ui.selectOptions || []).find((o) => o.value === value);
    setSelectLabel(match ? match.label : "Choose…");
    setSelectMenu();
  }

  function setSelectMenu() {
    const menu = ui.cselectMenu;
    menu.replaceChildren();
    for (const option of ui.selectOptions || []) {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "cselect-option";
      item.setAttribute("role", "option");
      const selected = option.value === state.selectedQuestionnaire;
      item.setAttribute("aria-selected", String(selected));
      if (selected) item.classList.add("is-selected");

      const label = document.createElement("span");
      label.className = "cselect-option-label";
      label.textContent = option.label;
      item.append(label);

      if (option.note) {
        const note = document.createElement("span");
        note.className = "cselect-option-note";
        note.textContent = option.note;
        item.append(note);
      }

      item.addEventListener("click", () => {
        setSelectValue(option.value);
        closeSelect();
        openQuestionnaire(option.value);
      });
      menu.append(item);
    }
  }

  function openSelect() {
    if (ui.cselectTrigger.disabled) return;
    ui.cselectMenu.hidden = false;
    ui.cselectTrigger.setAttribute("aria-expanded", "true");
    // Highlight the current choice so Enter is a no-op rather than a surprise.
    const selected = ui.cselectMenu.querySelector(".is-selected") ||
      ui.cselectMenu.querySelector(".cselect-option");
    selected?.focus();
  }

  function closeSelect({ focusTrigger = false } = {}) {
    ui.cselectMenu.hidden = true;
    ui.cselectTrigger.setAttribute("aria-expanded", "false");
    if (focusTrigger) ui.cselectTrigger.focus();
  }

  function toggleSelect() {
    if (ui.cselectMenu.hidden) openSelect();
    else closeSelect({ focusTrigger: true });
  }

  async function openQuestionnaire(id) {
    const entry = (state.manifest?.manifest?.questionnaires || []).find(
      (item) => item.id === id,
    );
    if (!entry) return;

    setStatus("Loading…", "busy");
    try {
      const result = await api(
        "/api/questionnaire?" + questionParams() + "&path=" + encodeURIComponent(entry.path),
      );
      validateQuestionnaire(result.document);
      state.questionnaire = result.document;
      ui.crumbQuestionnaire.textContent = entry.title;
      loadLocal();
      renderQuestionnaire();
      await loadSaved();
      setStatus("Ready", "ok");
    } catch (error) {
      setStatus("Failed", "error");
      toast("Could not open questionnaire", error.message);
    }
  }

  function validateQuestionnaire(document) {
    if (
      !document ||
      document.schemaVersion !== 1 ||
      !Array.isArray(document.sections)
    ) {
      throw new Error("Unsupported questionnaire document.");
    }
  }

  // ---------- persistence ----------

  function draftKey() {
    if (!state.questionnaire || !state.projectId) return null;
    return [DRAFT_PREFIX, state.projectId, state.questionnaire.id, state.questionnaire.version].join(":");
  }

  function loadLocal() {
    const key = draftKey();
    state.answers = {};
    state.comments = {};
    state.remoteSha = null;
    state.dirty = false;
    if (!key) return;
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return;
      const draft = JSON.parse(raw);
      state.answers = draft.answers || {};
      state.comments = draft.comments || {};
    } catch {
      /* a corrupt draft must not block opening the questionnaire */
    }
  }

  function saveLocal() {
    const key = draftKey();
    if (!key) return;
    localStorage.setItem(
      key,
      JSON.stringify({ answers: state.answers, comments: state.comments }),
    );
  }

  async function loadSaved() {
    if (!state.questionnaire) return;
    try {
      const result = await api(
        "/api/answers?" + questionParams() +
          "&questionnaireId=" + encodeURIComponent(state.questionnaire.id),
      );
      if (result.exists) {
        state.remoteSha = result.sha;
        // A saved copy always wins over an unsaved draft: it is the one the
        // user committed, and the draft is only a safety net.
        if (Object.keys(state.answers).length === 0) {
          state.answers = result.document.answers || {};
          state.comments = result.document.comments || {};
          renderQuestionnaire();
          setSaveState("Saved");
        } else {
          setSaveState("Unsaved changes");
        }
      } else {
        setSaveState(Object.keys(state.answers).length > 0 ? "Unsaved changes" : "Not saved");
      }
    } catch (error) {
      setSaveState("Not saved");
    }
    updateProgress();
  }

  function setSaveState(text) {
    ui.saveState.textContent = text;
    ui.saveBtn.disabled = text !== "Unsaved changes";
    ui.saveBarBtn.disabled = ui.saveBtn.disabled;
  }

  function markDirty() {
    state.dirty = true;
    saveLocal();
    setSaveState("Unsaved changes");
  }

  async function save() {
    if (!state.questionnaire) return;
    const entry = (state.manifest?.manifest?.questionnaires || []).find(
      (item) => item.id === state.questionnaire.id,
    );
    setStatus("Saving…", "busy");
    try {
      const result = await api("/api/answers?" + questionParams(), {
        method: "PUT",
        body: JSON.stringify({
          questionnaireId: state.questionnaire.id,
          questionnaireVersion: state.questionnaire.version,
          sourcePath: entry.path,
          answers: state.answers,
          comments: state.comments,
          respondent: state.identity || undefined,
          expectedSha: state.remoteSha,
          message: `docs: update ${state.questionnaire.id} answers`,
        }),
      });
      state.remoteSha = result.sha;
      state.dirty = false;
      setStatus("Saved", "ok");
      setSaveState("Saved");
      ui.saveTarget.textContent = result.path || "";
      localStorage.removeItem(draftKey());
      if (result.committed && result.committed.ok) {
        setStatus("Saved and committed", "ok");
      }
    } catch (error) {
      setStatus("Save failed", "error");
      if (error.code === "answer_conflict") {
        toast(
          "Answers changed on disk",
          "Reload to pick up the saved copy, then reapply your changes.",
        );
        setSaveState("Conflict");
      } else {
        toast("Could not save", error.message);
      }
    }
  }

  // ---------- rendering ----------

  function showEmpty(message) {
    ui.questions.replaceChildren();
    ui.toc.replaceChildren();

    // The heading is derived rather than fixed, because "No project open" over a
    // project that simply has no questions yet is the one message that is
    // always wrong.
    ui.emptyState.querySelector("h1").textContent = state.projectId
      ? "Nothing to show yet"
      : "No project open";
    if (message) ui.emptyState.querySelector("p").textContent = message;

    if (!state.projectId) {
      // No project selected: the dashboard is the view, unless there are no
      // projects at all, in which case the empty state is.
      ui.crumbProject.textContent = "Projects";
      ui.crumbQuestionnaire.textContent = "";
      renderMain();
      return;
    }

    // A project is open but has nothing to show.
    ui.crumbQuestionnaire.textContent = "Select a questionnaire";
    renderMain();
  }

  function renderQuestionnaire() {
    const questionnaire = state.questionnaire;
    if (!questionnaire) return showEmpty();

    renderMain();
    ui.qVersion.textContent = questionnaire.id + " · v" + questionnaire.version;
    ui.qTitle.textContent = questionnaire.title;
    ui.qDescription.textContent = questionnaire.description || "";

    ui.toc.replaceChildren();
    ui.questions.replaceChildren();

    for (const section of questionnaire.sections) {
      const block = document.createElement("section");
      block.className = "section";
      block.id = "section-" + CSS.escape(section.id);

      const title = document.createElement("h2");
      title.className = "section-title";
      title.textContent = section.title;
      block.append(title);

      if (section.description) {
        const note = document.createElement("p");
        note.className = "section-note";
        note.textContent = section.description;
        block.append(note);
      }

      for (const question of section.questions) {
        block.append(renderQuestion(question));
      }

      const link = document.createElement("a");
      link.href = "#" + block.id;
      link.textContent = section.title;
      ui.toc.append(link);

      ui.questions.append(block);
    }

    updateProgress();
  }

  function renderQuestion(question) {
    const wrapper = document.createElement("div");
    wrapper.className = "q";
    wrapper.dataset.questionId = question.id;

    if (question.type !== "info") {
      const head = document.createElement("div");
      head.className = "q-head";

      const label = document.createElement("span");
      label.className = "q-label";
      label.textContent = question.label || "";
      head.append(label);

      if (!question.required) {
        const optional = document.createElement("span");
        optional.className = "q-optional";
        optional.textContent = "optional";
        head.append(optional);
      }
      wrapper.append(head);

      if (question.help) {
        const help = document.createElement("p");
        help.className = "q-help";
        help.textContent = question.help;
        wrapper.append(help);
      }
    }

    const body = document.createElement("div");
    body.className = "q-body";
    body.append(renderControl(question));
    wrapper.append(body);

    if (question.type !== "info") {
      wrapper.append(renderNote(question));
    }

    return wrapper;
  }

  function renderControl(question) {
    const current = state.answers[question.id];
    // Dropdowns carry the question id on the wrapper so the shared collector
    // can coerce the chosen string back to the question's real type.
    const tag = (node) => {
      node.dataset.answerFor = question.id;
      return node;
    };

    if (question.type === "info") {
      const p = document.createElement("p");
      p.className = "info";
      p.textContent = question.text || "";
      return p;
    }

    if (question.type === "single" || question.type === "multi") {
      const list = document.createElement("div");
      list.className = "choices";
      const type = question.type === "single" ? "radio" : "checkbox";
      for (const item of question.options || []) {
        list.append(renderChoice(question, item, type, current));
      }
      return list;
    }

    if (question.type === "select") {
      return tag(renderDropdown({
        value: String(current ?? ""),
        placeholder: "Choose…",
        options: (question.options || []).map((item) => ({
          value: String(item.value),
          label: item.label,
        })),
      }));
    }

    if (question.type === "boolean") {
      return tag(renderDropdown({
        value: current === true ? "true" : current === false ? "false" : "",
        placeholder: "Choose…",
        options: [
          { value: "true", label: "Yes" },
          { value: "false", label: "No" },
        ],
      }));
    }

    if (question.type === "textarea") {
      const textarea = document.createElement("textarea");
      textarea.dataset.answerFor = question.id;
      textarea.value = current ?? "";
      if (question.placeholder) textarea.placeholder = question.placeholder;
      if (question.maxLength) textarea.maxLength = question.maxLength;
      return textarea;
    }

    const input = document.createElement("input");
    input.dataset.answerFor = question.id;
    input.type = question.type === "number" ? "number" : "text";
    input.value = current ?? "";
    if (question.placeholder) input.placeholder = question.placeholder;
    if (question.type === "number") {
      if (question.min !== undefined) input.min = question.min;
      if (question.max !== undefined) input.max = question.max;
      if (question.step !== undefined) input.step = question.step;
    }
    return input;
  }

  function renderChoice(question, item, type, current) {
    const label = document.createElement("label");
    label.className = "choice";

    const input = document.createElement("input");
    input.type = type;
    input.dataset.answerFor = question.id;
    // Radios are only mutually exclusive when they share a name. Without one,
    // every option is its own group and a "choose one" question takes several.
    if (type === "radio") input.name = "answer-" + question.id;
    input.value = String(item.value);
    input.checked =
      type === "radio"
        ? String(current ?? "") === String(item.value)
        : Array.isArray(current) && current.map(String).includes(String(item.value));

    const text = document.createElement("span");
    text.textContent = item.label;

    label.append(input, text);
    return label;
  }

  function renderNote(question) {
    const wrap = document.createElement("div");
    wrap.className = "note";

    const details = document.createElement("details");
    const existing = state.comments[question.id];
    if (existing) details.open = true;

    const summary = document.createElement("summary");
    summary.className = "note-toggle";
    summary.textContent = existing ? "Note" : "Add a note";

    const textarea = document.createElement("textarea");
    textarea.className = "note-input";
    textarea.dataset.noteFor = question.id;
    textarea.rows = 2;
    textarea.maxLength = COMMENT_MAX_LENGTH;
    textarea.placeholder = "Explain or qualify this answer";
    textarea.value = existing ?? "";

    const hint = document.createElement("span");
    hint.className = "note-hint";
    hint.textContent = "Saved with this answer. Never required.";

    details.append(summary, textarea, hint);
    wrap.append(details);
    return wrap;
  }

  // ---------- events ----------

  function collect(target) {
    if (target.dataset?.noteFor) {
      const id = target.dataset.noteFor;
      const value = target.value.trim();
      if (value) {
        state.comments[id] = value;
      } else {
        delete state.comments[id];
        const details = target.closest("details");
        if (details) details.open = false;
      }
      const summary = target.closest("details")?.querySelector(".note-toggle");
      if (summary) summary.textContent = value ? "Note" : "Add a note";
      markDirty();
      return;
    }

    const id = target.dataset?.answerFor;
    if (!id) return;
    const question = allQuestions().find((q) => q.id === id);
    if (!question) return;

    if (question.type === "multi") {
      const values = [...document.querySelectorAll(
        `input[data-answer-for="${CSS.escape(id)}"]:checked`,
      )].map((input) => input.value);
      state.answers[id] = values;
    } else if (question.type === "single") {
      const checked = document.querySelector(
        `input[data-answer-for="${CSS.escape(id)}"]:checked`,
      );
      if (checked) state.answers[id] = checked.value;
    } else if (question.type === "boolean") {
      if (target.value === "") delete state.answers[id];
      else state.answers[id] = target.value === "true";
    } else if (question.type === "number") {
      if (target.value === "") delete state.answers[id];
      else state.answers[id] = Number(target.value);
    } else if (target.value === "") {
      delete state.answers[id];
    } else {
      state.answers[id] = target.value;
    }

    markDirty();
    updateProgress();
  }

  function allQuestions() {
    return state.questionnaire
      ? state.questionnaire.sections.flatMap((s) => s.questions)
      : [];
  }

  function hasAnswer(question) {
    const value = state.answers[question.id];
    if (question.type === "multi") return Array.isArray(value) && value.length > 0;
    if (question.type === "boolean") return typeof value === "boolean";
    if (question.type === "number") return typeof value === "number" && Number.isFinite(value);
    return value !== undefined && value !== null && String(value).trim() !== "";
  }

  function updateProgress() {
    if (!state.questionnaire) return;
    const required = allQuestions().filter((q) => q.required && q.type !== "info");
    const done = required.filter(hasAnswer);
    const percent = required.length === 0
      ? 100
      : Math.round((done.length / required.length) * 100);

    ui.progressPercent.textContent = percent + "%";
    ui.progressFill.style.width = percent + "%";
    ui.progressDetail.textContent = done.length + " of " + required.length + " required";

    for (const question of required) {
      const node = ui.questions.querySelector(
        `.q[data-question-id="${CSS.escape(question.id)}"] .q-label`,
      );
      if (node) node.style.color = hasAnswer(question) ? "var(--text)" : "var(--text)";
    }
  }

  /**
   * A themed dropdown for a single answer. Same component as the questionnaire
   * picker, so no native select ever appears. Emits the chosen string through
   * the normal collect() path, which already knows how to coerce the value back
   * to the question's type.
   */
  function renderDropdown({ value, placeholder, options }) {
    const wrap = document.createElement("div");
    wrap.className = "cdropdown";

    const trigger = document.createElement("button");
    trigger.type = "button";
    trigger.className = "cdropdown-trigger";
    trigger.setAttribute("aria-haspopup", "listbox");
    trigger.setAttribute("aria-expanded", "false");

    const label = document.createElement("span");
    label.className = "cdropdown-value";
    const caret = document.createElement("span");
    caret.className = "cdropdown-caret";
    caret.setAttribute("aria-hidden", "true");
    trigger.append(label, caret);

    const menu = document.createElement("div");
    menu.className = "cdropdown-menu";
    menu.setAttribute("role", "listbox");
    menu.hidden = true;

    let current = value;

    const paint = () => {
      const match = options.find((o) => o.value === current);
      label.textContent = match ? match.label : placeholder;
      label.classList.toggle("is-placeholder", !match);
    };

    const close = () => {
      menu.hidden = true;
      trigger.setAttribute("aria-expanded", "false");
    };

    const open = () => {
      menu.hidden = false;
      trigger.setAttribute("aria-expanded", "true");
    };

    const choose = (next) => {
      current = next;
      paint();
      close();
      // Route through the shared collector so the stored type stays correct:
      // booleans become real booleans, numbers real numbers.
      const proxy = document.createElement("input");
      proxy.dataset.answerFor = wrap.dataset.answerFor;
      proxy.value = next;
      collect(proxy);
    };

    for (const option of options) {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "cdropdown-option";
      item.setAttribute("role", "option");
      item.setAttribute("aria-selected", String(option.value === current));
      if (option.value === current) item.classList.add("is-selected");
      item.textContent = option.label;
      item.addEventListener("click", () => choose(option.value));
      menu.append(item);
    }

    trigger.addEventListener("click", (event) => {
      event.stopPropagation();
      if (menu.hidden) open();
      else close();
    });
    trigger.addEventListener("keydown", (event) => {
      if (["ArrowDown", "Enter", " "].includes(event.key)) {
        event.preventDefault();
        event.stopPropagation();
        open();
      }
    });
    // Closing on an outside click, scoped to this dropdown, keeps a 42-question
    // form from stacking dozens of document listeners.
    wrap.addEventListener("click", (event) => event.stopPropagation());
    document.addEventListener("click", () => {
      if (!menu.hidden) close();
    });

    paint();
    wrap.append(trigger, menu);
    return wrap;
  }

  // ---------- project picker ----------
  //
  // One model: the server returns a single ordered list of entries, each either a
  // folder to travel into or a project to add. The UI keeps exactly one list and
  // one highlighted index, so keyboard and mouse always agree about what is
  // selected. Everything the user can reach is in that list, which is what makes
  // Tab and Enter predictable.

  function openPicker() {
    cancelPickerRequest();
    state.picker = {
      root: state.defaultProjectDir || null,
      home: null,
      entries: [],
      index: 0,
      loaded: false,
    };
    state.pickedPath = null;
    syncAddButton();
    ui.browseBlock.hidden = true;
    ui.browseBlock.open = false;
    ui.projectSearch.value = "";
    ui.searchResults.replaceChildren();
    ui.projectDialog.showModal();
    ui.projectSearch.focus();
    refreshPicker();
  }

  function setPickerNote(text) {
    ui.defaultDirStatus.textContent = text;
  }

  // A keystroke paints from the cache immediately and only then goes to the
  // server, so a query that has been typed before costs nothing and a new one
  // costs one short, cancellable request. The delay is just long enough to
  // swallow a burst of typing into a single request.
  let pickerTimer = null;
  function onSearchInput() {
    clearTimeout(pickerTimer);
    const typed = ui.projectSearch.value.trim();
    const cached = cachedSuggest((state.picker.root || "") + "\n" + typed);
    if (cached) applyPickerResult(cached, typed, null);
    pickerTimer = setTimeout(refreshPicker, 45);
  }

  // One request in flight at a time, plus recent answers kept per root and
  // query. Together they make typing feel local: a query that has been typed
  // before answers instantly, and one that does not cancels the request it
  // replaces rather than racing it onto the screen.
  let pickerRequest = null;
  const suggestCache = new Map();
  const SUGGEST_CACHE_LIMIT = 60;
  // Short enough that a folder or project created a minute ago can still be
  // found by a query typed before it existed. Without an expiry the cache would
  // quietly disagree with the disk.
  const SUGGEST_TTL_MS = 30_000;

  function cachedSuggest(key) {
    const hit = suggestCache.get(key);
    if (!hit) return null;
    if (Date.now() - hit.at >= SUGGEST_TTL_MS) {
      suggestCache.delete(key);
      return null;
    }
    return hit.result;
  }

  function cancelPickerRequest() {
    if (pickerRequest) {
      pickerRequest.abort();
      pickerRequest = null;
    }
  }

  /** Home is the floor: the abbreviated label is relative to it. */
  function displayRoot(root) {
    const home = (state.picker.home || "").replace(/\/$/, "");
    if (!root) return "~";
    if (root === home) return "~";
    return home && root.startsWith(home + "/")
      ? "~" + root.slice(home.length)
      : root;
  }

  function renderPickerHeader() {
    const root = state.picker.root;
    ui.pickerRoot.textContent = displayRoot(root);
    ui.pickerRoot.title = root || "";
    ui.pickerBack.disabled = !root || !state.picker.home || root === state.picker.home;
  }

  /**
   * Loads entries for the current root and query.
   *
   * An empty query lists what is in this folder, which is what makes the picker
   * browsable: you can walk the tree without knowing any path. A query switches
   * to matching everything below the root, and both folders and projects are
   * filtered by the server.
   *
   * `selectPath` keeps a specific entry highlighted across the reload, which is
   * how Tab lands on the row it just completed instead of the first match.
   */
  async function refreshPicker(selectPath) {
    const typed = ui.projectSearch.value.trim();

    // A pasted path is a location, not a search term. Handling it here means a
    // path copied from a shell or a config file works the moment it is pasted.
    if (typed.includes("/")) {
      try {
        const listing = await api("/api/directories?path=" + encodeURIComponent(typed));
        if (ui.projectSearch.value.trim() !== typed) return;
        state.picker.root = listing.path;
        state.picker.index = 0;
        ui.projectSearch.value = "";
        state.pickedPath = null;
        // Fall through to the normal load for the new root.
        return refreshPicker();
      } catch {
        // Not a directory, so search for it as a name instead.
      }
    }

    const query = typed;
    const key = (state.picker.root || "") + "\n" + query;
    const cached = cachedSuggest(key);
    if (cached) {
      applyPickerResult(cached, query, selectPath);
      return;
    }

    const params = new URLSearchParams({ q: query, limit: "30" });
    if (state.picker.root) params.set("root", state.picker.root);

    // The first keystroke has nothing to wait for, so the field never looks dead.
    if (suggestCache.size === 0) setPickerNote("Searching…");

    cancelPickerRequest();
    const controller = new AbortController();
    pickerRequest = controller;

    let result;
    try {
      result = await api("/api/suggest?" + params.toString(), {
        signal: controller.signal,
      });
    } catch (error) {
      // Superseded by a newer keystroke, which is not a failure to report.
      if (error.name === "AbortError") return;
      if (ui.projectSearch.value.trim() !== query) return;
      state.picker.entries = [];
      state.picker.loaded = true;
      renderPickerList("");
      setPickerNote(error.message);
      return;
    } finally {
      if (pickerRequest === controller) pickerRequest = null;
    }

    if (ui.projectSearch.value.trim() !== query) return;
    suggestCache.set(key, { at: Date.now(), result });
    if (suggestCache.size > SUGGEST_CACHE_LIMIT) {
      suggestCache.delete(suggestCache.keys().next().value);
    }
    applyPickerResult(result, query, selectPath);
  }

  /** Paints one response: the rows, the header, the note, and what is selected. */
  function applyPickerResult(result, query, selectPath) {
    if (!state.picker.home) state.picker.home = result.homeDir;
    // The root the server actually searched, so "the folder you are in" is a
    // real path even when the picker opened on the home folder.
    state.picker.root = result.root;
    // Remember the highlighted path before the list is replaced, otherwise the
    // new list is searched for an entry taken from the new list and the
    // highlight jumps to whatever now sits at that position.
    const keep = selectPath || state.picker.entries[state.picker.index]?.path;
    state.picker.entries = result.entries || [];
    state.picker.loaded = true;
    const at = keep
      ? state.picker.entries.findIndex((entry) => entry.path === keep)
      : -1;
    state.picker.index = at === -1 ? 0 : at;

    renderPickerHeader();
    renderPickerList(query);
    syncAddButton();

    // What Add project will add is spelled out, because a highlighted row and a
    // selected one look alike and a dead button is all the user would see.
    const highlighted = currentEntry();
    const hint = state.pickedPath
      ? "Press Add project to confirm."
      : highlighted && highlighted.kind === "project"
        ? "Press Enter to select it. Add project adds this folder."
        : "Add project adds this folder.";
    if (state.picker.entries.length === 0) {
      setPickerNote(
        (query
          ? "Nothing here. Try fewer letters, or press ‹ to go up."
          : "Nothing in this folder. Press ‹ to go up.") + " " + hint,
      );
    } else {
      setPickerNote(
        state.picker.entries.length +
          (query ? " match" + (state.picker.entries.length === 1 ? "" : "es") : " item" + (state.picker.entries.length === 1 ? "" : "s")) +
          " in " +
          displayRoot(result.root) + ". " +
          hint,
      );
    }
  }

  function currentEntry() {
    return state.picker.entries[state.picker.index] || null;
  }

  function renderPickerList(query) {
    ui.searchResults.replaceChildren();

    for (const [position, entry] of state.picker.entries.entries()) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "picker-item" + (entry.kind === "project" ? " is-project" : " is-folder");
      row.setAttribute("role", "option");
      const active = position === state.picker.index;
      row.setAttribute("aria-selected", String(active));
      if (active) row.classList.add("is-active");

      const dot = document.createElement("span");
      dot.className = "dot";

      const label = document.createElement("span");
      label.className = "picker-label";
      highlightMatch(label, entry.name, query);

      // The folder the result sits in. Two same-named results in different
      // folders are told apart by exactly this, and it is the only clue about
      // where a nested match actually lives.
      const path = document.createElement("span");
      path.className = "picker-sub";
      const inRoot = entry.parent === state.picker.root;
      path.textContent = inRoot
        ? entry.kind === "project" ? "project" : "folder"
        : displayRoot(entry.parent) || entry.path;

      row.append(dot, label, path);
      row.addEventListener("click", () => {
        state.picker.index = position;
        activateEntry();
      });
      row.addEventListener("mouseenter", () => {
        state.picker.index = position;
        paintPickerHighlight();
      });
      ui.searchResults.append(row);
    }
  }

  function paintPickerHighlight() {
    const rows = [...ui.searchResults.querySelectorAll(".picker-item")];
    rows.forEach((row, position) => {
      const active = position === state.picker.index;
      row.classList.toggle("is-active", active);
      row.setAttribute("aria-selected", String(active));
    });
  }

  /**
   * What Enter and clicking a row both do: a folder is travelled into, a
   * project is selected. One function, so the two can never disagree.
   *
   * Travelling also makes that folder addable, because "I picked a directory
   * and cannot add it" is not a state this dialog should ever be in.
   */
  function activateEntry() {
    const entry = currentEntry();
    if (!entry) return;

    if (entry.kind === "folder") {
      state.picker.root = entry.path;
      state.picker.index = 0;
      ui.projectSearch.value = "";
      state.pickedPath = null;
      refreshPicker();
      return;
    }

    state.pickedPath = entry.path;
    syncAddButton();
    paintPickerHighlight();
    setPickerNote("Selected " + entry.name + ". Press Add project to confirm.");
  }

  /**
   * Add project is enabled whenever there is something to add: the project that
   * was picked, or the folder the picker is currently in.
   */
  function syncAddButton() {
    ui.projectSave.disabled = !addablePath();
  }

  /** The path Add project would add right now. */
  function addablePath() {
    return state.pickedPath || state.picker.root || ui.pickerPath.value.trim() || "";
  }

  /**
   * Tab completes the highlighted entry into the field. On a folder that means
   * going there, because completing a location is navigating to it. Repeated
   * Tab walks down the list, so every entry is reachable without the mouse.
   */
  async function onSearchKeydown(event) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (state.picker.entries.length === 0) return;
      event.preventDefault();
      const delta = event.key === "ArrowDown" ? 1 : -1;
      const count = state.picker.entries.length;
      state.picker.index = (state.picker.index + delta + count) % count;
      paintPickerHighlight();
      ui.searchResults.children[state.picker.index]?.scrollIntoView({ block: "nearest" });
      return;
    }

    if (event.key === "Tab" && !event.shiftKey) {
      if (state.picker.entries.length === 0) return;
      event.preventDefault();
      const entry = currentEntry();
      if (!entry) return;
      if (entry.kind === "folder") {
        activateEntry();
      } else {
        // A project is a leaf, so completing it fills the name and leaves that
        // exact row highlighted, ready for Enter to select it.
        ui.projectSearch.value = entry.name;
        await refreshPicker(entry.path);
      }
      return;
    }

    if (event.key === "Enter") {
      event.preventDefault();
      activateEntry();
    }
  }

  /** Marks the characters that matched, so a fuzzy hit is explainable. */
  function highlightMatch(container, text, query) {
    const needle = (query || "").toLowerCase();
    if (!needle) {
      container.textContent = text;
      return;
    }
    let cursor = 0;
    const lower = text.toLowerCase();
    for (const char of needle) {
      const at = lower.indexOf(char, cursor);
      if (at === -1) continue;
      if (at > cursor) {
        container.append(document.createTextNode(text.slice(cursor, at)));
      }
      const mark = document.createElement("span");
      mark.className = "hit";
      mark.textContent = text[at];
      container.append(mark);
      cursor = at + 1;
    }
    if (cursor < text.length) {
      container.append(document.createTextNode(text.slice(cursor)));
    }
  }

  async function goUpPicker() {
    const { root, home } = state.picker;
    if (!root || !home || root === home) return;
    state.picker.root = root.replace(/\/+$/, "").split("/").slice(0, -1).join("/") || "/";
    state.picker.index = 0;
    ui.projectSearch.value = "";
    refreshPicker();
  }
  async function browseInto(path) {
    setStatus("Browsing…", "busy");
    try {
      const listing = await api("/api/directories" + (path ? "?path=" + encodeURIComponent(path) : ""));
      ui.pickerPath.value = listing.path;
      ui.pickerUp.disabled = !listing.parent;
      syncAddButton();
      ui.pickerList.replaceChildren();

      if (listing.directories.length === 0) {
        const empty = document.createElement("p");
        empty.className = "picker-empty";
        empty.textContent = "No sub-folders here.";
        ui.pickerList.append(empty);
        return;
      }

      for (const dir of listing.directories) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "picker-item" + (dir.isProject ? " is-project" : "");
        const dot = document.createElement("span");
        dot.className = "dot";
        const name = document.createElement("span");
        name.textContent = dir.name;
        button.append(dot, name);
        // Clicking a folder navigates; using one is explicit, so it is not
        // selected implicitly just by being on screen.
        button.addEventListener("click", () => browseInto(dir.path));
        ui.pickerList.append(button);
      }
    } catch (error) {
      toast("Could not open folder", error.message);
    } finally {
      setStatus("Ready", "ok");
    }
  }

  async function addSelectedProject() {
    // The picked project wins; otherwise the folder the picker is in, so that
    // selecting a directory and pressing Add does what it looks like.
    const path = addablePath();
    if (!path) return;
    setStatus("Adding…", "busy");
    try {
      const { project } = await api("/api/projects", {
        method: "POST",
        body: JSON.stringify({
          path,
          commitOnWrite: ui.projectGit.checked,
        }),
      });
      ui.projectDialog.close();
      await loadProjects();
      await selectProject(project.id);
      setStatus("Added " + project.name, "ok");
    } catch (error) {
      toast("Could not add project", error.message);
    }
  }

  /**
   * Writes settings and keeps the local copy in step with the server. The
   * projects folder is only where the picker starts looking; nothing here ever
   * adds a project on its own.
   */
  async function saveSettings(patch) {
    const result = await api("/api/settings", {
      method: "POST",
      body: JSON.stringify(patch),
    });
    if (result.defaultProjectDir !== undefined) {
      state.defaultProjectDir = result.defaultProjectDir;
    }
    if (result.identity !== undefined) {
      state.identity = result.identity;
    }
    return result;
  }

  /** Loads the stored settings that the picker and the settings dialog read. */
  async function loadSettings() {
    try {
      const settings = await api("/api/settings");
      state.defaultProjectDir = settings.defaultProjectDir || null;
      state.identity = settings.identity || "";
      state.configPath = settings.configPath || "";
      state.version = settings.version || "";
      if (ui.identityInput && ui.identityInput.value !== state.identity) {
        ui.identityInput.value = state.identity;
      }
    } catch {
      // Settings are a convenience; the app works without them.
    }
  }

  // ---------- settings dialog ----------

  function openSettings() {
    ui.settingsDir.value = state.defaultProjectDir || "";
    ui.settingsDirStatus.textContent = state.defaultProjectDir
      ? "The picker opens here next time."
      : "The picker opens in your home folder.";
    ui.settingsIdentity.value = state.identity || "";
    ui.aboutVersion.textContent = state.version || "—";
    ui.aboutConfig.textContent = state.configPath || "—";
    ui.aboutProjects.textContent = String(state.projects.length);
    ui.settingsDialog.showModal();
  }

  async function saveSettingsDialog() {
    const dir = ui.settingsDir.value.trim();
    try {
      // The folder is resolved before it is stored, and the server expands a
      // leading ~: a path that does not exist would otherwise sit in the
      // settings failing every search until someone noticed.
      const defaultProjectDir = dir
        ? (await api("/api/directories?path=" + encodeURIComponent(dir))).path
        : null;
      await saveSettings({ defaultProjectDir, identity: ui.settingsIdentity.value });
      if (ui.identityInput) ui.identityInput.value = state.identity;
      ui.settingsDialog.close();
      setStatus("Settings saved", "ok");
      if (state.questionnaire) await loadSaved();
    } catch (error) {
      ui.settingsDirStatus.textContent = error.message;
    }
  }

  function showSettingsSection(name) {
    for (const tab of ui.settingsDialog.querySelectorAll(".settings-tab")) {
      const active = tab.dataset.section === name;
      tab.classList.toggle("is-active", active);
      tab.setAttribute("aria-current", String(active));
    }
    for (const pane of ui.settingsDialog.querySelectorAll("[data-pane]")) {
      pane.hidden = pane.dataset.pane !== name;
    }
  }

  // ---------- wiring ----------

  function setMode(mode) {
    state.mode = mode;
    ui.modeLocal.setAttribute("aria-checked", String(mode === "local"));
    ui.modeGithub.setAttribute("aria-checked", String(mode === "github"));
  }

  ui.modeLocal.addEventListener("click", () => setMode("local"));
  ui.modeGithub.addEventListener("click", () =>
    setMode("github") ||
    toast("GitHub storage", "Add a project with GitHub configured in projects.json to use repo-backed storage."),
  );

  ui.identityInput.addEventListener("change", async () => {
    try {
      await saveSettings({ identity: ui.identityInput.value });
    } catch {
      /* the label is also sent per request, so a failure here is not fatal */
    }
    if (state.questionnaire) await loadSaved();
  });

  ui.settingsBtn.addEventListener("click", openSettings);
  ui.settingsClose.addEventListener("click", () => ui.settingsDialog.close());
  ui.settingsSave.addEventListener("click", saveSettingsDialog);
  ui.settingsDirReset.addEventListener("click", () => {
    ui.settingsDir.value = "";
    ui.settingsDirStatus.textContent = "The picker opens in your home folder.";
  });
  for (const tab of ui.settingsDialog.querySelectorAll(".settings-tab")) {
    tab.addEventListener("click", () => showSettingsSection(tab.dataset.section));
  }

  ui.addProjectBtn.addEventListener("click", () => openPicker());

  // One field, one list. Typing filters; the keyboard drives the same list the
  // mouse does.
  ui.projectSearch.addEventListener("input", onSearchInput);
  ui.projectSearch.addEventListener("keydown", onSearchKeydown);
  ui.pickerBack.addEventListener("click", goUpPicker);
  ui.defaultDirBrowse.addEventListener("click", async () => {
    ui.browseBlock.hidden = false;
    ui.browseBlock.open = true;
    await browseInto(state.picker.root || state.defaultProjectDir || "");
  });

  // The manual folder browser behind "Browse", kept for folders the search does
  // not surface.
  ui.pickerUp.addEventListener("click", async () => {
    const path = ui.pickerPath.value;
    const parent = path.replace(/\/[^/]*$/, "") || "/";
    await browseInto(parent);
  });
  ui.pickerPath.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      browseInto(ui.pickerPath.value.trim());
    }
  });
  ui.pickerPath.addEventListener("change", () => {
    browseInto(ui.pickerPath.value.trim());
  });
  ui.projectCancel.addEventListener("click", () => ui.projectDialog.close());
  ui.projectSave.addEventListener("click", (event) => {
    event.preventDefault();
    addSelectedProject();
  });
  ui.projectDialog.addEventListener("close", () => setStatus("Ready", "ok"));

  // Custom select wiring: click, keyboard, and close-on-outside-click.
  ui.cselectTrigger.addEventListener("click", toggleSelect);
  ui.cselectTrigger.addEventListener("keydown", (event) => {
    if (["ArrowDown", "Enter", " "].includes(event.key)) {
      event.preventDefault();
      openSelect();
    }
  });
  ui.cselectMenu.addEventListener("keydown", (event) => {
    const options = [...ui.cselectMenu.querySelectorAll(".cselect-option")];
    const index = options.indexOf(document.activeElement);
    if (event.key === "ArrowDown") {
      event.preventDefault();
      options[Math.min(index + 1, options.length - 1)]?.focus();
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      if (index <= 0) ui.cselectTrigger.focus();
      else options[index - 1].focus();
    } else if (event.key === "Escape") {
      event.preventDefault();
      closeSelect({ focusTrigger: true });
    }
  });
  document.addEventListener("click", (event) => {
    if (ui.cselectMenu.hidden) return;
    if (event.target.closest(".cselect")) return;
    closeSelect();
  });

  ui.saveBtn.addEventListener("click", save);
  ui.saveBarBtn.addEventListener("click", save);
  ui.reloadBtn.addEventListener("click", async () => {
    if (state.dirty && !confirm("Discard your unsaved answers?")) return;
    loadLocal();
    renderQuestionnaire();
    await loadSaved();
  });

  // The rail has one state, not two independent toggles. The previous code added
  // `rail-open` without clearing `rail-collapsed`, so reopening left the grid
  // column at 0 and the rail translated off-screen: collapsed, but unable to
  // come back.
  function setRail(open) {
    const app = document.querySelector(".app");
    app.classList.toggle("rail-collapsed", !open);
    app.classList.toggle("rail-open", open);
    ui.railOpen.hidden = open;
  }

  ui.railToggle.addEventListener("click", () => setRail(false));
  ui.railOpen.addEventListener("click", () => setRail(true));

  ui.questions.addEventListener("input", (event) => collect(event.target));
  ui.questions.addEventListener("change", (event) => collect(event.target));

  window.addEventListener("beforeunload", (event) => {
    if (!state.dirty) return;
    event.preventDefault();
  });

  // ---------- start ----------

  async function start() {
    setStatus("Starting…", "busy");
    try {
      // Land on the dashboard. No project is opened until one is chosen, so the
      // server has no default to guess and the choice stays with the user.
      await loadProjects();
      await loadSettings();

      if (state.projects.length === 0) {
        setStatus("No projects", "error");
        return;
      }
      setStatus("Ready", "ok");
    } catch (error) {
      setStatus("Failed", "error");
      showEmpty(error.message);
    }
  }

  trace("starting");
  start();
})();
