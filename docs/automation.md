# Auto mode and Recovery

Both are per-operation switches. Auto mode is off by default. Recovery is on by default for operations created from the New operation form (its **Keep missions running** switch) and off for operations created with `/holotable new` without `--recover`. Auto mode launches, lands and (opt-in) decides and approves plans for you. Recovery reopens and continues missions whose pane crashed or closed. Neither approves a Pause gate, answers a mission's question, or works around resume hold or the ownership lock. Landing rules that auto mode follows are in [landing.md](landing.md).

## Auto mode

Per operation (`/holotable set auto on`, or the auto card on the Operation page): `auto.launch` launches ready contacts up to `auto.maxLive` and the global `cap`, choosing the ready contact that unblocks the most unlanded work (saved queue order breaks ties); `auto.land` lands completed contacts; `auto.decide` resolves decisions using their recommended answer or an agent pane. `auto.maxLive` counts working missions (running, verifying, in review or held on you) and decision panes; a finished mission waiting on CI or landing keeps its pane but no longer uses a slot, so the next ready contact launches meanwhile. It still counts against `cap`, which protects memory. Actions are credited to auto mode in history. Overlapping uncommitted paths or the wrong base branch defer landing without switching Auto off; readiness is rechecked every 30 seconds while other automation continues. Your uncommitted changes are never stashed, discarded or committed by the board. A failed automatic launch, land, plan approval or decision pane never switches Auto off: that contact is retried after 5, 15 and 60 minutes, then left for you with the last error in its history, while the rest of the operation keeps moving. The backoff is read from history, so a board restart keeps it. `auto.plans` (off by default) approves advertised native plan reviews with compacted context on OMP 18.10.4 or newer. Older running panes must be updated and relaunched; absence of a pending review is not an unsupported-runtime warning. See [omp-plan-approval.md](omp-plan-approval.md). Pause gates still wait for you.

### Start an automatic campaign

Start an automatic campaign from OMP with `/holotable new release --repo /path/to/repo --base main --auto`, or use the same `new` arguments in the shell CLI. The flag enables launch and land with `auto.maxLive = 4`, bounded by the board cap. It does **not** disable Pause, approve plans, decide contacts or enable recovery. Explicit auto settings in a seed are preserved, with `enabled` switched on by `--auto`; without the flag, the seed's auto configuration is unchanged.

### Extra repair cycle

**Extra repair cycle** (`auto.repairs`, off by default) lets Auto authorize one additional cycle per contact after the mission's native repair budget runs out. It requires a live owner, passed verification, confirmed repair findings, non-Pause mode and an advertised Review action. The authorization goes through the owning pane's socket and is recorded in history; even a failed attempt consumes this board allowance, across restarts. A second exhaustion, a genuine decision escalation, quota, approval gate or failed verification still waits for you. Enable it on the Operation page or with `/holotable set auto.repairs on`; Auto must also be on. Start/relaunch older mission panes to load the new producer capability. Recovery remains a separate switch for crashed panes and resume holds.

### Request reviews

**Request reviews** (`auto.reviews`, off by default). A mission in Auto mode stops once its delivery passes and waits for **Review**. It continues only after an independent review is requested, so without this switch every mission needs that click before it can land. With the switch on, Auto switches each live mission from Auto to Force once, through the owning pane's socket, after plan review. Force mode requests that independent review itself, so the mission runs review, repairs and completion without stopping. Auto skips missions that are in Pause, in Force already, finished, or still in plan review. Each contact is switched at most once, so if you set a mission back to Auto it stays in Auto. A failed send backs off like other automatic actions, and quota waits pause it. Every request costs one reviewer run. Turn it on with `/holotable set auto.reviews on`.

### Quota and rate limits

Auto mode pauses new launches, plan approvals, automatic PR checks and decision-agent panes while a running pane in this operation reports quota/rate-limit failures. A reaped or dead pane's last error does not count. It leaves the queue visible and can still land completed work or record free recommended decisions. Existing producer retries retain their own pacing; the board changes a model only on the operator's **Switch model** and never adds a competing retry loop.

