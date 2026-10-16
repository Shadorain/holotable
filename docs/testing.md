# Testing

`bun test` and `bun run typecheck` must pass before every commit. Tests live under `tests/`, mirroring `src/`.

## Rules

- Isolated state only: every test makes temp directories with `mkdtemp` and removes them in `afterEach`. Home and agent directories are passed explicitly or via `OMP_HOLOTABLE_HOME` / `PI_CODING_AGENT_DIR` pointing at temp dirs. Never touch `~/.omp/agent`, `~/.omp/agent/missions` or a live `mission.json`.
- Test behavior (state tables, refusals, event sequences, git outcomes), not wiring or copied constants.
- Spawns go through the injected `Run`; tests use fakes or real git on temp repos. No network.

## Harnesses

|File|Provides|
|---|---|
|`tests/helpers.ts`|`seedOperation`, `status`, `contact`, `lane`, `fakePorts()` (in-memory ports that record calls, with `world.fail` to break a named method and `world.hold` to hold a launch mid-flight), `noRun`|
|`tests/core/fixtures.ts`|pure fixtures for `core/`|
|`tests/runtime/lander.test.ts`|real git repos, real `local-merge` delivery and git workspaces|
|`tests/runtime/actions.test.ts`|the real `omp-mission` fleet adapter against a stub unix-socket owner|

## Smokes (real programs)

- `bun run demo` serves the real board over simulated ports (every button works, nothing touches git or Orca); open one of the printed URLs and play Launch → Approve → Land, including the conflict path.
- Intel: open the header link from Board and an archive report. Confirm the base page never requests `/intel.js`, `/intel.css` or `/api/intel`; Intel requests sources plus one selected snapshot, never `/api/stream` or normal projections. Switch each facet, open diagnostics and recommendation history, refresh explicitly, return to the board. Check unknown legacy quality, partial cost, frozen archives, an unavailable source, keyboard tabs and a 390px viewport. Observe at least 30 seconds idle with zero extra API requests; record browser task time and heap separately from the watcher/service.
- Launch against Orca needs a repo whose Orca project has a worktree base path, and a launched `omp` that loads `omp-mission`. Close terminals by exact handle (never `--all`); an idle `omp` pane is about 600 MB.

## Benchmarks (read-only, reproducible)

- `memcap 512M -- bun examples/benchmark-evaluation.ts [pure|watch|append]` measures fold/evaluate CPU, per-pass watcher cost and append tail reads on generated fixtures; prints JSON, exits 1 when a gate fails.
- omp-mission: `memcap 2G -- bun examples/benchmark-usage.ts` measures `UsageProbe` cold/warm/append/throttle reads and the 4 MiB budget.
