import { expect, test } from "bun:test";
import { evaluateOperation } from "../../src/core/evaluation.ts";
import { foldEvents } from "../../src/core/fold.ts";
import { buildReport } from "../../src/core/report.ts";
import type { Contact, Event, Hold, Measurements } from "../../src/core/types.ts";
import { ev, iso, makeContact, makeMeasurements, makeOp, makeUsageEvidence, T0 } from "./fixtures.ts";

const launch=(ticket="a")=>ev(0,ticket,"launched",{worktree:"/w",frontend:"orca",terminal:{handle:ticket,incarnationId:ticket}});
function sample(ms:number,ticket="a",hold:Hold="none",complete=false,measurements?:Measurements):Event {
 return ev(ms,ticket,"sample",{mission:{id:`run-${ticket}`,hold,verify:null,complete},usageEvidence:makeUsageEvidence(0),...(measurements?{measurements}:{})});
}
function facts(events:Event[],contacts:Contact[]=[makeContact("a")],now=1_000_000){
 const sorted=[...events].sort((a,b)=>Date.parse(a.at)-Date.parse(b.at));
 return evaluateOperation(makeOp(contacts),foldEvents(sorted),T0+now);
}

test("verification and review rules require their own repeated-operation thresholds",()=>{
 for(const repeated of [1,2])for(const failures of [2,3]){
  const e=facts([launch(),sample(1,"a","none",false,makeMeasurements({recordedFailed:repeated+1,repeatedFailedRevision:repeated,reviewFailures:failures}))]);
  expect(e.recommendations.some(r=>r.id==="repeat-verification")).toBe(repeated>=2);
  expect(e.recommendations.some(r=>r.id==="review-retries")).toBe(failures>=3);
 }
});

test.each([[4,2,false],[5,2,true],[10,2,false],[10,3,true]] as const)("integration rule requires attempts, conflicts and rate: %i/%i",(attempts,conflicts,expected)=>{
 const events=[launch(),sample(1),...Array.from({length:attempts},(_,i)=>ev(2+i,"a","land-attempt",{outcome:i<conflicts?"conflict":"clean"}))];
 const rule=facts(events).recommendations.find(r=>r.id==="integration-conflicts");
 expect(!!rule).toBe(expected);
 if(rule){expect(rule.evidence.numerator).toBe(conflicts);expect(rule.evidence.denominator).toBe(attempts);}
});

test("approval wait needs three explicitly held contacts, ten minutes total and operation-wide elapsed share",()=>{
 for(const count of [2,3])for(const held of [199_999,200_000]){
  const contacts=Array.from({length:count},(_,i)=>makeContact(`c${i}`));
  const events=contacts.flatMap(c=>[launch(c.ticket),sample(1000,c.ticket,"gate"),sample(1000+held,c.ticket)]);
  const rule=facts(events,contacts,601_000).recommendations.find(r=>r.id==="approval-wait");
  expect(!!rule).toBe(count===3&&held===200_000);
  if(rule){expect(rule.evidence.observedMs).toBe(600_000);expect(rule.evidence.numerator).toBe(3);expect(rule.evidence.denominator).toBe(3);}
 }
 const contacts=["a","b","c","d"].map(ticket=>makeContact(ticket));
 const events=contacts.flatMap(c=>[launch(c.ticket),sample(1000,c.ticket,c.ticket==="d"?"none":"gate"),sample(201_000,c.ticket)]);
 expect(facts(events,contacts,601_000).recommendations.some(r=>r.id==="approval-wait")).toBe(false);
 const legacy=contacts.slice(0,3).flatMap(c=>[launch(c.ticket),ev(1000,c.ticket,"gate-armed",{gate:c.ticket})]);
 expect(facts(legacy,contacts,601_000).recommendations.some(r=>r.id==="approval-wait")).toBe(false);
});

test("delivery delay requires three measured work deliveries and uses the final completion interval",()=>{
 for(const count of [2,3])for(const delay of [599_999,600_000]){
  const contacts=Array.from({length:count},(_,i)=>makeContact(`c${i}`));
  const events=contacts.flatMap(c=>[launch(c.ticket),sample(1,c.ticket,"none",true),ev(1+delay,c.ticket,"landed",{via:"merge"})]);
  const rule=facts(events,contacts).recommendations.find(r=>r.id==="delivery-wait");
  expect(!!rule).toBe(count===3&&delay===600_000);
  if(rule)expect(rule.evidence.observedMs).toBe(600_000);
 }
 const contacts=[makeContact("a"),makeContact("b",{kind:"decision"}),makeContact("c",{kind:"conflict"})];
 const events=contacts.flatMap(c=>[launch(c.ticket),sample(1,c.ticket,"none",true),ev(700_001,c.ticket,"landed",{via:"manual"})]);
 expect(facts(events,contacts).recommendations.some(r=>r.id==="delivery-wait")).toBe(false);
 const repaired=["a","b","c"].flatMap(ticket=>[launch(ticket),sample(1,ticket,"none",true),sample(700_000,ticket),sample(800_000,ticket,"none",true),ev(900_000,ticket,"landed",{via:"merge"})]);
 expect(facts(repaired,["a","b","c"].map(ticket=>makeContact(ticket))).recommendations.some(r=>r.id==="delivery-wait")).toBe(false);
});

test("rule ordering is bounded, selects strongest run evidence and points to the threshold checkpoint",()=>{
 const contacts=[makeContact("a"),makeContact("z")];
 const events:Event[]=[launch("a"),launch("z"),sample(1,"a","none",false,makeMeasurements({recordedFailed:3,repeatedFailedRevision:2,reviewFailures:3}))];
 for(let i=0;i<5;i++)events.push(sample(2+i,"z","none",false,makeMeasurements({recordedFailed:i+1,repeatedFailedRevision:i,reviewFailures:i})));
 events.push(ev(10,"z","sample",{usageEvidence:{...makeUsageEvidence(0),missing:1,partial:true}}));
 events.push(...Array.from({length:5},(_,i)=>ev(20+i,"a","land-attempt",{outcome:i<2?"conflict":"clean"})));
 const e=facts(events,contacts),repeat=e.recommendations[1]!;
 expect(e.recommendations.map(r=>r.id)).toEqual(["usage-coverage","repeat-verification","review-retries"]);
 expect(repeat.evidence.contacts).toEqual(["z"]);expect(repeat.evidence.numerator).toBe(4);
 expect(repeat.evidence.eventIndexes).toContain(7);
 for(const r of e.recommendations){
  expect(r.ruleVersion).toBe(1);expect(r.evidence.contacts.length).toBeLessThanOrEqual(3);expect(r.evidence.eventIndexes.length).toBeLessThanOrEqual(3);
  for(const index of r.evidence.eventIndexes)expect(index).toBeLessThan(events.length);
 }
});

test("closed recommendations do not change with live read time",()=>{
 const op=makeOp([makeContact("a")]),events=[launch(),sample(1,"a","none",false,makeMeasurements({recordedFailed:3,repeatedFailedRevision:2})),ev(100,null,"closed",{outcome:"failed"})];
 const first=buildReport(op,events,new Date(T0+200));
 expect(first.evaluation?.recommendations.map(r=>r.id)).toEqual(["repeat-verification"]);
 expect(buildReport(op,events,new Date(T0+100_000_000)).evaluation?.recommendations).toEqual(first.evaluation?.recommendations);
});
