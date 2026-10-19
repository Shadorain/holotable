# Fleet contract

The board reads missions through one producer-written status file per mission run and mutates them only through a unix control socket the owning session listens on. `omp-mission` implements the producer side (`omp-mission/src/holotable.ts`). Holotable owns the schema (`src/core/validate-status.ts`). The board never reads mission JSON and never imports `omp-mission` code.

`ctl: null` means no board control authority, not necessarily an exited mission. A manually
resumed pane can continue publishing snapshots without its launch environment. The board marks
current socket-free activity `owner: observed` in projections (not in producer status): status
updated within 90 seconds, or an active review before its declared deadline. Such contacts show
their reported phase without allowing fleet commands or automatic recovery. They count against
capacity; after the activity window expires they are offline.

The producer opens the socket only when it owns the mission *and* is holotable-eligible: the
launch env `OMP_HOLOTABLE_CHILD=1`, or a `<run-id>.ctl` marker in the status directory left by
the first successful serve. An owner that acquired the lock before eligibility existed — a pane
revived without the launch env, or a mission started before the marker convention — retries the
socket on its polling passes and starts serving once the marker appears. On sighting a tracked
status file, the board backfills that marker (`src/adapters/fleet-omp-mission.ts`), so a revived
owner becomes controllable without a relaunch.

