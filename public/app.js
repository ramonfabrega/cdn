const $ = (s) => document.querySelector(s);
const railEl = $("#rail"),
  scopeEl = $("#scope"),
  countEl = $("#count"),
  listEl = $("#list"),
  qEl = $("#q"),
  preview = $("#preview"),
  pscrim = $("#pscrim"),
  sheet = $("#sheet"),
  sheetScrim = $("#sheetScrim"),
  sbody = $("#sbody"),
  sheetTitle = $("#sheettitle"),
  menu = $("#menu"),
  toastEl = $("#toast"),
  railScrim = $("#railScrim"),
  fileInput = $("#fileinput"),
  dropzone = $("#dropzone"),
  dzText = $("#dztext");
const COLOR = {
  image: "--t-image",
  video: "--t-video",
  audio: "--t-audio",
  pdf: "--t-pdf",
  html: "--t-html",
  code: "--t-code",
  text: "--t-text",
  archive: "--t-archive",
  file: "--t-file",
};

// inline icons (Lucide-style 24px paths; currentColor → they follow text color + theme)
const ICONS = {
  folders:
    '<path d="M20 17a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3.9a2 2 0 0 1-1.69-.9l-.81-1.2a2 2 0 0 0-1.67-.9H8a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2Z"/><path d="M2 8v11a2 2 0 0 0 2 2h14"/>',
  folder:
    '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
  external:
    '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  move: '<path d="M2 9V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H20a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H2"/><path d="M2 13h10"/><path d="m9 16 3-3-3-3"/>',
  rename:
    '<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/><path d="m15 5 4 4"/>',
  delete:
    '<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M10 11v6"/><path d="M14 11v6"/>',
  infinity:
    '<path d="M18.178 8c5.096 0 5.096 8 0 8-5.095 0-7.133-8-12.739-8-4.585 0-4.585 8 0 8 5.606 0 7.644-8 12.74-8z"/>',
  chart:
    '<path d="M21 12c.552 0 1.005-.449.95-.998a10 10 0 0 0-8.953-8.951c-.55-.055-.998.398-.998.95v8a1 1 0 0 0 1 1z"/><path d="M21.21 15.89A10 10 0 1 1 8 2.83"/>',
};
const icon = (n) =>
  `<svg class="ico" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[n]}</svg>`;

let objects = [];
let q = "";
const HOME = "__home__";
let scope = HOME; // HOME = overview, null = All files, "__root__" = root, "cuanto/" = a folder prefix
let sort = { col: "date", dir: -1 }; // newest first by default

// ── helpers ──
const esc = (s) =>
  String(s).replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]
  );
const isMarker = (k) => k.endsWith("/") || k.endsWith("/.keep") || k === ".keep";
const byKey = (k) => objects.find((o) => o.key === k);
const fmtSize = (b) => {
  if (!Number.isFinite(b)) return "—";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let n = b,
    i = 0;
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024;
    i++;
  }
  return `${i ? n.toFixed(1) : n} ${u[i]}`;
};
const fmtDate = (s) => {
  if (!s) return "—";
  const d = new Date(s);
  return `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })} ${d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`;
};
// opts.copy = a URL: the toast becomes a click-to-copy quick action (longer-lived)
function toast(m, opts) {
  const url = opts?.copy;
  toastEl.textContent = m;
  toastEl.classList.toggle("act", !!url);
  toastEl.onclick = url
    ? () => {
        navigator.clipboard.writeText(url);
        toast("Link copied");
      }
    : null;
  toastEl.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => toastEl.classList.remove("show"), url ? 6000 : 1700);
}

// ── scope / derive ──
const files = () => objects.filter((o) => !isMarker(o.key));
function inScope(key, sc) {
  if (sc === null || sc === HOME) return true;
  if (sc === "__root__") return !key.includes("/");
  return key.startsWith(sc);
}
const countFor = (sc) => files().filter((o) => inScope(o.key, sc)).length;
function allPrefixes() {
  const set = new Set([""]);
  for (const o of objects) {
    const parts = o.key.split("/");
    parts.pop();
    let acc = "";
    for (const p of parts) {
      if (p) {
        acc += `${p}/`;
        set.add(acc);
      }
    }
  }
  return [...set].sort();
}
function railItems() {
  const items = [
    { scope: HOME, label: "Overview", depth: 0, root: true },
    { scope: null, label: "All files", depth: 0, root: true },
  ];
  for (const p of allPrefixes()) {
    if (p === "") items.push({ scope: "__root__", label: "root", depth: 0 });
    else {
      const parts = p.split("/").filter(Boolean);
      items.push({ scope: p, label: parts[parts.length - 1], depth: parts.length - 1 });
    }
  }
  return items;
}

// ── data ──
// The boot skeleton is painted by the inline script in index.html (so it's in the
// first paint); load() just fetches and swaps in real data — no skeleton here.
async function load() {
  try {
    const res = await fetch("/api/tree");
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || res.status);
    objects = data.objects || [];
    homeInvalidate(); // bucket contents changed → rebuild the overview's tree/slots
  } catch (e) {
    railEl.innerHTML = "";
    scopeEl.textContent = "";
    countEl.textContent = "";
    listEl.innerHTML = `<div class="state">Error: ${esc(e.message)}</div>`;
    return;
  }
  // deep-link: on first boot only, restore the view the hash points at
  // (e.g. /#/golf-sim/sfx-family/); later loads (post-mutation) just re-render.
  if (!load.booted && location.hash && location.hash !== "#/") applyHash();
  else render();
  load.booted = true;
}
async function mutate(url, payload, okMsg) {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const d = await res.json();
    if (!res.ok) throw new Error(d.error || res.status);
    closeSheet();
    await load();
    toast(okMsg);
  } catch (e) {
    toast(`Error: ${e.message}`);
  }
}

