/**
 * Graph API contract tests.
 *
 * These close the gap the other two suites leave open: selftest.ts covers pure
 * logic and dbtest.ts covers storage, but neither checks what we actually
 * *send* to Meta. Here `fetch` is stubbed, so we can assert on the exact URLs,
 * methods and bodies the client builds, and drive the error paths (rate limit,
 * expired token, retired metric) that are hard to reproduce against a live page.
 *
 * Still not a substitute for one real call against a real page — a stub agrees
 * with whatever we tell it to. It verifies our side of the contract only.
 *
 * Run with: npm run graphtest
 */

import assert from "node:assert/strict";
import fs from "node:fs";

process.env.DATABASE_PATH = "./data/graphtest.db";
process.env.TOKEN_ENCRYPTION_KEY =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
process.env.SESSION_SECRET = "graphtest";
process.env.FB_APP_ID = "123";
process.env.FB_APP_SECRET = "graphtest-secret";
process.env.FB_GRAPH_VERSION = "v23.0";

fs.rmSync("./data/graphtest.db", { force: true });
fs.rmSync("./data/graphtest.db-wal", { force: true });
fs.rmSync("./data/graphtest.db-shm", { force: true });

import { graph, graphPaged, GraphError } from "../src/lib/graph";
import { fetchPageInsights } from "../src/lib/insights";
import { fetchRecentComments } from "../src/lib/commentSource";
import { runModeration } from "../src/lib/moderationRunner";
import { savePages, saveAccount } from "../src/lib/store";
import { createRule } from "../src/lib/moderationStore";

// --- fetch stub -----------------------------------------------------------

interface Call {
  url: string;
  method: string;
  body?: string;
}

type Handler = (url: string, method: string, body?: string) =>
  | { status: number; payload: unknown }
  | null;

let calls: Call[] = [];
let handlers: Handler[] = [];

const realFetch = globalThis.fetch;

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  const method = init?.method ?? "GET";
  const body = init?.body ? String(init.body) : undefined;
  calls.push({ url, method, body });

  for (const handler of handlers) {
    const result = handler(url, method, body);
    if (result) {
      return new Response(JSON.stringify(result.payload), {
        status: result.status,
        headers: { "content-type": "application/json" },
      });
    }
  }

  // 400 rather than 500 so an unstubbed call fails fast instead of retrying.
  return new Response(
    JSON.stringify({ error: { message: `unstubbed: ${method} ${url}`, code: 1 } }),
    { status: 400, headers: { "content-type": "application/json" } },
  );
}) as typeof fetch;

function reset(...next: Handler[]): void {
  calls = [];
  handlers = next;
}

function param(url: string, name: string): string | null {
  return new URL(url).searchParams.get(name);
}

let passed = 0;
async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (error) {
    console.error(`FAIL  ${name}`);
    console.error(`      ${(error as Error).message}`);
    process.exitCode = 1;
  }
}

// --- request shape --------------------------------------------------------

console.log("\nrequest construction");

await test("GET targets the configured version and signs the request", async () => {
  reset(() => ({ status: 200, payload: { id: "1", name: "Page" } }));
  await graph("me", { params: { fields: "id,name" }, accessToken: "tok" });

  const url = calls[0].url;
  assert.ok(url.startsWith("https://graph.facebook.com/v23.0/me"), `unexpected url: ${url}`);
  assert.equal(param(url, "fields"), "id,name");
  assert.equal(param(url, "access_token"), "tok");
  // appsecret_proof is HMAC-SHA256(token, app secret) — presence and shape only.
  assert.match(param(url, "appsecret_proof") ?? "", /^[a-f0-9]{64}$/);
});

await test("leading slash in the path does not double up", async () => {
  reset(() => ({ status: 200, payload: {} }));
  await graph("/me/accounts", { accessToken: "tok" });
  assert.ok(calls[0].url.includes("/v23.0/me/accounts"), calls[0].url);
  assert.ok(!calls[0].url.includes("//me"), "path should not contain a double slash");
});

