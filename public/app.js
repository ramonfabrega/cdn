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
  railScrim = $("#railScrim");
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

let objects = [];
let q = "";
let scope = null; // null = All files, "__root__" = root, "cuanto/" = a folder prefix
let sort = { col: "name", dir: 1 };

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
function toast(m) {
  toastEl.textContent = m;
  toastEl.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => toastEl.classList.remove("show"), 1700);
}

// ── scope / derive ──
const files = () => objects.filter((o) => !isMarker(o.key));
function inScope(key, sc) {
  if (sc === null) return true;
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
  const items = [{ scope: null, label: "All files", depth: 0, root: true }];
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
  } catch (e) {
    railEl.innerHTML = "";
    scopeEl.textContent = "";
    countEl.textContent = "";
    listEl.innerHTML = `<div class="state">Error: ${esc(e.message)}</div>`;
    return;
  }
  render();
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
function visible() {
  let list = files();
  if (q) {
    const t = q.toLowerCase();
    list = list.filter((o) => o.key.toLowerCase().includes(t));
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
  if (scope === null || scope === "__root__") return;
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
  renderList();
}
function renderRail() {
  railEl.innerHTML = railItems()
    .map((it) => {
      const sc = it.scope === null ? "__all__" : it.scope;
      const on = scope === it.scope || (it.scope === null && scope === null);
      const isFolder = it.scope !== null && it.scope !== "__root__";
      const ico = it.scope === null ? "🗂" : "📁";
      const more = isFolder
        ? `<button type="button" class="more" data-fmore aria-label="folder actions">⋯</button>`
        : "";
      return `<div class="sitem${on ? " on" : ""}" data-scope="${esc(sc)}" style="padding-left:${10 + it.depth * 14}px"><span class="ico">${ico}</span><span class="lbl">${esc(it.label)}</span><span class="n">${countFor(it.scope)}</span>${more}</div>`;
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
    <span class="nm"><span class="label" title="${esc(o.key)}"><span class="ns">${esc(prefix)}</span><span class="base">${esc(base)}</span></span></span>
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
    <span class="dtcol" data-sort="date">Modified <i class="ar">${arr("date")}</i></span>
    <span></span>
  </div>`;
}
function renderList() {
  scopeEl.textContent = scope === null ? "All files" : scope === "__root__" ? "root" : scope;
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
    ? `<button type="button" data-act="move">Move…</button>
    <button type="button" data-act="rename">Rename…</button>
    <button type="button" class="del" data-act="delete">Delete</button>`
    : `<button type="button" data-act="copy">Copy link</button>
    <button type="button" data-act="open">Open ↗</button>
    <hr>
    <button type="button" data-act="move">Move…</button>
    <button type="button" data-act="rename">Rename…</button>
    <button type="button" class="del" data-act="delete">Delete</button>`;
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
  else if (action === "move") openMove(key);
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
    if (el) setTimeout(render, 200);
    else render();
    toast(`Deleted “${name}”`);
  } catch (e) {
    if (el) el.classList.remove("removing");
    toast(`Error: ${e.message}`);
  }
}
$("#newfld").addEventListener("click", () => {
  const prefix = scope === null || scope === "__root__" ? "" : scope;
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
    <div class="pfoot"><div class="url">${esc(o.url)}</div><div class="btns"><button type="button" id="pcopy">Copy link</button><a class="primary" href="${o.url}" target="_blank" rel="noopener">Open ↗</a></div></div>`;
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
  renderList();
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
      renderList();
    }
  }
});

load();

// re-enable transitions once the first frame has painted (the hidden overlays are
// now settled off-screen, so they won't animate). double rAF = "after next paint".
requestAnimationFrame(() => {
  requestAnimationFrame(() => document.documentElement.classList.remove("booting"));
});