// ── filter + sort ──
// Query grammar (borrowed from the disk app — literal, not fuzzy): bare words
// substring-match the key; `kind:image` / `type:png` match category or ext;
// `size:>10mb` `size:<1gb` (b/kb/mb/gb/tb); `age:>1w` `age:<3d` (d/w/mo/y);
// `is:permanent` keeps sweep-exempt objects. All terms must match (AND).
const SIZE_U = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3, tb: 1024 ** 4 };
const AGE_U = { d: 864e5, w: 6048e5, mo: 2592e6, y: 31536e6 };
function parseQuery(text) {
  const terms = [];
  for (const tok of text.toLowerCase().split(/\s+/).filter(Boolean)) {
    const m = tok.match(/^(kind|type|size|age|is):(.+)$/);
    if (!m) {
      terms.push({ t: "text", v: tok });
      continue;
    }
    const [, k, v] = m;
    if (k === "kind" || k === "type") terms.push({ t: "kind", v });
    else if (k === "is" && v === "permanent") terms.push({ t: "perm" });
    else {
      const mm = v.match(/^([<>])(\d+(?:\.\d+)?)(tb|gb|mb|kb|b|mo|y|w|d)?$/);
      if (mm) terms.push({ t: k, op: mm[1], n: +mm[2], u: mm[3] });
      else terms.push({ t: "text", v: tok }); // malformed qualifier → literal match
    }
  }
  return terms;
}
function matchesQuery(o, terms) {
  for (const t of terms) {
    if (t.t === "text" && !o.key.toLowerCase().includes(t.v)) return false;
    if (t.t === "kind" && o.category !== t.v && o.ext !== t.v) return false;
    if (t.t === "perm" && !o.permanent) return false;
    if (t.t === "size") {
      const b = t.n * (SIZE_U[t.u ?? "b"] ?? 1);
      if (t.op === ">" ? o.size <= b : o.size >= b) return false;
    }
    if (t.t === "age") {
      // age:>1w = untouched for over a week (uploaded before the cutoff)
      const cutoff = Date.now() - t.n * (AGE_U[t.u ?? "d"] ?? 864e5);
      const ts = Date.parse(o.lastModified) || 0;
      if (t.op === ">" ? ts >= cutoff : ts < cutoff) return false;
    }
  }
  return true;
}
function visible() {
  let list = files();
  if (q) {
    const terms = parseQuery(q);
    list = list.filter((o) => matchesQuery(o, terms));
  } else list = list.filter((o) => inScope(o.key, scope));
  const dir = sort.dir;
  list.sort((a, b) =>
    sort.col === "size"
      ? ((a.size || 0) - (b.size || 0)) * dir
      : sort.col === "type"
        ? (a.ext || "~").localeCompare(b.ext || "~") * dir
        : sort.col === "date"
          ? (new Date(a.lastModified || 0) - new Date(b.lastModified || 0)) * dir
          : a.key.localeCompare(b.key, undefined, { numeric: true }) * dir
  );
  return list;
}

// ── render ──
const arr = (c) => (sort.col === c ? (sort.dir > 0 ? "▲" : "▼") : "");
// if the scoped folder vanished (e.g. you deleted it), climb to the nearest existing ancestor, else All
function validateScope() {
  if (scope === null || scope === "__root__" || scope === HOME) return;
  const prefixes = allPrefixes();
  let s = scope;
  while (s && !prefixes.includes(s)) {
    s = s.replace(/[^/]+\/$/, "");
    if (!s) {
      s = null;
      break;
    }
  }
  scope = s;
}
function render() {
  validateScope();
  renderRail();
  // typing a query while on Overview searches everything in the list view;
  // clearing it returns you to the sunburst.
  if (scope === HOME && !q) renderHome();
  else renderList();
  syncHash();
}
function renderRail() {
  railEl.innerHTML = railItems()
    .map((it) => {
      const sc = it.scope === null ? "__all__" : it.scope;
      const on = scope === it.scope || (it.scope === null && scope === null);
      const isFolder = it.scope !== null && it.scope !== "__root__" && it.scope !== HOME;
      const ico = icon(it.scope === HOME ? "chart" : it.scope === null ? "folders" : "folder");
      const more = isFolder
        ? `<button type="button" class="more" data-fmore aria-label="folder actions">⋯</button>`
        : "";
      const n = it.scope === HOME ? "" : `<span class="n">${countFor(it.scope)}</span>`;
      return `<div class="sitem${on ? " on" : ""}" data-scope="${esc(sc)}" style="padding-left:${10 + it.depth * 14}px">${ico}<span class="lbl">${esc(it.label)}</span>${n}${more}</div>`;
    })
    .join("");
}
function badge(o) {
  return `<span class="badge typecol" style="background:var(${COLOR[o.category] || COLOR.file})">${esc(o.ext || "file")}</span>`;
}
function rowHtml(o) {
  const slash = o.key.lastIndexOf("/");
  const prefix = slash === -1 ? "" : o.key.slice(0, slash + 1);
  const base = o.key.slice(slash + 1);
  return `<div class="row" data-key="${esc(o.key)}">
    <span class="nm"><span class="label" title="${esc(o.key)}"><span class="ns">${esc(prefix)}</span><span class="base">${esc(base)}</span></span>${o.permanent ? `<span class="pin" title="permanent — exempt from the 30d expiry sweep">∞</span>` : ""}</span>
    ${badge(o)}
    <span class="sz">${fmtSize(o.size)}</span>
    <span class="dt dtcol">${fmtDate(o.lastModified)}</span>
    <button type="button" class="more" data-more aria-label="actions">⋯</button>
  </div>`;
}
function headHtml() {
  return `<div class="hd">
    <span data-sort="name">Name <i class="ar">${arr("name")}</i></span>
    <span class="typecol" data-sort="type">Type <i class="ar">${arr("type")}</i></span>
    <span class="ralign" data-sort="size">Size <i class="ar">${arr("size")}</i></span>
    <span class="dtcol" data-sort="date">Uploaded <i class="ar">${arr("date")}</i></span>
    <span></span>
  </div>`;
}
function renderList() {
  listEl.dataset.view = "list"; // leaving Overview: next renderHome rebuilds its shell
  scopeEl.textContent =
    scope === null || scope === HOME ? "All files" : scope === "__root__" ? "root" : scope;
  const rows = visible();
  countEl.textContent = q ? `${rows.length} matches` : `${rows.length} files`;
  if (!rows.length) {
    listEl.innerHTML = `<div class="state">${q ? "No matches." : "Empty."}</div>`;
    return;
  }
  listEl.innerHTML = headHtml() + rows.map(rowHtml).join("");
}

// ── rail + list events ──
railEl.addEventListener("click", (e) => {
  const fmore = e.target.closest("[data-fmore]");
  if (fmore) {
    e.stopPropagation();
    const r = fmore.getBoundingClientRect();
    openMenu(fmore.closest(".sitem").dataset.scope, r.right, r.bottom, true);
    return;
  }
  const it = e.target.closest(".sitem");
  if (!it) return;
  scope = it.dataset.scope === "__all__" ? null : it.dataset.scope;
  closeRail();
  render();
});
railEl.addEventListener("contextmenu", (e) => {
  const it = e.target.closest(".sitem");
  if (!it || it.dataset.scope === "__all__" || it.dataset.scope === "__root__") return;
  e.preventDefault();
  openMenu(it.dataset.scope, e.clientX, e.clientY, true);
});
listEl.addEventListener("click", (e) => {
  const sortEl = e.target.closest("[data-sort]");
  if (sortEl) {
    const c = sortEl.dataset.sort;
    sort = sort.col === c ? { col: c, dir: -sort.dir } : { col: c, dir: 1 };
    renderList();
    return;
  }
  const more = e.target.closest("[data-more]");
  if (more) {
    e.stopPropagation();
    const r = more.getBoundingClientRect();
    openMenu(more.closest(".row").dataset.key, r.right, r.bottom);
    return;
  }
  const row = e.target.closest(".row");
  if (row) {
    const o = byKey(row.dataset.key);
    if (o) openPreview(o);
  }
});
listEl.addEventListener("contextmenu", (e) => {
  const row = e.target.closest(".row");
  if (!row) return;
  e.preventDefault();
  openMenu(row.dataset.key, e.clientX, e.clientY);
});

