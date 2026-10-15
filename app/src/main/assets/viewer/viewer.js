// PDF viewer built on PDF.js with a simple annotation layer.
//
// Each page is a <div class="page"> holding a <canvas> rendered by PDF.js and an
// <svg class="annotation-layer"> on top. The SVG uses the page's unscaled viewport
// (PDF points, origin top-left, y down) as its viewBox, so annotations are stored in
// zoom-independent coordinates and simply scale with the page.
//
// Annotation JSON (persisted per document through AndroidBridge):
//   { "version": 1,
//     "pages": { "<pageNumber>": [
//       { "id", "type": "ink",       "color", "width", "points": [[x, y], ...] },
//       { "id", "type": "highlight", "color", "rect": [x, y, w, h] },
//       { "id", "type": "note",      "color", "x", "y", "text" } ] } }

import * as pdfjsLib from "../pdfjs/build/pdf.min.mjs";

const PDFJS_BASE = new URL("../pdfjs/", import.meta.url);
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL("build/pdf.worker.min.mjs", PDFJS_BASE).href;

const SVG_NS = "http://www.w3.org/2000/svg";
const COLORS = ["#ef4444", "#2563eb", "#16a34a", "#f59e0b", "#111827"];
const HIGHLIGHT_OPACITY = 0.35;
const INK_WIDTH = 2;
const NOTE_SIZE = 18;
const ERASER_RADIUS_PX = 12;
const MIN_SCALE = 0.25;
const MAX_SCALE = 5;
const SAVE_DELAY_MS = 400;
const MAX_CANVAS_PIXELS = 16 * 1024 * 1024;

const $ = (sel) => document.querySelector(sel);
const viewerEl = $("#viewer");
const pagesEl = $("#pages");

const bridge = window.AndroidBridge ?? createBrowserBridge();

const state = {
  pdf: null,
  loadingTask: null,
  doc: null, // { url, id, name }
  pages: [], // { num, el, canvas, svg, width, height, pdfPage, renderTask, renderedScale }
  scale: 1,
  tool: "pan",
  color: COLORS[0],
  annotations: emptyAnnotations(),
  undoStack: [],
  saveTimer: 0,
};

// ---------------------------------------------------------------------------
// Bridge fallback so the viewer can also be tried in a desktop browser.

function createBrowserBridge() {
  const input = Object.assign(document.createElement("input"), { type: "file", accept: "application/pdf" });
  input.addEventListener("change", () => {
    const file = input.files[0];
    if (file) {
      window.viewer.openDocument({ url: URL.createObjectURL(file), id: `local-${file.name}`, name: file.name });
    }
    input.value = "";
  });
  const key = (id) => `annotations:${id}`;
  return {
    getInitialDocument: () => "",
    openFilePicker: () => input.click(),
    loadAnnotations: (id) => localStorage.getItem(key(id)) ?? "",
    saveAnnotations: (id, json) => localStorage.setItem(key(id), json),
  };
}

// ---------------------------------------------------------------------------
// Document loading

async function openDocument(doc) {
  flushSave();
  await closeDocument();
  state.doc = doc;
  $("#title").textContent = doc.name;
  setStatus("Loading…");

  const loadingTask = pdfjsLib.getDocument({
    url: doc.url,
    cMapUrl: new URL("cmaps/", PDFJS_BASE).href,
    cMapPacked: true,
    standardFontDataUrl: new URL("standard_fonts/", PDFJS_BASE).href,
    wasmUrl: new URL("wasm/", PDFJS_BASE).href,
    iccUrl: new URL("iccs/", PDFJS_BASE).href,
  });
  state.loadingTask = loadingTask;

  try {
    const pdf = await loadingTask.promise;
    if (state.loadingTask !== loadingTask) return; // superseded by another open
    state.pdf = pdf;
    state.annotations = loadAnnotations(doc.id);
    state.undoStack = [];
    updateUndoButton();

    for (let num = 1; num <= pdf.numPages; num++) {
      const pdfPage = await pdf.getPage(num);
      if (state.loadingTask !== loadingTask) return;
      state.pages.push(createPage(num, pdfPage));
    }
    state.scale = fitWidthScale();
    layoutPages();
    viewerEl.scrollTop = 0;
    updatePageLabel();
    setStatus(null);
  } catch (err) {
    if (state.loadingTask !== loadingTask) return;
    console.error(err);
    setStatus(`Could not open PDF: ${err.message ?? err}`);
  }
}

