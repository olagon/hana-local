// hana-local · a fully private, on-device task manager.
// All inference runs in the browser via WebGPU. All tasks live in IndexedDB.
// The one-time model download is the only network request this app makes.

import { dbGet, dbSet } from "./db.js";
import {
  pickerModels,
  hasWebGPU,
  loadEngine,
  engineReady,
  extractTasks,
  DEFAULT_MODEL,
} from "./llm.js";

const APP_VERSION = "0.6.0";

// ---------- date helpers (local time, Honolulu-safe) ----------
const pad = (n) => String(n).padStart(2, "0");
const toStr = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const todayStr = () => toStr(new Date());
const addDays = (str, n) => {
  const [y, m, d] = str.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + n);
  return toStr(dt);
};
const weekdayOf = (str) => {
  const [y, m, d] = str.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-US", { weekday: "long" });
};
const displayDate = (str) => {
  const t = todayStr();
  if (str === t) return "Today";
  if (str === addDays(t, 1)) return "Tomorrow";
  const [y, m, d] = str.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  const opts = { month: "short", day: "numeric" };
  if (y !== new Date().getFullYear()) opts.year = "numeric";
  return dt.toLocaleDateString("en-US", opts);
};
const isDateStr = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
const uid = () =>
  window.crypto && window.crypto.randomUUID
    ? window.crypto.randomUUID()
    : `t${Date.now()}${Math.floor(Math.random() * 1e6)}`;

// ---------- state ----------
let tasks = [];
let loaded = false;
let storageOk = true;
let busy = false;
let review = null; // { news: [...], updates: [...] }
let filter = null;
let tab = "active"; // "active" | "holding"
let editing = null; // { id, field }
let showPau = false;
let settings = { model: DEFAULT_MODEL, welcomeSeen: false };

// model status: "idle" | "loading" | "ready" | "unsupported" | "error"
let modelStatus = hasWebGPU() ? "idle" : "unsupported";

// ---------- dom ----------
const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

const pool = $("pool");
const makeBtn = $("makeBtn");
const reviewTray = $("reviewTray");
const errBox = $("errBox");
const errMsg = $("errMsg");
const bucketsEl = $("buckets");
const emptyMsg = $("emptyMsg");
const chipsEl = $("chips");
const pauSection = $("pauSection");
const pauList = $("pauList");
const pauToggle = $("pauToggle");
const pauClear = $("pauClear");
const toastEl = $("toast");
const modelBadge = $("modelBadge");
const modelSelect = $("modelSelect");
const modelNote = $("modelNote");
const progressWrap = $("modelProgressWrap");
const progressBar = $("modelProgressBar");
const progressText = $("modelProgressText");

// ---------- analytics ----------
// Counts only, never content: no task text, titles, notes, projects, or
// dates ever ride along. Safe no-op when gtag is absent (offline, blocked).
function track(name, params) {
  if (typeof window.gtag === "function") {
    try {
      window.gtag("event", name, params || {});
    } catch (e) {
      // analytics must never break the app
    }
  }
}

// ---------- toast ----------
let toastTimer = null;
function say(msg) {
  toastEl.textContent = msg;
  toastEl.hidden = false;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastEl.hidden = true;
  }, 3500);
}

// ---------- persistence ----------
// Writes are serialized and always flush the latest snapshot, so rapid
// actions (deleting several tasks quickly) can't interleave or clobber.
let pendingWrite = null;
let writing = false;
function persist() {
  pendingWrite = tasks;
  if (writing) return;
  writing = true;
  (async () => {
    try {
      while (pendingWrite) {
        const snapshot = pendingWrite;
        pendingWrite = null;
        await dbSet("tasks", snapshot);
      }
      setStorageOk(true);
    } catch (e) {
      setStorageOk(false);
    } finally {
      writing = false;
    }
  })();
}

function setStorageOk(ok) {
  storageOk = ok;
  $("storageWarn").hidden = ok;
}

function mutate(next) {
  tasks = typeof next === "function" ? next(tasks) : next;
  persist();
  renderAll();
}

async function saveSettings() {
  try {
    await dbSet("settings", settings);
  } catch (e) {
    // settings are conveniences; losing them is harmless
  }
}

// ---------- derived ----------
const open = () => tasks.filter((t) => !t.done);
const activeOpen = () => open().filter((t) => !t.holding);
const heldOpen = () => open().filter((t) => t.holding);
const pauTasks = () =>
  tasks
    .filter((t) => t.done)
    .sort((a, b) => (b.completedAt || "").localeCompare(a.completedAt || ""));
