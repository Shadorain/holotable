# Architecture

The board is a standalone Bun service (`bin/holotable.ts serve`, usually a systemd user unit) that owns campaign data (operations, contacts, zones, queue, events), the HTTP board and the watcher. The OMP host adapter runs explicit `/holotable` commands through the bundled CLI; its model tools, completions and passive status use the host-agnostic core (`src/plugin/`) in-process. The host reads the running service rather than owning it. Everything stack-specific sits behind four optional ports.

Automatic startup and the OMP CLI adapter resolve `bun` from `PATH`; they never treat OMP's `process.execPath` as a Bun interpreter (OMP may be a compiled executable). The adapter invokes the checkout's own `bin/holotable.ts`, avoiding a mismatched global CLI version. A missing Bun produces an installation error before any process or service is started. Detached spawn waits for spawn/error, unreferences the child and closes the parent's log descriptor.

The installed Linux unit bounds its cgroup (board plus CLI subprocesses): `CPUQuota=25%`, `MemoryHigh=256M`, `MemoryMax=512M`, `TasksMax=64`, `Nice=10`. Stop timeout is 15 s; failure restarts wait 10 s and are limited to three starts in 300 s. Orca/herdr mission panes run outside that cgroup. Direct/detached `serve` has no systemd resource ceiling.

```mermaid
flowchart LR
  subgraph store[$OMP_HOLOTABLE_HOME]
    OP[operation.json<br/>intent]
    EV[events.jsonl<br/>append-only]
  end
  subgraph core[src/core, pure]
    FOLD[foldEvents] --> PROJ[project]
    STATS[computeStats] --> PROJ
    POL[policy: state, refusals, actions] --> PROJ
  end
  subgraph ports[src/adapters]
    TR[Tracker] --- FL[Fleet] --- FE[Frontend] --- DL[Delivery]
  end
  WATCH[watcher<br/>poll, ping, sample] --> EV
  FL -->|status files| WATCH
  OP --> PROJ
  EV --> FOLD
  PROJ -->|Projection JSON| WEB[web: Board, Table]
  WEB -->|operator click| ACT[actions.ts]
  ACT --> FL
  ACT --> FE
  ACT --> DL
  ACT --> EV
```

## Layers

|Layer|Rule|
|---|---|
|`src/core/`|pure: no `node:*`, no `process.env`, no `Date.now()` (the clock is an argument), no I/O|
|`src/store/`|the only code that touches `$OMP_HOLOTABLE_HOME`|
|`src/adapters/`|the only code that spawns processes or opens sockets; spawns go through the injected `Run`|
|`src/runtime/`|watcher, launcher, actions, lander, auto mode (`auto.ts`), post-land cleanup (`cleanup.ts`), end-of-operation wind-down (`winddown.ts`, `end.ts`): orchestration over ports and store|
|`src/service.ts`|the standalone board owner: lock, server, watcher loop, token; used by `bin/holotable.ts` and the tests|
|`bin/holotable.ts`|the CLI: `start`, `stop`, `restart`, `status`, `url`, foreground `serve`, Linux default-home `install`/`uninstall`, and shared store commands; global `--home`, `--json`, `--current` precede the command|
|`src/plugin/`|host-agnostic core: command runner, generic tool definitions, structured live status, service health via `board.json`|
|`src/plugins/omp/`|the OMP adapter: explicit commands through `src/adapters/holotable-cli.ts`, generic core tools mapped into `ExtensionAPI`, themed status and completions. No server, no watcher|

The OMP adapter initially registers only `/holotable`. Its first explicit invocation imports the core and CLI adapter, registers and activates the model tools, and starts a session-owned 10-second refresh for completion data and live status. CLI calls carry the session's `--current` selection and never read or write the shell's selection. Inactive sessions do not read the store or query the board. Session start, switch, branch, shutdown and explicit stop clear status, cancel the refresh timer and disable the tools; session lifecycle events also clear selection, while stop keeps it. Late results from an old context cannot restore the row.

Each live-status refresh uses one operations request and no CLI subprocess, distinguishing an unreachable service from a running empty board. Counts belong to the selected operation (or the sole operation), otherwise they are board totals. OMP renders them with its current theme's symbols and colors, omits zero counts and hides the empty-board row.