await test("POST sends a form-encoded body and keeps auth in the query", async () => {
  reset(() => ({ status: 200, payload: { id: "post_1" } }));
  await graph("page1/feed", {
    method: "POST",
    accessToken: "tok",
    body: { message: "hello world", published: false, scheduled_publish_time: 1800000600 },
  });

  const call = calls[0];
  assert.equal(call.method, "POST");
  const form = new URLSearchParams(call.body!);
  assert.equal(form.get("message"), "hello world");
  assert.equal(form.get("published"), "false");
  assert.equal(form.get("scheduled_publish_time"), "1800000600");
  assert.equal(param(call.url, "access_token"), "tok");
});

await test("undefined body fields are omitted rather than sent as 'undefined'", async () => {
  reset(() => ({ status: 200, payload: { id: "x" } }));
  await graph("page1/feed", {
    method: "POST",
    accessToken: "tok",
    body: { message: "hi", link: undefined },
  });
  const form = new URLSearchParams(calls[0].body!);
  assert.equal(form.has("link"), false, "an undefined link must not be sent");
});

// --- error handling -------------------------------------------------------

console.log("\nerror handling");

await test("expired token is classified as needing re-auth", async () => {
  reset(() => ({
    status: 401,
    payload: { error: { message: "Session expired", code: 190, type: "OAuthException" } },
  }));

  await assert.rejects(
    () => graph("me", { accessToken: "tok", retries: 0 }),
    (error: GraphError) => {
      assert.equal(error.needsReauth, true);
      assert.equal(error.isPermissionError, false);
      return true;
    },
  );
});

await test("missing permission is classified separately from a dead token", async () => {
  reset(() => ({
    status: 403,
    payload: { error: { message: "Requires pages_read_engagement", code: 200 } },
  }));

  await assert.rejects(
    () => graph("page1/insights", { accessToken: "tok", retries: 0 }),
    (error: GraphError) => {
      assert.equal(error.isPermissionError, true);
      assert.equal(error.needsReauth, false);
      return true;
    },
  );
});

await test("rate limit is retried and can succeed on a later attempt", async () => {
  let attempt = 0;
  reset(() => {
    attempt++;
    if (attempt === 1) {
      return { status: 400, payload: { error: { message: "rate limited", code: 4 } } };
    }
    return { status: 200, payload: { ok: true } };
  });

  const result = await graph<{ ok: boolean }>("me", { accessToken: "tok", retries: 2 });
  assert.equal(result.ok, true);
  assert.equal(calls.length, 2, "should have retried exactly once");
});

await test("an ordinary 4xx is not retried", async () => {
  reset(() => ({ status: 400, payload: { error: { message: "bad field", code: 100 } } }));
  await assert.rejects(() => graph("me", { accessToken: "tok", retries: 3 }));
  assert.equal(calls.length, 1, "a 400 must not be retried — it just burns quota");
});

// --- pagination -----------------------------------------------------------

console.log("\npagination");

await test("graphPaged follows next cursors and respects maxPages", async () => {
  reset((url) => {
    if (url.includes("cursor=2")) {
      return { status: 200, payload: { data: [{ id: "c" }, { id: "d" }] } };
    }
    return {
      status: 200,
      payload: {
        data: [{ id: "a" }, { id: "b" }],
        paging: { next: "https://graph.facebook.com/v23.0/page1/posts?cursor=2" },
      },
    };
  });

  const all = await graphPaged<{ id: string }>("page1/posts", {
    accessToken: "tok",
    maxPages: 2,
  });
  assert.deepEqual(all.map((item) => item.id), ["a", "b", "c", "d"]);
});

await test("graphPaged stops at maxPages even when more pages exist", async () => {
  reset(() => ({
    status: 200,
    payload: {
      data: [{ id: "x" }],
      paging: { next: "https://graph.facebook.com/v23.0/page1/posts?cursor=next" },
    },
  }));

  const all = await graphPaged<{ id: string }>("page1/posts", {
    accessToken: "tok",
    maxPages: 3,
  });
  assert.equal(all.length, 3, "should have stopped after 3 pages");
});

