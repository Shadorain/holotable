import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_SETTINGS,
  displaySettingsPath,
  formatSettings,
  setSettingKey,
  settingsFile,
  validateSettings,
} from "../src/settings.ts";
import { readSettings, writeSettings } from "../src/store/settings.ts";
import type { Settings } from "../src/core/types.ts";

const dirs: string[] = [];
function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "holotable-settings-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

describe("validateSettings", () => {
  test("accepts an empty object and fills defaults", () => {
    expect(validateSettings({})).toEqual(DEFAULT_SETTINGS);
  });

  test("rejects cap 65 and non-integer cap", () => {
    expect(() => validateSettings({ cap: 65 })).toThrow("cap must be an integer from 1 to 64");
    expect(() => validateSettings({ cap: 0 })).toThrow("cap must be an integer from 1 to 64");
    expect(() => validateSettings({ cap: 2.5 })).toThrow("cap must be an integer from 1 to 64");
  });

  test("validates access and migrates old host values, dropping the key", () => {
    expect(() => validateSettings({ access: "invalid" })).toThrow("access must be one of: local, tailscale, network");
    expect(validateSettings({ host: "127.0.0.1" }).access).toBe("local");
    expect(validateSettings({ host: "localhost" }).access).toBe("local");
    expect(validateSettings({ host: "0.0.0.0" }).access).toBe("network");
    expect(validateSettings({ host: "board.local" }).access).toBe("network");
    expect("host" in validateSettings({ host: "127.0.0.1" })).toBe(false);
    expect(validateSettings({ access: "network" }).access).toBe("network");
  });

  test("rejects a bad port", () => {
    expect(() => validateSettings({ port: 65536 })).toThrow("port must be 0 or an integer from 1 to 65535");
    expect(() => validateSettings({ port: -1 })).toThrow("port must be 0 or an integer from 1 to 65535");
    expect(() => validateSettings({ port: "8080" })).toThrow("port must be 0 or an integer from 1 to 65535");
    expect(validateSettings({ port: 8080 }).port).toBe(8080);
    expect(validateSettings({ port: 0 }).port).toBe(0);
  });

  test("rejects out-of-range pollMs and sampleMs", () => {
    expect(() => validateSettings({ pollMs: 500 })).toThrow("pollMs must be an integer from 1000 to 60000");
    expect(() => validateSettings({ sampleMs: 5000 })).toThrow("sampleMs must be an integer from 10000 to 600000");
  });

  test("rejects unknown enum values in defaults", () => {
    expect(() => validateSettings({ defaults: { frontend: "vscode" } })).toThrow(
      "defaults.frontend must be one of: orca, herdr, custom, none",
    );
    expect(() => validateSettings({ defaults: { tracker: "jira" } })).toThrow("defaults.tracker must be one of");
  });

  test("normalizes empty custom templates to absent", () => {
    const withEmpty = validateSettings({ custom: { terminal: "x", focus: "" } });
    expect(withEmpty.custom).toEqual({ terminal: "x" });
    const allEmpty = validateSettings({ custom: {} });
    expect(allEmpty.custom).toEqual({});
  });

  test("error names the path", () => {
    expect(() => validateSettings({ cap: 65 }, "my-settings.json")).toThrow(
      "Invalid settings at my-settings.json:",
    );
  });
});

describe("readSettings/writeSettings", () => {
  test("absent file yields defaults", async () => {
    const home = tempHome();
    expect(await readSettings(home)).toEqual(DEFAULT_SETTINGS);
  });

  test("round trip writes mode 0600 and reads back", async () => {
    const home = tempHome();
    const settings: Settings = {
      ...DEFAULT_SETTINGS,
      port: 4321,
      custom: { terminal: "tmux neww -c {cwd} {command}", focus: "tmux selectw -t {handle}", close: "tmux killw -t {handle}" },
    };
    await writeSettings(home, settings);
    expect(statSync(settingsFile(home)).mode & 0o777).toBe(0o600);
    expect(await readSettings(home)).toEqual(settings);
  });

  test("writeSettings rejects invalid settings", async () => {
    const home = tempHome();
    await expect(writeSettings(home, { ...DEFAULT_SETTINGS, cap: 65 })).rejects.toThrow("cap must be");
  });

  test("readSettings rejects invalid JSON", async () => {
    const home = tempHome();
    await writeSettings(home, DEFAULT_SETTINGS);
    await Bun.write(settingsFile(home), "not json");
    await expect(readSettings(home)).rejects.toThrow("Invalid JSON in settings at");
  });

  test("readSettings migrates legacy host to access and writeSettings drops host from disk", async () => {
    const home = tempHome();
    const file = settingsFile(home);
    await Bun.write(file, JSON.stringify({ host: "127.0.0.1", port: 4848 }));
    const s1 = await readSettings(home);
    expect(s1.access).toBe("local");
    expect("host" in s1).toBe(false);
    await writeSettings(home, s1);
    const text1 = await Bun.file(file).text();
    expect(text1).toContain('"access": "local"');
    expect(text1).not.toContain('"host"');

    await Bun.write(file, JSON.stringify({ host: "0.0.0.0", port: 4848 }));
    const s2 = await readSettings(home);
    expect(s2.access).toBe("network");
    expect("host" in s2).toBe(false);
  });
});