async function closeDocument() {
  for (const page of state.pages) {
    page.renderTask?.cancel();
    pageObserver.unobserve(page.el);
  }
  state.pages = [];
  pagesEl.replaceChildren();
  const task = state.loadingTask;
  state.loadingTask = null;
  state.pdf = null;
  if (task) await task.destroy().catch(() => {});
}

function createPage(num, pdfPage) {
  const viewport = pdfPage.getViewport({ scale: 1 });
  const el = document.createElement("div");
  el.className = "page";
  el.dataset.page = String(num);

  const canvas = document.createElement("canvas");
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.classList.add("annotation-layer");
  svg.setAttribute("viewBox", `0 0 ${viewport.width} ${viewport.height}`);
  svg.setAttribute("preserveAspectRatio", "none");
  el.append(canvas, svg);
  pagesEl.append(el);

  const page = {
    num, el, canvas, svg, pdfPage,
    width: viewport.width,
    height: viewport.height,
    renderTask: null,
    renderedScale: 0,
    renderingScale: 0,
    visible: false,
  };
  attachDrawingHandlers(page);
  redrawAnnotations(page);
  pageObserver.observe(el);
  return page;
}

// ---------------------------------------------------------------------------
// Rendering & zoom

const pageObserver = new IntersectionObserver((entries) => {
  for (const entry of entries) {
    const page = state.pages[Number(entry.target.dataset.page) - 1];
    if (!page) continue;
    page.visible = entry.isIntersecting;
    if (page.visible) renderPage(page);
    else releasePage(page);
  }
}, { root: viewerEl, rootMargin: "100% 0px" });

function layoutPages() {
  for (const page of state.pages) {
    page.el.style.width = `${Math.floor(page.width * state.scale)}px`;
    page.el.style.height = `${Math.floor(page.height * state.scale)}px`;
    if (page.visible) renderPage(page);
  }
  $("#zoom-fit").textContent = `${Math.round(state.scale * 100)}%`;
}

async function renderPage(page) {
  const scale = state.scale;
  if (page.renderedScale === scale || (page.renderTask && page.renderingScale === scale)) return;
  page.renderTask?.cancel();

  // Render at device resolution, but cap the canvas size to keep memory in check.
  const cssPixels = page.width * page.height * scale * scale;
  const dpr = window.devicePixelRatio || 1;
  const outputScale = Math.min(dpr, Math.sqrt(MAX_CANVAS_PIXELS / cssPixels));
  const viewport = page.pdfPage.getViewport({ scale: scale * outputScale });
  // An offscreen canvas avoids flashing a blank page while re-rendering at a new zoom.
  const canvas = document.createElement("canvas");
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);

  const task = page.pdfPage.render({ canvas, viewport });
  page.renderTask = task;
  page.renderingScale = scale;
  try {
    await task.promise;
  } catch (err) {
    if (err?.name !== "RenderingCancelledException") console.error(err);
    return;
  } finally {
    if (page.renderTask === task) page.renderTask = null;
  }
  page.canvas.replaceWith(canvas);
  page.canvas = canvas;
  page.renderedScale = scale;
}

function releasePage(page) {
  page.renderTask?.cancel();
  page.canvas.width = 0;
  page.canvas.height = 0;
  page.renderedScale = 0;
}

function fitWidthScale() {
  const first = state.pages[0];
  if (!first) return 1;
  return clampScale((viewerEl.clientWidth - 16) / first.width);
}

function clampScale(scale) {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
}

function setScale(scale) {
  scale = clampScale(scale);
  if (scale === state.scale || !state.pages.length) return;
  // Keep the point at the centre of the screen in place.
  const cx = (viewerEl.scrollLeft + viewerEl.clientWidth / 2) / pagesEl.scrollWidth;
  const cy = (viewerEl.scrollTop + viewerEl.clientHeight / 2) / pagesEl.scrollHeight;
  state.scale = scale;
  layoutPages();
  viewerEl.scrollLeft = cx * pagesEl.scrollWidth - viewerEl.clientWidth / 2;
  viewerEl.scrollTop = cy * pagesEl.scrollHeight - viewerEl.clientHeight / 2;
}

function currentPageNumber() {
  const probe = viewerEl.scrollTop + viewerEl.clientHeight / 3;
  for (const page of state.pages) {
    if (page.el.offsetTop + page.el.offsetHeight > probe) return page.num;
  }
  return state.pages.length;
}