### Your checkout

**Landing never fights your checkout.** A land is refused only when the merge would write a path that already has uncommitted changes — the same rule `git merge` itself applies — and the refusal names the paths. Unrelated edits, notes and local config stay untouched and never block. The header shows `integration dirty · n` whenever the integration checkout has uncommitted paths, before any land is attempted; clicking it opens the Operation page.

## Recovery

Per operation and never inherited from a project. On the page it is the **Keep missions running** switch: in the New operation form (on by default) and in the Operation page's Recovery section. Elsewhere: `/holotable set recover on` (or `new <id> --recover`, `POST /api/operation-config {op, field: "recover", value: "on"}`, or `recover: true` in `POST /api/operations`); without these, an operation's `recover` is off. Switching it is recorded in history as yours. With it on, the board keeps missions running through a closed or crashed pane without you watching:

- **Resume.** A board-launched session sitting at resume hold with a live owner gets `Continue`, at most once every 30 s per contact (a crashed session's ownership lock stays stale for about 30 s, so the first try may fail with `ELOCKED`; failures are recorded and retried). The pacing is read from the events, so a board restart keeps it.
- **Relaunch.** An offline contact whose recorded pane vanished can reopen only when a fresh frontend inventory shows no sessions in its worktree. Rows the frontend knows are not agent sessions are ignored: on Orca, the idle default shell (untitled or titled after the shell) and the **Setup** tab. Any other pane counts, including one whose title is not recognised; an OMP pane (Orca title `π …`), manual or ours, blocks it. A changed handle, an expired status/review deadline, or a dead socket never proves an existing pane is safe to replace. If any session remains, or inventory is unavailable, inspect it and use manual Relaunch if needed. Recovery never closes a listed pane. Relaunches run in the background, one at a time, and respect the global `cap`.
- A responding mission socket takes precedence over a missing or changed terminal identity. Recovery does not replace that live session, and it still counts against the cap; Focus stays disabled if its recorded pane is gone. Relaunch rechecks the socket immediately before touching any terminal.
- A manually resumed pane can publish activity without a board control socket. The board shows its reported phase with an observed-activity indicator and counts it against capacity, but sends no mission commands and does not relaunch it while activity is current. Ordinary status is current for 90 seconds; an active independent review remains current until its advertised deadline, since progress can be quiet between reviewer results.
- **Give-up.** At most 3 recovery relaunches per contact in 30 minutes. The next candidate records one `gave up: 3 relaunches in 30 min` event and recovery leaves that contact alone until you press Relaunch yourself, which resets the count.
- **Refusals.** A refused automatic relaunch is not a crash and does not count toward the give-up limit. A relaunch is refused when another pane is open in the worktree or a session still holds the socket. The contact shows **Waiting**, with the reason and the retry time. Recovery tries again 5 minutes later and does not hold a slot for it in the meantime. Orca's leftover "Setup" tab never counts as a pane in the way.

Saved missions deferred by Recovery show **Waiting**, with the actual session-slot
or memory reason, rather than a misleading crash/attention alert. Recovery reserves
capacity for queued restarts and rechecks each one before opening a pane. After a
restart it refreshes ownership and load before admitting the next mission. Auto mode
leaves a crashed mission's slot empty while Recovery waits out the one-minute startup
grace, so new work cannot take it. This also applies to decision panes. Once a
slot or sufficient memory returns, it retries automatically without spending the
crash-loop budget on resource refusals. Idle and held panes still consume memory and
count against the Agents cap. **Started** counts assigned missions; Load counts
connected panes. A closed terminal's **Focus** is disabled.

Everything recovery does is an `operator` event with `by: "recover"`; history credits it to the board. Recovery never:

- continues a session whose `verify` is `failed` (continuing resets verification; that is your call),
- continues or relaunches a quota-held mission automatically; restore funding or change its model before an explicit retry,
- touches a session without a control socket (a human's `omp` in the worktree),
- approves a gate or a plan,
- relaunches a contact you Reaped,
- relaunches a finished (`complete`) or landed contact,
- exceeds `cap`.