// ── context menu ──
function openMenu(key, x, y, isFolder = false) {
  menu.innerHTML = isFolder
    ? `<button type="button" data-act="move">${icon("move")}Move…</button>
    <button type="button" data-act="rename">${icon("rename")}Rename…</button>
    <button type="button" class="del" data-act="delete">${icon("delete")}Delete</button>`
    : `<button type="button" data-act="copy">${icon("link")}Copy link</button>
    <button type="button" data-act="open">${icon("external")}Open</button>
    <hr>
    <button type="button" data-act="permanent">${icon("infinity")}${byKey(key)?.permanent ? "Let expire (30d)" : "Make permanent"}</button>
    <button type="button" data-act="move">${icon("move")}Move…</button>
    <button type="button" data-act="rename">${icon("rename")}Rename…</button>
    <button type="button" class="del" data-act="delete">${icon("delete")}Delete</button>`;
  menu.querySelectorAll("button").forEach((b) => {
    b.addEventListener("click", () => {
      closeMenu();
      doAct(b.dataset.act, key);
    });
  });
  menu.classList.add("show");
  const w = menu.offsetWidth || 170,
    h = menu.offsetHeight || 200;
  menu.style.left = `${Math.max(8, Math.min(x - w, window.innerWidth - w - 8))}px`;
  menu.style.top = `${Math.min(y + 2, window.innerHeight - h - 8)}px`;
}
function closeMenu() {
  menu.classList.remove("show");
}
function doAct(action, key) {
  const o = byKey(key);
  if ((action === "copy" || action === "open") && !o) return;
  if (action === "copy") {
    navigator.clipboard.writeText(o.url);
    toast("Link copied");
  } else if (action === "open") window.open(o.url, "_blank", "noopener");
  else if (action === "permanent") {
    if (!o) return;
    mutate(
      "/api/permanent",
      { key, permanent: !o.permanent },
      o.permanent ? "Expires 30d after upload again" : "Marked permanent — never auto-expires"
    );
  } else if (action === "move") openMove(key);
  else if (action === "rename") openRename(key);
  else if (action === "delete") openDelete(key);
}

// ── sheet (move / rename / delete / new folder) ──
function openSheet(title) {
  sheetTitle.textContent = title;
  sheet.classList.add("show");
  sheetScrim.classList.add("show");
}
function closeSheet() {
  sheet.classList.remove("show");
  sheetScrim.classList.remove("show");
}
function openMove(key) {
  const isFolder = key.endsWith("/");
  const stripped = key.replace(/\/$/, "");
  const cur = stripped.includes("/") ? `${stripped.slice(0, stripped.lastIndexOf("/"))}/` : "";
  sbody.innerHTML = allPrefixes()
    .map((p) => {
      const bad = p === cur || (isFolder && (p === key || p.startsWith(key)));
      return `<div class="pick${bad ? " disabled" : ""}" data-to="${esc(p)}">📁 ${esc(p || "root")}</div>`;
    })
    .join("");
  sbody.querySelectorAll(".pick:not(.disabled)").forEach((el) => {
    el.addEventListener("click", () => confirmMove(key, el.dataset.to));
  });
  openSheet(`Move “${stripped.split("/").pop()}” to…`);
}
function confirmMove(key, to) {
  const name = key.replace(/\/$/, "").split("/").pop();
  sbody.innerHTML = `<div class="confirm"><p>Move <b>${esc(name)}</b> → <b>${esc(to || "root")}</b>. <span class="warn">The key changes, so the public URL changes and old links break.</span></p><div class="cbtns"><button type="button" class="cancel" data-c>Cancel</button><button type="button" class="go" data-go>Move</button></div></div>`;
  sbody.querySelector("[data-c]").addEventListener("click", closeSheet);
  sbody
    .querySelector("[data-go]")
    .addEventListener("click", () => mutate("/api/move", { from: key, to }, `Moved “${name}”`));
  openSheet("Confirm move");
}
function openRename(key) {
  const cur = key.replace(/\/$/, "").split("/").pop();
  sbody.innerHTML = `<div class="confirm"><p>Rename <b>${esc(cur)}</b></p><input id="rn" class="nfname" value="${esc(cur)}"><div class="cbtns"><button type="button" class="cancel" data-c>Cancel</button><button type="button" class="go" data-go>Rename</button></div></div>`;
  sbody.querySelector("[data-c]").addEventListener("click", closeSheet);
  const go = () => {
    const name = $("#rn").value.trim();
    if (name && name !== cur) mutate("/api/rename", { key, name }, `Renamed to “${name}”`);
    else closeSheet();
  };
  sbody.querySelector("[data-go]").addEventListener("click", go);
  $("#rn").addEventListener("keydown", (e) => {
    if (e.key === "Enter") go();
  });
  openSheet("Rename");
  setTimeout(() => {
    const el = $("#rn");
    el.focus();
    const dot = cur.includes(".") ? cur.lastIndexOf(".") : cur.length;
    el.setSelectionRange(0, dot);
  }, 50);
}
function openDelete(key) {
  const name = key.replace(/\/$/, "").split("/").pop();
  sbody.innerHTML = `<div class="confirm"><p>Delete <b>${esc(name)}</b>. <span class="warn">Gone for good — the public URL stops working.</span></p><div class="cbtns"><button type="button" class="cancel" data-c>Cancel</button><button type="button" class="danger" data-go>Delete</button></div></div>`;
  sbody.querySelector("[data-c]").addEventListener("click", closeSheet);
  sbody.querySelector("[data-go]").addEventListener("click", () => doDelete(key, name));
  openSheet("Confirm delete");
}
// optimistic delete: animate the row (or rail folder) out, sync in the background
async function doDelete(key, name) {
  closeSheet();
  const el =
    [...listEl.querySelectorAll(".row")].find((r) => r.dataset.key === key) ||
    [...railEl.querySelectorAll(".sitem")].find((s) => s.dataset.scope === key);
  if (el) el.classList.add("removing");
  try {
    const res = await fetch("/api/delete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key }),
    });
    const d = await res.json();
    if (!res.ok) throw new Error(d.error || res.status);
    objects = objects.filter((o) => o.key !== key && !(key.endsWith("/") && o.key.startsWith(key)));
    homeInvalidate();
    if (el) setTimeout(render, 200);
    else render();
    toast(`Deleted “${name}”`);
  } catch (e) {
    if (el) el.classList.remove("removing");
    toast(`Error: ${e.message}`);
  }
}
$("#newfld").addEventListener("click", () => {
  const prefix = uploadPrefix();
  sbody.innerHTML = `<div class="confirm"><p>New folder in <b>${esc(prefix || "root")}</b></p><input id="nf" class="nfname" placeholder="folder name"><div class="cbtns"><button type="button" class="cancel" data-c>Cancel</button><button type="button" class="go" data-go>Create</button></div></div>`;
  sbody.querySelector("[data-c]").addEventListener("click", closeSheet);
  const go = () => {
    const name = $("#nf").value.trim();
    if (name) mutate("/api/folder", { prefix, name }, `Created “${name}”`);
  };
  sbody.querySelector("[data-go]").addEventListener("click", go);
  $("#nf").addEventListener("keydown", (e) => {
    if (e.key === "Enter") go();
  });
  openSheet("New folder");
  setTimeout(() => $("#nf").focus(), 50);
});