function updatePageLabel() {
  $("#page-label").textContent = state.pages.length ? `${currentPageNumber()} / ${state.pages.length}` : "";
}

// ---------------------------------------------------------------------------
// Annotation model

function emptyAnnotations() {
  return { version: 1, pages: {} };
}

function loadAnnotations(id) {
  try {
    const json = bridge.loadAnnotations(id);
    if (json) {
      const data = JSON.parse(json);
      if (data && data.version === 1 && typeof data.pages === "object") return data;
    }
  } catch (err) {
    console.error("Failed to load annotations", err);
  }
  return emptyAnnotations();
}

function scheduleSave() {
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(flushSave, SAVE_DELAY_MS);
}

function flushSave() {
  if (!state.saveTimer) return;
  clearTimeout(state.saveTimer);
  state.saveTimer = 0;
  if (!state.doc) return;
  try {
    bridge.saveAnnotations(state.doc.id, JSON.stringify(state.annotations));
  } catch (err) {
    console.error(err);
    setStatus("Failed to save annotations");
  }
}

function pageAnnotations(num) {
  return (state.annotations.pages[num] ??= []);
}

let nextId = 0;
function newId() {
  return `${Date.now().toString(36)}-${(nextId++).toString(36)}`;
}

/** Applies a change, records its inverse for undo, and persists. */
function commit(change) {
  applyChange(change);
  state.undoStack.push(change);
  updateUndoButton();
}

function applyChange(change, undo = false) {
  const list = pageAnnotations(change.page);
  switch (change.op) {
    case "add":
      if (undo) removeById(list, change.annotation.id);
      else list.push(change.annotation);
      break;
    case "remove":
      if (undo) list.splice(Math.min(change.index, list.length), 0, change.annotation);
      else removeById(list, change.annotation.id);
      break;
    case "update":
      Object.assign(list.find((a) => a.id === change.id) ?? {}, undo ? change.before : change.after);
      break;
    case "clear":
      if (undo) Object.assign(state.annotations.pages, structuredClone(change.before));
      else state.annotations.pages = {};
      break;
  }
  if (change.op === "clear") state.pages.forEach(redrawAnnotations);
  else redrawAnnotations(state.pages[change.page - 1]);
  scheduleSave();
}

function removeById(list, id) {
  const i = list.findIndex((a) => a.id === id);
  if (i >= 0) list.splice(i, 1);
}

function undo() {
  const change = state.undoStack.pop();
  if (change) applyChange(change, true);
  updateUndoButton();
}

function updateUndoButton() {
  $("#undo").disabled = state.undoStack.length === 0;
}

// ---------------------------------------------------------------------------
// Annotation rendering (SVG)

function redrawAnnotations(page) {
  if (!page) return;
  page.svg.replaceChildren(...(state.annotations.pages[page.num] ?? []).map(annotationElement));
}

function annotationElement(a) {
  let el;
  switch (a.type) {
    case "ink":
      el = svgEl("path", { class: "ink", d: inkPath(a.points), stroke: a.color, "stroke-width": a.width });
      break;
    case "highlight": {
      const [x, y, width, height] = a.rect;
      el = svgEl("rect", { class: "highlight", x, y, width, height, fill: a.color, "fill-opacity": HIGHLIGHT_OPACITY });
      break;
    }
    case "note":
      el = svgEl("g", { class: "note", transform: `translate(${a.x} ${a.y})` });
      el.append(
        svgEl("rect", { x: 0, y: 0, width: NOTE_SIZE, height: NOTE_SIZE, rx: 3, fill: a.color }),
        Object.assign(svgEl("text", { x: NOTE_SIZE / 2, y: 13, "text-anchor": "middle" }), { textContent: "N" }),
      );
      el.append(Object.assign(svgEl("title"), { textContent: a.text }));
      break;
    default:
      return svgEl("g");
  }
  el.dataset.id = a.id;
  return el;
}