// --- insights degradation -------------------------------------------------

console.log("\ninsights degradation");

await test("a retired metric degrades to per-metric calls and is reported", async () => {
  reset((url) => {
    const metric = param(url, "metric") ?? "";

    // The batch request names several metrics at once.
    if (metric.includes(",")) {
      return {
        status: 400,
        payload: { error: { message: "(#100) nonexisting field page_views_total", code: 100 } },
      };
    }
    if (metric === "page_views_total") {
      return { status: 400, payload: { error: { message: "metric retired", code: 100 } } };
    }
    return {
      status: 200,
      payload: {
        data: [
          {
            name: metric,
            period: "day",
            values: [{ value: 10, end_time: "2026-08-01T07:00:00+0000" }],
          },
        ],
      },
    };
  });

  const result = await fetchPageInsights({
    pageId: "page1",
    token: "tok",
    metrics: ["page_impressions", "page_views_total"],
    since: 1,
    until: 2,
  });

  assert.deepEqual(result.series.map((entry) => entry.metric), ["page_impressions"]);
  assert.equal(result.unavailable.length, 1);
  assert.equal(result.unavailable[0].metric, "page_views_total");
  assert.equal(result.series[0].points[0].date, "2026-08-01");
});

await test("a permission error surfaces instead of degrading into empty charts", async () => {
  reset(() => ({
    status: 403,
    payload: { error: { message: "needs read_insights", code: 200 } },
  }));

  // Degrading here would render a blank dashboard that looks like zero traffic,
  // hiding the fact that a permission is missing.
  await assert.rejects(
    () =>
      fetchPageInsights({
        pageId: "page1",
        token: "tok",
        metrics: ["page_impressions", "page_fan_adds"],
        since: 1,
        until: 2,
      }),
    (error: GraphError) => error.isPermissionError === true,
  );
});

// --- comment fetching -----------------------------------------------------

console.log("\ncomment fetching");

const POSTS_PAYLOAD = {
  data: [
    {
      id: "post_1",
      message: "Our new launch",
      comments: {
        data: [
          {
            id: "c_spam",
            message: "buy crypto now at cheap.shop",
            created_time: "2026-08-01T10:00:00+0000",
            from: { id: "u1", name: "Spammer" },
          },
          {
            id: "c_ok",
            message: "congratulations, looks great",
            created_time: "2026-08-01T11:00:00+0000",
            from: { id: "u2", name: "Real Person" },
          },
          {
            id: "c_hidden",
            message: "buy crypto now",
            created_time: "2026-08-01T09:00:00+0000",
            is_hidden: true,
          },
        ],
      },
    },
  ],
};

await test("comments are flattened, sorted newest first, and carry the post id", async () => {
  reset(() => ({ status: 200, payload: POSTS_PAYLOAD }));

  const comments = await fetchRecentComments({ pageId: "page1", token: "tok" });
  assert.equal(comments.length, 3);
  assert.equal(comments[0].id, "c_ok", "newest comment should sort first");
  assert.equal(comments[0].postId, "post_1");
  assert.equal(comments[0].postMessage, "Our new launch");
});

await test("a commenter Graph will not identify becomes null, not a fabricated name", async () => {
  reset(() => ({ status: 200, payload: POSTS_PAYLOAD }));
  const comments = await fetchRecentComments({ pageId: "page1", token: "tok" });
  const hidden = comments.find((comment) => comment.id === "c_hidden")!;
  assert.equal(hidden.authorName, null);
  assert.equal(hidden.isHidden, true);
});

// --- moderation runner end to end ----------------------------------------

console.log("\nmoderation runner");

saveAccount({ id: "acct1", name: "Owner", userToken: "user-tok", expiresAt: null });
savePages("acct1", [{ id: "page1", name: "Test Page", access_token: "page-tok" }]);
createRule({
  pageId: "page1",
  name: "Block crypto",
  matchType: "keyword",
  pattern: "crypto",
  action: "hide",
  priority: 10,
});

