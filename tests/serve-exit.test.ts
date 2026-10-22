import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

test("serve exits promptly on SIGTERM after a board tab dropped its event stream", async () => {
  const home = mkdtempSync(join(tmpdir(), "holotable-serve-exit-"));
  const agent = mkdtempSync(join(tmpdir(), "holotable-serve-agent-"));
  dirs.push(home, agent);
  // No `omp` on PATH: the model-catalog warm-up child would otherwise hold a fresh board open for seconds.
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "..", "bin", "holotable.ts"), "serve", "--port", "0", "--access", "local"], {
    env: { ...process.env, PATH: "/usr/bin:/bin", OMP_HOLOTABLE_HOME: home, PI_CODING_AGENT_DIR: agent, OMP_AGENT_DIR: agent },
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    const reader = child.stdout.getReader();
    let printed = "";
    let url: URL | null = null;
    while (!url) {
      const { value, done } = await reader.read();
      if (done) throw new Error(`serve stopped before printing its URL: ${printed}`);
      printed += new TextDecoder().decode(value);
      const match = printed.match(/http:\/\/127\.0\.0\.1:\d+\/#\w+/);
      if (match) url = new URL(match[0]);
    }
    const stream = new AbortController();
    const response = await fetch(`${url.origin}/api/stream`, { headers: { "x-holotable-token": url.hash.slice(1) }, signal: stream.signal });
    await response.body?.getReader().read();
    stream.abort();
    // Real time on purpose: the server has to see the disconnect before the signal, as with a closed tab.
    await Bun.sleep(300);

    const started = performance.now();
    child.kill("SIGTERM");
    const exited = await Promise.race([child.exited.then(() => true), Bun.sleep(5000).then(() => false)]);
    expect(exited).toBe(true);
    // Under the 3 s fallback in bin/holotable.ts: the dropped stream left nothing running.
    expect(performance.now() - started).toBeLessThan(2000);
    expect(child.exitCode).toBe(0);
  } finally {
    child.kill("SIGKILL");
  }
}, 20_000);