function svgEl(name, attrs = {}) {
  const el = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

function inkPath(points) {
  if (!points.length) return "";
  const [first, ...rest] = points;
  // A single tap still produces a visible dot thanks to the round line cap.
  if (!rest.length) return `M${first[0]} ${first[1]}l0 0`;
  return `M${first[0]} ${first[1]}` + rest.map(([x, y]) => `L${x} ${y}`).join("");
}

// ---------------------------------------------------------------------------
// Pointer interaction

function toPagePoint(page, event) {
  const rect = page.svg.getBoundingClientRect();
  return [
    round2(((event.clientX - rect.left) / rect.width) * page.width),
    round2(((event.clientY - rect.top) / rect.height) * page.height),
  ];
}

function round2(v) {
  return Math.round(v * 100) / 100;
}

function attachDrawingHandlers(page) {
  let gesture = null;

  page.svg.addEventListener("pointerdown", (event) => {
    // Tapping a note opens it, whichever tool is active (except the eraser).
    const noteEl = event.target.closest?.(".note");
    if (noteEl && state.tool !== "eraser") {
      event.preventDefault();
      editNote(page, noteEl.dataset.id);
      return;
    }
    if (state.tool === "pan" || !event.isPrimary) return;
    event.preventDefault();
    page.svg.setPointerCapture(event.pointerId);
    const point = toPagePoint(page, event);

    switch (state.tool) {
      case "pen": {
        const annotation = { id: newId(), type: "ink", color: state.color, width: INK_WIDTH, points: [point] };
        const el = annotationElement(annotation);
        page.svg.append(el);
        gesture = { annotation, el };
        break;
      }
      case "highlight": {
        const annotation = { id: newId(), type: "highlight", color: state.color, rect: [point[0], point[1], 0, 0] };
        const el = annotationElement(annotation);
        page.svg.append(el);
        gesture = { annotation, el, start: point };
        break;
      }
      case "note":
        createNote(page, point);
        break;
      case "eraser":
        gesture = { erasing: true };
        eraseAt(page, event);
        break;
    }
  });

  page.svg.addEventListener("pointermove", (event) => {
    if (!gesture || !event.isPrimary) return;
    const events = event.getCoalescedEvents?.() ?? [event];
    if (gesture.erasing) {
      events.forEach((e) => eraseAt(page, e));
      return;
    }
    const a = gesture.annotation;
    if (a.type === "ink") {
      const minDist = 1 / state.scale; // ~1 screen px
      for (const e of events) {
        const p = toPagePoint(page, e);
        const last = a.points[a.points.length - 1];
        if (Math.hypot(p[0] - last[0], p[1] - last[1]) >= minDist) a.points.push(p);
      }
      gesture.el.setAttribute("d", inkPath(a.points));
    } else if (a.type === "highlight") {
      const p = toPagePoint(page, event);
      const [sx, sy] = gesture.start;
      a.rect = [Math.min(sx, p[0]), Math.min(sy, p[1]), Math.abs(p[0] - sx), Math.abs(p[1] - sy)];
      const [x, y, width, height] = a.rect;
      Object.entries({ x, y, width, height }).forEach(([k, v]) => gesture.el.setAttribute(k, v));
    }
  });

  const finish = (event) => {
    if (!gesture || !event.isPrimary) return;
    const g = gesture;
    gesture = null;
    if (g.erasing) return;
    g.el.remove();
    const a = g.annotation;
    // Ignore accidental taps with the highlighter.
    if (a.type === "highlight" && (a.rect[2] < 2 || a.rect[3] < 2)) return;
    if (event.type === "pointercancel") return;
    commit({ op: "add", page: page.num, annotation: a });
  };
  page.svg.addEventListener("pointerup", finish);
  page.svg.addEventListener("pointercancel", finish);
}

function eraseAt(page, event) {
  const [x, y] = toPagePoint(page, event);
  const r = ERASER_RADIUS_PX / state.scale;
  const list = pageAnnotations(page.num);
  for (let i = list.length - 1; i >= 0; i--) {
    if (hitTest(list[i], x, y, r)) {
      commit({ op: "remove", page: page.num, annotation: list[i], index: i });
    }
  }
}

function hitTest(a, x, y, r) {
  switch (a.type) {
    case "ink": {
      const reach = r + a.width / 2;
      const pts = a.points;
      if (pts.length === 1) return Math.hypot(pts[0][0] - x, pts[0][1] - y) <= reach;
      for (let i = 1; i < pts.length; i++) {
        if (distToSegment(x, y, pts[i - 1], pts[i]) <= reach) return true;
      }
      return false;
    }
    case "highlight": {
      const [rx, ry, w, h] = a.rect;
      return x >= rx - r && x <= rx + w + r && y >= ry - r && y <= ry + h + r;
    }
    case "note":
      return x >= a.x - r && x <= a.x + NOTE_SIZE + r && y >= a.y - r && y <= a.y + NOTE_SIZE + r;
    default:
      return false;
  }
}

function distToSegment(px, py, [ax, ay], [bx, by]) {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

// ---------------------------------------------------------------------------
// Notes

const noteDialog = $("#note-dialog");
const noteText = $("#note-text");

/** Shows the note dialog; resolves to { action, text }. */
function promptNote(text, canDelete) {
  noteText.value = text;
  $("#note-delete").hidden = !canDelete;
  noteDialog.returnValue = "cancel";
  noteDialog.showModal();
  noteText.focus();
  return new Promise((resolve) => {
    noteDialog.addEventListener("close", () => resolve({ action: noteDialog.returnValue, text: noteText.value.trim() }), { once: true });
  });
}

async function createNote(page, [x, y]) {
  const { action, text } = await promptNote("", false);
  if (action !== "save" || !text) return;
  const annotation = {
    id: newId(),
    type: "note",
    color: state.color,
    x: round2(Math.min(x, page.width - NOTE_SIZE)),
    y: round2(Math.min(y, page.height - NOTE_SIZE)),
    text,
  };
  commit({ op: "add", page: page.num, annotation });
}

async function editNote(page, id) {
  const list = pageAnnotations(page.num);
  const note = list.find((a) => a.id === id);
  if (!note) return;
  const { action, text } = await promptNote(note.text, true);
  if (action === "delete" || (action === "save" && !text)) {
    commit({ op: "remove", page: page.num, annotation: note, index: list.indexOf(note) });
  } else if (action === "save" && text !== note.text) {
    commit({ op: "update", page: page.num, id, before: { text: note.text }, after: { text } });
  }
}

// ---------------------------------------------------------------------------
// Toolbar

function setTool(tool) {
  state.tool = tool;
  document.body.dataset.tool = tool;
  for (const b of document.querySelectorAll("#tools button")) {
    const active = b.dataset.tool === tool;
    b.classList.toggle("active", active);
    b.setAttribute("aria-pressed", String(active));
  }
}

function setColor(color) {
  state.color = color;
  for (const b of document.querySelectorAll("#colors button")) {
    b.classList.toggle("active", b.dataset.color === color);
  }
}

function setStatus(message) {
  const el = $("#status");
  el.hidden = !message;
  el.textContent = message ?? "";
}

function initToolbar() {
  const colorsEl = $("#colors");
  for (const color of COLORS) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "swatch";
    b.dataset.color = color;
    b.style.background = color;
    b.setAttribute("aria-label", `Color ${color}`);
    b.addEventListener("click", () => setColor(color));
    colorsEl.append(b);
  }
  setColor(COLORS[0]);
  setTool("pan");

  $("#tools").addEventListener("click", (e) => {
    const tool = e.target.closest("button")?.dataset.tool;
    if (tool) setTool(tool);
  });
  $("#open").addEventListener("click", () => bridge.openFilePicker());
  $("#undo").addEventListener("click", undo);
  $("#clear").addEventListener("click", () => {
    const hasAny = Object.values(state.annotations.pages).some((l) => l.length);
    if (hasAny && confirm("Remove all annotations in this document?")) {
      commit({ op: "clear", page: 1, before: structuredClone(state.annotations.pages) });
    }
  });
  $("#zoom-in").addEventListener("click", () => setScale(state.scale * 1.25));
  $("#zoom-out").addEventListener("click", () => setScale(state.scale / 1.25));
  $("#zoom-fit").addEventListener("click", () => setScale(fitWidthScale()));

  let scrollQueued = false;
  viewerEl.addEventListener("scroll", () => {
    if (scrollQueued) return;
    scrollQueued = true;
    requestAnimationFrame(() => {
      scrollQueued = false;
      updatePageLabel();
    });
  });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushSave();
  });
  window.addEventListener("pagehide", flushSave);
}

// ---------------------------------------------------------------------------
// Startup

window.viewer = { openDocument };

initToolbar();

let initial = null;
try {
  const json = bridge.getInitialDocument();
  if (json) initial = JSON.parse(json);
} catch (err) {
  console.error(err);
}
openDocument(initial ?? { url: new URL("../sample.pdf", import.meta.url).href, id: "sample", name: "sample.pdf" });
