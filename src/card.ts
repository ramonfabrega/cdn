// og:image card for a folder share page — the 1200×630 PNG that /.og/<prefix>.png
// renders (via takumi's WASM renderer in worker.ts). Built as a plain takumi node
// tree (no JSX runtime involved), styled with the explorer's OKLCH palette from
// lib/ui.ts. Fixed dark theme: unfurl chrome varies per app, the card shouldn't.

import type { Node } from "takumi-js";

import { BADGE, fmtSize } from "./lib/ui.ts";

type Style = NonNullable<Extract<Node, { type: "text" }>["style"]>;

import inter400 from "./assets/inter-400.woff2";
import inter600 from "./assets/inter-600.woff2";
import type { Entry, SubtreeEntry } from "./storage.ts";

export const CARD_FONTS = [
  { name: "Inter", weight: 400, data: inter400 },
  { name: "Inter", weight: 600, data: inter600 },
];

// dark-theme values of the shared tokens (lib/ui.ts BASE_TOKENS) — a card can't
// use light-dark(), so the dark arm is baked in.
const C = {
  bg: "oklch(15% .008 265)",
  card: "oklch(19% .009 265)",
  line: "oklch(26% .013 265)",
  line2: "oklch(31% .016 265)",
  ink: "oklch(94% .008 265)",
  dim: "oklch(71% .023 265)",
  faint: "oklch(52% .022 265)",
  onBright: "oklch(20% .01 265)",
};

const text = (t: string, style: Style): Node => ({ type: "text", text: t, style });
const box = (style: Style, children?: Node[]): Node => ({ type: "container", style, children });

