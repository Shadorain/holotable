// Settings drawer: gear in the header opens a right-side panel over a scrim. It holds
// only board-wide settings — the operation's own fields live on the operation page
// (Plan view → Operation). Every control saves on change/blur through PUT /api/settings;
// a 400 shows its message under the field, a save toasts.
import { closePopoversWithin, el, numberField, segmented, textField } from "./components.js";
import { enumRow, field, numberRow, switchRow, textRow } from "./fields.js";
import { icon } from "./icons.js";
import { PORT_OPTIONS } from "./projectform.js";
import { errorText, fetchJson, sectionBox, titleCase } from "./ui.js";

const THEME_LABELS = { holo: "Holo", omp: "OMP", slate: "Slate" };


const CUSTOM_TEMPLATES = [
  [
    "custom.terminal",
    "Terminal",
    "Runs once per launch inside the contact's lane. Opens the pane that runs the mission. " +
      "{cwd}, {title} and {command} are replaced (shell-quoted). It must print the new pane's id as JSON.",
    'my-term spawn --cwd {cwd} --title {title} -- {command}  →  {"handle":"win-3","incarnationId":"7"}',
  ],
  [
    "custom.focus",
    "Focus",
    "Focus (the crosshair button) brings the pane to the front. {handle} is the id Terminal printed.",
    "my-term focus {handle}",
  ],
  [
    "custom.close",
    "Close",
    "Reap and cleanup close the lane's pane through this template. {handle} is the id Terminal printed.",
    "my-term close {handle}",
  ],
];

