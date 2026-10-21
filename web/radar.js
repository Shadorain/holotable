// Table view centre: an animated radar. Zones are sectors (centre = zone.angle, 0° up, clockwise);
// rings are lifecycle stages from outside in: queue, planning, active, complete. Landed contacts
// leave the scope and only count in the hub. One canvas; the static well is prerendered offscreen
// on resize or layout change, then each frame blits it and draws sweep + blips.
import { needsYou, stateLabel } from "./ui.js";

/** Hub radius as a share of R; contacts never sit inside 0.17 R. */
const HUB = 0.15;
const TAU = Math.PI * 2;
const SWEEP_MS = 6000;
const TRAIL = 1.15; // radians of fading trail behind the sweep head
const FLARE_DECAY = 0.0011; // per ms
const FRAME_MS = 1000 / 30;
const HIT_PX = 12;

// Ring per lifecycle stage, outside in, as a fraction of the scope radius.
const RING_R = [0.78, 0.61, 0.44, 0.27];
const STATE_RING = {
  ready: 0, blocked: 0, decision: 0,
  planning: 1,
  running: 2, verify: 2, review: 2, hold: 2, conflict: 2, offline: 2, waiting: 2,
  complete: 3,
};
// State -> CSS variable name; the palette lives in :root only.
const STATE_VAR = {
  ready: "--accent", blocked: "--dim", decision: "--decide", planning: "--run",
  running: "--run", verify: "--info", review: "--info", hold: "--warn", conflict: "--bad",
  offline: "--dim", waiting: "--dim", complete: "--ok",
};

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
// Radar angle (0 up, clockwise) -> canvas angle (0 east, clockwise).
const cAng = (a) => a - Math.PI / 2;
const point = (cx, cy, a, r) => [cx + Math.sin(a) * r, cy - Math.cos(a) * r];

// Palette values come from CSS variables: hex like "#0a141a" or "rgb(a)(…)" both work.
const rgba = (color, alpha) => {
  const rgb = /^#([0-9a-f]{3,8})$/i.exec(color)?.[1];
  if (rgb) {
    const n = parseInt(rgb.length <= 4 ? [...rgb].map((c) => c + c).join("").slice(0, 6) : rgb.slice(0, 6), 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
  }
  const parts = /rgba?\(([^)]+)\)/.exec(color)?.[1].split(/[\s,/]+/).filter(Boolean);
  if (parts && parts.length >= 3) return `rgba(${parts[0]},${parts[1]},${parts[2]},${alpha})`;
  return color;
};

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

