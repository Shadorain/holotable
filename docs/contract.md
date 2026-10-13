# Fleet contract

The board reads missions through one producer-written status file per mission run and mutates them only through a unix control socket the owning session listens on. `omp-mission` implements the producer side (`omp-mission/src/holotable.ts`). Holotable owns the schema (`src/core/validate-status.ts`). The board never reads mission JSON and never imports `omp-mission` code.

## Status file

Path: `<agentDir>/missions/<workspace-key>/status/<run-id>.json`, mode `0600` in a `0700` directory, written by tmp file + rename.

`agentDir` is `$PI_CODING_AGENT_DIR`, else `$OMP_AGENT_DIR`, else `~/.omp/agent`.

The file lives in a `status/` subdirectory on purpose: `listMissions` in `omp-mission` reads every `*.json` directly inside `missions/<key>/` and throws on a file that is not a mission.

```ts
interface ContactStatus {
  schema: 1;
  id: string;                       // producer run id
  ticket: string;                   // as the producer shows it; informational, not a join key
  title: string;
  worktree: string;                 // realpath of the checkout; join key with Contact.lane.worktree (realpath compared)
  base: string | null;
  phase: string;                    // producer vocabulary, shown verbatim
  progress: { step: number; of: number } | null;
  hold: "none" | "plan-approval" | "resume" | "gate" | "blocked" | "quota";
  gate: { kind: string; id: string } | null;       // id = first 12 hex of sha256(gate token)
  next: string | null;              // one line shown on the card
  actions: string[];                // operator ops legal now
  workers: { live: number; total: number } | null;
  delivery: { url: string | null; branch: string | null } | null;
  complete: boolean;
  revision: string;
  ctl: { socket: string; generation: number } | null; // null: no control socket
  plan?: { path: string; revision: string } | null;   // pending plan awaiting approval; revision bumps on every edit
  mode?: "auto" | "pause" | "force" | null;           // the mission's review mode (the planned one while a plan is pending)
  usage?: {                                           // cumulative across the coordinator and worker sessions; null until any is recorded
    tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
    costUsd: number | null;                           // sum of omp's per-message cost estimates; null when none carried a cost
    sessions: number;
  } | null;
  updatedAt: string;
}
```

Unknown fields are ignored. An invalid file is skipped (and counted), never fatal.

Join: among status files whose `worktree` realpath equals the contact's `lane.worktree` realpath, the newest `updatedAt` wins. A lane hosts one mission at a time.

As implemented by `omp-mission`: `next` may carry `/mission <verb> — <text>` (command prefix plus step text, whitespace-collapsed, 240 chars); `progress.of` is 9 (the phase list length); clearing a pending plan deletes its status file; clearing a saved or completed mission keeps its final status with `ctl: null`.

## Control socket

Path: `<tmpdir>/omp-mission-ctl-<uid>/<sha256(missionId)[0:16]>.sock`, directory `0700` (owner uid verified), socket `0600`. A short hashed path is used because mission ids reach ~100 characters and unix socket paths cap near 104. The socket exists only when the session was started with `OMP_HOLOTABLE_CHILD=1`, from the moment a mission becomes a pending plan until the owner releases it. `ctl.generation` is `Date.now()` at `listen`.

Newline-delimited JSON, one request per connection, one response line. Max line 64 KiB.

- Request: `{"v":1,"op":"<ping|approve|continue|mode|review|dispatch|resend|release|reap|clear|plan-edit|plan-refine>","args":{...},"operator":true}`. `ping` needs no `operator`; any other op without `operator: true` is `bad-request`.
- Response: `{"v":1,"ok":true,"revision":"…"}` or `{"v":1,"ok":false,"error":{"code":"…","message":"…"}}`.
- Server codes: `bad-request`, `stale` (approve carried a `args.gate` that is not the current gate id), `busy`, `rejected` (the same `control()`/`decision()` path the slash command uses threw), `no-session`.
- Client-side only: `owner-offline` (ENOENT, ECONNREFUSED, connect/ping timeout 3 s). Operation timeout 150 s.

The board UI exposes producer-advertised `approve`, `continue`, `review`, `dispatch`, `resend`, `release`, `mode` (`args {mode: "auto"|"pause"|"force"}`), and the plan-review pair `plan-edit` (`args {text, base}` — `base` is the plan revision the editor saw; a mismatch is `stale`) and `plan-refine` (`args {message}` — the owner rewrites the plan from the feedback). Resend and Release accept optional `args {beadId, detail}`; an omitted bead id leaves selection to the mission controller. The socket also accepts `reap` (`args {beadId}`) and `clear` for the CLI and tests. Judgment ops (`bind_graph`, `record_verification`, `record_delivery`, `accept_repairs`, `reject_finding`) are never reachable. Resume hold, plan mode, Pause gates and the ownership lock are enforced by the mission code the socket calls into; the socket adds no bypass. Plan approval: when the session advertises `plan-approve` (`args {revision}`, a stale revision is `stale`; see `omp-plan-approval.md`) the board sends it; otherwise it stays in the mission pane: OMP has no extension API to answer its plan-review dialog, so the board edits and refines the plan text but never approves it.

Client quirk (Bun): a client that calls `socket.end(payload)` half-closes, and Bun then drops the server's reply. Clients must `write` the request and wait for the reply line.

## Launch recipe

Decided by the V5 smoke (real Orca pane, real OMP, isolated agent dir). A positional `omp "/mission …"` does not produce a pending plan, and neither does `omp "/plan /mission …"`. This does:

```bash
env OMP_HOLOTABLE_CHILD=1 \
    OMP_MISSION_AUTOSTART='/mission <ticket-or-args>' \
    OMP_MISSION_CHECKOUT=<worktree> OMP_MISSION_BASE=<base> \
    OMP_MISSION_GRAPH=<beads|local> OMP_MISSION_DELIVERY=<pr|local> \
    omp --config <overlay.yml>
```

where `overlay.yml` is `plan:\n  defaultOnStartup: true\n`. Autostart creates the plan; it never approves it. Approval stays in the pane unless the session advertises `plan-approve`. A relaunch of a mission whose saved status is past `plan` uses an overlay with `defaultOnStartup: false` (`launch/resume.yml`): omp-mission refuses `continue` while the session is in plan mode.

Holotable may also pass `--model <selector>` and `--thinking <effort>` when opening a new pane.
An explicit null model override omits `--model`; otherwise a per-use default inherits the global
default before leaving selection to OMP. Explicit mission overrides are kept on the lane for
replacement panes. These flags do not change autostart, plan approval, gates or socket ownership.
Plan refinement still uses the existing mission session and cannot change its model.

`OMP_MISSION_AUTOSTART` carries the `/mission` arguments verbatim (a leading `/mission` is stripped). The `OMP_MISSION_*` overrides replace `git config mission.baseBranch`, which is shared across all worktrees of a repository and would collide between operations.

Contact titles are short board labels; optional descriptions hold complete task instructions.
Local launches use the description, falling back to the title for title-only seeds. Tracked
launches retain the ticket and include the description as additional instructions. Decision
panes receive both the short question title and its full description. These fields do not alter
Pause, dependency gates, ownership or delivery mode.
