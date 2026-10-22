# Holotable reference

Commands, settings, frontends, resource limits and the data layout. For how to use the board, see [guide.md](guide.md).

- [OMP integration](#omp-integration)
- [Commands](#commands)
- [Standalone CLI and service](#standalone-cli-and-service)
- [Seed file](#seed-file)
- [Settings](#settings)
- [AI models and token usage](#ai-models-and-token-usage)
- [Model tools](#model-tools)
- [Frontends](#frontends)
- [Watching missions](#watching-missions)
- [Resource budgets](#resource-budgets)
- [HTTP API errors](#http-api-errors)
- [Data layout](#data-layout)

## OMP integration

`/holotable` runs the bundled `holotable` CLI to start or reuse one board per `OMP_HOLOTABLE_HOME`, records the current repo for the project picker, prints the URLs and enables the model tools. Bun must be on `PATH`; linking the shell command is optional for OMP. The board stays up independently of the session.

`/holotable` with no arguments makes sure the board service is running (starting it if needed), records the session's repo for the project picker, prints the URLs and enables the model tools. One board runs per `OMP_HOLOTABLE_HOME`: a second session is told where the first one lives.

Activation is session-local. Until you use `/holotable` (with or without arguments), OMP does not load the board core or CLI adapter, register its model tools, read campaign data, poll the service or show a board row. A new, switched or branched session returns to this inactive state, as does `/holotable stop`; the session's selected operation is kept.

Once activated, the row shows the selected operation and nonzero live, queued and need-you counts, using OMP's themed symbols and colors. With one operation it shows that operation automatically; with several and no selection it shows board totals. An empty board adds no row. An unreachable board shows a compact offline hint.

The optional status row follows OMP's theme and omits zero counts. `holotable_state` reads the board; `holotable_queue` proposes or edits queued contacts. Neither tool launches, lands or approves work. Holotable can request a model for a new agent pane; model execution, provider routing, verification and review remain in OMP and the mission.

After updating the checkout, run `holotable restart` and start fresh OMP sessions before using
queue tools. Existing sessions can retain the old contact schema; refreshing the browser alone
does not reload those tools. Existing operations do not need to be closed or recreated.

The CLI is the cross-platform management interface. On Linux, the default home uses a resource-bounded **systemd user service** when available. Custom homes and other platforms use a detached Bun process. Your campaigns live outside the plugin checkout, under `~/.omp/agent/holotable` by default; updates do not replace them. See [Resource budgets](#resource-budgets).

## Commands

|Command|Effect|
|---|---|
|(none)|start the board if needed and print its URLs; also records the session's repo for the project picker|
|`start` / `stop` / `restart` / `status` / `url`|manage or inspect the same home-selected board through the CLI|
|`new <id> (--project <id> \| --repo <path> --base <branch>) [--name] [--integration <path>] [--tracker] [--fleet] [--frontend] [--delivery] [--auto] [--pause \| --no-pause] [--closer \| --no-closer] [--recover] [--from file.json] [--brief file.md]`|create and select an operation; unset fields follow the project, then global defaults; `--auto` enables board launch/land, independently of mission Pause gates; `--closer`/`--no-closer` override `defaults.closer` (see [Closer review](guide.md#closer-review))|
|`project new <id> --repo <path> --base <branch> [--name] [--integration] [--tracker] [--fleet] [--frontend] [--delivery] [--pause \| --no-pause] [--worktree-root]`|create a project; mission mode follows the global default unless explicitly overridden|
|`project list`|projects and their operations|
|`project set [<id>:]<field> <value>`|change a project field (default: the selected operation's project); every operation that has not overridden it follows|
|`project attach <id> [op]` / `project detach [op]` / `project delete <id>`|attach (the operation takes every project value), detach (the values are copied in), delete (refused while an open operation uses it)|
|`list [--all]`|open operations (`--all` adds archived)|
|`use <id>`|select an operation|
|`zone <label>`|add a zone (its id is derived from the label)|
|`set <field> <value>`|change `name`, `base`, `integration`, `pause`, `ignoreChecks` (`true`/`false`, see [Landing](landing.md)), `tracker`, `fleet`, `frontend`, `delivery`, `worktreeRoot` (`default` clears it), `recover` (`on`/`off`, see [Recovery](automation.md#recovery)) or the auto-mode fields `auto` (`on`/`off`), `auto.launch`, `auto.land`, `auto.maxLive`, `auto.plans`, `auto.decide`, `auto.repairs`, `auto.reviews`. In a project's operation, `set <field> inherit` drops the override and follows the project again, like **use project value** on the Operation page. `name`, `auto*` and `recover` belong to the operation and cannot be inherited|
|`add <ticket> --zone <id> [--kind] [--blocked-by A,B] [--title] [--description <text>] [--worktree <path>] [--option X…] [--recommended X]`|add a contact with a short title and separate full instructions; `--worktree` adopts an existing checkout; `--option`/`--recommended` build a decision contact (see [Decisions](guide.md#decisions)); kinds: `implement` (default), `audit`, `decision`, `closer`|
|`add closer [ticket] [--zone <id>] [--title] [--description <text>]`|add the operation's closer (ticket `CLOSER`, the last zone, unless given): it waits for everything else, then reviews the integrated work (see [Closer review](guide.md#closer-review))|
|`close <id> <landed\|abandoned\|decision\|failed>`|end the operation through the same path as the page: wind-down, `closed` event, report, archive|
|`config [key value]`|show or set board settings; `access` and `port` set here apply when the board restarts (the settings drawer rebinds at once)|

Example:

```
/holotable project new lab --repo ~/projects/lab --base main
/holotable new lab-q3 --project lab
/holotable zone Ops
/holotable add notes --zone ops --kind decision
/holotable add api --zone ops --blocked-by notes
/holotable add closer
/holotable list
```

## Standalone CLI and service

The OMP plugin installer does not put `holotable` on your shell's `PATH`. From a checkout with dependencies installed, expose the existing executable:

```bash
bun link
export PATH="${BUN_INSTALL:-$HOME/.bun}/bin:$PATH"
holotable --help
```

Keep the checkout in place: the command links to it. Keep Bun's bin directory on your shell's `PATH` for future terminals. Without linking, `bun bin/holotable.ts` runs the same CLI from the checkout.

All OMP sessions and shell commands using the same `OMP_HOLOTABLE_HOME` share **one board process**. Closing OMP does not stop it. The localhost, Tailscale IP and Tailscale DNS URLs are different addresses for that same board, not separate instances. A different home deliberately creates a separate board.

|Command|Effect|
|---|---|
|`holotable` / `holotable start`|start or reuse the board and print its URLs|
|`holotable status`|check the board and show its PID and URLs; exit code 3 means offline|
|`holotable url`|print the running board's URLs|
|`holotable list`|list operations; all `/holotable` store commands also work here|
|`holotable serve [--access local\|tailscale\|network] [--port P]`|run in the foreground; Ctrl+C stops this foreground board|
|`holotable stop`|gracefully stop this home's board, keeping campaign data|
|`holotable restart`|stop, then start this home's board; the URL token is kept|
|`holotable install [--now]`|install the Linux user service for the default home; `--now` also enables it for login startup|
|`holotable uninstall`|stop and remove that Linux service; campaign data is kept|
|`holotable compare --manifest FILE`|offline comparison of named archives (see [Intel](intel.md)); no board needed|

Stopping the board stops watching and automatic board actions, not mission panes already owned by Orca or Herdr. In-flight actions finish before ownership is released. Stopping from OMP also clears that session's row and disables its tools. After a stop, `holotable start` or `/holotable` starts it again.

Global options go **before** the command: `holotable --home /path/to/campaigns status` controls a separate home; `holotable --json status` returns structured output. Shell selection is stored per home. Host integrations use `--current <id>` (or `--current ""` for none) to keep selection session-local.

Discovery is bound to its home: a copied `board.json`/`token` cannot let one home manage another home's board, and two homes always get separate processes.

`systemctl --user` remains useful for Linux logs and unit diagnostics, not required for normal lifecycle commands. After upgrading a board from a release without the shutdown API, restart it once with its original process manager before using CLI stop/restart.

## Seed file

`--from file.json` seeds an operation:

```json
{
  "zones": [{ "id": "api", "label": "API" }],
  "contacts": [
    { "ticket": "CHR-1", "zone": "api", "title": "Build database schema", "description": "Implement the schema migration with tenant-scoped constraints and persistence tests." },
    { "ticket": "CHR-2", "zone": "api", "title": "Build typed HTTP client", "description": "Generate the typed client for the new schema and verify its error handling.", "blockedBy": ["CHR-1"] }
  ],
  "notes": "## Ship\n- [ ] Staging\n- [ ] Announce"
}
```

Keep `title` to a short label, typically 3–8 words. Put scope, restrictions and acceptance criteria
in `description`; the card shows it in full. Local missions use the description as their task.
Tracked missions keep their ticket identity and receive the description as additional instructions.
Title-only local seeds still use their title as the task.

A `"brief"` string seeds the operation's brief (same as `--brief`); `--brief <file>` overrides a `brief` key in the seed. `"notes"` seeds the scratch pad.

## Settings

`$OMP_HOLOTABLE_HOME/settings.json` (default `~/.omp/agent/holotable`, mode `0600`). The page's settings drawer is global only (operation fields live on the Operation page under Plan). Every control saves on change; `access`/`port` rebind the running board — no restart — and the drawer lists the URLs it now answers on.

|Key|Default|Meaning|
|---|---|---|
|`access`|`tailscale`|who may open the board: `local` binds loopback only, `tailscale` binds everywhere but accepts only loopback and Tailscale peers (`100.64.0.0/10`, `fd7a:115c:a1e0::/48`), `network` accepts any address on your LAN. The token is required in every mode|
|`port`|`4848`|bind port; `0` picks a free one. A taken port falls back to one of the next ten|
|`cap`|`8`|live `omp` ceiling, 1-64; above 8, or when the sessions would need most of this machine's memory, the page warns (each idle omp holds about 600 MB)|
|`ai.model`|`null`|default model selector for new agent panes; unset leaves selection to OMP|
|`ai.thinking`|`null`|reasoning effort for new panes: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, `auto`; unset leaves it to OMP|
|`ai.draft` / `ai.decision` / `ai.mission`|`null`|per-use model defaults; unset inherits `ai.model`, then OMP|
|`pollMs`|`5000`|status read and owner ping floor — status-file writes wake a pass sooner via fs.watch|
|`sampleMs`|`60000`|tracker and delivery sampling interval|
|`theme`|`holo`|page theme: `holo`, `omp` (omp-grill's palette), `slate`|
|`worktrees.root`|`{repo}-holotable-{name}`|where herdr and custom lanes are created: `{repo}` (repo path), `{repoName}`, `{name}` (required), may start with `~/`. An operation's `worktreeRoot` overrides it|
|`defaults.tracker`|`none`|`linear`, `github`, `none`|
|`defaults.fleet`|`omp-mission`|`omp-mission`, `none`|
|`defaults.frontend`|`none`|`orca`, `herdr`, `custom`, `none`|
|`defaults.delivery`|`none`|`github-pr`, `local-merge`, `none`|
|`defaults.pause`|`false`|Settings → Defaults → **Pause gates**: whether missions in new projects and standalone operations stop at each Pause gate (unrelated to an operation's Auto mode); saved projects and operations keep theirs|
|`defaults.closer`|`true`|Settings → Defaults → **Finish with a closer review**: new operations end with a [closer](guide.md#closer-review) (the New operation form and `new --no-closer` can still leave it out); saved operations keep theirs|
|`cleanup`|`true`|after a contact lands or is marked done, close its terminal and remove its worktree when clean (a dirty worktree is kept and noted)|

## AI models and token usage

**Settings → AI & Models** controls new panes, not sessions already running. Searchable model
pickers also sit beside **Draft it**, **Launch** and **Decide with an agent**. A pick there overrides
the per-use default for that action; **OMP default** bypasses Holotable's model defaults. Explicit
mission picks survive replacement panes. **Refine** uses the model already running in the mission:
the control socket cannot change it.

Open **Settings → AI & Models → Load subscription quotas** to see remaining quota, binding
windows, reset times and report freshness from OMP. Model pickers rank reported capacity first,
warn at 10% remaining (or a provider warning), and disable exhausted subscriptions while preserving
their current selection visibly. Unknown or stale quota is never presented as available.
Antigravity's Gemini and shared Claude/GPT pools stay separate; the same model through another
provider is a different subscription. Some accounts do not expose usage, so a partial report
cannot prove that all accounts are exhausted.

The catalog and quotas load only when a picker opens or you request them: there is no quota
polling. Model choices appear as soon as the catalog arrives; subscription checks update them
separately, so a slow or failed quota report does not hold the picker open on a loading state.
**Refresh subscription quotas** reloads OMP's current report and updates the pickers; recent
exhaustion remains visible while that refresh is pending. The report timestamp shows its upstream
age. Browser and server caches expire after 30 seconds.
Choices apply to new panes, not running coordinators, bead workers or reviewers. No fallback,
account selection, subscription reset credits or global OMP settings are changed automatically.
Prices are catalog input/output dollars per million tokens, not spend limits or a promise of
provider/model access. Authenticate the selected provider in OMP. OMP still owns fallback and
subagent-role routing. Lower reasoning effort and the Agents cap to control token use and load.

```bash
holotable config cap 2
holotable config ai.thinking low
holotable config ai.draft openrouter/google/gemini-3.8-flash
holotable config ai.draft ""   # inherit the global/OMP default again
```

## Model tools

Enabled by an explicit `/holotable` command for the current session; a new, switched or branched session disables them again. They propose; the operator clicks.

- `holotable_state`: one line per contact (state, blockers), at most 4000 characters. Read-only.
- `holotable_queue`: `add` a contact or `update` a queued one. A contact that already has a lane is refused with `contact-launched`. It cannot launch, land, approve or set a lane.

## Frontends

Frontends (per operation, `--frontend` or `/holotable set frontend`):

|Frontend|Worktrees|Terminal|
|---|---|---|
|`orca`|`orca worktree create … --no-parent --command …`|Mission runs in the first terminal; `orca terminal create` only for existing lanes and relaunches|
|`herdr`|`git worktree add -b holotable/<name>` in the `worktrees.root` folder (default beside the repo)|`herdr tab create` + `herdr agent start`|
|`custom`|same as herdr|shell templates `custom.terminal`, `custom.focus`, `custom.close` (`{cwd} {title} {command} {handle}`)|
|`none`|never|never|

Requirements: the launched `omp` must load `omp-mission` (install it as an OMP extension). Orca puts worktrees in its own project's worktree folder (Orca project settings) and ignores `worktrees.root`; it creates worktrees only for repos where that folder is set, and the settings drawer shows the folder or says it is missing. `cap` (default 8, maximum 64) counts live `omp` sessions across every open operation; an idle `omp` is about 600 MB. **Reap** closes the contact's terminal after checking its handle, incarnation and worktree against what the frontend lists; it never uses `--all` and never types into a terminal.

New Orca workspaces start the mission in the workspace's first terminal instead of leaving an unused shell beside it. This requires an Orca CLI exposing `worktree create --command` (the host CLI extension forwards Orca's existing `startupCommand` RPC field). Setup is not skipped: Orca's repository setup/startup policy still applies. The separate Setup tab remains available for logs; this change does not auto-close it or touch existing tabs. Long mission commands use a private temporary startup script that removes itself when started; an unstarted script remains in the host's temporary directory for diagnosis.

## Watching missions

While the service runs, an `fs.watch` over the mission status directories wakes the watcher within about a second of any status write; the `pollMs` pass is the floor underneath it. Each pass reads each launched contact's mission status file, pings the owning session's control socket, and records changes as events (`phase`, `gate-armed`, `socket-up`, `socket-down`). Every `sampleMs` it samples the tracker and the delivery PR and appends a `sample` only when a field changed. It is read-only. Port failures are warned once per distinct message and never stop the loop.

Wakeups coalesce into one pending pass and never multiply fallback timers. Continuous writes cannot postpone updates indefinitely. Unrelated agent files do not wake the board; directory watches are reconciled after topology changes and periodically rearmed after replacement. The stream uses the same header token as the rest of the API, not a URL query. Hidden tabs close it; reconnect and updates received during a slow refresh trigger a catch-up refresh. Slow stream readers receive coalesced notifications rather than an unbounded write queue.

Adapters: tracker `linear` (`lin`) and `github` (`gh`); fleet `omp-mission` (status files and control socket, see [contract.md](contract.md)); delivery `github-pr` (`gh pr view`) and `local-merge` (`git merge-base --is-ancestor`).

## Resource budgets

The installed Linux user service limits the board **and its CLI subprocesses** to a quarter of one CPU core (`CPUQuota=25%`), 256 MiB memory pressure threshold, 512 MiB memory ceiling and 64 tasks. It runs at lower CPU priority and stops restarting after three starts in five minutes. A memory ceiling breach stops the board; operation data remains on disk. Existing installations: run `holotable install`, then `holotable restart` (use the original process manager once when upgrading from a release without the shutdown API).

These limits do **not** cover mission panes hosted by Orca/herdr, other services, or a board started directly with `serve`/a detached fallback. The Agents cap limits mission concurrency across operations, not each mission's CPU. On a small or heat-constrained machine, start with **2** live agents and raise it only after measuring the workload. No board setting can guarantee safe temperatures for the entire host.

On Linux, each mission launch/relaunch also checks `MemAvailable` before creating or closing
a pane: it needs a 600 MiB pane budget plus a 512 MiB machine reserve, with another
600 MiB reserved for each concurrently opening mission. Low headroom refuses the action
without changing the saved lane. Recovery waits for headroom and does not count memory
refusals against its crash-loop budget. This is admission control, not a memory limit on
running missions; other tools can still exhaust the host. If `/proc` is unavailable,
this check is unavailable and the Agents cap remains the limit.

Queued-only operations do not run terminal-list commands; operations with live recorded terminals or decision panes share one Orca/herdr listing per watcher pass. Custom frontends remain operation-scoped. Usage viewers share one machine snapshot instead of independently scanning `/proc`. The page refreshes on push events from `GET /api/stream`; a 30 s poll (3 s while the stream is down) is only a safety net and never stacks requests behind slow responses. Hidden pages stop refreshing and drawing; usage polling runs only while its tooltip is visible. Unchanged header and formatted statistics leave their DOM intact.

Watcher passes never overlap. OMP's passive 10-second refresh reads the service in-process; it does not spawn CLI polling processes. Explicit CLI starts close the parent's log descriptor after spawn. Stop authenticates a live PID and instance nonce, never signals a PID from a discovery file, and drains HTTP actions, watcher, auto and recovery work before releasing the ownership lock.

## HTTP API errors

- API errors say whose fault they are: 400 for your input, 404 for an operation, contact or project that does not exist, 409 for a conflict (stale notes, a taken id), 500 with the message for a store or I/O failure. See [architecture.md](architecture.md#http-api-status-codes).

## Data layout

Per project under `$OMP_HOLOTABLE_HOME/projects/<id>/project.json`: repo, base, integration, pause, the four ports, worktree folder, `ignoreChecks` (land with failing checks).

Per operation under `$OMP_HOLOTABLE_HOME/operations/<id>/`:

- `operation.json`: intent only (project, the fields it overrides, zones, contacts, blockers, lanes). The queue is derived: a contact with no lane is queued.
- `events.jsonl`: append-only history. Everything shown (state, stats) is rebuilt from it.
- `brief.md`: free-text brief, edited on the Operation page; `notes.md`: the scratch pad; `seed.json`: the raw seed the operation was created from.
- `decisions/<ticket>.sessions/`: the decision pane's omp transcripts (`--session-dir`), rescanned each watcher pass into `pane-usage` spend deltas attributed to the ticket's `decision` phase.
- `closer/<ticket>.json`: the closer mission's review (verdict per ticket, verification, fixes, follow-ups), shown on its card, on the Operation page once it lands and on the archive report; `closer/<ticket>.md`: its optional Markdown copy, shown when there is no JSON.
- `reports/<ticket>.json`: each contact's latest mission report, saved from its status so the card keeps it after the contact lands.

`drafts/<id>/` holds agent drafts until the form closes them; `drafts/<id>/sessions/` pins the draft pane's transcripts. Closing persists aggregate spend to `drafts/usage.jsonl` before deletion; a failed ledger write retains the transcripts for retry. Per-draft high-water marks prevent retry double-counting. Truncated or malformed evidence is marked partial.

At the home root, `board.json` (`{pid, url}`) records the running service for clients and `token` keeps the service's auth token across restarts so URLs stay valid.

Ending an operation moves its directory, `closer/` and `reports/` included, to `archive/<id>-<timestamp>` and adds `report.json` (outcome, per-contact final states, counts, stats, brief). History is kept.