// ── upload (button + drag-drop → POST /api/upload) ──
// Files land in the current scope (folder prefix), keeping their name; the session
// cookie authorizes the write. Key-gen is client-side, like the CLI. Folders are
// out of scope here (the `share` CLI handles those) — dropped dirs are skipped.
const uploadPrefix = () => (scope === null || scope === "__root__" || scope === HOME ? "" : scope);
async function uploadFiles(files) {
  const list = [...files];
  if (!list.length) return;
  const prefix = uploadPrefix();
  let ok = 0;
  let last = null;
  for (let i = 0; i < list.length; i++) {
    const f = list[i];
    const key = (prefix + f.name).replace(/^\/+/, "");
    toast(`Uploading ${i + 1}/${list.length}: ${f.name}`);
    try {
      const res = await fetch(`/api/upload?key=${encodeURIComponent(key)}`, {
        method: "POST",
        body: f,
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || res.status);
      ok++;
      last = d; // { key, url } — feeds the click-to-copy toast on single uploads
    } catch (e) {
      toast(`Failed: ${f.name} — ${e.message}`);
    }
  }
  await load();
  if (ok === 1 && list.length === 1 && last?.url)
    toast(`Uploaded ${list[0].name} — click to copy link`, { copy: last.url });
  else
    toast(
      ok === list.length
        ? `Uploaded ${ok} file${ok === 1 ? "" : "s"}`
        : `Uploaded ${ok}/${list.length}`
    );
}
// Pull top-level files from a drop; skip directories (need the entries API to detect).
function filesFromDrop(dt) {
  const items = dt.items ? [...dt.items] : [];
  if (items.length && items[0].webkitGetAsEntry) {
    const out = [];
    let sawDir = false;
    for (const it of items) {
      if (it.kind !== "file") continue;
      if (it.webkitGetAsEntry()?.isDirectory) {
        sawDir = true;
        continue;
      }
      const f = it.getAsFile();
      if (f) out.push(f);
    }
    if (sawDir) toast("Folders skipped — use the share CLI for those");
    return out;
  }
  return [...dt.files];
}
$("#upload").addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", () => {
  if (fileInput.files.length) uploadFiles(fileInput.files);
  fileInput.value = ""; // let the same file be picked again
});
// Drag files anywhere over the window; the overlay shows the destination scope.
const dtHasFiles = (e) => [...(e.dataTransfer?.types || [])].includes("Files");
let dragDepth = 0;
window.addEventListener("dragenter", (e) => {
  if (!dtHasFiles(e)) return;
  e.preventDefault();
  dragDepth++;
  dzText.textContent = `Drop to upload → ${uploadPrefix() || "root"}`;
  dropzone.classList.add("show");
});
window.addEventListener("dragover", (e) => {
  if (dtHasFiles(e)) e.preventDefault();
});
window.addEventListener("dragleave", (e) => {
  if (!dtHasFiles(e)) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) dropzone.classList.remove("show");
});
window.addEventListener("drop", (e) => {
  if (!dtHasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  dropzone.classList.remove("show");
  uploadFiles(filesFromDrop(e.dataTransfer));
});
// ⌘V with files on the clipboard (screenshot, copied Finder file) uploads like a
// drop. Text pastes are untouched — we only act when the clipboard carries files
// — and a sheet's inputs (rename / new folder) always keep normal paste.
window.addEventListener("paste", (e) => {
  if (sheet.classList.contains("show")) return;
  const fs = [...(e.clipboardData?.files || [])];
  if (!fs.length) return;
  e.preventDefault();
  // clipboard bitmaps all arrive as "image.png" — stamp them so pastes don't overwrite
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  uploadFiles(
    fs.map((f, i) => {
      if (!/^image\.\w+$/i.test(f.name)) return f; // real filename (e.g. Finder copy) — keep it
      const ext = (f.type.split("/")[1] || "png").replace("jpeg", "jpg");
      return new File([f], `paste-${stamp}${fs.length > 1 ? `-${i + 1}` : ""}.${ext}`, {
        type: f.type,
      });
    })
  );
});

// ── preview ──
function openPreview(o) {
  let pbody;
  if (o.category === "image") pbody = `<img src="${o.url}" alt="">`;
  else if (o.category === "video") pbody = `<video src="${o.url}" controls autoplay></video>`;
  else if (o.category === "audio")
    pbody = `<div class="noprev"><span class="big">🎵</span><audio src="${o.url}" controls></audio></div>`;
  else if (o.category === "archive")
    pbody = `<div class="noprev"><span class="big">🗜</span>No inline preview — use Open.</div>`;
  else
    pbody = `<iframe src="${o.url}" sandbox="allow-same-origin allow-scripts allow-popups"></iframe>`;
  const nm = o.key.split("/").pop();
  preview.innerHTML = `<div class="ph"><span class="label" title="${esc(o.key)}">${esc(nm)}</span><button type="button" class="x" id="px">×</button></div>
    <div class="pbody">${pbody}</div>
    <div class="pfoot"><div class="url">${esc(o.url)}</div><div class="btns"><button type="button" id="pcopy">${icon("link")}Copy link</button><a class="primary" href="${o.url}" target="_blank" rel="noopener">${icon("external")}Open</a></div></div>`;
  preview.classList.add("show");
  pscrim.classList.add("show");
  $("#px").addEventListener("click", closePreview);
  $("#pcopy").addEventListener("click", () => {
    navigator.clipboard.writeText(o.url);
    toast("Link copied");
  });
}
function closePreview() {
  preview.classList.remove("show");
  pscrim.classList.remove("show");
}

// ── rail drawer (mobile) ──
const closeRail = () => {
  railEl.classList.remove("open");
  railScrim.classList.remove("show");
};
$("#railbtn").addEventListener("click", () => {
  railEl.classList.toggle("open");
  railScrim.classList.toggle("show");
});
railScrim.addEventListener("click", closeRail);

// ── global events ──
qEl.addEventListener("input", () => {
  q = qEl.value.trim();
  if (scope === HOME)
    render(); // Overview ↔ search results swap the whole main area
  else renderList();
});
pscrim.addEventListener("click", closePreview);
sheetScrim.addEventListener("click", closeSheet);
$("#sheetx").addEventListener("click", closeSheet);
// capture phase: while the menu is open, the first outside click only dismisses it
// (don't let it fall through to a row/preview). Clicks on a ⋯ trigger pass through
// so the menu can re-open on the new target.
document.addEventListener(
  "click",
  (e) => {
    if (!menu.classList.contains("show")) return;
    if (e.target.closest("#menu")) return;
    closeMenu();
    if (!e.target.closest("[data-more], [data-fmore]")) {
      e.stopPropagation();
      e.preventDefault();
    }
  },
  true
);
window.addEventListener("scroll", closeMenu, true);
document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === "k") {
    e.preventDefault();
    qEl.focus();
    qEl.select();
    return;
  }
  if (e.key === "Escape") {
    closeMenu();
    if (preview.classList.contains("show")) closePreview();
    else if (sheet.classList.contains("show")) closeSheet();
    else if (document.activeElement === qEl && qEl.value) {
      qEl.value = "";
      q = "";
      if (scope === HOME) render();
      else renderList();
    }
  }
});

