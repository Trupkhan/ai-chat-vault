/**
 * Exercises the storage layer against a real SQLite file: migrations, token
 * encryption round-trip, rule CRUD, and the idempotency guarantee that stops
 * the moderation runner from acting on the same comment twice.
 *
 * Run with: npm run dbtest
 */

import assert from "node:assert/strict";
import fs from "node:fs";

// Set before any of the modules below are *called*. Safe as static imports
// because lib/env.ts exposes getters — nothing reads process.env at import
// time, only on first use.
process.env.DATABASE_PATH = "./data/dbtest.db";
process.env.TOKEN_ENCRYPTION_KEY =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
process.env.SESSION_SECRET = "dbtest";
process.env.FB_APP_SECRET = "dbtest-secret";

fs.rmSync("./data/dbtest.db", { force: true });
fs.rmSync("./data/dbtest.db-wal", { force: true });
fs.rmSync("./data/dbtest.db-shm", { force: true });

import {
  saveAccount,
  savePages,
  listPages,
  getPageToken,
  deleteAccount,
} from "../src/lib/store";
import {
  createRule,
  listRules,
  setRuleEnabled,
  deleteRule,
  claimAction,
  completeAction,
  listLog,
} from "../src/lib/moderationStore";
import { encrypt, decrypt } from "../src/lib/crypto";

let passed = 0;
function test(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (error) {
    console.error(`FAIL  ${name}`);
    console.error(`      ${(error as Error).message}`);
    process.exitCode = 1;
  }
}

console.log("\nencryption");

test("token round-trips through encrypt/decrypt", () => {
  const secret = "EAAG...a-real-looking-page-token";
  assert.equal(decrypt(encrypt(secret)), secret);
});

test("ciphertext differs between calls (random IV)", () => {
  assert.notEqual(encrypt("same"), encrypt("same"));
});

test("tampered ciphertext fails to decrypt", () => {
  const payload = encrypt("secret");
  const [iv, tag, data] = payload.split(".");
  const flipped = data.slice(0, -2) + (data.slice(-2) === "AA" ? "BB" : "AA");
  assert.throws(() => decrypt([iv, tag, flipped].join(".")));
});

console.log("\naccounts and pages");

saveAccount({ id: "acct1", name: "Test User", userToken: "user-token-1", expiresAt: null });
savePages("acct1", [
  { id: "page1", name: "My Page", category: "Blog", access_token: "page-token-1", tasks: ["MANAGE"] },
  { id: "page2", name: "Other Page", access_token: "page-token-2" },
]);

test("pages are stored and listed", () => {
  const pages = listPages("acct1");
  assert.equal(pages.length, 2);
  assert.equal(pages[0].name, "My Page");
  assert.deepEqual(pages[0].tasks, ["MANAGE"]);
});

test("page token decrypts back to the original", () => {
  assert.equal(getPageToken("acct1", "page1"), "page-token-1");
});

test("token lookup is scoped to the owning account", () => {
  assert.equal(getPageToken("someone-else", "page1"), null);
});

test("re-saving a page updates rather than duplicating", () => {
  savePages("acct1", [{ id: "page1", name: "Renamed", access_token: "page-token-1b" }]);
  assert.equal(listPages("acct1").length, 2);
  assert.equal(getPageToken("acct1", "page1"), "page-token-1b");
});

console.log("\nmoderation rules");

const created = createRule({
  pageId: "page1",
  name: "Block spam",
  matchType: "keyword",
  pattern: "spam",
  action: "hide",
  priority: 10,
});

test("rule is created and listed", () => {
  const rules = listRules("page1");
  assert.equal(rules.length, 1);
  assert.equal(rules[0].name, "Block spam");
  assert.equal(rules[0].enabled, true);
});

test("rule can be disabled", () => {
  setRuleEnabled("page1", created.id, false);
  assert.equal(listRules("page1")[0].enabled, false);
  setRuleEnabled("page1", created.id, true);
});

test("rules are scoped per page", () => {
  assert.equal(listRules("page2").length, 0);
});

console.log("\nidempotency");

test("the same comment+rule can only be claimed once", () => {
  const first = claimAction({ pageId: "page1", commentId: "c1", ruleId: created.id });
  const second = claimAction({ pageId: "page1", commentId: "c1", ruleId: created.id });
  assert.equal(first, true, "first claim should succeed");
  assert.equal(second, false, "second claim must be refused — this is what prevents duplicate auto-replies");
});

test("a different rule may still act on the same comment", () => {
  const other = createRule({
    pageId: "page1",
    name: "Second rule",
    matchType: "keyword",
    pattern: "x",
    action: "flag",
  });
  assert.equal(claimAction({ pageId: "page1", commentId: "c1", ruleId: other.id }), true);
});

test("completing an action writes it to the log", () => {
  completeAction({
    pageId: "page1",
    commentId: "c1",
    ruleId: created.id,
    ruleName: "Block spam",
    postId: "p1",
    action: "hide",
    authorName: "Someone",
    message: "buy spam now",
    status: "applied",
  });

  const entries = listLog("page1");
  const entry = entries.find((item) => item.commentId === "c1" && item.ruleName === "Block spam");
  assert.ok(entry, "log entry should exist");
  assert.equal(entry!.status, "applied");
  assert.equal(entry!.action, "hide");
});

test("pending claims stay out of the visible log", () => {
  // The second rule was claimed but never completed.
  const entries = listLog("page1");
  assert.equal(entries.some((item) => item.status === "pending"), false);
});

console.log("\ncascade delete");

test("deleting the account removes pages, rules and logs", () => {
  deleteRule("page1", created.id);
  deleteAccount("acct1");
  assert.equal(listPages("acct1").length, 0);
  assert.equal(listRules("page1").length, 0);
  assert.equal(listLog("page1").length, 0);
});

console.log(`\n${passed} checks passed\n`);