export function createRadar(stage, opts) {
  const canvas = document.createElement("canvas");
  canvas.className = "radar-canvas";
  canvas.setAttribute("role", "img");
  canvas.setAttribute("aria-label", "Radar");
  stage.append(canvas);
  const ctx = canvas.getContext("2d");

  const mq = matchMedia("(prefers-reduced-motion: reduce)");
  const bg = document.createElement("canvas");

  let pal = null;
  let W = 0, H = 0, dpr = 1, cx = 0, cy = 0, R = 0;
  let P = null; // last projection
  let selected = null;
  let hovered = null;
  let zoneRects = []; // zone label pills in the static layer; blip labels must not overlap them
  let blips = []; // {c, a, x, y, rr, tw, flare}
  let liveN = 0, queueN = 0, landedN = 0, needsN = 0;
  let staticSig = "";
  let staticReady = false;
  let running = false;
  let active = false;
  let raf = 0;
  let lastFrame = 0;
  let lastT = 0;
  let sweep = Math.random() * TAU;

  function readPalette() {
    const s = getComputedStyle(document.documentElement);
    const get = (name, fallback) => s.getPropertyValue(name).trim() || fallback;
    pal = {};
    for (const v of ["--text", "--muted", "--dim", "--accent", "--ok", "--warn", "--bad", "--info", "--run", "--decide", "--glow", "--line", "--line-2", "--panel"])
      pal[v] = get(v, "#8a9aa2");
    // Theme hooks for the dish itself; canvas needs real colours, not color-mix.
    for (const v of ["--well-inner", "--well-outer", "--rim", "--tooltip-bg"]) pal[v] = get(v, pal["--panel"] ?? "#0f1a20");
    return pal;
  }

  /** Recompute blip geometry from P and the current canvas size. */
  function relayout() {
    blips = [];
    liveN = queueN = landedN = needsN = 0;
    if (!P) return;
    for (const c of P.contacts) {
      if (c.state === "landed") landedN++;
      else if (c.group === "queue") queueN++;
      else liveN++;
      if (c.attention && c.state !== "landed") needsN++;
    }
    canvas.setAttribute(
      "aria-label",
      `Radar: ${liveN} started, ${queueN} queued, ${needsYou(needsN)}, ${landedN} landed.`,
    );
    if (R < 24) return;
    const zones = P.operation.zones;
    if (!zones.length) return;
    const sector = 360 / zones.length;
    const margin = Math.min(sector * 0.16, 8) * (Math.PI / 180);
    const gapPx = Math.max(16, R * 0.062);
    ctx.font = `${clamp(R * 0.034, 9.5, 12.5)}px Inter, system-ui, sans-serif`;
    const blipFont = ctx.font;
    ctx.font = zoneFont();
    const pills = new Map(zones.map((z) => [z.id, zonePill(ctx, z)]));
    ctx.font = blipFont;
    for (const zone of zones) {
      const pill = pills.get(zone.id);
      const centre = zone.angle * (Math.PI / 180);
      const avail = sector * (Math.PI / 180) - margin * 2;
      for (let ring = 0; ring < 4; ring++) {
        const members = P.contacts.filter((c) => c.zone === zone.id && c.state !== "landed" && STATE_RING[c.state] === ring);
        if (!members.length) continue;
        const rr0 = RING_R[ring] * R;
        const lanes = members.length > 12 ? 4 : members.length > 6 ? 3 : members.length > 3 ? 2 : 1;
        const laneMembers = Math.ceil(members.length / lanes);
        // Spread a ring's blips a label apart when the sector has room, so ticket labels don't collide.
        const labelGap = Math.max(gapPx, ...members.map((c) => ctx.measureText(c.ticket).width + 16));
        const step = Math.min(clamp(labelGap / rr0, 0, Math.PI), Math.max(avail, laneMembers > 1 ? 0.02 : 0) / Math.max(1, laneMembers - 1));
        const span = step * (laneMembers - 1);
        members.forEach((c, i) => {
          const laneIdx = Math.floor(i / lanes);
          const laneId = i % lanes;
          const a = centre - span / 2 + step * laneIdx;
          let stagger = 0;
          if (lanes === 2) stagger = (laneId === 0 ? 1 : -1) * R * 0.03;
          else if (lanes === 3) stagger = (laneId === 0 ? 0 : laneId === 1 ? 1 : -1) * R * 0.035;
          else if (lanes >= 4) stagger = (laneId === 0 ? 1.5 : laneId === 1 ? 0.5 : laneId === 2 ? -0.5 : -1.5) * R * 0.025;
          let rr = clamp(rr0 + stagger, R * 0.17, R * 0.86);
          const tw = ctx.measureText(c.ticket).width;
          // A blip (dot plus its label) never sits on its zone's label pill: step it inward until clear.
          for (let k = 0; k < 20 && hitsPill(pill, point(cx, cy, a, rr), tw); k++) rr = Math.max(R * 0.17, rr - 4);
          const [x, y] = point(cx, cy, a, rr);
          blips.push({ c, a, x, y, rr, tw, flare: 0 });
        });
      }
    }
  }

  function hitsPill(pill, [x, y], tw) {
    const pad = 4;
    // The dot plus its ticket text, which frame() may put on either side of it.
    const left = x - 12 - tw - pad, right = x + 12 + tw + pad, top = y - 9 - pad, bottom = y + 9 + pad;
    return left < pill.x + pill.w && right > pill.x && top < pill.y + pill.h && bottom > pill.y;
  }

  /** Where a zone's label pill sits: just inside the rim, pulled in until its corners fit. Uses g's font. */
  function zonePill(g, zone) {
    const [px, py] = point(cx, cy, zone.angle * (Math.PI / 180), R * 0.9);
    const w = g.measureText(zone.label.toUpperCase()).width + 14;
    let zx = px;
    let zy = py;
    const inside = (x, y) => Math.hypot(x - cx, y - cy) < R * 0.96;
    for (let k = 0; k < 30; k++) {
      if (inside(zx - w / 2, zy - 9) && inside(zx + w / 2, zy - 9) && inside(zx - w / 2, zy + 9) && inside(zx + w / 2, zy + 9)) break;
      zx = cx + (zx - cx) * 0.96;
      zy = cy + (zy - cy) * 0.96;
    }
    return { x: zx - w / 2, y: zy - 9, w, h: 18, cx: zx, cy: zy };
  }
  const zoneFont = () => `600 ${clamp(R * 0.033, 9, 12)}px Inter, system-ui, sans-serif`;

  /** Offscreen layer: well, rings, sector dividers, zone labels, rim ticks, hub bezel. */
  function drawStatic() {
    bg.width = Math.ceil(W * dpr);
    bg.height = Math.ceil(H * dpr);
    const g = bg.getContext("2d");
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    if (!pal) readPalette();
    const zones = P?.operation.zones ?? [];

    // Well: dark dish, faint light from the middle.
    let grad = g.createRadialGradient(cx, cy - R * 0.06, R * 0.05, cx, cy, R);
    grad.addColorStop(0, rgba(pal["--glow"], 0.10));
    grad.addColorStop(0.55, rgba(pal["--well-inner"], 0.72));
    grad.addColorStop(1, rgba(pal["--well-outer"], 0.95));
    g.fillStyle = grad;
    g.beginPath();
    g.arc(cx, cy, R, 0, TAU);
    g.fill();

    // Rim band.
    g.lineWidth = Math.max(2, R * 0.016);
    g.strokeStyle = rgba(pal["--rim"], 0.9);
    g.beginPath();
    g.arc(cx, cy, R - g.lineWidth / 2, 0, TAU);
    g.stroke();

    // Range rings at the stage radii; queue ring dashed.
    g.lineWidth = 1;
    for (let ring = 0; ring < 4; ring++) {
      g.setLineDash(ring === 0 ? [4, 5] : []);
      g.strokeStyle = ring === 0 ? rgba(pal["--warn"], 0.30) : rgba(pal["--muted"], 0.13);
      g.beginPath();
      g.arc(cx, cy, RING_R[ring] * R, 0, TAU);
      g.stroke();
    }
    g.setLineDash([]);

    // Sector dividers and rim ticks.
    const sector = zones.length ? (TAU / zones.length) : 0;
    g.strokeStyle = rgba(pal["--muted"], 0.10);
    for (const zone of zones) {
      const a = zone.angle * (Math.PI / 180);
      for (const edge of [a - sector / 2, a + sector / 2]) {
        const [x0, y0] = point(cx, cy, edge, R * 0.15);
        const [x1, y1] = point(cx, cy, edge, R * 0.97);
        g.beginPath();
        g.moveTo(x0, y0);
        g.lineTo(x1, y1);
        g.stroke();
      }
    }
    // Tick marks: heavy every 30°, light every 6°.
    for (let deg = 0; deg < 360; deg += 6) {
      const major = deg % 30 === 0;
      const a = (deg * Math.PI) / 180;
      const [x0, y0] = point(cx, cy, a, R * (major ? 0.945 : 0.965));
      const [x1, y1] = point(cx, cy, a, R * 0.988);
      g.lineWidth = major ? 1.4 : 0.8;
      g.strokeStyle = rgba(pal["--muted"], major ? 0.42 : 0.2);
      g.beginPath();
      g.moveTo(x0, y0);
      g.lineTo(x1, y1);
      g.stroke();
    }

    // Zone labels just inside the rim; rects are kept so blip labels route around them.
    zoneRects = [];
    if (zones.length) {
      g.font = zoneFont();
      g.textAlign = "center";
      g.textBaseline = "middle";
      for (const zone of zones) {
        const label = zone.label.toUpperCase();
        const { x: px0, w, cx: zx, cy: zy } = zonePill(g, zone);
        zoneRects.push({ x: px0, y: zy - 9, w, h: 18 });
        g.fillStyle = rgba(pal["--panel"], 0.85);
        g.strokeStyle = rgba(pal["--line-2"], 0.8);
        g.lineWidth = 1;
        roundRect(g, zx - w / 2, zy - 9, w, 18, 9);
        g.fill();
        g.stroke();
        g.fillStyle = rgba(pal["--muted"], 0.95);
        g.fillText(label, zx, zy + 0.5);
      }
    }

    // Hub bezel.
    g.fillStyle = rgba(pal["--panel"], 0.85);
    g.strokeStyle = rgba(pal["--line-2"], 0.7);
    g.lineWidth = 1;
    g.beginPath();
    g.arc(cx, cy, R * HUB, 0, TAU);
    g.fill();
    g.stroke();
    staticReady = true;
  }

  /** Links for the selected contact: blockers, dependents, conflict edge. */
  function linksFor(sel) {
    const out = [];
    if (!sel || !P) return out;
    const byTicket = new Map(blips.map((b) => [b.c.ticket, b]));
    for (const b of sel.c.blockedBy ?? [])
      if (byTicket.has(b.ticket)) out.push({ to: byTicket.get(b.ticket), kind: "blocker" });
    for (const b of blips) {
      if (b === sel) continue;
      if (b.c.blockedBy?.some((x) => x.ticket === sel.c.ticket)) out.push({ to: b, kind: "dependent" });
      if (b.c.conflictOf === sel.c.ticket || sel.c.conflictOf === b.c.ticket) out.push({ to: b, kind: "conflict" });
    }
    return out;
  }

  function frame(t) {
    const dt = lastT ? Math.min(100, t - lastT) : 0;
    lastT = t;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    if (R < 24) return;
    const sig = `${W}x${H}@${dpr}|${P ? P.operation.zones.map((z) => `${z.id}${z.angle}`).join(",") : ""}`;
    if (sig !== staticSig) {
      staticSig = sig;
      staticReady = false;
    }
    if (!staticReady) drawStatic();
    ctx.drawImage(bg, 0, 0, W, H);

    const motion = animates();
    if (motion) sweep = (sweep + (dt * TAU) / SWEEP_MS) % TAU;

    // Sweep trail + head.
    if (!mq.matches) {
      ctx.save();
      ctx.beginPath();
      ctx.arc(cx, cy, R * 0.985, 0, TAU);
      ctx.clip();
      const slices = 46;
      ctx.fillStyle = rgba(pal["--accent"], 0.05);
      for (let i = 0; i < slices; i++) {
        const a0 = sweep - TRAIL + (TRAIL * i) / slices;
        ctx.globalAlpha = (i / slices) * 0.9;
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.arc(cx, cy, R, cAng(a0), cAng(a0 + TRAIL / slices + 0.004));
        ctx.closePath();
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      ctx.restore();
      // Leading edge.
      const [hx, hy] = point(cx, cy, sweep, R * 0.985);
      const grad = ctx.createLinearGradient(cx, cy, hx, hy);
      grad.addColorStop(0, rgba(pal["--accent"], 0));
      grad.addColorStop(1, rgba(pal["--accent"], 0.5));
      ctx.strokeStyle = grad;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(hx, hy);
      ctx.stroke();
    }

    // Flare: the sweep head just passed the blip; it decays out.
    for (const b of blips) {
      if (motion) {
        let d = sweep - b.a;
        d = ((d % TAU) + TAU) % TAU;
        if (d < TRAIL) b.flare = Math.max(b.flare, 1 - d / TRAIL);
        b.flare = Math.max(0, b.flare - dt * FLARE_DECAY);
      }
    }

    // Dependency lines for the selection.
    const sel = blips.find((b) => b.c.ticket === selected) ?? null;
    if (sel) {
      for (const link of linksFor(sel)) {
        ctx.strokeStyle = link.kind === "conflict" ? rgba(pal["--bad"], 0.75) : rgba(pal["--accent"], 0.45);
        ctx.lineWidth = 1;
        ctx.setLineDash(link.kind === "blocker" ? [4, 4] : link.kind === "conflict" ? [3, 4] : []);
        ctx.beginPath();
        ctx.moveTo(sel.x, sel.y);
        ctx.lineTo(link.to.x, link.to.y);
        ctx.stroke();
      }
      ctx.setLineDash([]);
    }

    // Blips.
    const showLabels = R >= 175;
    const blipR = clamp(R * 0.014, 3.2, 5.2);
    ctx.textBaseline = "middle";
    ctx.font = `${clamp(R * 0.034, 9.5, 12.5)}px Inter, system-ui, sans-serif`;
    for (const b of blips) {
      const c = b.c;
      const color = pal[STATE_VAR[c.state]] ?? pal["--muted"];
      const isSel = c.ticket === selected;
      const isHover = c.ticket === hovered;
      const glow = b.flare;

      if (c.attention && !mq.matches) {
        const pulse = (t % 1600) / 1600;
        ctx.strokeStyle = rgba(color, 0.55 * (1 - pulse));
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.arc(b.x, b.y, blipR + 2 + pulse * 8, 0, TAU);
        ctx.stroke();
      } else if (c.attention) {
        ctx.strokeStyle = rgba(color, 0.5);
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.arc(b.x, b.y, blipR + 5, 0, TAU);
        ctx.stroke();
      }

      if (glow > 0.01) {
        ctx.fillStyle = rgba(color, 0.28 * glow);
        ctx.beginPath();
        ctx.arc(b.x, b.y, blipR + 6 * glow, 0, TAU);
        ctx.fill();
      }

      const r = blipR * (1 + 0.45 * glow) + (isSel ? 0.6 : 0);
      ctx.beginPath();
      ctx.arc(b.x, b.y, r, 0, TAU);
      // Hollow means "waiting its turn"; a decision is waiting on you, so it stays filled.
      if (c.group === "queue" && c.state !== "decision") {
        ctx.fillStyle = rgba(pal["--well-inner"], 0.9);
        ctx.fill();
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.4;
        ctx.stroke();
      } else {
        ctx.fillStyle = color;
        ctx.fill();
        if (isSel || isHover) {
          ctx.strokeStyle = rgba(pal["--text"], 0.7);
          ctx.lineWidth = 1;
          ctx.stroke();
        }
      }
      if (isSel) {
        ctx.strokeStyle = pal["--accent"];
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.arc(b.x, b.y, r + 4, 0, TAU);
        ctx.stroke();
      }
    }

    // Labels in a second pass: placed against the rim, other blips and already-placed labels.
    const placed = [];
    const labelFont = `${clamp(R * 0.034, 9.5, 12.5)}px Inter, system-ui, sans-serif`;
    const labelH = clamp(R * 0.034, 9.5, 12.5) + 4;
    const fits = (x, y, w) =>
      Math.hypot(x - cx, y - labelH / 2 - cy) < R * 0.92 &&
      Math.hypot(x + w - cx, y - labelH / 2 - cy) < R * 0.92 &&
      Math.hypot(x - cx, y + labelH / 2 - cy) < R * 0.92 &&
      Math.hypot(x + w - cx, y + labelH / 2 - cy) < R * 0.92;
    const clear = (x, y, w, self) => {
      for (const o of blips)
        if (o !== self && x < o.x + 10 && x + w > o.x - 10 && y < o.y + 9 && y + labelH > o.y - 9) return false;
      for (const p of placed)
        if (x < p.x + p.w && x + w > p.x && y < p.y + labelH && y + labelH > p.y) return false;
      for (const z of zoneRects)
        if (x < z.x + z.w && x + w > z.x && y < z.y + z.h && y + labelH > z.y) return false;
      return true;
    };
    const selBlip = blips.find((b) => b.c.ticket === selected);
    const selDeps = new Set();
    if (selBlip) {
      for (const l of linksFor(selBlip)) selDeps.add(l.to.c.ticket);
    }
    const priority = (c) => {
      if (c.ticket === selected || c.ticket === hovered) return 3;
      if (selDeps.has(c.ticket)) return 2;
      return c.attention ? 1 : 0;
    };
    const labelsToPlace = [...blips].sort((a, b) => priority(b.c) - priority(a.c));
    for (const b of labelsToPlace) {
      const isSel = b.c.ticket === selected;
      const isHover = b.c.ticket === hovered;
      const isDep = selDeps.has(b.c.ticket);
      if (!(showLabels || isSel || isHover || isDep)) continue;
      const w = b.tw + 6;
      // Candidates: right, left, below, above the blip, then the four diagonals for crowded clusters.
      const mid = b.y - labelH / 2;
      const cands = [
        [b.x + 8, mid, w],
        [b.x - 8 - w, mid, w],
        [b.x - w / 2, b.y + blipR + 4, w],
        [b.x - w / 2, b.y - blipR - 4 - labelH, w],
        [b.x + 6, mid - labelH, w],
        [b.x + 6, mid + labelH, w],
        [b.x - 6 - w, mid - labelH, w],
        [b.x - 6 - w, mid + labelH, w],
      ];
      let spot = null;
      for (const [x, y, cw] of cands) {
        if (fits(x, y, cw) && clear(x, y, cw, b)) {
          spot = [x, y];
          break;
        }
      }
      if (!spot && (isSel || isHover)) {
        const [x, y] = cands[0];
        spot = [x, y];
      }
      if (!spot) continue;
      placed.push({ x: spot[0], y: spot[1], w });
      ctx.textAlign = "left";
      ctx.font = labelFont;
      ctx.fillStyle = isSel ? pal["--text"] : isHover ? pal["--accent"] : rgba(pal["--muted"], 0.9);
      ctx.fillText(b.c.ticket, spot[0] + 3, spot[1] + labelH / 2);
    }

    // Hover tooltip: ticket, title, state.
    if (hovered) {
      const hb = blips.find((b) => b.c.ticket === hovered);
      if (hb) {
        const word = stateLabel(hb.c);
        const line1 = hb.c.ticket;
        const line2 = `${hb.c.title ?? "—"} · ${word}`;
        ctx.font = `600 12px Inter, system-ui, sans-serif`;
        const w1 = ctx.measureText(line1).width;
        ctx.font = `11px Inter, system-ui, sans-serif`;
        const w2 = ctx.measureText(line2).width;
        const tw = Math.max(w1, w2) + 18;
        const th = 38;
        let tx = hb.x + 12;
        let ty = hb.y - th - 10;
        if (tx + tw > W - 12) tx = hb.x - tw - 12;
        if (tx < 12) tx = 12;
        if (ty < 12) ty = hb.y + 12;
        if (ty + th > H - 12) ty = H - th - 12;
        ctx.fillStyle = rgba(pal["--tooltip-bg"], 0.95);
        ctx.strokeStyle = rgba(pal["--line-2"], 0.9);
        ctx.lineWidth = 1;
        roundRect(ctx, tx, ty, tw, th, 6);
        ctx.fill();
        ctx.stroke();
        ctx.textAlign = "left";
        ctx.fillStyle = pal["--text"];
        ctx.font = `600 12px Inter, system-ui, sans-serif`;
        ctx.fillText(line1, tx + 9, ty + 12);
        ctx.fillStyle = pal["--muted"];
        ctx.font = `11px Inter, system-ui, sans-serif`;
        ctx.fillText(line2, tx + 9, ty + 27);
      }
    }

    // Hub counts: short stacked lines so they read at real size inside the hub; shrink only as a last resort.
    const maxW = 2 * R * HUB - 14;
    const lines = [
      [`${liveN} started`, pal["--text"], 600],
      [`${queueN} queued`, pal["--muted"], 500],
      needsN ? [needsYou(needsN), pal["--warn"], 600] : [`${landedN} landed`, pal["--dim"], 500],
    ];
    const size = clamp(R * 0.042, 10, 15);
    const lineH = size * 1.25;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (const [i, [text, color, weight]] of lines.entries()) {
      ctx.font = `${weight} ${size}px Inter, system-ui, sans-serif`;
      const s = Math.min(1, maxW / ctx.measureText(text).width);
      ctx.save();
      ctx.translate(cx, cy + (i - 1) * lineH);
      ctx.scale(s, s);
      ctx.fillStyle = color;
      ctx.fillText(text, 0, 0);
      ctx.restore();
    }
    ctx.textBaseline = "alphabetic";
  }
  const needsMotion = () => P && (P.header.open > 0 || P.contacts.some((c) => c.attention));
  const visible = () => active && document.visibilityState === "visible";
  const animates = () => visible() && !mq.matches && needsMotion();
  const render_ = () => {
    if (visible()) frame(performance.now());
  };

  function loop(t) {
    raf = 0;
    if (!running || !animates()) {
      stop();
      return;
    }
    if (t - lastFrame >= FRAME_MS - 4) {
      lastFrame = t;
      frame(t);
    }
    raf = requestAnimationFrame(loop);
  }

  function start() {
    if (running || !animates()) return;
    running = true;
    lastT = 0;
    lastFrame = 0;
    raf = requestAnimationFrame(loop);
  }
  function stop() {
    running = false;
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
  }

  function hitTest(mx, my) {
    let best = null;
    let bestD = HIT_PX;
    for (const b of blips) {
      const d = Math.hypot(b.x - mx, b.y - my);
      if (d < bestD) {
        bestD = d;
        best = b;
      }
    }
    return best;
  }

  canvas.addEventListener("pointermove", (e) => {
    const rect = canvas.getBoundingClientRect();
    const b = hitTest(e.clientX - rect.left, e.clientY - rect.top);
    const next = b?.c.ticket ?? null;
    canvas.style.cursor = b ? "pointer" : "default";
    if (next !== hovered) {
      hovered = next;
      if (!running) render_();
    }
  });
  canvas.addEventListener("pointerleave", () => {
    canvas.style.cursor = "default";
    if (hovered !== null) {
      hovered = null;
      if (!running) render_();
    }
  });
  canvas.addEventListener("click", (e) => {
    const rect = canvas.getBoundingClientRect();
    const b = hitTest(e.clientX - rect.left, e.clientY - rect.top);
    if (b) opts.onSelect(b.c.ticket, e);
  });

  const ro = new ResizeObserver(() => {
    const rect = stage.getBoundingClientRect();
    dpr = Math.min(2.5, window.devicePixelRatio || 1);
    W = rect.width;
    H = rect.height;
    canvas.width = Math.max(1, Math.round(W * dpr));
    canvas.height = Math.max(1, Math.round(H * dpr));
    canvas.style.width = `${W}px`;
    canvas.style.height = `${H}px`;
    cx = W / 2;
    cy = H / 2;
    R = Math.min(W, H) / 2 - Math.max(8, Math.min(W, H) * 0.03);
    readPalette();
    relayout();
    staticReady = false;
    render_();
  });
  ro.observe(stage);
  // A theme change swaps every colour variable; repaint the dish and its cached layer.
  new MutationObserver(() => {
    readPalette();
    staticReady = false;
    render_();
  }).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  mq.addEventListener?.("change", () => {
    if (mq.matches) stop();
    render_();
    start();
  });
  document.addEventListener("visibilitychange", () => {
    if (!visible()) stop();
    render_();
    start();
  });

  return {
    /** Blip centres in CSS pixels, for keyboard navigation. */
    positions() {
      return blips.map((b) => ({ ticket: b.c.ticket, x: b.x, y: b.y }));
    },
    update(projection, sel) {
      P = projection;
      selected = sel;
      relayout();
      if (needsMotion()) start();
      else stop();
      if (!running) render_();
    },
    setActive(on) {
      if (active === Boolean(on)) return;
      active = Boolean(on);
      if (!visible()) stop();
      render_();
      start();
    },
  };
}