// ═══ home / overview — animated sunburst of the bucket ═══════════════════════
// A DaisyDisk-style size map, drawn immediate-mode on one <canvas>. Design debts
// to ~/code/fun/disk: pure geometry shared by draw + hit-test, hue by top-level
// folder (depth only fades), the "smaller items" rest bucket, and the zoom
// choreography (0.55s cubic in-out, newborn rings unfold staggered, ghosts sink,
// the center total COUNTS between values instead of swapping).

const SANS_F = "system-ui, -apple-system, sans-serif";
const MONO_F = 'ui-monospace, "SF Mono", Menlo, monospace';
// 9 slot hues per theme (hand-tuned + CVD-checked in the disk app — not hsl(i*40))
const SLOTS_D = [
  "#3987e5",
  "#199e70",
  "#c98500",
  "#008300",
  "#7e42d8",
  "#e66767",
  "#d55181",
  "#d95926",
  "#c74fb0",
];
const SLOTS_L = [
  "#2a78d6",
  "#1baf7a",
  "#eda100",
  "#008300",
  "#4a3aa7",
  "#e34948",
  "#e87ba4",
  "#eb6834",
  "#b0439a",
];
const REST_D = "#4a4a47";
const REST_L = "#b5b3ab";
const SURFACE_D = "#1c1c21"; // ≈ --bg, for depth-fading fills toward the page
const SURFACE_L = "#f8f8fa";
const INK = { d: "#eceef4", l: "#33353f" };
const DIM_INK = { d: "#a9adbd", l: "#6a6d7c" };

const darkMq = matchMedia("(prefers-color-scheme: dark)");
const reduceMq = matchMedia("(prefers-reduced-motion: reduce)");
const hexRgb = (x) => ({
  r: parseInt(x.slice(1, 3), 16),
  g: parseInt(x.slice(3, 5), 16),
  b: parseInt(x.slice(5, 7), 16),
});
const mixRgb = (a, b, t) => ({
  r: a.r + (b.r - a.r) * t,
  g: a.g + (b.g - a.g) * t,
  b: a.b + (b.b - a.b) * t,
});
const cssRgb = (c) => `rgb(${c.r | 0},${c.g | 0},${c.b | 0})`;
const lumaOf = (c) => (0.299 * c.r + 0.587 * c.g + 0.114 * c.b) / 255;
const easeIO = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
const lerp = (a, b, t) => a + (b - a) * t;
const clamp01 = (v) => Math.min(1, Math.max(0, v));

let tree = null; // rollup of `objects` — rebuilt lazily after any data change
let slotMap = null; // top-level entry key -> hue slot index
let hscope = ""; // sunburst root prefix ("" = whole bucket)
let hover = null; // hovered mark id ("d:cuanto/", "f:a/b.png", "r:prefix")
const sun = { canvas: null, ctx: null, w: 0, h: 0, geo: null, node: null, disp: null };

function homeInvalidate() {
  tree = null;
  slotMap = null;
}

// ── tree (rollup of the flat object list) ──
function buildTree() {
  const root = { name: "", prefix: "", dirs: new Map(), files: [], total: 0, count: 0 };
  for (const o of files()) {
    const parts = o.key.split("/");
    parts.pop();
    let node = root;
    let acc = "";
    for (const p of parts) {
      acc += `${p}/`;
      let child = node.dirs.get(p);
      if (!child) {
        child = { name: p, prefix: acc, dirs: new Map(), files: [], total: 0, count: 0 };
        node.dirs.set(p, child);
      }
      node = child;
    }
    node.files.push(o);
  }
  (function roll(n) {
    n.total = n.files.reduce((s, f) => s + f.size, 0);
    n.count = n.files.length;
    for (const c of n.dirs.values()) {
      roll(c);
      n.total += c.total;
      n.count += c.count;
    }
  })(root);
  return root;
}
function nodeAt(root, prefix) {
  let n = root;
  for (const p of prefix.split("/").filter(Boolean)) {
    n = n.dirs.get(p);
    if (!n) return null;
  }
  return n;
}
const depthOf = (prefix) => prefix.split("/").filter(Boolean).length;
const scopeLabel = (prefix) => (prefix ? prefix.replace(/\/$/, "").split("/").pop() : "All files");

// hue slot = the top-level ancestor's size rank; a whole subtree shares one hue
function buildSlots(root) {
  const tops = [...root.dirs.values()]
    .map((d) => ({ k: `${d.name}/`, size: d.total }))
    .concat(root.files.map((f) => ({ k: f.key, size: f.size })))
    .sort((a, b) => b.size - a.size);
  const m = new Map();
  tops.forEach((t, i) => m.set(t.k, i % SLOTS_D.length));
  return m;
}
const topOf = (key) => {
  const i = key.indexOf("/");
  return i === -1 ? key : key.slice(0, i + 1);
};
function fillOf(key, depth, rest) {
  const dark = darkMq.matches;
  const hue = rest
    ? dark
      ? REST_D
      : REST_L
    : (dark ? SLOTS_D : SLOTS_L)[slotMap.get(topOf(key)) ?? 0];
  const surf = dark ? SURFACE_D : SURFACE_L;
  // deeper rings fade toward the page, capped so they never wash out
  return mixRgb(hexRgb(hue), hexRgb(surf), Math.min(0.14 * (depth - 1), 0.45));
}

// ── entries of a node: dirs + files interleaved size-desc, tail rolled into a
//    single "smaller items" bucket so we never draw 4000 slivers ──
function entriesOf(node, cap = 60) {
  const out = [...node.dirs.values()]
    .map((d) => ({
      id: `d:${d.prefix}`,
      key: d.prefix,
      name: d.name,
      size: d.total,
      isDir: true,
      node: d,
    }))
    .concat(
      node.files.map((f) => ({
        id: `f:${f.key}`,
        key: f.key,
        name: f.key.split("/").pop(),
        size: f.size,
        isDir: false,
      }))
    )
    .sort((a, b) => b.size - a.size);
  let rest = 0;
  if (out.length > cap) {
    for (const e of out.slice(cap)) rest += e.size;
    out.length = cap;
  }
  if (rest > 0)
    out.push({
      id: `r:${node.prefix}`,
      key: node.prefix,
      name: "smaller items",
      size: rest,
      isDir: false,
      rest: true,
    });
  return out;
}

