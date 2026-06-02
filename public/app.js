const $ = (s) => document.querySelector(s);
const app = $("#app"), rowsEl = $("#rows"), treeEl = $("#tree"), crumbsEl = $("#crumbs"), qEl = $("#q"),
      sbody = $("#sbody"), sheetTitle = $("#sheettitle"),
      preview = $("#preview"), pscrim = $("#pscrim"), scrim = $("#scrim"), toastEl = $("#toast");
const COLOR = { image: "--t-image", video: "--t-video", audio: "--t-audio", pdf: "--t-pdf", html: "--t-html", code: "--t-code", text: "--t-text", archive: "--t-archive", file: "--t-file" };

let objects = [], root = null, sel = "", expanded = { "": true }, sort = { col: "name", dir: 1 },
    dragKey = null, dragIsFolder = false, sheetNode = null;

const fmtSize = (b) => { if (!Number.isFinite(b)) return "—"; const u = ["B", "KB", "MB", "GB", "TB"]; let n = b, i = 0; while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; } return (i ? n.toFixed(1) : n) + " " + u[i]; };
const fmtDate = (s) => { if (!s) return "—"; const d = new Date(s); return d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) + " " + d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }); };
const esc = (s) => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
function toast(m) { toastEl.textContent = m; toastEl.classList.add("show"); clearTimeout(toast._t); toast._t = setTimeout(() => toastEl.classList.remove("show"), 1700); }
function badge(o) { return '<span class="badge" style="background:var(' + (COLOR[o.category] || COLOR.file) + ')">' + esc(o.ext || "file") + '</span>'; }

// ── build the nested tree from the flat object list ──
function buildTree(objs) {
  const r = { name: "cdn", path: "", children: {}, files: [] };
  const folderAt = (parts) => { let n = r, acc = ""; for (const p of parts) { acc += p + "/"; n.children[p] ??= { name: p, path: acc, children: {}, files: [] }; n = n.children[p]; } return n; };
  for (const o of objs) {
    const parts = o.key.split("/").filter(Boolean);
    const base = parts[parts.length - 1];
    if (o.key.endsWith("/") || base === ".keep") {   // empty-folder marker: materialize folder, don't list it
      folderAt(o.key.endsWith("/") ? parts : parts.slice(0, -1));
      continue;
    }
    const file = parts.pop();
    folderAt(parts).files.push({ ...o, name: file });
  }
  return r;
}
function nodeAt(path) { let n = root; for (const p of path.split("/").filter(Boolean)) { if (!n.children[p]) return null; n = n.children[p]; } return n; }
function folderCount(node) { return Object.keys(node.children).length + node.files.length; }

// ── data ──
async function loadTree(keepSel) {
  const prev = keepSel ? sel : "";
  rowsEl.innerHTML = '<div class="state">Loading…</div>';
  let data;
  try { const res = await fetch("/api/tree"); data = await res.json(); if (!res.ok) throw new Error(data.error || res.status); }
  catch (e) { rowsEl.innerHTML = '<div class="state">Error: ' + esc(e.message) + '</div>'; return; }
  objects = data.objects || []; root = buildTree(objects);
  sel = nodeAt(prev) ? prev : "";
  render();
}
async function mutate(url, body, okMsg) {
  try {
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const d = await res.json(); if (!res.ok) throw new Error(d.error || res.status);
    closeSheet(); await loadTree(true); toast(okMsg);
  } catch (e) { toast("Error: " + e.message); }
}

// ── render ──
function arr(c) { return sort.col === c ? (sort.dir > 0 ? "▲" : "▼") : ""; }
function render() { renderTree(); renderCrumbs(); renderRows(); }

function renderTree() {
  treeEl.innerHTML = "";
  (function walk(node, depth) {
    const folders = Object.values(node.children).sort((a, b) => a.name.localeCompare(b.name));
    const row = document.createElement("div");
    row.className = "tnode" + (node.path === sel ? " sel" : ""); row.style.paddingLeft = (8 + depth * 14) + "px";
    const has = folders.length > 0;
    row.innerHTML = '<span class="chev ' + (has ? (expanded[node.path] ? "open" : "") : "leaf") + '">▶</span>📁<span class="label">' + esc(node.name) + '</span><span class="tcount">' + folderCount(node) + '</span>';
    row.querySelector(".chev").addEventListener("click", e => { e.stopPropagation(); expanded[node.path] = !expanded[node.path]; renderTree(); });
    row.addEventListener("click", () => { sel = node.path; expanded[node.path] = true; closeDrawer(); qEl.value = ""; render(); });
    wireFolderDrop(row, node);
    treeEl.appendChild(row);
    if (expanded[node.path]) folders.forEach(c => walk(c, depth + 1));
  })(root, 0);
}