// ── sunburst — the explorer's Overview donut, drawn with conic-gradients ─────
// Rings are concentric circles: each ring's conic-gradient paints its wedges and
// the next circle in covers its center, leaving an annulus (a 1px bg ring between
// them mirrors the canvas `rOut = rIn + band - 1` seam). The geometry below is a
// SERVER MIRROR of public/app.js's pure `sunburstMarks`/`entriesOf`/`fillOf`
// (which the Worker can't import — app.js is a zero-build inline client script):
// same proportional angles with NO angular gaps, same size-desc order with the
// tail rolled into one "smaller items" wedge, same 9-slot CVD-checked palette by
// top-child rank, same depth fade (14%/ring toward the page, capped 45%), same
// sliver skipping, and the ring count adapting to the subtree's real depth.
const SLOTS = [
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
const REST = "#4a4a47";
const SURFACE = "#1c1c21"; // ≈ C.bg, for depth-fading fills toward the page

type Rgb = { r: number; g: number; b: number };
const hexRgb = (x: string): Rgb => ({
  r: parseInt(x.slice(1, 3), 16),
  g: parseInt(x.slice(3, 5), 16),
  b: parseInt(x.slice(5, 7), 16),
});
const mixRgb = (a: Rgb, b: Rgb, t: number): Rgb => ({
  r: a.r + (b.r - a.r) * t,
  g: a.g + (b.g - a.g) * t,
  b: a.b + (b.b - a.b) * t,
});
const cssRgb = (c: Rgb) => `rgb(${c.r | 0},${c.g | 0},${c.b | 0})`;

// nested tree built from the flat subtree — the same node shape app.js builds
type SunNode = { dirs: Map<string, SunNode>; files: number[]; total: number };
function buildTree(subtree: SubtreeEntry[], prefix: string): SunNode {
  const root: SunNode = { dirs: new Map(), files: [], total: 0 };
  for (const e of subtree) {
    const size = Math.max(e.size, 1); // zero-byte files still occupy structure
    const segs = e.key.slice(prefix.length).split("/");
    let n = root;
    n.total += size;
    for (const seg of segs.slice(0, -1)) {
      let d = n.dirs.get(seg);
      if (!d) {
        d = { dirs: new Map(), files: [], total: 0 };
        n.dirs.set(seg, d);
      }
      d.total += size;
      n = d;
    }
    n.files.push(size);
  }
  return root;
}

// mirror of app.js entriesOf: dirs + files size-desc, tail → one "smaller items"
type SunEntry = { size: number; isDir: boolean; rest?: boolean; node?: SunNode; top?: string };
function entriesOf(node: SunNode, cap = 60): SunEntry[] {
  const out: SunEntry[] = [
    ...[...node.dirs.entries()].map(
      ([name, d]): SunEntry => ({ size: d.total, isDir: true, node: d, top: `${name}/` })
    ),
    ...node.files.map((size): SunEntry => ({ size, isDir: false })),
  ].sort((a, b) => b.size - a.size);
  let rest = 0;
  if (out.length > cap) {
    for (const e of out.slice(cap)) rest += e.size;
    out.length = cap;
  }
  if (rest > 0) out.push({ size: rest, isDir: false, rest: true });
  return out;
}

function visibleDepth(node: SunNode, d = 1): number {
  let deep = d;
  for (const c of node.dirs.values()) deep = Math.max(deep, visibleDepth(c, d + 1));
  return Math.min(3, deep); // explorer caps at 4; a card is smaller — cap 3
}

type Mark = { a0: number; a1: number; depth: number; fill: string };

/** Mirror of app.js sunburstMarks — radians from the top (-π/2), depth-recursive,
    no angular gaps, slivers (<0.006 rad) skipped. Hue = the depth-1 ancestor's
    size-rank slot (what app.js's topOf/slotMap resolves to within one scope),
    faded 14% per ring toward the page, capped 45%; "smaller items" gets REST. */
function sunburstMarks(root: SunNode, rings: number): Mark[] {
  const surface = hexRgb(SURFACE);
  const fill = (slot: number | null, depth: number) =>
    cssRgb(
      mixRgb(
        hexRgb(slot === null ? REST : SLOTS[slot % SLOTS.length]),
        surface,
        Math.min(0.14 * (depth - 1), 0.45)
      )
    );

  const marks: Mark[] = [];
  (function ring(n: SunNode, a0: number, a1: number, depth: number, slot: number | null) {
    if (depth > rings || !n.total) return;
    let a = a0;
    let rank = 0;
    for (const e of entriesOf(n)) {
      const span = (a1 - a0) * (e.size / n.total);
      // rank advances for every non-rest depth-1 entry, drawn or not — stable hues
      const s = e.rest ? null : depth === 1 ? rank++ : slot;
      if (span >= 0.006) {
        marks.push({ a0: a, a1: a + span, depth, fill: fill(s, depth) });
        if (e.isDir && e.node && span > 0.02) ring(e.node, a, a + span, depth + 1, s);
      }
      a += span;
    }
  })(root, -Math.PI / 2, 1.5 * Math.PI, 1, null);
  return marks;
}

const degOf = (rad: number) => ((rad + Math.PI / 2) * 180) / Math.PI; // conic 0deg = top

/** One ring's wedges → conic-gradient stops. Adjacent same-fill wedges coalesce
    and touching wedges transition color-to-color directly — a bg stop between
    every wedge would rasterize as a hairline seam, striping ranks of slivers
    that the canvas explorer renders as one solid block. bg fills only real gaps. */
const grad = (wedges: Mark[]) => {
  const merged: { from: number; to: number; fill: string }[] = [];
  for (const w of wedges) {
    const prev = merged[merged.length - 1];
    if (prev && prev.fill === w.fill && degOf(w.a0) - prev.to < 0.01) prev.to = degOf(w.a1);
    else merged.push({ from: degOf(w.a0), to: degOf(w.a1), fill: w.fill });
  }
  const stops: string[] = [];
  let pos = 0;
  for (const m of merged) {
    if (m.from > pos + 0.01)
      stops.push(`${C.bg} ${pos.toFixed(3)}deg`, `${C.bg} ${m.from.toFixed(3)}deg`);
    stops.push(`${m.fill} ${m.from.toFixed(3)}deg`, `${m.fill} ${m.to.toFixed(3)}deg`);
    pos = m.to;
  }
  if (pos < 360) stops.push(`${C.bg} ${pos.toFixed(3)}deg`, `${C.bg} 360deg`);
  return `conic-gradient(from 0deg, ${stops.join(", ")})`;
};

function sunburst(prefix: string, subtree: SubtreeEntry[], items: number, size: string): Node {
  const S = 310;
  const R = S / 2;
  const r0 = 68; // center hole — sized for the two-line total, not app.js's R*0.22
  const root = buildTree(subtree, prefix);
  const rings = visibleDepth(root);
  const band = (R - r0) / rings;
  const marks = sunburstMarks(root, rings);

  const circle = (d: number, style: Style, children?: Node[]) =>
    box(
      {
        position: "absolute",
        left: (S - d) / 2,
        top: (S - d) / 2,
        width: d,
        height: d,
        borderRadius: d / 2,
        ...style,
      },
      children
    );

  // outermost ring first; a bg circle under each shallower ring leaves the 1px seam
  const depths = [...new Set(marks.map((m) => m.depth))].sort((a, b) => b - a);
  const layers = depths.flatMap((d) => [
    circle(2 * (r0 + d * band - 1), {
      backgroundImage: grad(marks.filter((m) => m.depth === d)),
    }),
    ...(d > 1 ? [circle(2 * (r0 + (d - 1) * band), { backgroundColor: C.bg })] : []),
  ]);

  return box({ position: "relative", width: S, height: S }, [
    ...(marks.length ? layers : [circle(2 * (r0 + band - 1), { backgroundColor: C.card })]),
    circle(
      2 * r0,
      {
        backgroundColor: C.bg,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 4,
      },
      [
        text(`${items} item${items === 1 ? "" : "s"}`, {
          fontSize: 27,
          fontWeight: 600,
          color: C.ink,
        }),
        ...(size ? [text(size, { fontSize: 22, color: C.dim })] : []),
      ]
    ),
  ]);
}

/** Deterministic middle-truncation — takumi has no text-overflow ellipsis knob to lean on. */
const trunc = (s: string, max: number) =>
  s.length <= max ? s : `${s.slice(0, max - 8)}…${s.slice(-7)}`;

/** One listing row, mirroring the folder page: name, badge, size. */
function row(name: string, badge: string, hue: string | null, size: string): Node {
  return box(
    {
      display: "flex",
      flexDirection: "row",
      alignItems: "center",
      gap: 20,
      height: 66,
      paddingLeft: 28,
      paddingRight: 28,
      borderTop: `2px solid ${C.line}`,
    },
    [
      box({ display: "flex", flexGrow: 1, overflow: "hidden" }, [
        text(trunc(name, 24), { fontSize: 27, color: C.ink, whiteSpace: "nowrap" }),
      ]),
      box(
        {
          display: "flex",
          borderRadius: 8,
          paddingTop: 7,
          paddingBottom: 7,
          paddingLeft: 10,
          paddingRight: 10,
          // `undefined` must not cross the wasm boundary (serde sees a unit type)
          ...(hue ? { backgroundColor: hue } : { border: `2px solid ${C.line2}` }),
        },
        [
          text(badge.toUpperCase(), {
            fontSize: 16,
            fontWeight: 600,
            letterSpacing: 1,
            color: hue ? C.onBright : C.faint,
          }),
        ]
      ),
      box({ display: "flex", width: 96, justifyContent: "flex-end" }, [
        text(size, { fontSize: 22, color: C.dim }),
      ]),
    ]
  );
}

/** `host` is the request's — the card is stamped with the host that rendered it,
    so an unfurl of a preview link never advertises the production domain. */
export function folderCard(
  host: string,
  prefix: string,
  files: Entry[],
  folders: string[],
  subtree: SubtreeEntry[]
): Node {
  const parts = prefix.replace(/\/$/, "").split("/");
  const name = parts.pop() ?? prefix;
  const parent = parts.length ? `${parts.join(" / ")} /` : "";
  const items = folders.length + files.length;
  // hole totals come from the whole subtree — that's what the donut draws
  const subTotal = subtree.reduce((n, e) => n + e.size, 0);

  // The listing panel — the folder page in miniature: subfolders first, then
  // files in the page's order (numeric-aware name sort), capped to what fits.
  const sorted = [...files].sort((a, b) =>
    a.key.localeCompare(b.key, undefined, { numeric: true })
  );
  const MAX_ROWS = 7;
  const entries: Node[] = [
    ...folders.map((f) => row(`${f.slice(prefix.length).replace(/\/$/, "")}/`, "dir", null, "")),
    ...sorted.map((f) =>
      row(
        f.key.slice(prefix.length),
        f.ext || "file",
        BADGE[f.category] ?? BADGE.file,
        fmtSize(f.size)
      )
    ),
  ];
  const overflow = entries.length - MAX_ROWS;
  const rows =
    overflow > 0
      ? [
          ...entries.slice(0, MAX_ROWS - 1),
          box(
            {
              display: "flex",
              alignItems: "center",
              height: 66,
              paddingLeft: 28,
              borderTop: `2px solid ${C.line}`,
            },
            [text(`+ ${overflow + 1} more`, { fontSize: 25, color: C.faint })]
          ),
        ]
      : entries;

  const panel = box(
    {
      display: "flex",
      flexDirection: "column",
      width: 560,
      alignSelf: "flex-start", // hug the rows — a short list reads as a short list
      backgroundColor: C.card,
      border: `2px solid ${C.line2}`,
      borderRadius: 20,
      overflow: "hidden",
    },
    rows.length
      ? // cancel the first row's divider by pulling it under the panel edge
        [box({ display: "flex", flexDirection: "column", marginTop: -2 }, rows)]
      : [
          box({ display: "flex", height: 160, alignItems: "center", justifyContent: "center" }, [
            text("Empty folder.", { fontSize: 26, color: C.faint }),
          ]),
        ]
  );

  // Big-name size steps down for long folder names (the left column is ~460px).
  const nameSize = name.length <= 12 ? 64 : name.length <= 20 ? 48 : 38;

  return box(
    {
      display: "flex",
      flexDirection: "row",
      width: "100%",
      height: "100%",
      padding: 64,
      gap: 48,
      backgroundColor: C.bg,
      fontFamily: "Inter",
    },
    [
      // identity column: name top-left → sunburst → brand stamped bottom-left
      box({ display: "flex", flexDirection: "column", flexGrow: 1 }, [
        box({ display: "flex", flexDirection: "column", gap: 8 }, [
          ...(parent ? [text(trunc(parent, 34), { fontSize: 26, color: C.faint })] : []),
          text(`${trunc(name, 28)}/`, { fontSize: nameSize, fontWeight: 600, color: C.ink }),
        ]),
        box(
          {
            display: "flex",
            flexGrow: 1,
            alignItems: "center",
            justifyContent: "center",
            marginTop: 8,
            marginBottom: 8,
          },
          [sunburst(prefix, subtree, items, subTotal ? fmtSize(subTotal) : "")]
        ),
        text(host, { fontSize: 26, fontWeight: 600, color: C.faint }),
      ]),
      // listing column: the folder page in miniature
      panel,
    ]
  );
}
