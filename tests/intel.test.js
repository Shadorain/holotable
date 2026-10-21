import { describe, expect, test } from "bun:test";
import { operationDocket } from "../web/intel-brief.js";
import { sortContacts } from "../web/intel.js";

const ctx = { duration: n => n, money: n => n, number: n => n, opId: "op" };
const rule = (id, scoreMs) => ({
  id, ruleVersion: 1, level: "warning", message: "", caveat: "",
  evidence: { numerator: 2, denominator: 4, observedMs: 60_000, contacts: ["A"], eventIndexes: [] },
  ...(scoreMs === undefined ? {} : { impact: { ms: scoreMs, usd: null, scoreMs } }),
});
const evaluation = recommendations => ({
  recommendations, phaseMs: {}, offlineMs: null, quality: null, fleet: {},
  usage: { byPhase: {}, coordinatorSessionAssociated: false }, coverage: { legacyUsage: 0 },
  queued: { n: 0, totalMs: 0, maxMs: null }, connectivity: { mean: null },
});

describe("operationDocket", () => {
  test("ranks cases by what they put at stake, carrying the stake", () => {
    const cases = operationDocket(evaluation([rule("usage-coverage", 0), rule("relaunch-churn", 3_600_000), rule("delivery-wait", 18_000_000)]), ctx);
    expect(cases.map(c => c.id)).toEqual(["delivery-wait", "relaunch-churn", "usage-coverage"]);
    expect(cases[0].impact).toEqual({ ms: 18_000_000, usd: null, scoreMs: 18_000_000 });
  });

  test("evaluations archived before impact ranking keep severity order", () => {
    const cases = operationDocket(evaluation([rule("usage-coverage"), rule("delivery-wait"), rule("relaunch-churn")]), ctx);
    expect(cases.map(c => c.id)).toEqual(["relaunch-churn", "delivery-wait", "usage-coverage"]);
    expect(cases[0].impact).toBeNull();
  });

  test("a fix that turns on a setting the operation already has is not offered", () => {
    const fixes = auto => operationDocket(evaluation([rule("dependency-wait", 1)]), { ...ctx, auto })[0].fixes.map(f => f.text);
    const launchOn = /set auto\.launch on/;
    expect(fixes(null).some(t => launchOn.test(t))).toBe(true);
    expect(fixes({ enabled: false, launch: false }).some(t => launchOn.test(t))).toBe(true);
    expect(fixes({ enabled: false, launch: true }).some(t => launchOn.test(t))).toBe(false);
    // The map link is not a setting and always stays.
    expect(fixes({ enabled: true, launch: true })).toContain("map:op");
  });
});

describe("sortContacts", () => {
  const contact = (ticket, leadMs, outcome = "open") => ({ ticket, leadMs, outcome });
  const contacts = [contact("A", null), contact("B", 5000, "landed"), contact("C", 9000, "landed"), contact("D", 5000, "abandoned")];
  const tickets = list => list.map(c => c.ticket);

  test("orders by the measure with unknown values last and ties in declaration order", () => {
    expect(tickets(sortContacts(contacts, "lead", "desc"))).toEqual(["C", "B", "D", "A"]);
    expect(tickets(sortContacts(contacts, "lead", "asc"))).toEqual(["B", "D", "C", "A"]);
    expect(tickets(sortContacts(contacts, "outcome", "asc"))).toEqual(["A", "B", "C", "D"]);
  });

  test("no sort key keeps declaration order without mutating the input", () => {
    const sorted = sortContacts(contacts, "", "desc");
    expect(tickets(sorted)).toEqual(["A", "B", "C", "D"]);
    expect(sorted).not.toBe(contacts);
  });
});
