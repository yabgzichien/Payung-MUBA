# Migrate the web app from static HTML/CSS/JS to Next.js

**Status:** drafted from conversation 2026-08-29, awaiting user approval before planning.
**Classification:** architectural (build system / routing / deployment restructuring). No visual, layout, or business-logic change is intended anywhere in this document. Every user-visible pixel and every `/api/*` response shape must be identical before and after.

---

## 1. Problem statement

The app is a single 2,917-line [web/index.html](../../../web/index.html) (1,194 lines of inline CSS, ~1,335 lines of inline vanilla JS) served as a static file by a hand-rolled Node `http` server, [src/server.ts](../../../src/server.ts), which also exposes seven JSON `/api/*` endpoints backed by [src/core.ts](../../../src/core.ts), [src/intent.ts](../../../src/intent.ts), [src/aave.ts](../../../src/aave.ts), and [src/spot.ts](../../../src/spot.ts). Deployment to Vercel uses a custom [vercel.json](../../../vercel.json) that routes every path to `src/server.ts` as a single Node function, bypassing Vercel's normal static/serverless split.

The user wants this converted to a Next.js app, with the explicit constraint that the design, layout, and backend behavior must not change. This is being done for its own sake (framework modernization / standard Vercel deployment), not to fix a UX or backend problem — so the guiding principle throughout is **minimum-risk relocation, not rewrite**.

## 2. Rejected alternative: rewrite the frontend as idiomatic React

Considered and rejected (confirmed with the user in the initial Q&A). The vanilla JS in `index.html` is a ~1,335-line hand-rolled state machine covering wallet connection (injected-provider detection, balance polling, chain-switching), a canvas-drawn price chart with a draggable floor line, a multi-step wizard (`setStep`), and direct DOM mutation keyed off element ids. Reimplementing this as React components/hooks would touch every line of behavior-bearing code in the app for a task whose only requirement is "run inside Next.js" — the highest-risk way to satisfy "don't change the design or layout." Rejected in favor of lift-and-shift (§4).

## 3. Target structure

```
app/
  layout.tsx        — <html>/<head>: metadata (title, favicon), font <link>s,
                       <Script src="/ethers.min.js" strategy="beforeInteractive">,
                       <Script src="/app.js" strategy="afterInteractive">
  page.tsx           — renders the extracted body markup
  _markup.ts         — BODY_HTML constant (verbatim extracted markup)
  globals.css        — the extracted <style> block, verbatim, imported once in layout.tsx
  api/
    parse/route.ts
    candidates/route.ts
    quote/route.ts
    simulate/route.ts
    prepare-tx/route.ts
    execute/route.ts
    history/route.ts
public/
  ethers.min.js, favicon.svg, payung-icon.svg   — moved from web/, unchanged
  app.js                                         — extracted <script> block, verbatim
  support.js, "Payung Protection Workspace.dc.html" — moved from web/, unchanged (see §7)
src/
  core.ts, cli.ts, intent.ts, aave.ts, spot.ts, judgment.ts, spec.ts — untouched
  api-shared.ts      — NEW: candidateId, toWire, jsonSafe, ClientError, getCached,
                       parseSpend, serverSigningAllowed, SERVER_SIGNING_REFUSAL,
                       the cache Maps (candidate cache, spotCache, candleCache),
                       extracted verbatim from server.ts
```

`src/server.ts`, `web/`, and `vercel.json` are deleted once the migration is verified. Nothing outside `server.ts` itself and `tests/wire.test.ts` currently imports from `src/server.ts` (confirmed by grep), so this is safe.

## 4. Frontend: byte-for-byte lift-and-shift