const projectNames = () => {
  const s = new Set();
  tasks.forEach((t) => t.project && s.add(t.project));
  return Array.from(s).sort();
};
const visibleTasks = () => {
  const list = tab === "holding" ? heldOpen() : activeOpen();
  return list.filter((t) => (filter ? t.project === filter : true));
};
const makeBuckets = () => {
  const t = todayStr();
  const tm = addDays(t, 1);
  const wk = addDays(t, 7);
  const sorted = [...visibleTasks()].sort(
    (a, b) => a.due.localeCompare(b.due) || (a.createdAt || "").localeCompare(b.createdAt || "")
  );
  return [
    { label: "Late", items: sorted.filter((x) => x.due < t) },
    { label: "Today", items: sorted.filter((x) => x.due === t) },
    { label: "Tomorrow", items: sorted.filter((x) => x.due === tm) },
    { label: "This week", items: sorted.filter((x) => x.due > tm && x.due <= wk) },
    { label: "Later", items: sorted.filter((x) => x.due > wk) },
  ].filter((b) => b.items.length > 0);
};

// ---------- model bar ----------
function populateModelPicker() {
  const models = pickerModels();
  modelSelect.innerHTML = "";
  models.forEach((m) => {
    const opt = document.createElement("option");
    opt.value = m.id;
    opt.textContent = m.label;
    modelSelect.appendChild(opt);
  });
  if (models.some((m) => m.id === settings.model)) {
    modelSelect.value = settings.model;
  } else if (models.length) {
    settings.model = models[0].id;
    modelSelect.value = settings.model;
  }
  renderModelBar();
}

function currentModelChoice() {
  return pickerModels().find((m) => m.id === settings.model) || null;
}

function renderModelBar() {
  modelBadge.classList.remove("ready", "bad");
  const choice = currentModelChoice();
  if (modelStatus === "unsupported") {
    modelBadge.textContent = "this browser can't run the model";
    modelBadge.classList.add("bad");
    modelNote.textContent =
      "This browser doesn't offer WebGPU, which hana-local needs to run the model on your device. " +
      "Try a current Chrome, Edge, or Safari. Everything else still works. Press Make tasks and " +
      "add the task by hand in the box that appears, and your list stays private either way.";
    progressWrap.hidden = true;
  } else if (modelStatus === "ready" && engineReady(settings.model)) {
    modelBadge.textContent = "✓ running locally";
    modelBadge.classList.add("ready");
    modelNote.textContent = "";
    progressWrap.hidden = true;
  } else if (modelStatus === "loading") {
    modelBadge.textContent = "loading model…";
    progressWrap.hidden = false;
  } else if (modelStatus === "error") {
    modelBadge.textContent = "model failed to load";
    modelBadge.classList.add("bad");
    progressWrap.hidden = true;
    modelNote.textContent = "";
    modelNote.appendChild(
      document.createTextNode(
        "The model couldn't load. Check your connection or free up memory, pick a smaller model above, or "
      )
    );
    const retry = el("button", "linklike", "try again");
    retry.addEventListener("click", () => {
      modelStatus = "idle";
      renderModelBar();
      ensureEngine()
        .then(() => say("Model ready"))
        .catch(() => {});
    });
    modelNote.appendChild(retry);
    modelNote.appendChild(document.createTextNode("."));
  } else {
    modelBadge.textContent = "model starting…";
    modelNote.textContent = choice ? choice.note : "";
    progressWrap.hidden = true;
  }
  modelSelect.disabled = modelStatus === "loading";
}

async function ensureEngine() {
  if (modelStatus === "unsupported") throw new Error("webgpu missing");
  if (engineReady(settings.model)) return;
  modelStatus = "loading";
  renderModelBar();
  try {
    await loadEngine(settings.model, ({ progress, text }) => {
      const pct = Math.round((progress || 0) * 100);
      progressBar.style.width = `${pct}%`;
      progressText.textContent = text || `${pct}%`;
    });
    modelStatus = "ready";
    track("model_ready", { model_id: settings.model });
  } catch (e) {
    modelStatus = "error";
    throw e;
  } finally {
    renderModelBar();
  }
}

// Switching models acts immediately: the newly picked model loads (and, for
// the CDN alternates, downloads) right now, not at the next extraction.
modelSelect.addEventListener("change", async () => {
  settings.model = modelSelect.value;
  await saveSettings();
  if (modelStatus === "ready" || modelStatus === "error") modelStatus = "idle";
  renderModelBar();
  try {
    await ensureEngine();
    say("Model ready");
  } catch (e) {
    // renderModelBar already shows the error state
  }
});