## Service lifecycle

One authenticated board is shared per home. Default-home Linux starts use the installed systemd user unit when available; custom homes and other platforms use a detached Bun process. `stop` reads the live identity from `GET /api/service`, then posts its PID and ephemeral instance nonce to `POST /api/service/stop`, under the existing token, Host and Origin checks. A stale identity is rejected; the CLI never kills a PID from `board.json`.

The shutdown reply finishes before closing the listener. The service stops scheduling passes, drains tracked HTTP requests and the current watcher, auto and recovery work, then releases the ownership lock. Stop waits for that lock release; a replaced owner is not stopped. Startup failures close any acquired resources and release the lock. Restart uses this same stop path before starting, keeping campaign files and the URL token.

`new --auto` builds the enabled auto configuration into the initial operation write, then the CLI ensures the board is running. Its defaults enable launch and land, cap operation concurrency at four (also bounded by the global cap), and leave plan approval, decision automation and recovery off. Explicit seed auto fields are preserved; the flag overrides only `enabled`. Pause and project inheritance are unchanged.

`board.json` binds discovery to the home it was written in (realpath). A copied `board.json`/`token` pair cannot make another home's CLI manage this board; symlinked homes resolve to the same owner.

## Ports

|Port|Adapters|Role|
|---|---|---|
|Tracker|`linear`, `github`, `none`|sample a ticket's state and URL; `search` feeds the Add contact ticket picker (`GET /api/tracker/search?op=<id>|project=<id>&q=<text>` → `{tracker, hits, error?}`, hits already on the operation flagged `taken`)|
|Fleet|`omp-mission`, `none`|read mission status, ping and control the owning session, build the launch command|
|Frontend|`orca`, `herdr`, `custom`, `none`|create worktrees, open/focus/close terminals|
|Delivery|`github-pr`, `local-merge`, `none`|probe delivery state, land on the integration checkout|

An operation names one adapter per port; all four can be `none`.

## Data flow

1. Operator commands and board clicks change `operation.json` (intent) and append events.
2. The watcher reads mission status files and pings sockets, then appends `phase`, `gate-armed`, `socket-up/down` and `sample` events only when something changed. Its in-memory view is seeded from the events, so a restart replays nothing. Frontend terminal lists are needed only for live recorded lane terminals or open decision panes. Orca/herdr listings are global and shared once per pass; custom listings remain operation-scoped. Vanished terminals and open counts update in the same pass.

The operation directory also holds `brief.md` (free text the operator edits on the operation page; `GET`/`PUT /api/brief`), `notes.md` (the scratch pad; `GET /api/notes`, `PUT /api/notes {op, text, base}` answers 409 `stale` when `base` is not the current revision; the projection only counts its task lines as `notes {done, total}`) and `seed.json` (the raw `--from`/create-payload that seeded the operation).

Projects live in `projects/<id>/project.json` (`store/projects.ts`). An operation's `operation.json` stores `project` and only the overridable fields that differ (`repo`, `base`, `integration`, `pause`, the four ports, `worktreeRoot`); `core/validate-operation.ts` resolves the effective operation from the project and reports which fields were `inherited`. Attaching sets every overridable field to the project's value (refused with 409 when launched work would move to another repo); detaching writes the resolved values back so nothing changes in effect; the value `inherit` drops one override. `store/migrate.ts` runs once per home (marker `.v5-projects`, under the home lock): project-less operations are grouped by repo realpath into one project each, seeded from the oldest. Reading an operation that still has the legacy `workflow` array rewrites it to `notes.md` task lines (done state from its last `workflow` event) and drops the key. Routes: `GET /api/projects`, `GET`/`POST /api/project-config`, `POST /api/projects`, `POST /api/projects/remove` (409 while an open operation uses it).

Reach (`src/access.ts`, `settings.access`): `local` binds `127.0.0.1`, `tailscale` (default) binds `0.0.0.0` but accepts only loopback and Tailscale peers (`100.64.0.0/10`, `fd7a:115c:a1e0::/48`) by remote address, `network` binds `0.0.0.0` and accepts any. The API token and the Host/Origin checks apply in every mode. `settings.port` defaults to 4848; a taken port falls back up to 4858 (`0` = any free port). The service publishes its reachable `urls` in `board.json` (loopback always, plus Tailscale IPs and the MagicDNS name from `tailscale status --json`, plus LAN addresses in `network`). `PUT /api/settings` for `access` or `port` rebinds in-process — close listener, reopen, republish `board.json` — and answers the new `urls`.