Hand-transcribing ~400 lines of markup ([web/index.html:1196](../../../web/index.html#L1196)–1582, the `<body>` content excluding the trailing `<script>`) into JSX risks attribute typos, self-closing-tag mistakes, and invalid-in-JSX constructs. Instead:

- The body markup is extracted verbatim into a template string (`BODY_HTML` in `app/_markup.ts`) and rendered via a single `<div dangerouslySetInnerHTML={{ __html: BODY_HTML }} />` in `page.tsx`. This guarantees pixel-identical output — React never re-renders this subtree because no component state drives it, exactly as today's static HTML is never re-rendered by anything but the legacy script's own direct DOM mutations.
- The `<style>` block ([web/index.html:12](../../../web/index.html#L12)–1194) becomes `app/globals.css`, imported once in the root layout. It is global, unscoped CSS today (no CSS Modules), so this is a direct copy with no selector changes needed.
- The `<script>` block ([web/index.html:1583](../../../web/index.html#L1583)–end) becomes `public/app.js`, loaded with `next/script`'s `strategy="afterInteractive"` — this fires after hydration, which is functionally equivalent to the original's own `document.addEventListener('DOMContentLoaded', ...)` gate at the bottom of the file. No line of this script changes.
- `ethers.min.js` was loaded in `<head>` via a blocking `<script src>` before any inline script ran; `app.js` depends on the `ethers` global being present by the time its `DOMContentLoaded` handler fires. This is preserved with `strategy="beforeInteractive"` on the ethers script.
- `<title>`, the favicon `<link>`, and the two Google Fonts `<link>` tags move into the root layout — title/favicon via Next's `metadata` export, fonts kept as raw `<link>` tags (not `next/font`) to avoid any change in how/when font files are fetched.

## 5. Backend: same functions, Next.js Route Handlers

Each `if (req.method === X && url === Y)` branch in [src/server.ts:215](../../../src/server.ts#L215)–470 becomes one `route.ts` exporting the matching HTTP method, calling the same `core.ts`/`intent.ts`/`aave.ts`/`spot.ts` functions with unchanged arguments. Specifically preserved, unchanged:

- **Error shape and status codes** — `ClientError` → 400, anything else → 500, body always `{ error: message }`, via `jsonSafe` (handles `bigint`).
- **The CSRF content-type gate** — every POST route still rejects non-`application/json` bodies before running any handler logic ([src/server.ts:203](../../../src/server.ts#L203)–213).
- **The in-memory caches** — candidate cache (`CACHE_MAX_AGE_MS` = 3 min), `spotCache`/`candleCache` (`HISTORY_CACHE_MS` = 60s), moved into `src/api-shared.ts` as module-level singletons so every route handler importing that module shares the same instances, matching today's single-module behavior. As today, these do not survive a cold serverless start — no behavior change from the current Vercel deployment.
- **`GET /api/history`** — query params read via `request.nextUrl.searchParams` instead of manual `URLSearchParams` parsing; same validation (`asset` must be `ETH`/`BTC`, `days` clamped 1–90), same per-asset/per-asset+days caching split.

### 5a. Security-critical detail: `serverSigningAllowed()`

Today, `localDirectRun` is set `true` only when `server.ts` is executed directly ([src/server.ts:473](../../../src/server.ts#L473)–474: `process.argv[1].endsWith('server.ts')`), which happens for `npm run web` (bound to `127.0.0.1`) and never for the Vercel-invoked `handler` export. This is the entire reason `/api/execute` and `/api/simulate` — both of which can spend real USDC from the server's burner wallet — are refused on the public deployment.

Next.js Route Handlers have no equivalent "was this the directly-run entrypoint" signal. The port uses `!process.env.VERCEL` — Vercel sets `VERCEL=1` in every deployed invocation but it is never set under local `next dev`/`next start` — preserving the same guarantee: **local-only unless `PAYUNG_ALLOW_SERVER_SIGNING=true` is explicitly set**, exactly as today (`src/server.ts:66`–68). This is flagged for extra scrutiny during implementation and testing.

## 6. Deployment

`vercel.json` is deleted; Vercel auto-detects Next.js and needs no custom build/route config. The `web` npm script (`tsx src/server.ts`) is replaced by the standard `next dev` / `next build` / `next start` scripts.

## 7. Explicitly out of scope

- **The CLI** (`src/cli.ts` and everything it imports) — confirmed with the user as untouched. It does not import `server.ts` and has no dependency on the web app's structure.
- **`web/support.js` and `web/Payung Protection Workspace.dc.html`** — grep confirms `index.html` never references `support.js` and no `<x-dc>` markup exists in it; these appear to be an unrelated design-tool export, not part of the running app. They are moved into `public/` unchanged rather than dropped, so anyone who could reach `/support.js` today still can — dropping them would be an actual (if obscure) behavior change, which is out of scope for a migration.
- **All existing vitest tests** (`tests/*.test.ts`) keep testing `src/*.ts` unchanged. The one exception: `tests/wire.test.ts` imports `candidateId`, `toWire`, `jsonSafe` from `../src/server.js` ([tests/wire.test.ts:2](../../../tests/wire.test.ts#L2)); this import path changes to `../src/api-shared.js` since that's where those functions now live. The assertions themselves do not change.

## 8. Testing / verification plan

- `npm test` (vitest) passes unchanged, including the updated `wire.test.ts` import.
- `next build` succeeds with no type errors.
- Manual/browser verification of the full flow (NL parse → candidates → quote → wallet connect → prepare-tx) against `next dev`, comparing against the current `npm run web` behavior for the same inputs.
- Explicit check that `/api/execute` and `/api/simulate` return the `SERVER_SIGNING_REFUSAL` 403 when `VERCEL` is set (or simulated), and behave as today when run locally.