// ---------- extraction ----------
// Showing an error also arms the manual fallback: title prefilled from the
// pool, date defaulting to tomorrow, so a model problem never blocks the
// user from landing the task by hand.
function setErr(msg) {
  errMsg.textContent = msg;
  errBox.hidden = !msg;
  if (msg) {
    const text = pool.value.trim();
    $("manualTitle").value = text.length > 80 ? text.slice(0, 77) + "..." : text;
    $("manualDate").value = addDays(todayStr(), 1);
  }
}

// The exact text the open review tray was built from. ⌘↵ only accepts the
// review when the pool still holds this text; if the user rewrote the box,
// their new words win and a fresh extraction runs instead.
let lastExtractedText = null;

async function extract() {
  const text = pool.value.trim();
  if (!text || busy) return;
  busy = true;
  setErr("");
  review = null;
  lastExtractedText = text;
  renderThinking(
    engineReady(settings.model) ? "Reading your text…" : "Loading the model, then reading…"
  );
  makeBtn.textContent = "Reading…";
  makeBtn.disabled = true;

  const t = todayStr();
  const openList = open().map(({ id, title, project, due, holding }) => ({
    id, title, project, due, holding: !!holding,
  }));

  try {
    await ensureEngine();
    setThinkingLabel("Reading your text…");
    makeBtn.textContent = "Reading…";
    const parsed = await extractTasks({
      text: text.slice(0, 8000),
      openList,
      projects: projectNames(),
      today: t,
      weekday: weekdayOf(t),
    });

    // Grammar enforces the shape; this still validates values in code.
    const openTitles = new Set(open().map((x) => x.title.trim().toLowerCase()));
    const news = (Array.isArray(parsed.new_tasks) ? parsed.new_tasks : [])
      .filter((n) => n && typeof n.title === "string" && n.title.trim())
      .filter((n) => !openTitles.has(n.title.trim().toLowerCase()))
      .map((n) => {
        const holding = n.holding === true;
        // active tasks never sit in the past; tank tasks keep the given date
        let due = isDateStr(n.due) ? n.due : t;
        if (!holding && due < t) due = t;
        return {
          title: n.title.trim(),
          project: typeof n.project === "string" && n.project.trim() ? n.project.trim() : null,
          notes: typeof n.notes === "string" ? n.notes.trim() : "",
          due,
          holding,
          checked: true,
        };
      });

    const byId = new Map(open().map((x) => [x.id, x]));
    const updates = (Array.isArray(parsed.updates) ? parsed.updates : [])
      .filter((u) => u && byId.has(u.id))
      .map((u) => {
        const target = byId.get(u.id);
        const changes = {};
        if (typeof u.title === "string" && u.title.trim() && u.title.trim() !== target.title)
          changes.title = u.title.trim();
        const willHold = typeof u.holding === "boolean" ? u.holding : !!target.holding;
        if (isDateStr(u.due) && u.due !== target.due) changes.due = !willHold && u.due < t ? t : u.due;
        if (typeof u.project === "string" && u.project.trim() && u.project.trim() !== target.project)
          changes.project = u.project.trim();
        if (typeof u.notes === "string" && u.notes.trim() && u.notes.trim() !== target.notes)
          changes.notes = u.notes.trim();
        if (typeof u.holding === "boolean" && u.holding !== !!target.holding) changes.holding = u.holding;
        return { id: u.id, target, changes, checked: true };
      })
      .filter((u) => Object.keys(u.changes).length > 0);

    review = { news, updates };
    renderReview();
  } catch (e) {
    review = null;
    renderReview();
    if (modelStatus === "unsupported") {
      setErr("This browser can't run the model, so nothing was read. Add the task yourself:");
    } else if (modelStatus === "error") {
      setErr("The model couldn't load, so nothing was read. Add the task yourself, or pick another model above and try again:");
    } else {
      setErr("Couldn't finish reading that. Try again, paste a smaller chunk, or add the task yourself:");
    }
  } finally {
    busy = false;
    makeBtn.textContent = "Make tasks";
    makeBtn.disabled = !pool.value.trim();
  }
}

