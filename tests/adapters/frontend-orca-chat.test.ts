import { expect, test } from "bun:test";
import { orcaChatFrontend } from "../../src/adapters/frontend-orca-chat.ts";
import { noneFrontend } from "../../src/adapters/frontend-none.ts";
import type { Run } from "../../src/ports.ts";

const session = {
  sessionId: "native-session", executionHostId: "local", worktreeId: "opaque-worktree",
  worktreePath: "/checkout", incarnation: 4, agent: "omp", liveness: "alive", wslDistro: null,
};
const ref = { handle: session.sessionId, incarnationId: "4", host: "local", worktreeId: session.worktreeId };
const reply = (result: unknown) => ({ code: 0, stdout: JSON.stringify({ ok: true, result }), stderr: "" });

function inventory(rows: unknown[]): Run {
  return async (_command, args) => {
    if (args[0] === "session" && args[1] === "list") return reply({ sessions: rows });
    throw new Error(`Unexpected mutating request: ${args.slice(0, 2).join(" ")}`);
  };
}

test("native close refuses a replacement incarnation and a same-path session on another host", async () => {
  for (const replacement of [{ ...session, incarnation: 5 }, { ...session, executionHostId: "ssh:other" }]) {
    const frontend = orcaChatFrontend(noneFrontend(), inventory([replacement]));
    await expect(frontend.close(ref, "/checkout")).rejects.toMatchObject({ code: "terminal-missing" });
  }
});

test("persisted exited sessions do not reserve capacity or become focusable", async () => {
  const frontend = orcaChatFrontend(noneFrontend(), inventory([
    { ...session, liveness: "exited" },
    { ...session, sessionId: "starting", liveness: "starting" },
  ]));
  const listed = await frontend.listTerminals();
  expect(listed?.filter((row) => row.connected).map((row) => row.handle)).toEqual(["starting"]);
  await expect(frontend.focus(ref, "/checkout")).rejects.toMatchObject({ code: "terminal-missing" });
});

test("native inventory fails closed on ambiguous path, fence, liveness and WSL placement", async () => {
  for (const invalid of [
    { ...session, worktreePath: undefined }, { ...session, incarnation: 1.5 },
    { ...session, liveness: "unknown" }, { ...session, wslDistro: "Ubuntu" },
  ]) {
    const frontend = orcaChatFrontend(noneFrontend(), inventory([invalid]));
    await expect(frontend.listTerminals()).rejects.toMatchObject({ code: "orca-chat-inventory" });
  }
});

test("native launch refuses a terminal downgrade or a conflicting atomic session identity", async () => {
  const launch = { worktree: "/checkout", title: "Mission", argv: ["omp"], env: {}, worktreeId: session.worktreeId };
  const valid = { outcome: { kind: "structured", sessionId: session.sessionId }, worktreeId: session.worktreeId, receipt: { mode: "structured" }, session };
  for (const result of [
    { ...valid, outcome: { kind: "terminal", sessionId: session.sessionId } },
    { ...valid, session: { ...session, executionHostId: "ssh:other" } },
    { ...valid, session: { ...session, worktreePath: "/another-checkout" } },
    { ...valid, session: { ...session, liveness: "exited" } },
  ]) {
    const run: Run = async (_command, args) => {
      if (args[0] === "agent" && args[1] === "launch") return reply(result);
      throw new Error("Launch identity must be handed off atomically");
    };
    await expect(orcaChatFrontend(noneFrontend(), run).openTerminal(launch)).rejects.toMatchObject({ code: "orca-chat-launch" });
  }
});

test("native launch accepts Orca's atomic top-level worktree receipt", async () => {
  const run: Run = async () => reply({
    outcome: { kind: "structured", sessionId: session.sessionId, handle: "provider-handle" },
    worktreeId: session.worktreeId,
    receipt: { mode: "structured" },
    session,
  });
  const launched = await orcaChatFrontend(noneFrontend(), run).openTerminal({
    worktree: "/checkout", title: "Mission", argv: ["omp"], env: {}, worktreeId: session.worktreeId,
  });
  expect(launched).toEqual(ref);
});