// ── geometry (pure — draw and hit-test share it) ──
// how many rings this subtree can actually fill (≤4) — a shallow scope (one
// folder of files) gets one FAT ring instead of a thin donut in dead space
function visibleDepth(node, d = 1) {
  let deep = d;
  for (const c of node.dirs.values()) deep = Math.max(deep, visibleDepth(c, d + 1));
  return Math.min(4, deep);
}
function sunburstMarks(node, w, h) {
  const R = Math.min(w, h) / 2 - 14;
  const r0 = Math.min(110, Math.max(46, R * 0.22)); // center hole
  const rings = visibleDepth(node);
  const band = (R - r0) / rings;
  const marks = [];
  (function ring(n, a0, a1, depth) {
    if (depth > rings || !n.total) return;
    let a = a0;
    for (const e of entriesOf(n)) {
      const span = (a1 - a0) * (e.size / n.total);
      if (span < 0.006) {
        a += span;
        continue;
      }
      const rIn = r0 + (depth - 1) * band;
      const fill = fillOf(e.key, depth, e.rest);
      marks.push({
        ...e,
        a0: a,
        a1: a + span,
        rIn,
        rOut: rIn + band - 1, // -1px gap between rings
        depth,
        fillRgb: fill,
        fillCss: cssRgb(fill),
      });
      if (e.isDir && span > 0.02) ring(e.node, a, a + span, depth + 1);
      a += span;
    }
  })(node, -Math.PI / 2, 1.5 * Math.PI, 1);
  return { marks, r0, band, R };
}
function freshDisp() {
  const m = new Map();
  for (const t of sun.geo.marks)
    m.set(t.id, { a0: t.a0, a1: t.a1, rIn: t.rIn, rOut: t.rOut, op: 1, mark: t });
  return m;
}