function renderCrumbs() {
  crumbsEl.innerHTML = "";
  if (qEl.value.trim()) { crumbsEl.innerHTML = '<a class="here">search: ' + esc(qEl.value.trim()) + '</a>'; return; }
  const parts = sel.split("/").filter(Boolean); let acc = "";
  const mk = (label, path, here) => { const a = document.createElement("a"); a.textContent = label; if (here) a.className = "here"; a.addEventListener("click", () => { sel = path; render(); }); return a; };
  crumbsEl.appendChild(mk("cdn", "", parts.length === 0));
  parts.forEach((p, i) => { acc += p + "/"; crumbsEl.insertAdjacentHTML("beforeend", '<span class="sep">/</span>'); crumbsEl.appendChild(mk(p, acc, i === parts.length - 1)); });
}

function renderRows() {
  const q = qEl.value.trim().toLowerCase();
  if (q) { // global search across all files
    const hits = objects.filter(o => !o.key.endsWith("/") && !o.key.endsWith("/.keep") && o.key !== ".keep" && o.key.toLowerCase().includes(q))
      .map(o => ({ ...o, name: o.key.split("/").pop() }));
    rowsEl.innerHTML = hits.length ? hits.map(o => fileRow(o, true)).join("") : '<div class="state">No matches.</div>';
    wireRows(); return;
  }
  const node = nodeAt(sel) || root;
  let folders = Object.values(node.children).map(f => ({ type: "folder", name: f.name, path: f.path, n: folderCount(f) }));
  let files = node.files.map(f => ({ type: "file", ...f }));
  const dir = sort.dir;
  const cmp = (a, b) => sort.col === "size" ? ((a.size || 0) - (b.size || 0)) * dir : sort.col === "date" ? (new Date(a.lastModified || 0) - new Date(b.lastModified || 0)) * dir : a.name.localeCompare(b.name, undefined, { numeric: true }) * dir;
  folders.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })); files.sort(cmp);
  if (!folders.length && !files.length) { rowsEl.innerHTML = '<div class="state">This folder is empty.</div>'; return; }
  rowsEl.innerHTML =
    '<div class="hd"><span data-sort="name">Name <i class="ar">' + arr("name") + '</i></span><span class="ralign" data-sort="size">Size <i class="ar">' + arr("size") + '</i></span><span class="dtcol" data-sort="date">Modified <i class="ar">' + arr("date") + '</i></span></div>' +
    folders.map(folderRow).join("") + files.map(o => fileRow(o, false)).join("");
  wireRows();
}
function acts() { return '<span class="acts"><button data-mv>Move</button><button data-rn>Rename</button><button class="del" data-del>Delete</button></span>'; }
function folderRow(f) { return '<div class="r folder" data-path="' + esc(f.path) + '"><span class="nm"><span class="fldico">📁</span><span class="label">' + esc(f.name) + '/</span></span><span class="sz">' + f.n + '</span><span class="dt dtcol">—</span>' + acts() + '</div>'; }
function fileRow(o, withPath) {
  const sub = withPath ? '<span class="path"> ' + esc(o.key.replace(/[^/]+$/, "").replace(/\/$/, "") || "/") + '</span>' : "";
  return '<div class="r file" data-key="' + esc(o.key) + '"><span class="nm">' + badge(o) + '<span class="label">' + esc(o.name) + sub + '</span></span><span class="sz">' + fmtSize(o.size) + '</span><span class="dt dtcol">' + fmtDate(o.lastModified) + '</span>' + acts() + '</div>';
}