function applyReview() {
  if (!review) return;
  const t = todayStr();
  const now = new Date().toISOString();
  const chosenNew = review.news
    .filter((n) => n.checked && typeof n.title === "string" && n.title.trim())
    .map((n) => ({
      id: uid(),
      title: n.title.trim(),
      project: typeof n.project === "string" && n.project.trim() ? n.project.trim() : null,
      notes: n.notes,
      due: isDateStr(n.due) ? n.due : t,
      holding: !!n.holding,
      done: false,
      createdAt: now,
      completedAt: null,
    }));
  const chosenUpdates = new Map(
    review.updates.filter((u) => u.checked).map((u) => [u.id, u.changes])
  );
  const next = tasks.map((tk) =>
    chosenUpdates.has(tk.id) ? { ...tk, ...chosenUpdates.get(tk.id) } : tk
  );
  review = null;
  pool.value = "";
  pool.style.height = "auto";
  mutate([...next, ...chosenNew]);
  renderReview();
  makeBtn.disabled = true;
  const parts = [];
  if (chosenNew.length) parts.push(`Added ${chosenNew.length}`);
  if (chosenUpdates.size) parts.push(`updated ${chosenUpdates.size}`);
  say(parts.length ? parts.join(" · ") : "Nothing added");
  if (chosenNew.length || chosenUpdates.size) {
    track("tasks_added", {
      count: chosenNew.length,
      updated: chosenUpdates.size,
      method: "extract",
      model_id: settings.model,
    });
  }
}

function manualAdd() {
  const title = $("manualTitle").value.trim();
  if (!title) {
    $("manualTitle").focus();
    return;
  }
  const dateVal = $("manualDate").value;
  const now = new Date().toISOString();
  mutate([
    ...tasks,
    {
      id: uid(),
      title,
      project: null,
      notes: "",
      due: isDateStr(dateVal) ? dateVal : addDays(todayStr(), 1),
      holding: tab === "holding",
      done: false,
      createdAt: now,
      completedAt: null,
    },
  ]);
  pool.value = "";
  pool.style.height = "auto";
  setErr("");
  makeBtn.disabled = true;
  say("Added 1 task");
  track("tasks_added", { count: 1, method: "manual" });
}

// ---------- task actions ----------
function toggleDone(id) {
  const now = new Date().toISOString();
  mutate((prev) =>
    prev.map((tk) =>
      tk.id === id ? { ...tk, done: !tk.done, completedAt: tk.done ? null : now } : tk
    )
  );
}
const removeTask = (id) => mutate((prev) => prev.filter((tk) => tk.id !== id));
const setField = (id, field, value) =>
  mutate((prev) => prev.map((tk) => (tk.id === id ? { ...tk, [field]: value } : tk)));
function moveHolding(id, toHolding) {
  mutate((prev) => prev.map((tk) => (tk.id === id ? { ...tk, holding: toHolding } : tk)));
  say(toHolding ? "Moved to Holding Tank" : "Moved to Active");
}
function clearPau() {
  showPau = false;
  mutate((prev) => prev.filter((tk) => !tk.done));
  say("Cleared pau");
}

