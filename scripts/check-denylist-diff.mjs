#!/usr/bin/env node
// check-denylist-diff.mjs — the D-40 denylist drift gate.
//
// The SSRF denylist is ONE list stated in THREE places (S-1 layering, RR-01):
//   1. the engine export  — DENYLIST in src/lib/ssrf.ts (audit §15.1)
//   2. the audit mirror   — docs/ARCHITECTURE-AUDIT.md §15.4 (prose, not parsed here)
//   3. the operator rules — docs/DEPLOY-RUNBOOK.md §10 (what the OS egress
//      firewall denies)
// The same-change mandate says all statements move together. This gate makes
// the mandate machine-enforced for the two machine-readable sides (engine
// export vs runbook §10): it extracts the CIDR tokens from each, compares
// them as SETS, and exits non-zero listing the symmetric difference on any
// drift. The audit mirror (side 2) is documentation; a §15.4 edit that skips
// the other two sides now FAILS `pnpm verify` here.
//
// Token extraction:
//   - engine side: the quoted strings of the `export const DENYLIST` array
//   - runbook side: BACKTICKED tokens inside §10 (the section between the
//     `## 10.` heading and the next `## ` heading), filtered by CIDR SHAPE so
//     prose decoys (`80/tcp`, `5432/tcp`, `10.x.x.x`, URLs, `http://`) never
//     enter the comparison:
//       IPv4: 1-4 dotted-or-bare numeric groups + /prefix  (10/8, 172.16/12, 0.0.0.0/8)
//       IPv6: hex/colon run, optional /prefix               (::1, fc00::/7, ::ffff:0:0/96)
//
// Usage: node scripts/check-denylist-diff.mjs   (also wired as `pnpm denylist:diff`
// in the verify chain, adjacent to worker:boundary — plan 04-09 Task 2, D-40).

import { readFileSync } from "node:fs";

const SSRF_FILE = "src/lib/ssrf.ts";
const RUNBOOK_FILE = "docs/DEPLOY-RUNBOOK.md";

function fail(message) {
  console.error(`[denylist-diff] FAIL: ${message}`);
  process.exit(1);
}

// --- engine side: the DENYLIST export ---------------------------------------

function extractEngineTokens() {
  const source = readFileSync(SSRF_FILE, "utf8");
  const match = source.match(/export\s+const\s+DENYLIST[^;]*;/s);
  if (!match) {
    fail(`could not locate 'export const DENYLIST' in ${SSRF_FILE} — the engine side of the D-40 gate is missing its anchor`);
  }
  const tokens = [...match[0].matchAll(/["']([^"']+)["']/g)].map((m) => m[1]);
  if (tokens.length === 0) {
    fail(`DENYLIST in ${SSRF_FILE} parsed as empty — extraction regex broken or the export changed shape`);
  }
  return tokens;
}

// --- runbook side: §10 backticked CIDR-shaped tokens -------------------------

const V4_SHAPE = /^(\d{1,3}\.){0,3}\d{1,3}\/\d{1,2}$/; // 10/8 .. 0.0.0.0/8
const V6_SHAPE = /^[0-9a-fA-F:]*:[0-9a-fA-F:]*$/; // contains ':' and only hex/colon

function isCidrShaped(token) {
  const body = token.replace(/\/\d{1,3}$/, ""); // strip optional /prefix
  return V4_SHAPE.test(token) || (token.includes(":") && V6_SHAPE.test(body) && body !== "");
}

function extractRunbookTokens() {
  const doc = readFileSync(RUNBOOK_FILE, "utf8");
  const start = doc.indexOf("## 10.");
  if (start === -1) {
    fail(`could not locate section '## 10.' in ${RUNBOOK_FILE} — the operator side of the D-40 gate is missing its anchor`);
  }
  const rest = doc.slice(start);
  const nextSection = rest.slice(1).search(/^## /m);
  const section = nextSection === -1 ? rest : rest.slice(0, nextSection + 1);
  const backticked = [...section.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
  const tokens = [...new Set(backticked.filter(isCidrShaped))];
  if (tokens.length === 0) {
    fail(`zero CIDR-shaped backticked tokens found in ${RUNBOOK_FILE} §10 — extraction filter broken or the operator list was deleted`);
  }
  return tokens;
}

// --- set comparison ----------------------------------------------------------

const engine = extractEngineTokens();
const runbook = extractRunbookTokens();

const engineSet = new Set(engine);
const runbookSet = new Set(runbook);
const onlyInEngine = [...engineSet].filter((t) => !runbookSet.has(t));
const onlyInRunbook = [...runbookSet].filter((t) => !engineSet.has(t));

if (engineSet.size !== engine.length || runbookSet.size !== runbook.length) {
  const dupes = (list) => list.filter((t, i) => list.indexOf(t) !== i);
  fail(
    `duplicate tokens present (a list, not a set): engine dups [${dupes(engine)}], runbook §10 dups [${dupes(runbook)}]`
  );
}

if (onlyInEngine.length > 0 || onlyInRunbook.length > 0) {
  fail(
    `denylist drift (D-40: one list, three statements — engine export, audit §15.4, runbook §10 must change together):\n` +
      `  only in src/lib/ssrf.ts DENYLIST: [${onlyInEngine.join(", ") || "—"}]\n` +
      `  only in docs/DEPLOY-RUNBOOK.md §10: [${onlyInRunbook.join(", ") || "—"}]\n` +
      `update BOTH statements (and audit §15.4) in the same change, then re-run pnpm denylist:diff.`
  );
}

console.log(
  `[denylist-diff] OK — engine DENYLIST and runbook §10 agree as sets (${engineSet.size} CIDR tokens: ${[...engineSet].join(", ")})`
);