// ── layout / paint ──
function sizeSun() {
  const box = $("#chart");
  if (!box || !sun.canvas) return;
  const r = box.getBoundingClientRect();
  const dpr = devicePixelRatio || 1;
  sun.w = r.width;
  sun.h = r.height;
  sun.canvas.width = Math.round(r.width * dpr);
  sun.canvas.height = Math.round(r.height * dpr);
  sun.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
function layoutSun() {
  sun.node = nodeAt(tree, hscope);
  if (!sun.node) {
    hscope = "";
    sun.node = tree;
  }
  sun.geo = sunburstMarks(sun.node, sun.w, sun.h);
}
function inChain(id) {
  if (!hover) return true;
  const a = id.slice(2);
  const b = hover.slice(2);
  const pre = (x, y) => x === y || (y.endsWith("/") && x.startsWith(y));
  return pre(a, b) || pre(b, a);
}
function wedgePath(ctx, cx, cy, d) {
  ctx.beginPath();
  ctx.arc(cx, cy, d.rOut, d.a0, d.a1);
  ctx.arc(cx, cy, Math.max(0, d.rIn), d.a1, d.a0, true);
  ctx.closePath();
}
function paintSun() {
  const { ctx, w, h } = sun;
  if (!ctx || !sun.disp) return;
  const dark = darkMq.matches;
  const cx = w / 2;
  const cy = h / 2;
  ctx.clearRect(0, 0, w, h);
  const a = sun.anim;
  // on drill, release the hover dim over the first 30% so half the map doesn't
  // re-brighten in one frame
  const dimBase = a ? lerp(0.62, 1, clamp01((sun.animT ?? 1) / 0.3)) : 0.62;
  for (const d of sun.disp.values()) {
    if (d.op <= 0.01 || d.a1 - d.a0 <= 0.0001 || d.rOut - d.rIn <= 0.3) continue;
    const m = d.mark;
    ctx.globalAlpha = Math.min(1, d.op) * (hover && !inChain(m.id) ? dimBase : 1);
    wedgePath(ctx, cx, cy, d);
    ctx.fillStyle = m.fillCss;
    ctx.fill();
    // separators: skip on sub-2px arcs — the stroke would be wider than the wedge
    if (((d.a1 - d.a0) * (d.rIn + d.rOut)) / 2 > 2) {
      ctx.strokeStyle = dark ? SURFACE_D : SURFACE_L;
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    if (hover === m.id) {
      ctx.fillStyle = dark ? "rgba(255,255,255,.12)" : "rgba(0,0,0,.12)";
      ctx.fill();
    }
  }
  ctx.globalAlpha = 1;
  for (const d of sun.disp.values()) drawWedgeLabel(ctx, cx, cy, d);
  drawCenter(ctx, cx, cy, dark);
  ctx.globalAlpha = 1;
}
function drawWedgeLabel(ctx, cx, cy, d) {
  const m = d.mark;
  const span = d.a1 - d.a0;
  const rMid = (d.rIn + d.rOut) / 2;
  const angThick = span * rMid;
  const radDepth = d.rOut - d.rIn;
  // gates FADE near the thresholds instead of popping mid-zoom
  const gate = clamp01((angThick - 11) / 6) * clamp01((radDepth - 34) / 10);
  if (gate <= 0.03) return;
  const maxChars = Math.floor((radDepth - 12) / 5.6);
  if (maxChars < 3) return;
  let txt = m.name;
  if (txt.length > maxChars) txt = `${txt.slice(0, maxChars - 1)}…`;
  const mid = (d.a0 + d.a1) / 2;
  const rot = Math.cos(mid) < 0 ? mid + Math.PI : mid; // flip on the left half — never upside-down
  ctx.save();
  ctx.translate(cx + Math.cos(mid) * rMid, cy + Math.sin(mid) * rMid);
  ctx.rotate(rot);
  ctx.globalAlpha = gate * Math.min(1, d.op);
  ctx.fillStyle = lumaOf(m.fillRgb) > 0.55 ? "#16161a" : "#fff";
  ctx.font = `10px ${SANS_F}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(txt, 0, 0);
  ctx.restore();
}
function drawCenter(ctx, cx, cy, dark) {
  const node = sun.node;
  if (!node) return;
  const ink = dark ? INK.d : INK.l;
  const dim = dark ? DIM_INK.d : DIM_INK.l;
  const a = sun.anim;
  const t = a ? (sun.animT ?? 0) : 1;
  const e = easeIO(t);
  const name = scopeLabel(hscope);
  const maxChars = Math.floor((sun.geo.r0 * 2 - 18) / 6.5);
  const trunc = (s) => (s.length > maxChars ? `${s.slice(0, maxChars - 1)}…` : s);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = `600 13px ${SANS_F}`;
  const drift = a?.dir === "in" ? -8 : a?.dir === "out" ? 8 : 0;
  if (a && t < 0.4) {
    // old name exits first, drifting with the zoom…
    ctx.globalAlpha = 1 - t / 0.4;
    ctx.fillStyle = ink;
    ctx.fillText(trunc(a.fromName), cx, cy - 10 + drift * e);
  }
  // …the new one arrives from the opposite side; never both at full strength
  ctx.globalAlpha = a ? clamp01((t - 0.35) / 0.5) : 1;
  ctx.fillStyle = ink;
  ctx.fillText(trunc(name), cx, cy - 10 - (a ? drift * (1 - e) : 0));
  // the size NEVER swaps — one number counting old → new
  ctx.globalAlpha = 1;
  ctx.font = `11px ${MONO_F}`;
  ctx.fillStyle = dim;
  const total = a ? lerp(a.fromTotal, node.total, e) : node.total;
  ctx.fillText(node.count ? fmtSize(total) : "empty", cx, cy + 8);
  if (hscope) {
    ctx.font = `9px ${SANS_F}`;
    ctx.globalAlpha = 0.75;
    ctx.fillText("click to go up", cx, cy + 24);
  }
}

// ── zoom transition (state-watching: EVERY path that changes hscope animates) ──
function setHomeScope(prefix) {
  if (!tree || prefix === hscope || !nodeAt(tree, prefix)) return;
  const oldScope = hscope;
  const oldNode = nodeAt(tree, oldScope);
  const dir = prefix.startsWith(oldScope) ? "in" : oldScope.startsWith(prefix) ? "out" : "fade";
  const levels = Math.abs(depthOf(prefix) - depthOf(oldScope)) || 1;
  hscope = prefix;
  layoutSun();
  renderTiles();
  renderCrumbs();
  renderHlist();
  syncHash();
  if (reduceMq.matches || !sun.disp) {
    sun.anim = null;
    sun.disp = freshDisp();
    paintSun();
    return;
  }
  sun.anim = {
    t0: null, // clock anchors to the FIRST DRAWN FRAME, not the click (layout hitch ≠ animation time)
    dur: 550 * Math.min(1.6, 1 + 0.18 * (levels - 1)),
    dir,
    levels,
    from: sun.disp, // current on-screen state — interrupting mid-zoom catches up, never snaps
    fromTotal: oldNode?.total ?? 0,
    fromName: scopeLabel(oldScope),
  };
  cancelAnimationFrame(sun.raf);
  sun.raf = requestAnimationFrame(sunTick);
}
function sunTick(ts) {
  const a = sun.anim;
  if (!a) return;
  if (a.t0 == null) a.t0 = ts;
  const rawT = a.dur ? Math.min(1, (ts - a.t0) / a.dur) : 1;
  const e = easeIO(rawT);
  sun.animT = rawT;
  const { band } = sun.geo;
  const disp = new Map();
  const liveIds = new Set(sun.geo.marks.map((m) => m.id));
  // ghosts first (they paint underneath): outgoing marks with no home in the new view
  for (const [id, f] of a.from) {
    if (liveIds.has(id)) continue;
    if (a.dir === "in") {
      // sink toward the hole; geometry does the exit, opacity fades late (1-e²)
      const shift = e * a.levels * band;
      const rIn = Math.max(0, f.rIn - shift);
      const rOut = Math.max(0, f.rOut - shift);
      if (rOut > 0.5)
        disp.set(id, { a0: f.a0, a1: f.a1, rIn, rOut, op: (1 - e * e) * f.op, mark: f.mark });
    } else if (a.dir === "out") {
      // dying detail folds closed, deepest-first
      const k = 4 - (f.mark.depth ?? 1);
      const le = easeIO(clamp01((rawT - 0.1 * k) / Math.max(0.001, 1 - 0.1 * k)));
      disp.set(id, {
        a0: f.a0,
        a1: f.a1,
        rIn: f.rIn,
        rOut: f.rIn + (f.rOut - f.rIn) * (1 - le),
        op: (1 - le) * f.op,
        mark: f.mark,
      });
    } else {
      disp.set(id, { ...f, op: f.op * (1 - e) });
    }
  }
  for (const m of sun.geo.marks) {
    const f = a.from.get(m.id);
    if (f) {
      disp.set(m.id, {
        a0: lerp(f.a0, m.a0, e),
        a1: lerp(f.a1, m.a1, e),
        rIn: lerp(f.rIn, m.rIn, e),
        rOut: lerp(f.rOut, m.rOut, e),
        op: lerp(f.op, 1, e),
        mark: m,
      });
    } else if (a.dir === "fade") {
      disp.set(m.id, { a0: m.a0, a1: m.a1, rIn: m.rIn, rOut: m.rOut, op: e, mark: m });
    } else {
      // newborn rings unfold from zero thickness, staggered outward
      const k = m.depth - 1;
      const le = easeIO(clamp01((rawT - 0.12 * k) / Math.max(0.001, 1 - 0.12 * k)));
      disp.set(m.id, {
        a0: m.a0,
        a1: m.a1,
        rIn: m.rIn,
        rOut: m.rIn + (m.rOut - m.rIn) * le,
        op: 1,
        mark: m,
      });
    }
  }
  sun.disp = disp;
  paintSun();
  if (rawT < 1) sun.raf = requestAnimationFrame(sunTick);
  else {
    sun.anim = null;
    sun.animT = null;
    sun.disp = freshDisp();
    paintSun();
  }
}

// ── hit-testing (inverse of the same pure geometry) ──
function sunHit(x, y) {
  if (!sun.geo) return null;
  const dx = x - sun.w / 2;
  const dy = y - sun.h / 2;
  const dist = Math.hypot(dx, dy);
  if (dist < sun.geo.r0 - 6) return { center: true };
  let th = Math.atan2(dy, dx);
  if (th < -Math.PI / 2) th += 2 * Math.PI; // wedges live in [-π/2, 3π/2)
  for (const m of sun.geo.marks)
    if (th >= m.a0 && th <= m.a1 && dist >= m.rIn && dist <= m.rOut) return { mark: m };
  return null;
}

// ── DOM panels ──
function homeShell() {
  return `<div class="home">
    <div class="tiles" id="tiles"></div>
    <div class="hgrid">
      <div class="chart" id="chart"><canvas id="sun"></canvas></div>
      <div class="hside">
        <div class="hcrumbs" id="hcrumbs"></div>
        <div class="hlist" id="hlist"></div>
      </div>
    </div>
  </div>`;
}
function renderTiles() {
  const node = sun.node;
  if (!node) return;
  const week = Date.now() - 7 * 864e5;
  let wn = 0;
  let wb = 0;
  (function walk(n) {
    for (const f of n.files)
      if ((Date.parse(f.lastModified) || 0) > week) {
        wn++;
        wb += f.size;
      }
    for (const c of n.dirs.values()) walk(c);
  })(node);
  const tile = (v, l) => `<div class="tile"><b>${v}</b><span>${l}</span></div>`;
  $("#tiles").innerHTML =
    tile(fmtSize(node.total), "total") +
    tile(node.count, "files") +
    tile(node.dirs.size, "folders") +
    tile(wn ? `${wn} · ${fmtSize(wb)}` : "0", "past 7 days");
}
function renderCrumbs() {
  const segs = hscope.split("/").filter(Boolean);
  let acc = "";
  const parts = [
    `<button type="button" class="crumb${segs.length ? "" : " cur"}" data-hs="">All files</button>`,
  ];
  for (let i = 0; i < segs.length; i++) {
    acc += `${segs[i]}/`;
    parts.push(
      `<span class="csep">/</span><button type="button" class="crumb${i === segs.length - 1 ? " cur" : ""}" data-hs="${esc(acc)}">${esc(segs[i])}</button>`
    );
  }
  $("#hcrumbs").innerHTML =
    `${parts.join("")}<button type="button" class="cbrowse" data-browse title="browse in the file list">${icon("external")}</button>`;
}
function renderHlist() {
  const node = sun.node;
  const el = $("#hlist");
  if (!node || !el) return;
  const rows = entriesOf(node, 24);
  if (!rows.length) {
    el.innerHTML = '<div class="state">Empty.</div>';
    return;
  }
  const max = rows[0]?.size || 1;
  el.innerHTML = rows
    .map((r) => {
      const col = cssRgb(fillOf(r.key, 1, r.rest));
      const pct = node.total ? (r.size / node.total) * 100 : 0;
      const act = r.isDir
        ? ` data-dir="${esc(r.key)}"`
        : r.rest
          ? ""
          : ` data-file="${esc(r.key)}"`;
      return `<div class="hrow${r.rest ? " rest" : ""}" data-id="${esc(r.id)}"${act}>
      <span class="dot" style="background:${col}"></span>
      <span class="hnm">${esc(r.name)}${r.isDir ? "/" : ""}</span>
      <span class="hpc">${pct < 0.1 ? "<0.1" : pct.toFixed(pct < 10 ? 1 : 0)}%</span>
      <span class="hsz">${fmtSize(r.size)}</span>
      <i class="hbar" style="background:${col};transform:scaleX(${(r.size / max).toFixed(4)})"></i>
    </div>`;
    })
    .join("");
}
function syncHover(id) {
  if (id === hover) return;
  hover = id;
  paintSun();
  const hl = $("#hlist");
  if (hl) for (const row of hl.children) row.classList.toggle("hov", !!id && row.dataset.id === id);
}
function showTip(m, x, y) {
  const tip = $("#tip");
  if (!m) {
    tip.classList.remove("show");
    return;
  }
  const pct = sun.node?.total ? ((m.size / sun.node.total) * 100).toFixed(1) : "0";
  const extra = m.isDir ? ` · ${nodeAt(tree, m.key)?.count ?? 0} files` : "";
  tip.innerHTML = `<b>${esc(m.name)}${m.isDir ? "/" : ""}</b>${fmtSize(m.size)} · ${pct}% of ${esc(scopeLabel(hscope))}${extra}`;
  tip.classList.add("show");
  const w = tip.offsetWidth;
  const h = tip.offsetHeight;
  tip.style.left = `${Math.min(x + 14, window.innerWidth - w - 8)}px`;
  tip.style.top = `${Math.min(y + 14, window.innerHeight - h - 8)}px`;
}

function bindHomeEvents() {
  const canvas = sun.canvas;
  canvas.addEventListener("pointermove", (ev) => {
    const r = canvas.getBoundingClientRect();
    const hit = sunHit(ev.clientX - r.left, ev.clientY - r.top);
    canvas.style.cursor =
      hit && (hit.center ? hscope : hit.mark && !hit.mark.rest) ? "pointer" : "";
    syncHover(hit?.mark ? hit.mark.id : null);
    showTip(hit?.mark ?? null, ev.clientX, ev.clientY);
  });
  canvas.addEventListener("pointerleave", () => {
    syncHover(null);
    showTip(null);
  });
  canvas.addEventListener("click", (ev) => {
    const r = canvas.getBoundingClientRect();
    const hit = sunHit(ev.clientX - r.left, ev.clientY - r.top);
    if (!hit) return;
    if (hit.center) {
      if (hscope) setHomeScope(hscope.replace(/[^/]+\/$/, ""));
      return;
    }
    const m = hit.mark;
    if (m.isDir) setHomeScope(m.key);
    else if (!m.rest) {
      const o = byKey(m.key);
      if (o) openPreview(o);
    }
  });
  const side = $(".hside");
  side.addEventListener("click", (ev) => {
    const crumb = ev.target.closest("[data-hs]");
    if (crumb) return setHomeScope(crumb.dataset.hs);
    if (ev.target.closest("[data-browse]")) {
      scope = hscope === "" ? null : hscope; // jump into the classic list, scoped here
      render();
      return;
    }
    const row = ev.target.closest(".hrow");
    if (!row) return;
    if (row.dataset.dir) setHomeScope(row.dataset.dir);
    else if (row.dataset.file) {
      const o = byKey(row.dataset.file);
      if (o) openPreview(o);
    }
  });
  side.addEventListener("mouseover", (ev) => {
    const row = ev.target.closest(".hrow");
    syncHover(row ? row.dataset.id : null);
  });
  side.addEventListener("mouseleave", () => syncHover(null));
}

function renderHome() {
  scopeEl.textContent = "Overview";
  countEl.textContent = `${files().length} files`;
  if (!tree) {
    tree = buildTree();
    slotMap = buildSlots(tree);
    if (hscope && !nodeAt(tree, hscope)) hscope = ""; // scoped folder vanished → back to root
  }
  if (listEl.dataset.view !== "home") {
    cancelAnimationFrame(sun.raf);
    sun.anim = null;
    listEl.dataset.view = "home";
    listEl.innerHTML = homeShell();
    sun.canvas = $("#sun");
    sun.ctx = sun.canvas.getContext("2d");
    bindHomeEvents();
    sun.ro?.disconnect();
    sun.ro = new ResizeObserver(() => {
      if (listEl.dataset.view !== "home") return;
      sizeSun();
      layoutSun();
      if (!sun.anim) sun.disp = freshDisp();
      paintSun();
    });
    sun.ro.observe($("#chart"));
    sizeSun();
    sun.disp = null;
  }
  layoutSun();
  if (!sun.anim) sun.disp = freshDisp();
  renderTiles();
  renderCrumbs();
  renderHlist();
  paintSun();
}

darkMq.addEventListener?.("change", () => {
  if (scope === HOME && !q && tree) renderHome();
});

// ── url sync ─────────────────────────────────────────────────────────────────
// #/<prefix>/ = Overview drilled to a folder (the explorer twin of the public
// /<prefix>/ share page) · #f = All files · #f/ = root · #f/<prefix>/ = a scoped
// file list. Drills push history entries, so Back is an animated zoom-out.
let applyingHash = false;
function hashFor() {
  if (scope === HOME) return hscope ? `#/${hscope}` : "#/";
  if (scope === null) return "#f";
  return `#f/${scope === "__root__" ? "" : scope}`;
}
function syncHash() {
  if (applyingHash) return;
  const h = hashFor();
  if (h === "#/" && !location.hash) return; // default view — don't mint an entry on boot
  if (location.hash !== h) location.hash = h;
}
function applyHash() {
  const h = decodeURIComponent(location.hash);
  applyingHash = true;
  try {
    if (h.startsWith("#f")) {
      const p = h.slice(2).replace(/^\//, "");
      scope = h === "#f" ? null : p ? p.replace(/\/?$/, "/") : "__root__";
      render();
    } else {
      const p = h.replace(/^#\/?/, "");
      const prefix = p ? p.replace(/\/?$/, "/") : "";
      scope = HOME;
      // already on the sunburst → animated drill; otherwise jump straight there
      if (listEl.dataset.view === "home" && tree && !q) setHomeScope(prefix);
      else {
        hscope = prefix;
        render();
      }
    }
  } finally {
    applyingHash = false;
  }
}
window.addEventListener("hashchange", applyHash);

load();

// re-enable transitions once the first frame has painted (the hidden overlays are
// now settled off-screen, so they won't animate). double rAF = "after next paint".
requestAnimationFrame(() => {
  requestAnimationFrame(() => document.documentElement.classList.remove("booting"));
});
