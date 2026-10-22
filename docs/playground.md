# Playground

`bun run demo [--port 4747] [--access local|tailscale|network] [--host 0.0.0.0] [--home /tmp/holotable-playground]` serves the real board over simulated ports. Access defaults to `tailscale`; `--host 127.0.0.1` (or `localhost`) means `local` and any other host means `network`, unless `--access` is given. Launch walks through plan (**Approve plan** on the card or opt-in `auto.plans`), execute, a Pause gate, review and complete. Plan edits, refinement and stale-revision approval refusals use the simulated socket contract. Land can open a conflict mission; Reap, Relaunch, Focus, notes, decisions, contacts and abort also work. Nothing touches Orca or any CLI. `--home` runs an isolated copy and prints its URLs.

The playground seeds five open operations:

|Operation|Wiring|What it shows|
|---|---|---|
|`charidel`|Linear, Orca, GitHub PR|a busy campaign: ready tickets, decisions, a conflict mission, quota holds, red CI|
|`mission`|custom frontend, local merge|the full mission flow, a closed pane, an idle coordinator, a tool approval, a closer|
|`lab`|all `none`|a board with no frontend or fleet: its queue shows as **Blocked**|
|`autopilot`|custom frontend, local merge|auto mode on (`maxLive` 2) and Recovery on|
|`scratch`|standalone, fleet `none`|an operation with no project|

The simulated frontend lists its panes, so a pane can vanish: the `status` contact in the `mission` operation is seeded with a closed pane (offline, not reaped), and Reap closes any other. **Relaunch** brings a session back at resume hold (card shows Continue; Continue resumes at the stage it left); `autopilot` has `recover` on, and `set recover on` on `mission` makes the board relaunch and continue that closed pane by itself. Settings survive restarts (`<home>/settings.json` is kept and applied); demo data does not.

The `review` contact in the `mission` operation is seeded with a coordinator idle at review since ten minutes before startup, so it shows **Idle in its pane** under **Needs you**.
The `socket` contact in `mission` is seeded mid-execute waiting on a tool approval (`bash`, `bun run migrate --apply`). Its card shows the prompt with **Approve**, **Approve bash for this session** and **Deny**, and any of them lets the mission run on.

Simulated decision panes write their answer about five seconds after opening (the recommended option, else the first, else "proceed with the longest option"), so the watcher decides on its own. `charidel` has two undecided contacts: `CHR-151` with options "Migrate ACS data"/"Start fresh" and the former recommended — switch on `auto.decide` and it lands instantly — and `CHR-163`, a free-text decision for **Ask an agent**.

`charidel` also seeds failure cases. `CHR-156`'s simulated PR has a red `Flaky e2e` check, so once it completes, Land waits and **Land anyway** (or **Land with failing checks**) merges it. `CHR-167` and `CHR-157-CONFLICT-1` are parked on provider quota: the first leads with **Switch model** and fills the strip above the list, while the second stopped while planning, where the switch is not offered.

`mission` ends with a [closer](guide.md#closer-review): it stays blocked, saying how many contacts are left, until `socket`, `status`, `review` and `herdr` have all landed, then launches like any contact. Its card shows the review brief under Details before launch, and the simulated closer writes a JSON report (and a Markdown copy) once it completes: verdicts cycle ok, follow-up, fixed, and it leaves the last ticket out so its chip reads **not reported**. `autopilot` gets one from `defaults.closer`, so auto mode launches and finishes it after the pipeline lands.

Simulated missions publish a status report from review on (marked in progress) and a complete one with summary and PR link once delivered. `CHR-153` in `charidel` and `notes` in `lab` landed before the board started, so their cards show only the saved report.

Two operations are closed through the real end path before the board starts, so Picker → Archive shows a closer review both ways: `relay` with a JSON review (a not-run e2e, a fix, high/medium/low follow-ups) and `ledger` with only a Markdown report written the way older closers did (gate table, seam checks, fixes with commits, numbered follow-ups, verbatim gate output).
