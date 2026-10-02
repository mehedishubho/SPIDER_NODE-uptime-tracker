// One-shot generator: builds 07-UAT.md from uat.classify-coverage results (verified CLI + JSON shape).
const { execSync } = require("child_process");
const fs = require("fs");

const GSD = "node .zcode/gsd-core/bin/gsd-tools.cjs";
const DIR = ".planning/phases/07-better-auth-cutover-admin-gating-prisma-removal";
const PLANS = ["01", "02", "03", "04", "05", "06", "07", "08"];

const auto = [];
const human = [];
const errors = [];

for (const p of PLANS) {
  const out = execSync(
    `${GSD} query uat.classify-coverage --summary "${DIR}/07-${p}-SUMMARY.md"`,
    { encoding: "utf8", maxBuffer: 1e8 }
  );
  const j = JSON.parse(out);
  for (const e of j.errors || []) errors.push({ plan: `07-${p}`, error: String(e) });
  for (const a of j.auto_passed || []) {
    auto.push({ plan: `07-${p}`, id: a.id, description: a.description });
  }
  for (const h of j.present || []) {
    human.push({ plan: `07-${p}`, reason: h.reason, description: h.description });
  }
}

const now = new Date().toISOString();
let n = 0;
const L = [];

// Cold-start smoke test (prepended: 07-01 files include drizzle/0002_better_auth_cutover.sql -> migrations/*)
L.push(`### ${++n}. Cold Start Smoke Test`);
L.push(`expected: Kill any running server/service. Clear ephemeral state (temp DBs, caches, lock files). Start the application from scratch. Server boots without errors, any seed/migration completes, and a primary query (health check, homepage load, or basic API call) returns live data.`);
L.push(`result: [pending]`);
L.push("");

for (const a of auto) {
  const short = a.description.replace(/\s+/g, " ").slice(0, 70);
  L.push(`### ${++n}. [${a.plan}${a.id ? " " + a.id : ""}] ${short}… (automated)`);
  L.push(`expected: ${a.description}`);
  L.push(`result: pass`);
  L.push(`source: automated`);
  if (a.id) L.push(`coverage_id: ${a.id}`);
  L.push("");
}

for (const h of human) {
  const short = h.description.replace(/\s+/g, " ").slice(0, 70);
  L.push(`### ${++n}. [${h.plan}] ${short}…`);
  L.push(`expected: ${h.description}`);
  L.push(`result: [pending]`);
  L.push("");
}

const total = n;
const pending = total - auto.length; // cold start + human entries

const md = `---
status: testing
phase: 07-better-auth-cutover-admin-gating-prisma-removal
source: [07-01-SUMMARY.md, 07-02-SUMMARY.md, 07-03-SUMMARY.md, 07-04-SUMMARY.md, 07-05-SUMMARY.md, 07-06-SUMMARY.md, 07-07-SUMMARY.md, 07-08-SUMMARY.md]
started: ${now}
updated: ${now}
---

## Current Test
<!-- OVERWRITE each test - shows where we are -->

number: 1
name: Cold Start Smoke Test
expected: |
  Kill any running server/service. Clear ephemeral state (temp DBs, caches, lock files). Start the application from scratch. Server boots without errors, any seed/migration completes, and a primary query (health check, homepage load, or basic API call) returns live data.
awaiting: user response

## Tests

${L.join("\n")}

## Summary

total: ${total}
passed: ${auto.length}
issues: 0
pending: ${pending}
skipped: 0

## Gaps

[none yet]
`;

fs.writeFileSync(`${DIR}/07-UAT.md`, md);
console.log(`WROTE ${DIR}/07-UAT.md — total:${total} auto:${auto.length} human:${human.length} pending:${pending}`);
for (const e of errors) console.log(`ERROR ${e.plan}: ${e.error}`);