A second pane can attach the same saved mission read-only (`session.owned: false`): it publishes snapshots but opens no socket, and it never overwrites an owner-published file that is less than ~45 s old — the owner's liveness is the file's modification time, so only a fresh write keeps it current.

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
  hold: "none" | "plan-approval" | "resume" | "gate" | "blocked" | "quota" | "question";
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
  problem?: {
    kind: "quota" | "rate-limit" | "timeout" | "error";
    source: string;                 // review, worker, coordinator, verification, graph, triage or repair-budget
    detail: string;                 // full current failure, not truncated next-step text
    retryAt: string | null;         // ISO deadline owned by the producer; null = explicit retry
    attempt: number | null;         // failed review attempt
    completed: number | null;       // retained review targets
    total: number | null;
  } | null;                        // null = healthy; absent = older producer
  check?: {                        // latest result of the `check` op; absent = never checked or older producer
    at: string;                    // when the check ran
    state: "clean" | "merged" | "closed" | "conflict" | "threads" | "checks" | "fixing" | "unknown";
    detail: string;                // one line shown on the card
    conflicts: string[];           // paths conflicting with the base, if any
    threads: { open: number; total: number };  // unresolved PR review threads
  } | null;
  usage?: {                                           // associated coordinator, mission-owned subagents and independent reviewer sessions
    tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
    costUsd: number | null;                           // sum of omp's per-message cost estimates; null when none carried a cost
    sessions: number;
  } | null;
  measurements?: Measurements | null;
  usageEvidence?: UsageEvidence | null;
  session?: {                        // identity of the publishing process
    id: string;                      // OMP session id
    pid: number; processStart: string | null;  // start-time distinguishes recycled pids
    terminal: string | null;         // Orca terminal handle when present
    owned: boolean;                  // false = read-only inspection pane; it opens no socket
  };
  updatedAt: string;                 // when this snapshot was published (not mission.updatedAt)
}
```

Unknown fields are ignored. An invalid control/status file is skipped (and counted), never fatal. Invalid optional `measurements` or `usageEvidence` instead become explicit `null` (unknown evidence); they must not hide valid controls. Append-only sample events validate these groups strictly: malformed non-null evidence is rejected rather than silently changing historical meaning.

Join: among status files whose `worktree` realpath equals the contact's `lane.worktree` realpath, the newest `updatedAt` wins. A lane hosts one mission at a time.

As implemented by `omp-mission`: `next` may carry `/mission <verb> — <text>` (command prefix plus step text, whitespace-collapsed, 240 chars); `progress.of` is 9 (the phase list length); clearing a pending plan deletes its status file; clearing a saved or completed mission keeps its final status with `ctl: null`.

`problem` is display and scheduling evidence, not a capability. Only advertised `actions` authorize socket controls. Missing fields from older panes do not authorize board retries or model switching.

`source: "repair-budget"` identifies confirmed findings blocked only by the native repair-cycle limit; it publishes `kind: "error"`. Genuine decision escalations remain `source: "triage"`. This distinction requires updated producer code; the board must not infer budget authorization from older free-text failures.

While the main mission agent's `ask` tool is waiting, `hold: question` replaces plan approval, `next` carries the question text, and `actions` is empty. The board offers **Answer in mission** (frontend focus), not answer submission. Matching tool completion clears the hold; unrelated tool completions do not. Recovery must not continue or relaunch it. The producer rejects mutating socket operations with `question-waiting` until answered. Planning provider blockers publish blocked/quota holds and no plan-approval action until a new turn clears the blocker.

### Optional evaluation evidence (v1)

The two new status groups together are at most 4 KiB after normalization. Counts are nonnegative safe integers, USD estimates finite and nonnegative or null, timestamps at most 64 characters, and opaque source ids at most 128 characters. No transcripts, paths, finding text or model-generated summaries are copied. Older producers may omit both groups.

```ts
interface MeasurementConfig {
  graph: "local" | "beads";
  frontend: "none" | "orca" | "herdr" | "custom" | "subagent";
  maxWorkers: number; reviewConcurrency: number; // 1..64; current producer config permits 1..8
  mode: "auto" | "pause" | "force";
}
interface Measurements {
  v: 1; since: string;
  recordedPassed: number; recordedFailed: number; repeatedFailedRevision: number;
  mergePreflightFailures: number; boundaryFailures: number; reviewFailures: number;
  acceptedRepairs: number; completedRounds: number; invalidatedRounds: number;
  findingOccurrences: number; latestActionable: number; latestRejected: number;
  severity: { critical: number; high: number; medium: number; low: number };
  workerAttempts: number; workerBeads: number; repairRound: number; repairLinks: number;
  config: MeasurementConfig;
}
interface UsageSource {
  role: "coordinator" | "worker" | "review"; id: string;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
  costUsd: number | null; sessions: number;
  pricedMessages: number; unpricedMessages: number;
}
interface UsageEvidence {
  v: 1; measuredAt: string; sources: UsageSource[]; // at most three, unique roles
  missing: number; unsupportedWorkers: number; malformedLines: number;
  resets: number; backlogBytes: number; partial: boolean;
}
```

`since` marks persisted counter coverage, not mission creation on legacy runs. Only accepted explicit verification calls increment recorded pass/fail; a consecutive failed captured revision increments the repeat counter. Merge preflight and coordinator boundary failures are separate. Review rounds include invalidated rounds; finding/severity counts are occurrences, not unique defects. Current actionable/rejected findings use only the latest round and become zero when it is invalidated. Worker reservations and attempts are utilization/retry proxies, not measured CPU activity.

Usage is associated spend, not exclusive mission cost or exact billing. Independent reviewer sessions (including failed/aborted runs) are included. Terminal-worker usage is unsupported. The producer lazily samples on existing publication, with bounded incremental reads and explicit backlog; it forces a sample once at Complete and at detach. Cold restarts rebuild without a usage ledger. Holotable takes component high-water marks per `(role,id)` and deduplicates a shared coordinator across contacts. Decreases are flagged, never invented as additional spend. Legacy aggregates cannot resolve cross-contact overlap and are omitted for a contact once scoped evidence exists.

Board-owned panes are separate evidence, not mission spend. Decision panes write `pane-usage` delta events (folded into the contact's `decision` phase and `usage.pane`) from bounded `--session-dir` transcript reads. Only newline-terminated records count; a partial final append is not a malformed message. Committed signatures and monotonic `pane:N` ids prevent lost retries or duplicate spend after restart. Removed contacts retain recorded pane costs. Draft panes append aggregate counters to `drafts/usage.jsonl` before deletion; persistence failure retains their transcripts, retries use per-draft high-water marks, and malformed/truncated coverage stays partial. Both classes appear under `totals.panes` (a subtotal, not additional spend), never in `usage.tokens`. `totals.drafts` is board-wide and excluded from operation spend and cost per delivery.

Missing/unsupported source counts and backlog are current-run gauges: fully reconstructed evidence can clear a temporary launch or cold-scan gap. Malformed/reset evidence remains conservative. An unresolved gap when the contact switches missions stays partial; a healthy new run cannot erase the old run's uncertainty.

Scoped `usage.byPhase` deltas use operation-wide `(role,id)` high-water marks, so shared coordinator snapshots cannot charge two contacts' phases for the same increase. Attribution follows the first observing contact, not exclusive worker ownership. Initial cumulative baselines are unassigned; counter recovery below an earlier high-water mark does not create new spend. Mission replacement preserves prior attributed totals.

The existing watcher records `mission: {id, hold, verify, complete}` and changed counters before the slow sampling gate. Usage stays on that gate except final capture. Each group deduplicates by its values, not publication timestamps or JSON key order; restart seeds from the folded merged sample. Mission changes clear the previous run's sampled counters/usage. Land captures after merge verification, Done before `landed`, and Reap/Close/Abort before closing each unreaped pane. Capture shares the watcher serialization chain, reads only the target status when needed, and performs no ping, tracker, delivery or terminal scan. An already-closed recovery uses persisted history only. Capture failure is warned and cannot prevent the requested action.

## Comparison manifest (v1)

`holotable compare --manifest FILE` is an explicit, offline A/B read: it loads only the archive keys the manifest names, writes nothing, and never starts the board. Version 1 supports `variable: "maxWorkers"` only.

```json
{
  "v": 1,
  "variable": "maxWorkers",
  "baseline": "A",
  "groups": {"A": 1, "B": 2},
  "trials": [
    {"archive": "ARCHIVE_KEY", "group": "A", "pair": "workload-01", "repo": "/canonical/repo", "baseCommit": "FULL_COMMIT", "workload": "fixture-v1", "acceptance": "smoke-v1", "environment": "host-settings-v1", "externalOutcome": "unassessed"}
  ]
}
```

Exactly groups A/B with limits 1..64; baseline A or B; at most 100 trials; no repeated archive or `(pair, group)`. `repo` must literally equal the archive report's repo; the other identity fields are operator attestations Holotable does not verify. `externalOutcome` (`pass|fail|unassessed`) is the operator's judgment, kept separate from landed/check status. A valid manifest with fewer than five complete pairs, mismatched attestations or configs, non-beads graphs, or missing worker-dispatch evidence exits 0 with `comparable: false` and reasons plus raw per-trial facts — never fabricated deltas. Invalid manifests, missing archives, or repo mismatches exit 1. Deltas are candidate minus baseline per pair: delivery, queue-to-land lead, and cost-per-delivered (only over pairs with clean scoped usage coverage; figures stay "known associated estimates"). Incomplete arms remain in denominators; `--json` returns the typed `comparison` object.


## Control socket

Path: `<tmpdir>/omp-mission-ctl-<uid>/<sha256(missionId)[0:12]>-<pid>.sock`, directory `0700` (owner uid verified), socket `0600`. The pid suffix keeps a relaunched pane's socket unique while a stale file from the previous owner remains. A short hashed prefix is used because mission ids reach ~100 characters and unix socket paths cap near 104. The socket exists only on a controller pane started with `OMP_HOLOTABLE_CHILD=1` or one that later acquires ownership of a board-launched mission, from the moment a mission becomes a pending plan until the owner releases it. `ctl.generation` is `Date.now()` at `listen`.

Newline-delimited JSON, one request per connection, one response line. Max line 64 KiB.

- Request: `{"v":1,"op":"<ping|approve|continue|mode|review|dispatch|check|resend|release|reap|clear|plan-edit|plan-refine|plan-approve|retry-model>","args":{...},"operator":true}`. `ping` needs no `operator`; any other op without `operator: true` is `bad-request`.
- Response: `{"v":1,"ok":true,"revision":"…"}` or `{"v":1,"ok":false,"error":{"code":"…","message":"…"}}`.
- Server codes: `bad-request`, `stale` (approve carried a `args.gate` that is not the current gate id), `busy`, `rejected` (the same `control()`/`decision()` path the slash command uses threw), `no-session`.
- Client-side only: `owner-offline` (ENOENT, ECONNREFUSED, connect/ping timeout 3 s). Operation timeout 150 s.

The board UI exposes producer-advertised `approve`, `continue`, `review`, `dispatch`, `check` (the mission inspects its delivered PR: updates it from the base, works review threads and conflicts, replies to reviewers, then publishes the outcome as the status `check` field — operator clicks only, never auto mode), `resend`, `release`, `mode` (`args {mode: "auto"|"pause"|"force"}`), `retry-model` (`args {model}` — an operator-only model switch plus retry of failed coordinator/review/worker work; a mission that stopped offering it is `refused` before the socket call), and the plan-review pair `plan-edit` (`args {text, base}` — `base` is the plan revision the editor saw; a mismatch is `stale`) and `plan-refine` (`args {message}` — the owner rewrites the plan from the feedback). Resend and Release accept optional `args {beadId, detail}`; Resend also takes `files` (paths added to a stopped subagent worker's scope). An omitted bead id leaves selection to the mission controller. The socket also accepts `reap` (`args {beadId}`) and `clear` for the CLI and tests. Judgment ops (`bind_graph`, `record_verification`, `record_delivery`, `accept_repairs`, `reject_finding`) are never reachable. Resume hold, plan mode, Pause gates and the ownership lock are enforced by the mission code the socket calls into; the socket adds no bypass. Plan approval: when the session advertises `plan-approve` (`args {revision}`, a stale revision is `stale`; see `omp-plan-approval.md`) the board sends it; otherwise it stays in the mission pane, where a pane on OMP older than 18.10.4 has no review API the board can answer.

Opt-in `auto.repairs` may send `review` with `args: {repairBudgetOnly: true}`, once per contact. The producer rejects this scoped request unless it is currently a confirmed repair-budget hold outside Pause, then applies the normal ownership, resume, gate and reviewed-revision guards. The request authorizes one cycle, not completion, rejection of findings or escalation override. The board durably counts failed attempts too; Recovery never sends it.

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