function wireRows() {
  rowsEl.querySelectorAll(".hd span[data-sort]").forEach(s => s.addEventListener("click", () => { const c = s.dataset.sort; sort = sort.col === c ? { col: c, dir: -sort.dir } : { col: c, dir: 1 }; render(); }));
  rowsEl.querySelectorAll(".r.folder").forEach(row => {
    const node = nodeAt(row.dataset.path);
    row.addEventListener("click", e => { if (e.target.closest("[data-mv],[data-del]")) return; sel = row.dataset.path; if (node) expanded[row.dataset.path] = true; qEl.value = ""; render(); });
    row.draggable = true;
    row.addEventListener("dragstart", () => { dragKey = row.dataset.path; dragIsFolder = true; row.classList.add("dragging"); });
    row.addEventListener("dragend", () => row.classList.remove("dragging"));
    if (node) wireFolderDrop(row, node);
    bindActs(row, row.dataset.path, true);
  });
  rowsEl.querySelectorAll(".r.file").forEach(row => {
    const o = objects.find(x => x.key === row.dataset.key);
    row.addEventListener("click", e => { if (e.target.closest("[data-mv],[data-del]")) return; if (o) openPreview(o); });
    row.draggable = true;
    row.addEventListener("dragstart", () => { dragKey = row.dataset.key; dragIsFolder = false; row.classList.add("dragging"); });
    row.addEventListener("dragend", () => row.classList.remove("dragging"));
    bindActs(row, row.dataset.key, false);
  });
}
function bindActs(row, key, isFolder) {
  row.querySelector("[data-mv]").addEventListener("click", e => { e.stopPropagation(); openMove(key, isFolder); });
  row.querySelector("[data-rn]").addEventListener("click", e => { e.stopPropagation(); openRename(key, isFolder); });
  row.querySelector("[data-del]").addEventListener("click", e => { e.stopPropagation(); openDelete(key, isFolder); });
}

// ── drag/move targets ──
function canDrop(folderPath) { return dragKey !== null && (dragIsFolder ? (folderPath !== dragKey && !folderPath.startsWith(dragKey)) : true) && parentOf(dragKey) !== folderPath; }
function parentOf(key) { const k = key.replace(/\/$/, ""); return k.includes("/") ? k.slice(0, k.lastIndexOf("/") + 1) : ""; }
function wireFolderDrop(el, node) {
  el.addEventListener("dragover", e => { if (canDrop(node.path)) { e.preventDefault(); el.classList.add("dropok"); } });
  el.addEventListener("dragleave", () => el.classList.remove("dropok"));
  el.addEventListener("drop", e => { e.preventDefault(); el.classList.remove("dropok"); const k = dragKey; confirmMove(k, node.path); });
}

// ── sheet: move (pick → confirm) / delete / new folder ──
function openSheet(title) { sheetTitle.textContent = title; app.classList.add("sheetopen", "open"); }
function closeSheet() { app.classList.remove("sheetopen", "open"); sheetNode = null; }
function closeDrawer() { app.classList.remove("open"); }
function allFolderPaths() { const out = []; (function w(n) { out.push(n.path); Object.values(n.children).forEach(w); })(root); return out; }

function openMove(key, isFolder) {
  sbody.innerHTML = "";
  allFolderPaths().forEach(path => {
    const bad = parentOf(key) === path || (isFolder && (path === key || path.startsWith(key)));
    const p = document.createElement("div"); p.className = "pick" + (bad ? " disabled" : "");
    p.innerHTML = '📁 <span>' + (path || "cdn/") + '</span>';
    if (!bad) p.addEventListener("click", () => confirmMove(key, path));
    sbody.appendChild(p);
  });
  openSheet("Move “" + key.replace(/\/$/, "").split("/").pop() + "” to…");
}
function confirmMove(key, to) {
  const name = key.replace(/\/$/, "").split("/").pop();
  sbody.innerHTML = '<div class="confirm"><p>Move <b>' + esc(name) + '</b> → <b>' + esc(to || "cdn/") + '</b>. <span class="warn">The key changes, so the public URL changes and old links break.</span></p><div class="cbtns"><button class="cancel" data-c>Cancel</button><button class="go" data-go>Move</button></div></div>';
  sbody.querySelector("[data-c]").addEventListener("click", closeSheet);
  sbody.querySelector("[data-go]").addEventListener("click", () => mutate("/api/move", { from: key, to }, "Moved “" + name + "”"));
  openSheet("Confirm move");
}
function openDelete(key, isFolder) {
  const name = key.replace(/\/$/, "").split("/").pop();
  const node = isFolder ? nodeAt(key) : null;
  const extra = isFolder && node ? (" and its " + countDeep(node) + " item(s)") : "";
  sbody.innerHTML = '<div class="confirm"><p>Delete <b>' + esc(name) + (isFolder ? "/" : "") + '</b>' + extra + '. <span class="warn">Gone for good — the public URL' + (isFolder ? "s" : "") + ' stop working.</span></p><div class="cbtns"><button class="cancel" data-c>Cancel</button><button class="danger" data-go>Delete</button></div></div>';
  sbody.querySelector("[data-c]").addEventListener("click", closeSheet);
  sbody.querySelector("[data-go]").addEventListener("click", () => mutate("/api/delete", { key }, "Deleted “" + name + "”"));
  openSheet("Confirm delete");
}
function countDeep(node) { let c = node.files.length; Object.values(node.children).forEach(k => c += 1 + countDeep(k)); return c; }
function openRename(key, isFolder) {
  const cur = key.replace(/\/$/, "").split("/").pop();
  sbody.innerHTML = '<div class="confirm"><p>Rename <b>' + esc(cur) + '</b>' + (isFolder ? '/' : '') + '</p><input id="rnname" class="nfname" value="' + esc(cur) + '"><div class="cbtns"><button class="cancel" data-c>Cancel</button><button class="go" data-go>Rename</button></div></div>';
  sbody.querySelector("[data-c]").addEventListener("click", closeSheet);
  const go = () => { const name = $("#rnname").value.trim(); if (name && name !== cur) mutate("/api/rename", { key, name }, "Renamed to “" + name + "”"); else closeSheet(); };
  sbody.querySelector("[data-go]").addEventListener("click", go);
  $("#rnname").addEventListener("keydown", e => { if (e.key === "Enter") go(); });
  openSheet("Rename");
  setTimeout(() => { const el = $("#rnname"); el.focus(); const dot = (!isFolder && cur.includes(".")) ? cur.lastIndexOf(".") : cur.length; el.setSelectionRange(0, dot); }, 50);
}

