# UX design: conversational front door + collapsed orderbook

**Status:** drafted from conversation 2026-08-28, awaiting user approval before planning.
**Classification:** presentation-only. Nothing in this document changes `ProtectionSpec`, `filterCandidates`, the `/api/*` surface, or the provenance of any number the user sees. All edits are confined to markup, CSS, and render functions inside [web/index.html](../../../web/index.html).

---

## 1. Problem statement

Two complaints, both about the same thing: the UI's visual weight is on the parts the user doesn't need, and off the parts they do.

### 1a. The natural-language input reads as an optional extra, not the front door

The pitch is "say it in your own words — the AI fills the form." The screen says otherwise. The NL input at [web/index.html:376](../../../web/index.html#L376) is a single-line box the same height as the four form inputs below it, paired with a `btn secondary` labeled "Parse" ([:380](../../../web/index.html#L380)), sitting above a `.field-row` of four fully-populated controls that already contain valid defaults (`1 ETH`, `$2,300`, `14 days`).

Every weight cue points at the form: the fields are pre-filled and immediately actionable, the NL box is empty and requires an extra click before anything happens. A first-time user reads this as a form with an autofill shortcut, which is the inverse of the intended story.

### 1b. Step 2 renders eight near-identical rows for a decision already made

`filterCandidates` slices to eight ([src/core.ts:179](../../../src/core.ts#L179)). `renderCandidates` appends all eight, then auto-selects one at [:879](../../../web/index.html#L879) — index 0 unless a prior selection is being restored. So the default screen is eight rows in which seven are decoration for a choice already made on the user's behalf, and the row-level vocabulary (`put, buyable · iv 0.51`) is meaningless to the stated target user, who described their problem as "I have 1 ETH and need it worth $2,300."

But there is a real decision buried in those rows. In an observed book:

| floor | window | premium |
|---|---|---|
| $2,300 | 13.9d | $18.37/ETH |
| $2,250 | 13.9d | $12.37/ETH |
| $2,150 | 13.9d | $5.97/ETH |

A 6.5% lower floor costs 3.1× less. That price/protection tradeoff is the single most decision-relevant fact in the section — it is also `PROJECT.md`'s core pricing intuition made concrete — and it is currently on row 8, in a table the user has been given no reason to read.

---

## 2. Rejected alternative: replace the flow with a chatbot

Considered and rejected. Recorded here because it will be proposed again.

1. **It would break design rule 2.** [HANDOFF.md:194](../../../HANDOFF.md#L194) — "the LLM never produces a number the user sees." That boundary is currently *visible*: the model fills labeled fields, and every price appears in a card sourced from `previewFillOrder()`. In a message transcript, a bot saying "$18.37" is indistinguishable from a bot inventing "$18.37". The architecture would be unchanged and the credibility that architecture buys would be lost.
2. **Money needs reviewable state.** Before a wallet signature the user must see strike, expiry, premium, and total spend held still in one place. A transcript pushes them upward and out of view. The per-unit vs. total floor ambiguity — significant enough to warrant two synced inputs at [:396–403](../../../web/index.html#L396) — becomes an unreviewed parse instead of a visibly wrong number in a box.
3. **Chat does not add agency.** The system already perceives (live `fetchOrders` on Base), decides (`filterCandidates`, `judgment.ts`), and acts (`/api/prepare-tx` → `/api/execute`). Chat is transport; agency is authority to act. A message stream calls the same functions and adds none.
4. **Demo risk.** The current flow is deterministic and fast. Chat-first puts a Gonka Router round-trip on the critical path of every step during a live demo.
5. **Free text is not simpler, it is relocated complexity.** The four inputs are constrained (`select`, `number` with `min`/`max`), so whole classes of invalid input are unrepresentable. Unbounded text means owning parse failure, ambiguity, clarification turns, and multi-turn correction. The strict validation gate at [src/intent.ts:104](../../../src/intent.ts#L104) exists precisely because free text is harder.

The hybrid already in the codebase — NL in, structured everything-else — is the correct shape. This spec changes its *emphasis*, not its architecture.

---

## 3. Decisions

1. **The NL box becomes the hero of step 1.** Larger type, autofocus on load, `Enter` submits, and its button becomes primary (`.btn`, not `.btn secondary`).
2. **The four form fields demote to a "what I understood" confirmation strip** below it — compact, still fully editable. Editability is **required, not optional**: this strip is the user-facing audit surface for design rule 2. Making it read-only would defeat the entire reason for keeping a form.
3. **Step 2 renders one hero card plus a collapsed disclosure** for the remaining candidates, closed by default.
4. **The disclosure summary states the tradeoff as a sentence,** computed from the live list — not a generic "show more."
5. **`iv` moves off the primary card** into the expanded rows only. It is a real number from the book and is not removed, just deprioritized.
6. **Step 2's header and `fetchOrders()` subtitle stay.** They are the on-chain proof; the section is not deleted.

---

## 4. Screen-by-screen

### Step 1 — before

```
1  STATE WHAT YOU'RE AFRAID OF LOSING
   Say it in your own words — the AI fills the form; it never invents a price
   [                                        ] [ Parse ]     <- secondary
   [Asset ▾] [Amount] [Market floor $/ETH] [Total floor $] [Days]
   "I have 1 ETH. I need it to be worth at least $2,300..."
   [ Find real offers on Thetanuts → ]
```

### Step 1 — after

```
1  STATE WHAT YOU'RE AFRAID OF LOSING

   [ I have 1 ETH and need it worth at least $2,300 in two weeks   ]  <- hero, autofocus
                                                      [ Read this → ]  <- primary

   what I understood — edit anything                                   <- small, dim
   [ETH ▾] [1] [$2,300 /ETH] [$2,300 total] [14d]                      <- compact strip

   "I have 1 ETH. I need it to be worth at least $2,300 total in
    14 days" — that's a floor of $2,300 per ETH.
   [ Find real offers on Thetanuts → ]
```

The restated sentence at [:409](../../../web/index.html#L409) is unchanged and stays where it is. It is the parse-back receipt and it does that job already.

### Step 2 — before

Eight `.candidate` rows, the first badged `closest match`, all identical in weight.

### Step 2 — after

```
2  LIVE OFFERS PULLED FROM THE ORDERBOOK
   Querying fetchOrders() on Base, filtered to buyable puts near your strike...

   ┌──────────────────────────────────────────────────────────┐
   │ $2,300 floor   [closest match]              $18.37/ETH   │   <- hero, .selected
   │ 13.9d window · expires 2026-09-11           confirmed    │
   └──────────────────────────────────────────────────────────┘

   ▸ 7 more live offers — from $5.97/ETH ($2,150 floor) to
     $44.07/ETH (27.9d window)                                     <- one line, closed
```

Expanded, the seven remaining rows render exactly as today, `iv` included.

---

## 5. Implementation notes

| Concern | Location |
|---|---|
| Step 1 markup | [web/index.html:373–412](../../../web/index.html#L373) |
| `parseNL` — add `Enter` handling, primary-button state | [:746](../../../web/index.html#L746) |
| Step 2 markup — add hero + disclosure containers | [:417–424](../../../web/index.html#L417) |
| `renderCandidates` — split hero from rest, build summary line | [:821](../../../web/index.html#L821) |
| New CSS: `.candidate.hero`, `.candidate-more`, compact `.field` variant | near [:162](../../../web/index.html#L162) |

**Disclosure summary derivation.** Computed from `list.slice(1)`, not hardcoded: cheapest by `pricePerContract` and longest by `daysToExpiry`. If those are the same candidate, or only one other offer exists, degrade to a single clause. If `list.length === 1`, omit the disclosure entirely.

---

## 6. Invariants — what must not break

1. **`selectCandidate` is called positionally.** [:879](../../../web/index.html#L879) does `selectCandidate(indexToSelect, el.children[indexToSelect])`, which assumes `#candidateList`'s DOM children are index-aligned with `list`. Moving candidate 0 into a separate hero container **breaks this alignment** — this is the single highest-risk edit in the change. Either keep all rows in one container and style the first differently, or replace the positional lookup with an explicit node array built during render. The plan must pick one deliberately.
2. **`.candidate` class on every clickable row.** [:883](../../../web/index.html#L883) clears selection via `querySelectorAll('.candidate')`. Hero and collapsed rows must both carry it.
3. **Selection restore must still work.** The `previouslySelectedId` lookup at [:877](../../../web/index.html#L877) exists so a re-render doesn't silently move the user's pick. If the restored candidate is not index 0, it must be promoted into the hero slot — the hero is "what is selected," not "what ranked first."
4. **`CLOSEST_MATCH_MAX_PCT` and the far-miss path are untouched.** The 15% gate at [:814](../../../web/index.html#L814) and the `#candFarMiss` block at [:863](../../../web/index.html#L863) are honesty machinery, not polish. When the nearest match is a far miss it earns a `warn` badge and no `closest match` badge — the hero card must render that state, not hide it behind a collapsed row.
5. **`currentSpec()` reads the same four element IDs.** [:779](../../../web/index.html#L779). Restyling the fields must not rename `asset`, `amount`, `floor`, `days`, nor drop the `unitFloor` ⇄ `floor` sync listeners at [:742–743](../../../web/index.html#L742).
6. **No new numbers.** Every figure in the disclosure summary comes from `list`, which comes from `/api/candidates`. Design rule 3, [HANDOFF.md:195](../../../HANDOFF.md#L195).

---

## 7. Non-goals

- Replacing the step flow with a transcript (see §2).
- Any change to `src/`. This is a `web/index.html` change.
- Multi-turn conversational correction.
- Removing `iv`, `buyable`, or expiry dates from the product.

---

## 8. Acceptance checks

1. Page loads with the cursor in the NL box; typing a sentence and pressing `Enter` fills all four fields and updates the restated sentence.
2. Editing any of the four fields after a parse still works and still syncs `unitFloor` ⇄ `floor`.
3. Step 2 shows exactly one full-size card by default, and the disclosure line names both a cheaper and a longer alternative with figures matching the expanded rows.
4. Expanding, then clicking a non-hero row, selects it — verdict updates, chart updates, and the choice survives a re-render.
5. A far-miss spec (e.g. a $900/ETH floor) still renders the `#candFarMiss` warning and shows a `warn` badge instead of `closest match`.
6. A single-candidate book renders the hero with no disclosure line and no empty container.
