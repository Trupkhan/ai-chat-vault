# Page Suite

Four tools for running a Facebook Page, built entirely on Meta's official Graph API:

| Tool | What it does |
| --- | --- |
| **Insights** | Follower growth, reach, impressions, engagement, per-post performance, best posting hours. Read-only. |
| **Scheduler** | Compose text / link / photo posts and queue them. Scheduling is handed to Facebook, so posts publish even when this app is offline. |
| **Moderation** | Keyword, regex and link rules that hide, delete, auto-reply to or flag comments. Manual inbox, dry-run preview, full audit log. |
| **Monetization** | Your page measured against Meta's published eligibility thresholds, with the remaining gaps listed. |

## What this app deliberately does not do

- **No payout, billing, or ads-spend access.** No permission is requested that
  can move money or change where payouts go. Meta does not expose payout
  configuration through the Graph API at all, by design.
- **No bulk inviting, auto-liking, or follower automation.** Those actions
  violate Meta's Platform Terms and are the fastest route to a restricted page.
  Everything here uses documented, permitted API endpoints.
- **No UI scraping or browser automation.** Every call is an authenticated
  Graph API request.

## Setup

### 1. Create a Meta app

1. Go to <https://developers.facebook.com/apps> → **Create App** → type **Business**.
2. Add the **Facebook Login for Business** product.
3. Under Facebook Login → Settings, add your redirect URI to
   **Valid OAuth Redirect URIs**:
   `http://localhost:3000/api/auth/callback` for local development.
4. Copy the **App ID** and **App Secret** from Settings → Basic.

### 2. Configure the app

```bash
cd page-suite
npm install
cp .env.example .env.local
```

Fill in `.env.local`. Generate the two secrets with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

`TOKEN_ENCRYPTION_KEY` must be 64 hex characters — page access tokens are
encrypted at rest with it. If you lose it, stored tokens become unreadable and
you simply reconnect.

### 3. Run

```bash
npm run dev      # http://localhost:3000
npm test         # 52 checks, no network or credentials needed
npm run build    # production build
```

Open the app and click **Connect Facebook**.

## Permissions requested

| Permission | Used for |
| --- | --- |
| `pages_show_list` | Listing the pages you administer |
| `pages_read_engagement` | Page and post metadata |
| `pages_read_user_content` | Reading comments written by other people |
| `pages_manage_posts` | Creating and scheduling posts |
| `pages_manage_engagement` | Hiding, deleting and replying to comments |
| `read_insights` | Page and post insight metrics |

While your app is in development mode these work for admins, developers and
testers of the app. To use it on a page you do not administer — or to let other
people use it — the app must go through **App Review** for each permission.

## Automating the moderation run

Rules apply when you press **Run rules now**, or when an external scheduler
calls the run endpoint. Set `CRON_SECRET` in the environment, then:

```bash
curl -X POST https://your-host/api/moderation/run \
  -H "x-cron-secret: $CRON_SECRET"
```

That sweeps every connected page. The endpoint refuses to run if `CRON_SECRET`
is unset, so an empty variable cannot leave it open.

Every `(comment, rule)` pair is recorded before the Graph call is made, so
re-running — or two overlapping runs — will never double-hide a comment or post
a duplicate auto-reply.

## Architecture

```
src/
  app/
    api/
      auth/{login,callback,logout}   OAuth: state cookie, long-lived token exchange
      pages/                         Connected page list + refresh
      insights/                      Page metrics; insights/posts for per-post + best hours
      posts/                         GET queue · POST create · PATCH reschedule · DELETE cancel
      moderation/{rules,comments,run,log}
      monetization/                  Signals + scored report; POST records manual answers
    {insights,scheduler,moderation,monetization}/   UI routes
  components/                        PageGate (page selector), feature views, shared UI
  lib/
    graph.ts          Graph client: retry on 429/5xx, typed errors, appsecret_proof
    crypto.ts         AES-256-GCM token encryption, HMAC cookie signing
    db.ts / store.ts  SQLite schema and repositories
    moderation*.ts    Rule engine, storage, runner
    monetization.ts   Eligibility thresholds and scoring
scripts/              selftest.ts (pure logic) · dbtest.ts (storage + crypto)
                      graphtest.mts (Graph request shapes, stubbed fetch)
```

Storage is SQLite via `better-sqlite3` — one file, nothing to provision. The
schema ports to Postgres unchanged if this ever becomes multi-tenant.

### Design decisions worth knowing

**Scheduling is Meta's, not ours.** Posts are created with
`scheduled_publish_time`, so Facebook holds the queue. No job runner to keep
alive, and nothing is lost if this app is redeployed or asleep.

**Insights degrade instead of failing.** Meta retires page metrics between Graph
versions, and Graph fails the *whole* insights call if one requested metric is
unknown. When the batch request fails, the client retries each metric
individually and reports which ones were unavailable — rather than showing an
empty chart that looks like zero traffic.

**"Could not measure" is not "failed".** The monetization checker distinguishes
a threshold you missed from one it could not read. Reporting an unmeasured
metric as a failure would send you chasing a problem you may not have.

### What the tests do and do not cover

`npm test` runs three suites with no network and no credentials:

- **selftest** — rule matching, priority ordering, regex safety, schedule
  bounds, monetization scoring.
- **dbtest** — encryption round-trip, token scoping, rule CRUD, the
  idempotency claim, cascade deletes.
- **graphtest** — `fetch` is stubbed, so this asserts the exact URLs, methods
  and bodies sent to Meta, plus the error paths that are awkward to reproduce
  live: expired token, missing permission, rate-limit retry, and a retired
  insight metric.

The gap: **no suite makes a real Graph API call.** A stub agrees with whatever
you tell it to. These verify our side of the contract; they cannot confirm that
Meta's current API still matches it. The insight metric names are the most
likely thing to drift — which is why that path degrades and names what failed
rather than rendering an empty chart.

## Monetization checker: read this before trusting it

Meta does not publish a general eligibility API — the Monetization Eligibility
API is limited to approved partners. This tool therefore compares your page
against Meta's **published** thresholds using the numbers Graph does expose.

Two limitations, both surfaced in the UI:

1. **Thresholds change.** They are dated in `src/lib/monetization.ts`
   (`THRESHOLDS_REVIEWED`) and must be re-checked against Meta's current
   monetization documentation. That constant is a snapshot, not a live feed.
2. **Policy compliance is not measurable.** Content standards, partner
   policies, country eligibility and admin age are self-reported checkboxes.

A green result here is an estimate. The only authoritative answer is in
**Meta Business Suite → Monetization**.

## Graph API version

Set by `FB_GRAPH_VERSION` (default `v23.0`). Meta deprecates versions on a
rolling schedule — bump it deliberately and re-test insights first, since that
is where metric changes bite.