export function createSettingsDrawer({ api, applyTheme, toast, openHelp, openGuide, startTour }) {
  const scrim = document.getElementById("scrim");
  const drawer = document.getElementById("settings");
  const body = drawer.querySelector(".settings-body");
  const foot = drawer.querySelector(".settings-foot");
  let open = false;
  let settings = null; // last GET /api/settings payload
  let lastFocus = null;

  async function saveSetting(key, value, done) {
    try {
      const res = await api("/api/settings", { method: "PUT", body: JSON.stringify({ key, value: String(value) }) });
      const data = await fetchJson(res);
      settings = data;
      foot.textContent = `Saved to ${settings.path}`;
      if (key === "theme") applyTheme(settings.settings.theme);
      toast("Saved", "ok");
      done?.(null);
    } catch (error) {
      done?.(error);
    }
  }

  function section(title) {
    const s = sectionBox(title, { cls: "set-sec" }).root;
    body.append(s);
    return s;
  }

  // Intervals are stored in ms; the operator picks whether to read them in s or ms.
  let intervalUnit = localStorage.getItem("holotable.intervalUnit") === "ms" ? "ms" : "s";

  function unitToggle() {
    const box = el("span", "unit-toggle");
    box.setAttribute("role", "group");
    box.setAttribute("aria-label", "Interval unit");
    for (const unit of ["s", "ms"]) {
      const b = el("button", "", unit);
      b.type = "button";
      b.setAttribute("aria-pressed", String(unit === intervalUnit));
      b.title = unit === "s" ? "Show intervals in seconds" : "Show intervals in milliseconds";
      b.addEventListener("click", () => {
        if (unit === intervalUnit) return;
        intervalUnit = unit;
        localStorage.setItem("holotable.intervalUnit", unit);
        build();
        drawer.querySelector(`.unit-toggle button[aria-pressed="true"]`)?.focus();
      });
      box.append(b);
    }
    return box;
  }

  /** Interval saved in milliseconds, shown in the chosen unit. */
  function intervalRow(parent, title, key, ms, { note, minMs, maxMs } = {}) {
    const factor = intervalUnit === "s" ? 1000 : 1;
    const nf = numberField({ label: `${title} (${intervalUnit})`, value: ms / factor, min: minMs / factor, max: maxMs / factor, step: intervalUnit === "s" ? 1 : 500 });
    const control = el("span", "set-inline");
    control.append(nf.root, unitToggle());
    const f = field(parent, title, control, { note });
    nf.input.addEventListener("change", () => {
      f.setError(null);
      const next = Math.round(Number(nf.input.value) * factor);
      saveSetting(key, String(next), (error) => {
        if (error) {
          nf.input.value = String(ms / factor);
          f.setError(error);
        } else ms = next;
      });
    });
    return f;
  }

  function build() {
    body.replaceChildren();
    if (!settings) {
      body.append(el("div", "set-err big", "Settings are not available from this board yet."));
      return;
    }
    const s = settings.settings;

    // ---- Appearance ----
    let sec = section("Appearance");
    let themeField;
    const themeCtl = segmented({
      label: "Theme",
      options: (settings.themes?.length ? settings.themes : ["holo", "omp", "slate"]).map((value) => ({
        value,
        label: THEME_LABELS[value] ?? value,
      })),
      value: s.theme,
      onChange: (v) => {
        applyTheme(v); // instant; persisted below, reverted if the save fails
        themeField.setError(null);
        saveSetting("theme", v, (error) => {
          if (error) {
            applyTheme(s.theme);
            themeField.setError(error);
          } else s.theme = v;
        });
      },
    });
    themeField = field(sec, "Theme", themeCtl.root, { note: "Colours for the whole page." });

    // ---- Agents ----
    sec = section("Agents");
    {
      const machine = settings.machine;
      const nf = numberField({ label: "Max live agents", value: s.cap, min: 1, max: 64 });
      const f = field(sec, "Max live agents", nf.root, {
        note: "Live omp sessions the board runs at once, across all operations. 8 is the default.",
      });
      const warn = el("div", "set-warn");
      f.row.append(warn);
      // Each idle omp holds about 600 MB; say what the cap costs on this machine before it is a problem.
      const syncWarn = (cap) => {
        const need = cap * (machine?.ompGb ?? 0.6);
        const have = machine?.memoryGb;
        const tight = have !== undefined && need > have * 0.75;
        warn.hidden = cap <= 8 && !tight;
        warn.classList.toggle("bad", tight);
        warn.textContent = tight
          ? `${cap} sessions need about ${need.toFixed(1)} GB; this machine has ${have} GB. Expect swapping or omp sessions being killed.`
          : `${cap} sessions need about ${need.toFixed(1)} GB of memory${have !== undefined ? ` (this machine has ${have} GB)` : ""}.`;
      };
      syncWarn(s.cap);
      nf.input.addEventListener("input", () => syncWarn(Number(nf.input.value) || s.cap));
      nf.input.addEventListener("change", () => {
        f.setError(null);
        syncWarn(Number(nf.input.value) || s.cap);
        saveSetting("cap", nf.input.value, (error) => {
          if (error) {
            nf.input.value = String(s.cap);
            syncWarn(s.cap);
            f.setError(error);
          } else s.cap = Number(nf.input.value);
        });
      });
    }

    // ---- Polling ----
    sec = section("Polling");
    intervalRow(sec, "Mission status", "pollMs", s.pollMs, { minMs: 1000, maxMs: 60000,
      note: "How often the board reads each mission's status file and pings its session.",
    });
    intervalRow(sec, "Tracker and pull requests", "sampleMs", s.sampleMs, { minMs: 10000, maxMs: 600000,
      note: "How often it re-checks the tracker and pull requests (slower: these call Linear and GitHub).",
    });

    // ---- Server ----
    sec = section("Server");
    {
      const ACCESS_EXPLANATIONS = {
        local: "Only this machine can open the board (binds 127.0.0.1).",
        tailscale: "Only this machine and devices on your Tailscale network can open the board.",
        network: "Anyone on your local network or VPN can open the board (binds 0.0.0.0).",
      };

      const originWarn = el("div", "set-warn");
      originWarn.hidden = true;
      sec.append(originWarn);

      const checkOriginAllowed = () => {
        const curHost = window.location.hostname.toLowerCase();
        const curAccess = s.access || "tailscale";
        let allowed = true;
        if (curAccess === "local") {
          allowed = curHost === "127.0.0.1" || curHost === "localhost" || curHost === "::1";
        } else if (curAccess === "tailscale") {
          const isLoop = curHost === "127.0.0.1" || curHost === "localhost" || curHost === "::1";
          const octets = curHost.split(".").map(Number);
          const isTs = (octets.length === 4 && octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127) || curHost.endsWith(".ts.net") || curHost.endsWith(".ts.net.");
          allowed = isLoop || isTs;
        }
        // The page must be one of the board's served URLs: a port change, a port fallback, or a
        // narrower mode moves it even when the host stays allowed. Port 0 / unknown list: skip.
        if (allowed && settings.urls && settings.urls.length > 0) {
          const here = `${window.location.protocol}//${window.location.host}/`;
          allowed = settings.urls.some((u) => {
            try {
              return new URL(u).origin === new URL(here).origin;
            } catch {
              return false;
            }
          });
        }
        if (!allowed) {
          originWarn.hidden = false;
          originWarn.replaceChildren();
          const targetUrl = settings.urls?.[0] || `http://127.0.0.1:${s.port}/#${window.location.hash.slice(1)}`;
          originWarn.append(
            document.createTextNode("The board is no longer reachable at this page's address. Open it here instead: "),
          );
          const link = el("a", "set-link", targetUrl);
          link.href = targetUrl;
          originWarn.append(link);
        } else {
          originWarn.hidden = true;
        }
      };

      let accessField;
      const explainEl = el("div", "set-note", ACCESS_EXPLANATIONS[s.access] || ACCESS_EXPLANATIONS.tailscale);
      const accessCtl = segmented({
        label: "Who can open the board",
        options: [
          { value: "local", label: "This machine" },
          { value: "tailscale", label: "My Tailscale devices" },
          { value: "network", label: "My network" },
        ],
        value: s.access || "tailscale",
        onChange: (v) => {
          accessField.setError(null);
          explainEl.textContent = ACCESS_EXPLANATIONS[v] || "";
          saveSetting("access", v, (error) => {
            if (error) {
              explainEl.textContent = ACCESS_EXPLANATIONS[s.access] || "";
              accessField.setError(error);
            } else {
              s.access = v;
              buildUrls();
              checkOriginAllowed();
            }
          });
        },
      });

      const controlWrap = el("div", "set-access-wrap");
      controlWrap.append(accessCtl.root, explainEl);
      accessField = field(sec, "Who can open the board", controlWrap);

      numberRow(
        sec,
        "Port",
        "port",
        s.port,
        (key, value, done) => {
          saveSetting(key, value, (error) => {
            if (!error) {
              s.port = Number(value);
              buildUrls();
              checkOriginAllowed();
            }
            done?.(error);
          });
        },
        { min: 0, max: 65535, note: "Port 0 picks a free port. Changes apply immediately." },
      );

      const urlsContainer = el("div", "set-urls-wrap");
      sec.append(urlsContainer);

      const buildUrls = () => {
        urlsContainer.replaceChildren();
        const urlsList = settings.urls && settings.urls.length > 0 ? settings.urls : [];
        if (urlsList.length === 0) return;

        const heading = el("div", "set-name", "Board URLs");
        heading.style.marginTop = "10px";
        urlsContainer.append(heading);

        for (const u of urlsList) {
          const row = el("div", "set-inline");
          row.style.marginTop = "6px";
          row.style.display = "flex";
          row.style.alignItems = "center";
          row.style.justifyContent = "space-between";
          row.style.gap = "8px";

          const urlText = el("code", "mono", u);
          urlText.style.fontSize = "11.5px";
          urlText.style.overflow = "hidden";
          urlText.style.textOverflow = "ellipsis";
          urlText.style.whiteSpace = "nowrap";

          const copyBtn = el("button", "btn small", "Copy");
          copyBtn.type = "button";
          copyBtn.style.flexShrink = "0";
          copyBtn.addEventListener("click", () => {
            navigator.clipboard?.writeText(u).then(
              () => {
                copyBtn.textContent = "Copied!";
                setTimeout(() => {
                  copyBtn.textContent = "Copy";
                }, 2000);
                toast("Copied URL", "ok");
              },
              () => toast("Failed to copy", "error"),
            );
          });

          row.append(urlText, copyBtn);
          urlsContainer.append(row);
        }
      };

      buildUrls();
      checkOriginAllowed();
    }
    // ---- After landing ----
    sec = section("After landing");
    switchRow(sec, "Clean up landed lanes", "cleanup", s.cleanup !== false, saveSetting, {
      note: "When a contact lands, close its mission pane and remove its worktree.",
    });

    // ---- Defaults for new operations ----
    sec = section("Defaults for new operations");
    for (const kind of ["tracker", "fleet", "frontend", "delivery"])
      enumRow(sec, titleCase(kind), `defaults.${kind}`, PORT_OPTIONS[kind], s.defaults[kind], saveSetting);
    textRow(sec, "Worktree folder", "worktrees.root", s.worktrees.root, saveSetting, {
      mono: true,
      placeholder: "{repo}-holotable-{name}",
      note: "Template for lanes holotable creates itself (herdr, custom). {repo} {repoName} {name} expand; ~/ is allowed. Orca ignores it.",
    });

    // ---- Custom frontend templates (only while something uses them) ----
    if (settings.customInUse) {
      sec = section("Custom frontend");
      sec.append(
        el("div", "set-note", "Shell templates for the `custom` frontend. Each runs with `bash -lc`."),
      );
      for (const [key, title, explain, example] of CUSTOM_TEMPLATES) {
        const short = key.split(".")[1];
        const tf = textField({ label: title, value: s.custom?.[short] ?? "", placeholder: "not set", spellcheck: false });
        tf.input.classList.add("mono");
        const wrap = el("div", "set-tpl");
        wrap.append(tf.root);
        const note = el("div", "set-note");
        note.append(document.createTextNode(explain));
        note.append(el("code", "set-example", example));
        const f = field(sec, title, wrap, {});
        // field() owns the note slot; attach the explanation under the control.
        f.row.append(note);
        tf.input.addEventListener("change", () => {
          f.setError(null);
          saveSetting(key, tf.input.value, (error) => {
            if (error) {
              tf.input.value = s.custom?.[short] ?? "";
              f.setError(error);
            }
          });
        });
      }
    }

    // ---- Help ----
    sec = section("Help");
    const keys = el("button", "btn small");
    keys.type = "button";
    keys.append(icon("keyboard", { size: 13 }), document.createTextNode("Keyboard shortcuts"));
    keys.addEventListener("click", () => {
      close();
      openHelp();
    });
    field(sec, "Keys", keys, { note: "Press ? anywhere for the same list." });
    const guideRow = el("div", "list-tools left");
    const guide = el("button", "btn small");
    guide.type = "button";
    guide.append(icon("rocket", { size: 13 }), document.createTextNode("Getting started"));
    guide.addEventListener("click", () => {
      close();
      openGuide();
    });
    const tour = el("button", "btn small");
    tour.type = "button";
    tour.append(icon("map", { size: 13 }), document.createTextNode("Take the tour"));
    tour.addEventListener("click", () => {
      close();
      startTour();
    });
    guideRow.append(guide, tour);
    field(sec, "New here?", guideRow, { note: "Machine checks and the first campaign, step by step; or a walk through the header." });
  }

  /** Restore focus where the operator was; regions rebuild, so fall back to the gear. */
  function restoreFocus() {
    const target = lastFocus?.isConnected ? lastFocus : document.getElementById("settingsButton");
    target?.focus?.();
  }

  async function load() {
    body.replaceChildren(el("div", "set-note", "Loading…"));
    foot.textContent = "";
    try {
      const res = await api("/api/settings");
      const data = await fetchJson(res);
      settings = data;
      applyTheme(settings.settings.theme);
      foot.textContent = settings.path;
    } catch (error) {
      settings = null;
      body.replaceChildren();
      body.append(el("div", "set-err big", `Cannot load settings: ${error instanceof Error ? error.message : error}`));
      return;
    }
    build();
  }

  function trapTab(e) {
    const items = [...drawer.querySelectorAll(FOCUSABLE)].filter((n) => n.offsetParent !== null);
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && (document.activeElement === first || !drawer.contains(document.activeElement))) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  function onKeydown(e) {
    if (!open || e.defaultPrevented) return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if (e.key === "Tab") trapTab(e);
  }

  function show() {
    if (open) return;
    open = true;
    lastFocus = document.activeElement;
    scrim.hidden = false;
    drawer.hidden = false;
    drawer.dataset.open = "1";
    document.addEventListener("keydown", onKeydown);
    load();
    drawer.querySelector(".settings-close").focus();
  }

  function close() {
    if (!open) return;
    open = false;
    closePopoversWithin(drawer, { focus: false });
    scrim.hidden = true;
    drawer.hidden = true;
    delete drawer.dataset.open;
    document.removeEventListener("keydown", onKeydown);
    restoreFocus();
    lastFocus = null;
  }

  scrim.addEventListener("click", close);
  drawer.querySelector(".settings-close").addEventListener("click", close);
  return { open: show, close, isOpen: () => open };
}
