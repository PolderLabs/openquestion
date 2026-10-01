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
    "projectDialog", "defaultDirBlock", "defaultDirPath", "defaultDirBrowse",
    "defaultDirStatus", "searchBlock", "projectSearch", "searchResults",
    "searchHint", "browseBlock", "pickerPath", "pickerUp", "pickerList",
    "projectGit", "projectSave", "toastDialog", "toastTitle", "toastBody",
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
    // Picker state, kept across opens so the projects folder is remembered.
    defaultProjectDir: null,
    searchRoot: null,
    searchResultsCache: null,
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
   */
  function renderDashboard() {
    const list = ui.dashList;
    list.replaceChildren();

    if (state.projects.length === 0) {
      showEmpty();
      return;
    }

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
    ui.dash.hidden = hasProject || state.projects.length === 0;
    ui.emptyState.hidden = hasProject || state.projects.length > 0;
    ui.sheet.hidden = !state.questionnaire;
    ui.savebar.hidden = !state.questionnaire;

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
      setStatus("No manifest", "error");
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
    // Only meaningful when a project is selected but has nothing to show.
    // With no project selected the dashboard is the right view.
    if (!state.projectId) {
      renderDashboard();
      renderMain();
      return;
    }
    ui.sheet.hidden = true;
    ui.dash.hidden = true;
    ui.emptyState.hidden = false;
    ui.savebar.hidden = true;
    ui.questions.replaceChildren();
    ui.toc.replaceChildren();
    ui.crumbQuestionnaire.textContent = "Select a questionnaire";
    if (message) ui.emptyState.querySelector("p").textContent = message;
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

  // The picker is two steps because the two questions are different: where to
  // look, and what to add. The projects folder is never pre-filled - the user
  // points it at an existing directory, and only then does search run.
  function openPicker() {
    state.pickedPath = null;
    ui.projectSave.disabled = true;
    ui.defaultDirBlock.hidden = false;
    ui.searchBlock.hidden = true;
    ui.browseBlock.hidden = true;
    ui.defaultDirPath.value = state.defaultProjectDir || "";
    ui.defaultDirStatus.textContent = "";
    ui.projectSearch.value = "";
    ui.searchResults.replaceChildren();
    ui.projectDialog.showModal();
    ui.defaultDirPath.focus();
  }

  /** Validates the chosen folder and, if it is usable, reveals the search step. */
  async function useDefaultDir() {
    const raw = ui.defaultDirPath.value.trim().replace(/^~(?=$|\/)/, "");
    if (!raw) {
      ui.defaultDirStatus.textContent = "Choose a folder to search.";
      return;
    }
    ui.defaultDirStatus.textContent = "Checking…";

    let listing;
    try {
      listing = await api("/api/directories?path=" + encodeURIComponent(raw));
    } catch (error) {
      ui.defaultDirStatus.textContent = error.message;
      return;
    }

    state.defaultProjectDir = listing.path;
    state.searchRoot = listing.path;
    ui.defaultDirStatus.textContent = "Searching " + listing.path;
    ui.searchBlock.hidden = false;
    ui.browseBlock.hidden = false;
    ui.searchHint.textContent = "Scanning…";
    await loadSearchResults();
    renderSearchResults(state.searchResultsCache || [], "");
    ui.projectSearch.focus();
  }

  let searchTimer = null;

  function scheduleSearch() {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(runSearch, 140);
  }

  /**
   * Fuzzy-matches the query against cached search results. Filtering runs on
   * whatever the server already returned, so typing is instant and does not
   * re-walk the filesystem on every keystroke.
   */
  function runSearch() {
    const query = ui.projectSearch.value.trim();
    if (!state.searchResultsCache) return;
    const all = state.searchResultsCache;
    const ranked = query ? rankMatches(all, query) : all;
    renderSearchResults(ranked, query);
  }

  /**
   * Subsequence match with a bonus for consecutive characters and for matches at
   * word starts, so "gfq" finds "globalfrontio" and "oq" finds "openquestion"
   * faster than "oe" would.
   */
  function rankMatches(items, query) {
    const needle = query.toLowerCase();
    const scored = [];
    for (const item of items) {
      const score = fuzzyScore(item.name, needle);
      if (score > 0) scored.push({ item, score });
    }
    scored.sort((a, b) => b.score - a.score || a.item.depth - b.item.depth);
    return scored.map((entry) => entry.item);
  }

  function fuzzyScore(text, needle) {
    const haystack = text.toLowerCase();
    if (haystack.includes(needle)) {
      // An exact substring is the strongest signal; earlier is better.
      return 1000 - haystack.indexOf(needle);
    }
    let score = 0;
    let index = 0;
    let streak = 0;
    for (const char of needle) {
      const found = haystack.indexOf(char, index);
      if (found === -1) return 0;
      // Consecutive characters and word starts are worth more.
      if (found === index) streak += 1;
      else streak = 0;
      score += 10 + streak * 5;
      if (found === 0 || /[-_/ ]/.test(haystack[found - 1])) score += 15;
      index = found + 1;
    }
    return score;
  }

  async function loadSearchResults() {
    if (!state.searchRoot) return;
    try {
      const result = await api("/api/search?root=" + encodeURIComponent(state.searchRoot));
      state.searchResultsCache = result.results;
      ui.searchHint.textContent =
        result.results.length === 0
          ? "No projects found here."
          : result.results.length + " found · two levels deep";
    } catch (error) {
      state.searchResultsCache = [];
      ui.searchHint.textContent = error.message;
    }
  }

  function renderSearchResults(items, query) {
    ui.searchResults.replaceChildren();

    if (items.length === 0) {
      const empty = document.createElement("p");
      empty.className = "picker-empty";
      empty.textContent = state.searchResultsCache && state.searchResultsCache.length === 0
        ? "No projects in this folder. Use Browse folders instead."
        : "No match. Try part of a name, or use Browse folders.";
      ui.searchResults.append(empty);
      return;
    }

    for (const item of items) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "picker-item is-project" + (item.path === state.pickedPath ? " is-picked" : "");
      button.setAttribute("role", "option");
      button.setAttribute("aria-selected", String(item.path === state.pickedPath));

      const dot = document.createElement("span");
      dot.className = "dot";
      const label = document.createElement("span");
      label.className = "picker-label";
      highlightMatch(label, item.name, query);
      const path = document.createElement("span");
      path.className = "picker-sub";
      path.textContent = item.path;

      button.append(dot, label, path);
      button.addEventListener("click", () => {
        state.pickedPath = item.path;
        ui.projectSave.disabled = false;
        renderSearchResults(items, query);
      });
      ui.searchResults.append(button);
    }
  }

  /** Marks the matched characters so the user can see why a row matched. */
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

  async function browseInto(path) {
    setStatus("Browsing…", "busy");
    try {
      const listing = await api("/api/directories" + (path ? "?path=" + encodeURIComponent(path) : ""));
      ui.pickerPath.value = listing.path;
      ui.pickerUp.disabled = !listing.parent;
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
    // A picked search result wins; otherwise the manually browsed path is used,
    // which is how a folder that is not a project can still be added.
    const path = state.pickedPath || ui.pickerPath.value.trim();
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
      // Remember the folder so the next add starts from the same place.
      if (state.defaultProjectDir) {
        await saveDefaultDir(state.defaultProjectDir);
      }
      ui.projectDialog.close();
      await loadProjects();
      await selectProject(project.id);
      setStatus("Added " + project.name, "ok");
    } catch (error) {
      toast("Could not add project", error.message);
    }
  }

  async function saveDefaultDir(path) {
    try {
      await api("/api/settings", {
        method: "POST",
        body: JSON.stringify({ defaultProjectDir: path }),
      });
    } catch {
      // A failure to remember the folder is not worth blocking the add.
    }
  }

  /** Restores the remembered projects folder so the picker reopens there. */
  async function loadSettings() {
    try {
      const settings = await api("/api/settings");
      if (settings.defaultProjectDir) {
        state.defaultProjectDir = settings.defaultProjectDir;
      }
    } catch {
      // Settings are a convenience; the app works without them.
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
    state.identity = ui.identityInput.value.trim();
    try {
      await api("/api/identity", {
        method: "POST",
        body: JSON.stringify({ label: state.identity }),
      });
    } catch {
      /* the label is also sent per request, so a failure here is not fatal */
    }
    if (state.questionnaire) await loadSaved();
  });

  ui.addProjectBtn.addEventListener("click", () => openPicker());

  // The projects folder: accept a pasted path, or pick one by browsing.
  ui.defaultDirPath.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      useDefaultDir();
    }
  });
  ui.defaultDirPath.addEventListener("change", () => useDefaultDir());
  ui.defaultDirBrowse.addEventListener("click", async () => {
    ui.browseBlock.hidden = false;
    ui.browseBlock.open = true;
    await browseInto(state.defaultProjectDir || "");
  });

  // Search-as-you-type over the cached results.
  ui.projectSearch.addEventListener("input", scheduleSearch);

  ui.pickerUp.addEventListener("click", async () => {
    const path = ui.pickerPath.value;
    const parent = path.replace(/\/[^/]*$/, "") || "/";
    await browseInto(parent);
  });
  // Typing or pasting a path should navigate, not just sit in the field: the
  // path box is the fastest route for someone who already knows the folder.
  ui.pickerPath.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      browseInto(ui.pickerPath.value.trim());
    }
  });
  ui.pickerPath.addEventListener("change", () => {
    browseInto(ui.pickerPath.value.trim());
  });
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