// ── preview ──
function openPreview(o) {
  let body;
  if (o.category === "image") body = '<img src="' + o.url + '" alt="">';
  else if (o.category === "video") body = '<video src="' + o.url + '" controls autoplay></video>';
  else if (o.category === "audio") body = '<div class="noprev"><span class="big">🎵</span><audio src="' + o.url + '" controls></audio></div>';
  else if (o.category === "archive") body = '<div class="noprev"><span class="big">🗜</span>No inline preview — use Open.</div>';
  else body = '<iframe src="' + o.url + '" sandbox="allow-same-origin allow-scripts allow-popups"></iframe>';
  const nm = o.key.split("/").pop();
  preview.innerHTML = '<div class="ph"><span class="label" title="' + esc(o.key) + '">' + esc(nm) + '</span><button class="x" id="px">×</button></div>' +
    '<div class="pbody">' + body + '</div>' +
    '<div class="pfoot"><div class="url">' + esc(o.url) + '</div><div class="btns"><button id="pcopy">Copy link</button><a class="primary" href="' + o.url + '" target="_blank" rel="noopener">Open ↗</a></div></div>';
  preview.classList.add("show"); pscrim.classList.add("show");
  $("#px").addEventListener("click", closePreview);
  $("#pcopy").addEventListener("click", () => { navigator.clipboard.writeText(o.url); toast("Link copied"); });
}
function closePreview() { preview.classList.remove("show"); pscrim.classList.remove("show"); }

// ── events ──
$("#drawerbtn").addEventListener("click", () => app.classList.toggle("open"));
scrim.addEventListener("click", () => { closeSheet(); closeDrawer(); });
$("#sheetx").addEventListener("click", closeSheet);
pscrim.addEventListener("click", closePreview);
document.addEventListener("keydown", e => { if (e.key === "Escape") { closePreview(); closeSheet(); } });
$("#newfld").addEventListener("click", () => {
  sbody.innerHTML = '<div class="confirm"><p>New folder in <b>' + esc(sel || "cdn/") + '</b></p><input id="nfname" class="nfname" placeholder="folder name"><div class="cbtns"><button class="cancel" data-c>Cancel</button><button class="go" data-go>Create</button></div></div>';
  sbody.querySelector("[data-c]").addEventListener("click", closeSheet);
  const go = () => { const name = $("#nfname").value.trim(); if (name) mutate("/api/folder", { prefix: sel, name }, "Created “" + name + "”"); };
  sbody.querySelector("[data-go]").addEventListener("click", go);
  $("#nfname").addEventListener("keydown", e => { if (e.key === "Enter") go(); });
  openSheet("New folder"); setTimeout(() => $("#nfname").focus(), 50);
});
qEl.addEventListener("input", () => { renderCrumbs(); renderRows(); });

loadTree(false);