Repo detection (`src/adapters/detector.ts`, all through the injected `Run`): `GET /api/repos` merges project repos, `orca repo list --json`, and `recent-repos.json` (up to five git top-levels recorded by the plugin when `/holotable` runs), deduplicated by realpath, cached ~30 s. `POST /api/projects/detect {repo}` answers `{fields, reasons}`: base from Orca's `worktreeBaseRef`, else remote `origin/HEAD`, else the current branch, else `main`; name from Orca's `displayName` else the folder; frontend `orca`/`herdr`/`none`; tracker `linear` (`lin me`) or `github` (GitHub origin + `gh auth`) or `none`; delivery `github-pr` or `local-merge`; fleet `omp-mission`, pause on, integration = the git top-level (non-git paths are a 400). `POST /api/projects` accepts `{repo}` alone and detects every field it is not given.

Agent drafts (`store/drafts.ts`, `drafts/<id>/`): `POST /api/drafts {text, project?|repo?}` opens a terminal through the frontend running `omp` with a prompt to read the text or link and write `seed.json` there; `GET /api/drafts?id=` reports `running`, `ready` (with the validated seed), `invalid` (with the error) or `missing`; `POST /api/drafts/close` closes the pane and deletes the directory. Refused with 409 when the effective frontend is `none`. The board never runs a model itself; the form only fills fields from the seed.

Decision panes (`store/decisions.ts`, inside the operation directory — unlike drafts, which live under the home): `decide-agent` opens a lane-less `omp` terminal in the operation's `integration` checkout with a prompt that lists the question, `options` and `recommended` (free text when there are none) and asks it to write `decisions/<ticket>.json` (`{choice, rationale?}`) under that operation directory, then stop. The open pane is recorded in `decision-panes/<ticket>.json` (`terminal: null` until `openTerminal` returns). The watcher lists terminals per pass: a listed pane with no answer file yet is still working; a readable answer records `decided {choice, rationale?, by: "agent"}`, lands the contact (`via: "manual"`), deletes the record and closes the pane (`terminal-missing` when it already exited); a listed pane whose answer is invalid records one `operator {op: "decide-agent", ok: false}` and is left open for the operator to fix or close; a gone pane with no answer records the same failure once (`pane closed before deciding`) and deletes the record. The same shape covers crashes and restarts: a pane written on disk but absent from `listTerminals` fails on the next pass.

First-run setup (`GET /api/setup`): checks prerequisites (OMP CLI, OMP Mission extension, and CLIs for the frontends/trackers in use) by running them in parallel through `ports.ts::Run` with a 5s timeout. Cached for 30s. Failures return `ok: false` with a `fix` message instead of 500s. Also returns store counts (projects, operations, contacts, launched contacts).