describe("setSettingKey", () => {
  test("parses numbers", () => {
    const next = setSettingKey(DEFAULT_SETTINGS, "port", "8080");
    expect(next.port).toBe(8080);
    expect(setSettingKey(DEFAULT_SETTINGS, "cap", "4").cap).toBe(4);
    expect(setSettingKey(DEFAULT_SETTINGS, "pollMs", "2000").pollMs).toBe(2000);
  });

  test("sets enum defaults", () => {
    expect(setSettingKey(DEFAULT_SETTINGS, "defaults.frontend", "orca").defaults.frontend).toBe("orca");
    expect(() => setSettingKey(DEFAULT_SETTINGS, "defaults.fleet", "k8s")).toThrow("defaults.fleet must be one of");
  });

  test("sets access and custom templates", () => {
    expect(setSettingKey(DEFAULT_SETTINGS, "access", "network").access).toBe("network");
    expect(setSettingKey(DEFAULT_SETTINGS, "access", "local").access).toBe("local");
    expect(() => setSettingKey(DEFAULT_SETTINGS, "access", "invalid")).toThrow("access must be one of");
    const withCustom = setSettingKey(DEFAULT_SETTINGS, "custom.terminal", "kitty {cwd}");
    expect(withCustom.custom?.terminal).toBe("kitty {cwd}");
  });
  test("a single custom.* key survives writeSettings and readSettings", async () => {
    const home = tempHome();
    const withCustom = setSettingKey(DEFAULT_SETTINGS, "custom.terminal", "kitty {cwd}");
    await writeSettings(home, withCustom);
    const back = await readSettings(home);
    expect(back.custom).toEqual({ terminal: "kitty {cwd}" });
  });

  test("rejects a non-numeric or empty numeric setting", () => {
    expect(() => setSettingKey(DEFAULT_SETTINGS, "port", "")).toThrow("port must be a non-negative integer");
    expect(() => setSettingKey(DEFAULT_SETTINGS, "port", " ")).toThrow("port must be a non-negative integer");
    expect(() => setSettingKey(DEFAULT_SETTINGS, "cap", "4.5")).toThrow("cap must be a non-negative integer");
  });

  test("does not mutate the input settings", () => {
    const before = structuredClone(DEFAULT_SETTINGS);
    setSettingKey(DEFAULT_SETTINGS, "cap", "2");
    expect(DEFAULT_SETTINGS).toEqual(before);
  });

  test("rejects an unknown key listing the valid ones", () => {
    expect(() => setSettingKey(DEFAULT_SETTINGS, "nope", "x")).toThrow(
      'Unknown setting "nope". Valid keys: access, port, cap, pollMs, sampleMs',
    );
  });

  test("rejects an invalid value for the key", () => {
    expect(() => setSettingKey(DEFAULT_SETTINGS, "cap", "65")).toThrow("cap must be an integer from 1 to 64");
  });
});
describe("AI settings", () => {

  test("validateSettings parses and trims ai string fields and normalizes empty to null", () => {
    const s = validateSettings({
      ai: {
        model: "  anthropic/claude-3-5-sonnet  ",
        thinking: "  high  ",
        draft: "",
        decision: "  openai/gpt-4o  ",
        mission: null,
      },
    });
    expect(s.ai).toEqual({
      model: "anthropic/claude-3-5-sonnet",
      thinking: "high",
      draft: null,
      decision: "openai/gpt-4o",
      mission: null,
    });
  });

  test("validateSettings rejects non-record ai and invalid field types", () => {
    expect(() => validateSettings({ ai: "nope" })).toThrow("ai must be a JSON object");
    expect(() => validateSettings({ ai: { model: 123 } })).toThrow("ai.model must be a string or null");
    expect(() => validateSettings({ ai: { thinking: "ultra" } })).toThrow("ai.thinking must be one of: off, minimal, low, medium, high, xhigh, max, auto");
  });

  test("setSettingKey updates and clears ai fields", () => {
    let s = setSettingKey(DEFAULT_SETTINGS, "ai.model", "openai/gpt-4o");
    expect(s.ai.model).toBe("openai/gpt-4o");

    s = setSettingKey(s, "ai.thinking", "low");
    expect(s.ai.thinking).toBe("low");

    s = setSettingKey(s, "ai.thinking", "");
    expect(s.ai.thinking).toBeNull();

    s = setSettingKey(s, "ai.model", null);
    expect(s.ai.model).toBeNull();

    s = setSettingKey(s, "ai.draft", "none");
    expect(s.ai.draft).toBeNull();
  });

  test("round trips ai settings to disk", async () => {
    const home = tempHome();
    const withAi = setSettingKey(
      setSettingKey(DEFAULT_SETTINGS, "ai.model", "anthropic/claude-3-5-sonnet"),
      "ai.thinking",
      "medium",
    );
    await writeSettings(home, withAi);
    const read = await readSettings(home);
    expect(read.ai.model).toBe("anthropic/claude-3-5-sonnet");
    expect(read.ai.thinking).toBe("medium");
  });
});

describe("display/format", () => {
  test("displaySettingsPath abbreviates the home dir", () => {
    expect(displaySettingsPath("/home/me/.omp/agent/holotable", "/home/me")).toBe(
      "~/.omp/agent/holotable/settings.json",
    );
    expect(displaySettingsPath("/other/dir", "/home/me")).toBe("/other/dir/settings.json");
  });

  test("formatSettings lists every key", () => {
    const text = formatSettings(DEFAULT_SETTINGS);
    for (const key of ["access", "port", "cap", "pollMs", "sampleMs", "defaults.tracker", "defaults.delivery"])
      expect(text).toContain(`${key}:`);
  });
});