function moderationHandlers(): Handler {
  return (url, method) => {
    if (url.includes("/page1/posts")) return { status: 200, payload: POSTS_PAYLOAD };
    if (method === "POST") return { status: 200, payload: { success: true } };
    return null;
  };
}

await test("a dry run reports matches and sends no write requests", async () => {
  reset(moderationHandlers());

  const summary = await runModeration({ pageId: "page1", token: "page-tok", dryRun: true });
  assert.equal(summary.matched, 1, "only the visible spam comment should match");
  assert.equal(summary.applied, 0);
  assert.equal(summary.outcomes[0].status, "would-apply");
  assert.equal(
    calls.filter((call) => call.method === "POST").length,
    0,
    "a dry run must not write anything",
  );
});

await test("a real run hides the matching comment with the right request", async () => {
  reset(moderationHandlers());

  const summary = await runModeration({ pageId: "page1", token: "page-tok" });
  assert.equal(summary.applied, 1);
  assert.equal(summary.failed, 0);

  const write = calls.find((call) => call.method === "POST")!;
  assert.ok(write.url.includes("/v23.0/c_spam"), `wrote to wrong target: ${write.url}`);
  assert.equal(new URLSearchParams(write.body!).get("is_hidden"), "true");
});

await test("an already-hidden comment is left alone", async () => {
  // Its own page and rule, so this does not depend on any earlier test's state
  // or on what the dedup table already contains.
  savePages("acct1", [{ id: "page9", name: "Hidden Only", access_token: "page9-tok" }]);
  createRule({
    pageId: "page9",
    name: "Block crypto",
    matchType: "keyword",
    pattern: "crypto",
    action: "hide",
  });

  reset((url, method) => {
    if (url.includes("/page9/posts")) {
      return {
        status: 200,
        payload: {
          data: [
            {
              id: "post_9",
              message: "Post",
              comments: {
                data: [
                  {
                    id: "c_already_hidden",
                    message: "crypto spam",
                    created_time: "2026-08-01T09:00:00+0000",
                    is_hidden: true,
                  },
                ],
              },
            },
          ],
        },
      };
    }
    if (method === "POST") return { status: 200, payload: { success: true } };
    return null;
  });

  const summary = await runModeration({ pageId: "page9", token: "page9-tok" });
  assert.equal(summary.matched, 0, "a hidden comment should not even be considered a match");
  assert.equal(
    calls.some((call) => call.url.includes("c_already_hidden")),
    false,
    "must not re-act on a comment someone already hid",
  );
});

await test("re-running does not act on the same comment twice", async () => {
  reset(moderationHandlers());

  const summary = await runModeration({ pageId: "page1", token: "page-tok" });
  assert.equal(summary.applied, 0);
  assert.equal(summary.skipped, 1, "the second run must skip what the first already handled");
  assert.equal(
    calls.filter((call) => call.method === "POST").length,
    0,
    "no duplicate hide — this is what stops duplicate auto-replies too",
  );
});

await test("a failed Graph write is recorded as failed, not silently dropped", async () => {
  reset((url, method) => {
    if (url.includes("/page1/posts")) {
      return {
        status: 200,
        payload: {
          data: [
            {
              id: "post_2",
              message: "Second post",
              comments: {
                data: [
                  {
                    id: "c_new_spam",
                    message: "more crypto spam",
                    created_time: "2026-08-02T10:00:00+0000",
                    from: { id: "u3", name: "Spammer Two" },
                  },
                ],
              },
            },
          ],
        },
      };
    }
    if (method === "POST") {
      return { status: 400, payload: { error: { message: "Comment not found", code: 100 } } };
    }
    return null;
  });

  const summary = await runModeration({ pageId: "page1", token: "page-tok" });
  assert.equal(summary.failed, 1);
  assert.equal(summary.applied, 0);
  assert.match(summary.outcomes[0].detail ?? "", /Comment not found/);
});

globalThis.fetch = realFetch;
console.log(`\n${passed} checks passed\n`);