Load tooltip (`GET /api/usage?op=<id>`): `src/machine.ts` samples `/proc` (machine CPU jiffies from `stat`, `MemTotal`/`MemAvailable` from `meminfo`, the process table's cwd/ppid/jiffies/RSS) and `src/usage.ts` diffs two samples — the previous one it kept, or a pair 300 ms apart when it has none or it is over 10 s old. A single in-flight refresh and ~1 s snapshot cache are shared across all viewers and operation ids; each refresh resolves lane roots once, then derives per-operation reports from that same baseline. `core/usage.ts` does the math: a process belongs to an operation when its cwd is inside a lane worktree (realpath compare) or it descends from one that is; CPU% is ticks delta over `elapsed * CLK_TCK * cpuCount` (share of the whole machine), memory is summed RSS against `usableMemoryBytes()`. `op` is null when `op=` is absent, and every figure degrades to null when /proc cannot be read. The web (`usage.js`) fetches only while the stat is hovered or focused and the document is visible.

Browser lifecycle: the next board poll is scheduled three seconds after the current poll finishes; overlapping calls do not queue a burst. Board, draft and load-tooltip polling stop when hidden, and visibility restoration refreshes immediately. Tooltips dismiss on hiding. Radar draws are gated by both view and visibility; idle projections have no animation loop, while live missions or attention animate at ~30 fps unless reduced motion is requested. Header and sidebar signatures use visible formatted values to avoid rebuilding unchanged DOM.

3. `project()` folds the events, joins live status, and returns one `Projection` that both views render. Contact state, the refusal text of a disabled button and the legal actions all come from `core/policy.ts`; the web never recomputes legality. Decision contacts carry `options`, `recommended` and `decision` (the folded latest `decided`, with its `by`), and the watcher's `decisionPanes` set marks `decisionPane` on the contact whose agent pane is still open.
4. A click posts `{op, contact, action, args?}` (`focus` takes `args.purpose: "plan-approval"` when the plan tab's Approve sent it; real frontends ignore it, the playground's simulated pane approves the plan only then). The server recomputes the action's legality from a fresh projection, then `runtime/actions.ts` runs it and records an `operator` event.
5. After every watcher pass, `runtime/auto.ts` looks at each open operation with `auto.enabled`: it lands contacts that are `complete` (when `auto.land`), resolves undecided decisions — `by: "recommended"` when a recommended option exists, otherwise a `decide-agent` pane that counts as one live lane — until `auto.maxLive` or the operation cap is hit (when `auto.decide`), then launches queued `implement`/`audit` contacts in queue order under the same two limits (when `auto.launch`). Actions it takes are recorded as `operator` events with `by: "auto"`. A failed launch or land pauses auto mode for that operation (`auto` event with the reason); plans at `plan-approval` and unmet blockers are always left for the operator.
6. `runtime/cleanup.ts` runs after a clean land (and `done`), when `settings.cleanup` is on: it closes the terminal (`reaped` event; a terminal that is already gone counts as reaped) and removes the worktree only when `git status --porcelain` is empty (`removed` event). Any failure — a dirty worktree included — appends an `operator {op: "cleanup", ok: false}` event and never fails the land. The watcher stops reading and pinging landed+reaped contacts, so a landed mission stops counting against the live cap.
7. Ending an operation (page `close`/`abort`, `/holotable close`, `POST /api/close|abort`) runs `runtime/end.ts::endOperation`: auto mode off, `winddown.ts` closes every recorded terminal (`reaped`; `terminal-missing` counts) and removes every non-external worktree (`removed`; abort deletes dirty worktrees), failures are `operator` events that never stop it, then `closed` is appended, `store/archive.ts::writeReport` writes `report.json` next to the operation's files and `archiveOperation` moves the directory under `archive/`. Abort's `GET /api/abort-preview` lists the terminals and worktrees (each `git status --porcelain`-checked) before the confirm. `core/report.ts::buildReport` is pure: an archive without `report.json` gets one rebuilt on read, never written back. Archive routes: `GET /api/archive` (newest first) and `GET /api/archive/report?key=`; the key must name a real archive entry, so traversal cannot leave `archive/`.
8. After every watcher pass, `runtime/recover.ts` looks at each open operation with `recover: true` (default off, never inherited from a project). It never acts for an operation with the switch off. Per contact: (a) a session at `hold: "resume"` whose owner is live, with `status.ctl !== null`, `verify !== "failed"` and `continue` among `status.actions`, gets a `continue` through the normal action runner with `by: "recover"`; attempts for one contact are at least 30 s apart, derived from the events so a board restart keeps the pacing (the ownership lock of a crashed session stays stale ~30 s). (b) A contact that is `offline`, has a lane terminal, is not `complete`, has no `reaped` event after its latest `launched` (an operator Reap means "leave it"), and either lost its terminal from a frontend that lists terminals (`vanished`) or has had `socket-down` for 60 s or more with the terminal still listed, gets a `relaunch` with `by: "recover"`. Relaunches run fire-and-forget (one in flight per contact, in memory) so the watcher loop never waits on the 90 s socket poll; none is attempted while the relaunch action is disabled (cap full), so a refusal never costs crash-loop budget. At most 3 `by: "recover"` relaunches per contact in 30 min; the next candidate records one `operator {op: "relaunch", ok: false, by: "recover", error: "gave up: 3 relaunches in 30 min"}` and stops until an operator Relaunch (any `relaunch` event without `by`) resets the count. `runtime/launcher.ts::relaunchContact` is the relaunch: close the recorded terminal if the frontend still lists it, open a new one in `lane.worktree` with the same fleet launch command and environment, record it on the lane and as a fresh `launched` (which clears `reaped`), then wait for the control socket. The new child attaches the worktree's saved mission under resume hold (`OMP_MISSION_AUTOSTART` is ignored when a mission exists), so (a) or the operator's Continue finishes the job. Recovery never approves a gate or plan, never continues on failed verification, never touches a session without a control socket, never relaunches a reaped contact and never exceeds the cap.
## Invariants

- Events are append-only and every stat is derived from them; there is no second copy of mission JSON and the board never parses it.
- One board per home (`proper-lockfile` on `board.lock`); a second session is told where the first one lives.
- Mutations of a mission only happen from board clicks, through the owning session's control socket. This process never attaches a mission and never calls `control()`.
- Launch is resumable: each step's result is written to `contact.lane` immediately, so a crash never orphans a worktree or a terminal.
- A blocker counts only when it has a `landed` event.
- Land happens on the integration checkout, only when it is clean and on the base branch; a conflict aborts the merge and opens a conflict mission.
- The live-`omp` cap (default 8, maximum 64) counts terminals across all open operations.

## Events

`$OMP_HOLOTABLE_HOME/operations/<id>/events.jsonl`: append only, one JSON object per line, written with a single `appendFile` of `JSON.stringify(e) + "\n"`. Never rewritten. Every event has `v: 1` and `at` (ISO-8601). Contact events add `contact` (ticket). Kinds and extra fields, exact:

| kind | extra fields |
|---|---|
| `queued` | `source?: "operator" \| "model" \| "seed" \| "conflict"` (who put it on the board) |
| `edited` | `source`, `fields: string[]` (a queued contact changed) |
| `blocked` | `by: string[]` |
| `unblocked` | |
| `adopted` | `worktree: string`, `source?` |
| `launched` | `worktree`, `frontend`, `terminal: {handle, incarnationId}` |
| `launch-failed` | `step: "repo" \| "workspace" \| "terminal" \| "socket"`, `error: string` |
| `socket-up` | `generation: number` |
| `socket-down` | |
| `phase` | `from: string \| null`, `to: string` |
| `gate-armed` | `gate: string` |
| `operator` | `op: string`, `ok: boolean`, `error?: string`, `by?: "auto" \| "recover"` (auto mode or recovery ran it). `op` is a policy action id (`launch`, `relaunch`, `continue`, `reap`, ...) |
| `land-attempt` | `outcome: "clean" \| "conflict"`, `paths?: string[]` |
| `conflict-opened` | `conflictContact: string` |
| `landed` | `via: "merge" \| "pr" \| "manual"` |
| `decided` | `choice: string`, `rationale?: string`, `by: "operator" \| "agent" \| "recommended"` (latest one wins for fold; lands the contact) |
| `reaped` | |
| `removed` | `worktree: string` (lane worktree removed: cleanup after landing, or the operation's wind-down) |
| `sample` | `tracker?: {state, url}`, `delivery?: {url, state, mergeable, checks}`, `workers?: number`, `omp?: number`, `usage?: {tokens: {input, output, cacheRead, cacheWrite}, costUsd: number \| null}` (the mission's cumulative total; stats add each contact's latest) |
| `workflow` | legacy, read only to migrate a checklist into `notes.md`; no longer written |
| `auto` | no `contact`; `enabled: boolean`, `reason?: string`, `by: "operator" \| "board"` (auto mode flipped) |
| `recover` | no `contact`; `enabled: boolean`, `by: "operator" \| "board"` (recovery flipped; `/holotable set recover`, `POST /api/operation-config`) |
| `closed` | no `contact`; `outcome: "landed" \| "abandoned" \| "decision" \| "failed"` |

A `sample` carries ids, states, URLs and counts, never ticket text. The watcher appends one only when a watched field differs from the last sample for that contact.

## Contact state and policy

Contact state, first match wins:

| condition | state |
|---|---|
| landed event | `landed` |
| lane null, kind decision | `decision` |
| lane null, unmet blockers | `blocked` |
| lane null | `ready` |
| a contact with `conflictOf` = this exists and is not yet `complete` or `landed` | `conflict` |
| status null, no `socket-up` event yet, lane has a terminal | `planning` |
| status null, or owner `offline` | `offline` |
| `status.hold !== "none"` | `hold` |
| `status.complete` | `complete` |
| `status.phase === "verify"` | `verify` |
| otherwise | `running` |

A finished mission (`status.complete`) stays `complete` when its owner is gone or its terminal was reaped, because landing needs no live owner; any other status with an offline owner or a reaped terminal is `offline`.

Group: `queue` if lane is null and the contact has no `landed` event, else `live`.

`launchRefusal` returns the first matching reason (strings exact), else null:

1. `operation closed`
2. `decision tickets do not launch`
3. `already launched` (lane has a terminal)
4. `blocked by <T1, T2>` (unmet blockers, ticket list comma-space joined)
5. `cap <open>/<cap> omp` when `load.open >= cap`
6. `no frontend: set one with /holotable set frontend orca` when frontend `none`
7. `no fleet configured` when fleet `none`

`actionsFor` returns `ActionView = { id, label, primary: boolean, enabled: boolean, reason: string | null }[]`:

| state | actions |
|---|---|
| ready | `launch` (Launch, primary, enabled iff `launchRefusal` null, else reason) |
| blocked | `launch` disabled with its reason |
| decision | `done` (Mark decided, primary; `{choice?, rationale?}` — the choice must be one of `options` when set, free text otherwise, blank counts as `decided`); `decide-agent` (Ask an agent: opens the decision pane; enabled iff the operation is open and under `cap`, reason `operation closed`/`cap <open>/<cap> omp`/`no frontend`, disabled while `decisionPane` is set with reason `decision agent running`) |
| planning, running, verify, hold, offline | `focus` (Focus, enabled iff terminal recorded and frontend not `none`/`external`); for owner live and hold/running/verify: one button per op in `status.actions ∩ {approve, continue, review, dispatch}` (labels Approve, Continue, Review, Dispatch; `approve` and `continue` primary) plus `mode` (Mode); owner not live: those buttons disabled with reason `owner-offline`; `ctl === null` disabled with reason `no control socket (not launched by holotable)`; `reap` (Reap, enabled iff terminal recorded) |
| complete | `land` (Land, primary; enabled iff delivery is not `none`, kind is `implement`, the probe is not `closed`, and no conflict contact for it is unresolved; reason otherwise: `no delivery configured`, `conflict mission <ticket> open`, `pull request closed`); `done` (Mark done) when Land does not apply (kind `audit`, kind `conflict`, or delivery `none`); `focus`; `reap` |
| conflict | `land` disabled with reason `conflict mission <ticket> open`; `focus`; `reap`. The conflict contact has its own card in `planning`/`running`/... states. When every conflict contact for this contact is `complete`, this contact falls through to its own state (`complete`) and Land uses the newest conflict contact's branch |
| landed | `reap` (enabled iff terminal recorded and not reaped); `redecide` (Change decision, `{choice, rationale?}`, same choice rules as `done`) when `kind: "decision"` |

Fleet buttons require `status.ctl !== null`. Holotable never computes mission legality itself; it renders `status.actions`.

`relaunch` (Relaunch, primary) is offered in state `offline` only, when the lane has a terminal, the frontend is neither `none` nor `external`, and the mission is not complete (a complete mission is `complete`, not `offline`). A reaped contact is `offline` and therefore relaunchable by the operator; that is the only way back after Reap. It is enabled unless the operation is closed or `load.open >= cap`, with the reason `operation closed` or `cap <open>/<cap> omp`. A lane with no terminal (a launch that stopped early) offers `launch` instead.

## Provenance
Every history entry has an actor: `operator` (your commands and board clicks, and `--from` seeds), `model` (the `holotable_queue` tool), `mission` (phase, gate and session changes the watcher reads from the mission's status), or `board` (blocking and unblocking, conflict contacts the lander opens, auto mode, and recovery). `operator` events fired by auto mode carry `by: "auto"`, those fired by recovery `by: "recover"`; a `decided` event's `by` is `operator`, `agent` (the decision pane answered) or `recommended` (auto mode took the recommended option). `ContactView.origin` is the contact's first `queued`/`adopted` event. `GET /api/history?op=<id>` returns the full history, newest first; the projection carries only the last 50.