// ---------- export / import ----------
function exportData() {
  if (tasks.length === 0) {
    say("Nothing to export yet");
    return;
  }
  const payload = JSON.stringify(
    { app: "hana-local", exportedAt: new Date().toISOString(), tasks },
    null,
    2
  );
  const blob = new Blob([payload], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `hana-local-backup-${todayStr()}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  say(`Exported ${tasks.length} ${tasks.length === 1 ? "task" : "tasks"}`);
}

async function importData(e) {
  const file = e.target.files && e.target.files[0];
  e.target.value = "";
  if (!file) return;
  try {
    const text = await file.text();
    const parsed = JSON.parse(text);
    const incoming = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed.tasks)
      ? parsed.tasks
      : null;
    if (!incoming) throw new Error("bad file");
    const t = todayStr();
    const prevById = new Map(tasks.map((tk) => [tk.id, tk]));
    const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
    // For a task we already have, the file wins on any field it actually
    // carries, and we keep our current value for fields the file leaves out.
    const build = (x) => {
      const id = typeof x.id === "string" && x.id ? x.id : uid();
      const prev = prevById.get(id);
      const done = has(x, "done") ? !!x.done : !!(prev && prev.done);
      const holding = has(x, "holding") ? x.holding === true : !!(prev && prev.holding);
      const due = isDateStr(x.due) ? x.due : prev && isDateStr(prev.due) ? prev.due : t;
      return {
        id,
        title: x.title.trim(),
        project:
          typeof x.project === "string" && x.project.trim()
            ? x.project.trim()
            : prev
            ? prev.project
            : null,
        notes: typeof x.notes === "string" ? x.notes : prev ? prev.notes : "",
        due,
        holding,
        done,
        createdAt:
          typeof x.createdAt === "string"
            ? x.createdAt
            : prev && prev.createdAt
            ? prev.createdAt
            : new Date().toISOString(),
        completedAt: done
          ? typeof x.completedAt === "string"
            ? x.completedAt
            : prev && prev.completedAt
            ? prev.completedAt
            : new Date().toISOString()
          : null,
      };
    };
    const builtById = new Map();
    incoming
      .filter((x) => x && typeof x.title === "string" && x.title.trim())
      .forEach((x) => {
        const b = build(x);
        builtById.set(b.id, b);
      });
    let updated = 0;
    const next = tasks.map((tk) => {
      if (builtById.has(tk.id)) {
        updated += 1;
        return builtById.get(tk.id);
      }
      return tk;
    });
    const brandNew = [];
    builtById.forEach((b, id) => {
      if (!prevById.has(id)) brandNew.push(b);
    });
    if (brandNew.length === 0 && updated === 0) {
      say("Nothing to import");
      return;
    }
    mutate([...next, ...brandNew]);
    const parts = [];
    if (brandNew.length) parts.push(`Imported ${brandNew.length}`);
    if (updated) parts.push(`updated ${updated}`);
    say(parts.join(" · "));
    track("tasks_added", { count: brandNew.length, updated, method: "import" });
  } catch (err) {
    say("Couldn't read that file");
  }
}

// ---------- rendering ----------
function renderHeader() {
  $("openCount").textContent = loaded ? `${open().length} open` : "loading";
}

function renderTabs() {
  const a = $("tabActive");
  const h = $("tabHolding");
  a.textContent = `Active · ${activeOpen().length}`;
  h.textContent = `Holding Tank · ${heldOpen().length}`;
  a.classList.toggle("on", tab === "active");
  h.classList.toggle("on", tab === "holding");
  a.setAttribute("aria-selected", tab === "active");
  h.setAttribute("aria-selected", tab === "holding");
}

function renderChips() {
  const projects = projectNames();
  chipsEl.hidden = projects.length === 0;
  chipsEl.innerHTML = "";
  if (projects.length === 0) {
    if (filter) filter = null;
    return;
  }
  if (filter && !projects.includes(filter)) filter = null;
  [null, ...projects].forEach((p) => {
    const b = el("button", "chip" + (filter === p ? " on" : ""), p || "All");
    b.addEventListener("click", () => {
      filter = p;
      renderAll();
    });
    chipsEl.appendChild(b);
  });
}

function renderDatalist() {
  const dl = $("hana-projects");
  dl.innerHTML = "";
  projectNames().forEach((p) => {
    const o = document.createElement("option");
    o.value = p;
    dl.appendChild(o);
  });
}

function taskRow(t) {
  const late = !t.done && isDateStr(t.due) && t.due < todayStr();
  const row = el("div", "row" + (late ? " late" : ""));

  // done circle
  const circle = el("button", "circle" + (t.done ? " done" : ""));
  circle.setAttribute("aria-label", t.done ? "Mark not done" : "Mark done");
  if (t.done) {
    circle.innerHTML =
      '<svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="M2.5 6.5L5 9L9.5 3.5" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  }
  circle.addEventListener("click", () => toggleDone(t.id));
  row.appendChild(circle);

  const main = el("div", "row-main");

  // title
  if (editing && editing.id === t.id && editing.field === "title") {
    const inp = el("input", "row-title-input");
    inp.value = t.title;
    inp.setAttribute("aria-label", "Task title");
    const commit = () => {
      const v = inp.value.trim();
      editing = null;
      if (v && v !== t.title) setField(t.id, "title", v);
      else renderAll();
    };
    inp.addEventListener("blur", commit);
    inp.addEventListener("keydown", (e) => {
      if (e.key === "Enter") commit();
      if (e.key === "Escape") {
        editing = null;
        renderAll();
      }
    });
    main.appendChild(inp);
    setTimeout(() => inp.focus(), 0);
  } else {
    const title = el("div", "row-title" + (t.done ? " done" : ""), t.title);
    if (!t.done) {
      title.title = "Click to edit";
      title.addEventListener("click", () => {
        editing = { id: t.id, field: "title" };
        renderAll();
      });
    }
    main.appendChild(title);
  }

  if (t.notes) main.appendChild(el("div", "row-notes", t.notes));

  const meta = el("div", "row-meta");

  // date pill
  if (!t.done) {
    if (editing && editing.id === t.id && editing.field === "due") {
      const inp = el("input", "date-input");
      inp.type = "date";
      inp.value = t.due;
      inp.setAttribute("aria-label", "Due date");
      inp.addEventListener("change", () => {
        if (isDateStr(inp.value)) {
          editing = null;
          setField(t.id, "due", inp.value);
        }
      });
      inp.addEventListener("blur", () => {
        editing = null;
        renderAll();
      });
      meta.appendChild(inp);
      setTimeout(() => inp.focus(), 0);
    } else {
      const pill = el(
        "button",
        "date-pill" + (late ? " late" : t.due === todayStr() ? " today" : ""),
        displayDate(t.due)
      );
      pill.title = "Change date";
      pill.addEventListener("click", () => {
        editing = { id: t.id, field: "due" };
        renderAll();
      });
      meta.appendChild(pill);
    }
  }

  // project chip
  if (editing && editing.id === t.id && editing.field === "project") {
    const inp = el("input", "project-input");
    inp.value = t.project || "";
    inp.placeholder = "project";
    inp.setAttribute("list", "hana-projects");
    inp.setAttribute("aria-label", "Project");
    const commit = () => {
      const v = inp.value.trim();
      editing = null;
      setField(t.id, "project", v || null);
    };
    inp.addEventListener("blur", commit);
    inp.addEventListener("keydown", (e) => {
      if (e.key === "Enter") commit();
      if (e.key === "Escape") {
        editing = null;
        renderAll();
      }
    });
    meta.appendChild(inp);
    setTimeout(() => inp.focus(), 0);
  } else {
    const chip = el(
      "button",
      "project-chip" + (t.project ? " set" : ""),
      t.project || "+ project"
    );
    chip.title = t.project ? "Change project" : "Add to a project";
    if (!t.done) {
      chip.addEventListener("click", () => {
        editing = { id: t.id, field: "project" };
        renderAll();
      });
    }
    meta.appendChild(chip);
  }

  // move to/from tank
  if (!t.done) {
    const mv = el("button", "move-btn", t.holding ? "← Active" : "→ Tank");
    mv.title = t.holding ? "Move back to Active" : "Move to Holding Tank";
    mv.addEventListener("click", () => moveHolding(t.id, !t.holding));
    meta.appendChild(mv);
  }

  main.appendChild(meta);
  row.appendChild(main);

  const del = el("button", "del-btn", "×");
  del.setAttribute("aria-label", "Delete task");
  del.title = "Delete";
  del.addEventListener("click", () => removeTask(t.id));
  row.appendChild(del);

  return row;
}

function renderList() {
  bucketsEl.innerHTML = "";
  const vis = visibleTasks();
  const held = heldOpen();
  const act = activeOpen();

  if (loaded && vis.length === 0 && !review) {
    emptyMsg.hidden = false;
    emptyMsg.textContent =
      tab === "holding"
        ? held.length === 0
          ? "The Holding Tank is empty. Send tasks here with → Tank, or let hana-local sort them in."
          : "Nothing in the tank for this project."
        : act.length === 0
        ? "Nothing here yet. Paste anything above and hana-local will pull out the tasks."
        : "Nothing open in this project.";
  } else {
    emptyMsg.hidden = true;
  }

  makeBuckets().forEach((b) => {
    const wrap = el("div", "bucket");
    const head = el(
      "div",
      "bucket-head" + (b.label === "Late" ? " late" : ""),
      `${b.label} · ${b.items.length}`
    );
    wrap.appendChild(head);
    b.items.forEach((t) => wrap.appendChild(taskRow(t)));
    bucketsEl.appendChild(wrap);
  });
}

function renderPau() {
  const list = pauTasks();
  pauSection.hidden = !(tab === "active" && list.length > 0);
  if (pauSection.hidden) return;
  pauToggle.textContent = `${showPau ? "▾" : "▸"} Pau · ${list.length}`;
  pauClear.hidden = !showPau;
  pauList.innerHTML = "";
  if (showPau) list.forEach((t) => pauList.appendChild(taskRow(t)));
}

// Fills the review tray with a live "reading" state the moment extraction
// starts, so it is obvious something is happening and where results land.
function renderThinking(label) {
  reviewTray.hidden = false;
  reviewTray.innerHTML = "";
  const row = el("div", "thinking");
  row.setAttribute("role", "status");
  row.appendChild(el("span", "thinking-label", label));
  const dots = el("span", "thinking-dots");
  dots.setAttribute("aria-hidden", "true");
  for (let i = 0; i < 3; i++) dots.appendChild(el("span"));
  row.appendChild(dots);
  reviewTray.appendChild(row);
}

function setThinkingLabel(text) {
  const label = reviewTray.querySelector(".thinking-label");
  if (label) label.textContent = text;
}

function reviewKeyHandler(e) {
  if (e.key === "Enter") {
    e.preventDefault();
    applyReview();
  }
}

function renderReview() {
  if (!review) {
    reviewTray.hidden = true;
    reviewTray.innerHTML = "";
    return;
  }
  reviewTray.hidden = false;
  reviewTray.innerHTML = "";

  if (review.news.length === 0 && review.updates.length === 0) {
    const box = el("div", "review-empty");
    box.appendChild(el("span", null, "No clear tasks in that. Nothing was added."));
    const ok = el("button", "subtle-btn", "OK");
    ok.addEventListener("click", () => {
      review = null;
      renderReview();
    });
    box.appendChild(ok);
    reviewTray.appendChild(box);
    return;
  }

  const head = el(
    "div",
    "review-head",
    `Found ${review.news.length} new` +
      (review.updates.length > 0
        ? ` · ${review.updates.length} update${review.updates.length > 1 ? "s" : ""}`
        : "")
  );
  reviewTray.appendChild(head);

  review.news.forEach((n) => {
    const row = el("div", "review-row");

    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = n.checked;
    cb.setAttribute("aria-label", "Include this task");
    cb.addEventListener("change", () => {
      n.checked = cb.checked;
      updateApplyCount();
    });
    row.appendChild(cb);

    const main = el("div", "review-main");

    const title = el("input", "review-title");
    title.value = n.title;
    title.setAttribute("aria-label", "Task title");
    title.addEventListener("input", () => (n.title = title.value));
    title.addEventListener("keydown", reviewKeyHandler);
    main.appendChild(title);

    const meta = el("div", "review-meta");

    const date = el("input", "review-date");
    date.type = "date";
    date.value = isDateStr(n.due) ? n.due : "";
    date.setAttribute("aria-label", "Due date");
    date.addEventListener("change", () => {
      if (isDateStr(date.value)) n.due = date.value;
    });
    date.addEventListener("keydown", reviewKeyHandler);
    meta.appendChild(date);

    const proj = el("input", "review-project");
    proj.value = n.project || "";
    proj.placeholder = "+ project";
    proj.setAttribute("list", "hana-projects");
    proj.setAttribute("aria-label", "Project");
    proj.addEventListener("input", () => {
      n.project = proj.value.trim() ? proj.value : null;
    });
    proj.addEventListener("keydown", reviewKeyHandler);
    meta.appendChild(proj);

    const place = el(
      "button",
      "review-place " + (n.holding ? "tank" : "active"),
      n.holding ? "Tank" : "Active"
    );
    place.type = "button";
    place.title = n.holding ? "Goes to the Holding Tank" : "Goes to Active";
    place.addEventListener("click", () => {
      n.holding = !n.holding;
      place.textContent = n.holding ? "Tank" : "Active";
      place.className = "review-place " + (n.holding ? "tank" : "active");
      place.title = n.holding ? "Goes to the Holding Tank" : "Goes to Active";
    });
    meta.appendChild(place);

    main.appendChild(meta);
    row.appendChild(main);
    reviewTray.appendChild(row);
  });

  review.updates.forEach((u) => {
    const label = el("label", "review-update");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = u.checked;
    cb.addEventListener("change", () => {
      u.checked = cb.checked;
      updateApplyCount();
    });
    label.appendChild(cb);
    const text = el("span", "u-text", `Update "${u.target.title}"`);
    const change = el("span", "u-change");
    change.textContent =
      (u.changes.due ? ` → ${displayDate(u.changes.due)}` : "") +
      (u.changes.title ? ` → "${u.changes.title}"` : "") +
      (u.changes.project ? ` → ${u.changes.project}` : "") +
      (u.changes.holding !== undefined ? (u.changes.holding ? " → Tank" : " → Active") : "");
    text.appendChild(change);
    label.appendChild(text);
    reviewTray.appendChild(label);
  });

  const foot = el("div", "review-foot");
  const discard = el("button", "subtle-btn", "Discard");
  discard.addEventListener("click", () => {
    review = null;
    renderReview();
  });
  foot.appendChild(discard);
  const apply = el("button", "primary-btn", "Add");
  apply.id = "applyBtn";
  apply.addEventListener("click", applyReview);
  foot.appendChild(apply);
  reviewTray.appendChild(foot);

  updateApplyCount();
  // keyboard flow: Enter accepts everything hana-local found
  setTimeout(() => apply.focus({ preventScroll: true }), 0);
}

function updateApplyCount() {
  const apply = $("applyBtn");
  if (!apply || !review) return;
  const n =
    review.news.filter((x) => x.checked).length +
    review.updates.filter((x) => x.checked).length;
  apply.textContent = `Add ${n}`;
}

function renderAll() {
  renderHeader();
  renderTabs();
  renderChips();
  renderDatalist();
  renderList();
  renderPau();
}

// ---------- models page ----------
function renderModelsPage() {
  const list = $("modelsList");
  list.innerHTML = "";
  pickerModels().forEach((m) => {
    const row = el("div", "model-row");
    const head = el("div", "model-row-head");
    head.appendChild(el("strong", null, m.label));
    if (m.id === settings.model) {
      head.appendChild(el("span", "model-chip", "in use"));
    } else {
      const use = el("button", "ghost-btn model-use", "Use this model");
      use.addEventListener("click", () => {
        modelSelect.value = m.id;
        modelSelect.dispatchEvent(new Event("change"));
        renderModelsPage();
      });
      head.appendChild(use);
    }
    row.appendChild(head);
    row.appendChild(el("p", "model-row-summary", m.summary || m.note));
    list.appendChild(row);
  });
}

// ---------- panels ----------
const panels = {
  models: { panel: $("modelsPanel"), link: $("navModels") },
  help: { panel: $("helpPanel"), link: $("navHelp") },
  privacy: { panel: $("privacyPanel"), link: $("navPrivacy") },
};
let openPanel = null;

function setPanel(name) {
  openPanel = openPanel === name ? null : name;
  if (openPanel === "models") renderModelsPage();
  Object.entries(panels).forEach(([key, { panel, link }]) => {
    const on = openPanel === key;
    panel.hidden = !on;
    link.classList.toggle("on", on);
    link.textContent = on ? "back to tasks" : key;
  });
  $("mainView").hidden = openPanel !== null;
  $("footTag").hidden = openPanel !== null;
}

$("navHelp").addEventListener("click", () => setPanel("help"));
$("navPrivacy").addEventListener("click", () => setPanel("privacy"));
$("navModels").addEventListener("click", () => setPanel("models"));

document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (openPanel) {
    setPanel(openPanel);
  } else if (review) {
    review = null;
    renderReview();
  }
});

// ---------- pool wiring ----------
pool.addEventListener("input", () => {
  pool.style.height = "auto";
  pool.style.height = Math.min(pool.scrollHeight, 320) + "px";
  makeBtn.disabled = !pool.value.trim() || busy;
});
pool.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
    e.preventDefault();
    // Accept the open review only if the box still shows the text it came
    // from. Rewritten text means the user wants a fresh read, not a silent
    // apply of the old one.
    if (review && pool.value.trim() === lastExtractedText) applyReview();
    else extract();
  }
});
makeBtn.addEventListener("click", extract);
$("manualAddBtn").addEventListener("click", manualAdd);
["manualTitle", "manualDate"].forEach((id) => {
  $(id).addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      manualAdd();
    }
  });
});

// ---------- pau / export / import wiring ----------
pauToggle.addEventListener("click", () => {
  showPau = !showPau;
  renderPau();
});
pauClear.addEventListener("click", clearPau);
$("exportBtn").addEventListener("click", exportData);
$("importBtn").addEventListener("click", () => $("importFile").click());
$("importFile").addEventListener("change", importData);
$("tabActive").addEventListener("click", () => {
  tab = "active";
  renderAll();
});
$("tabHolding").addEventListener("click", () => {
  tab = "holding";
  renderAll();
});

// ---------- splash ----------
function showSplash() {
  const splash = $("splash");
  splash.hidden = false;
  const card = $("splashCard");
  card.scrollTop = 0;
  $("splashBtn").focus({ preventScroll: true });
}
$("splashBtn").addEventListener("click", async () => {
  $("splash").hidden = true;
  settings.welcomeSeen = true;
  await saveSettings();
});

// ---------- service worker (offline app shell) ----------
if ("serviceWorker" in navigator && location.protocol !== "file:") {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch(() => {
      // offline install is a nicety; the app runs fine without it
    });
  });
}

// ---------- boot ----------
(async () => {
  $("appVersion").textContent = `v${APP_VERSION}`;
  // Ask the browser not to evict our storage: losing IndexedDB would lose
  // tasks, and losing the Cache API would force a full model re-download.
  if (navigator.storage && navigator.storage.persist) {
    navigator.storage.persist().catch(() => {});
  }
  try {
    const stored = await dbGet("tasks");
    if (Array.isArray(stored)) tasks = stored;
    const st = await dbGet("settings");
    if (st && typeof st === "object") settings = { ...settings, ...st };
  } catch (e) {
    setStorageOk(false);
  }
  // Dates never change on their own; only backfill a missing date so every
  // task still sorts into a bucket.
  const t = todayStr();
  tasks = tasks.map((tk) => (isDateStr(tk.due) ? tk : { ...tk, due: t }));
  loaded = true;
  populateModelPicker();
  renderAll();
  if (!settings.welcomeSeen) showSplash();
  // Load the model now, while the user reads the splash or types, so it is
  // ready before their first Make tasks — never triggered by typing.
  if (modelStatus === "idle") {
    ensureEngine().catch(() => {});
  }
})();
