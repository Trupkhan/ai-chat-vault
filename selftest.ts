/**
 * Logic checks for the pure modules — the parts that can be wrong without the
 * build noticing. No network, no database.
 *
 * Run with: npm run selftest
 */

import assert from "node:assert/strict";
import { firstMatch, ruleMatches, validateRule, type Rule } from "../src/lib/moderation";
import { validateScheduleTime, validateContent } from "../src/lib/scheduling";
import { evaluate, type Signals } from "../src/lib/monetization";

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

function rule(overrides: Partial<Rule>): Rule {
  return {
    id: 1,
    pageId: "p1",
    name: "test",
    enabled: true,
    matchType: "keyword",
    pattern: "spam",
    action: "hide",
    replyText: null,
    priority: 100,
    ...overrides,
  };
}

console.log("\nmoderation rules");

test("keyword match is case-insensitive and comma separated", () => {
  const r = rule({ pattern: "crypto, DM me" });
  assert.equal(ruleMatches(r, "Great post, DM ME for details"), true);
  assert.equal(ruleMatches(r, "buy CRYPTO now"), true);
  assert.equal(ruleMatches(r, "nice photo"), false);
});

test("regex match works and bad regex never throws", () => {
  assert.equal(ruleMatches(rule({ matchType: "regex", pattern: "\\b(free|win)\\b" }), "FREE money"), true);
  assert.equal(ruleMatches(rule({ matchType: "regex", pattern: "\\b(free|win)\\b" }), "freedom"), false);
  // A pattern that no longer compiles must return false, not crash the run.
  assert.equal(ruleMatches(rule({ matchType: "regex", pattern: "([" }), "anything"), false);
});

test("link match catches bare domains and urls", () => {
  const r = rule({ matchType: "link", pattern: "" });
  assert.equal(ruleMatches(r, "check https://spam.example/x"), true);
  assert.equal(ruleMatches(r, "visit cheapstuff.shop today"), true);
  assert.equal(ruleMatches(r, "no links at all here"), false);
});

test("empty comment does not match a keyword rule", () => {
  assert.equal(ruleMatches(rule({ pattern: "spam" }), ""), false);
});

test("firstMatch respects priority and skips disabled rules", () => {
  const rules = [
    rule({ id: 1, name: "reply", priority: 200, action: "reply", pattern: "hello" }),
    rule({ id: 2, name: "delete", priority: 10, action: "delete", pattern: "hello" }),
    rule({ id: 3, name: "off", priority: 1, enabled: false, pattern: "hello" }),
  ];
  const match = firstMatch(rules, "hello there");
  assert.equal(match?.name, "delete", "lowest priority number should win");
});

test("firstMatch returns null when nothing matches", () => {
  assert.equal(firstMatch([rule({ pattern: "zzz" })], "hello"), null);
});

console.log("\nrule validation");

test("reply rule requires reply text", () => {
  const result = validateRule({ name: "x", matchType: "keyword", pattern: "a", action: "reply" });
  assert.equal(result.ok, false);
});

test("invalid regex is rejected at creation", () => {
  const result = validateRule({ name: "x", matchType: "regex", pattern: "([", action: "hide" });
  assert.equal(result.ok, false);
  assert.match(result.error!, /Invalid regular expression/);
});

test("link rule does not require a pattern", () => {
  assert.equal(validateRule({ name: "x", matchType: "link", action: "hide" }).ok, true);
});

console.log("\nscheduling");

const nowSeconds = 1_800_000_000;

test("rejects times under the 10 minute minimum", () => {
  assert.equal(validateScheduleTime(nowSeconds + 300, nowSeconds).ok, false);
});

test("accepts a time just past the minimum", () => {
  assert.equal(validateScheduleTime(nowSeconds + 601, nowSeconds).ok, true);
});

test("rejects times beyond six months", () => {
  assert.equal(validateScheduleTime(nowSeconds + 200 * 86400, nowSeconds).ok, false);
});

test("content needs something in it", () => {
  assert.equal(validateContent({}).ok, false);
  assert.equal(validateContent({ message: "hi" }).ok, true);
  assert.equal(validateContent({ photoUrl: "https://x.test/a.jpg" }).ok, true);
});

test("a bare link with no text is rejected", () => {
  assert.equal(validateContent({ link: "https://x.test" }).ok, false);
});

test("malformed urls are rejected", () => {
  assert.equal(validateContent({ message: "hi", link: "not a url" }).ok, false);
});

console.log("\nmonetization");

const emptySignals: Signals = {
  followers: null,
  isPublished: null,
  videoCount: null,
  postsLast30Days: null,
  watchMinutes60Days: null,
  engagements60Days: null,
};

test("unmeasurable signals report unknown, never fail", () => {
  const { products } = evaluate(emptySignals, {});
  const ads = products.find((p) => p.product === "in_stream_ads")!;
  assert.equal(ads.blocking.length, 0, "nothing should be reported as blocking when nothing was measured");
  assert.equal(ads.ready, false, "unmeasured must not count as ready");
});

test("a page under threshold is reported as blocking", () => {
  const { products } = evaluate({ ...emptySignals, followers: 200 }, {});
  const stars = products.find((p) => p.product === "stars")!;
  assert.ok(stars.blocking.some((check) => check.id === "stars_followers"));
});

test("unanswered manual checks keep a page from reading as ready", () => {
  const strong: Signals = {
    followers: 50_000,
    isPublished: true,
    videoCount: 20,
    postsLast30Days: 12,
    watchMinutes60Days: 900_000,
    engagements60Days: 90_000,
  };
  assert.equal(evaluate(strong, {}).products.find((p) => p.product === "stars")!.ready, false);

  const allAnswered = {
    partner_policies: true,
    content_policies: true,
    eligible_country: true,
    admin_age: true,
    stars_duration: true,
  };
  assert.equal(
    evaluate(strong, allAnswered).products.find((p) => p.product === "stars")!.ready,
    true,
  );
});

console.log(`\n${passed} checks passed\n`);
