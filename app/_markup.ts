export const BODY_HTML = `

<header>
  <div class="header-brand">
    <span class="brand-title"><span class="brand-umbrella">☂</span> Payung</span>
    <span class="brand-tag">Downside floor, priced live</span>
  </div>
  <div class="header-right">
    <div class="net-pill">
      <span class="pulse-dot"></span>
      <span class="net-text">BASE MAINNET · 8453</span>
    </div>
    <a id="historyLink" class="history-link" href="/history" style="display:none;" title="Protection & transaction history">📜 History</a>
    <div class="wallet-box" id="walletBox">
      <button class="wallet-btn" id="connectWalletBtn" onclick="connectWallet()">🦊 Connect Wallet</button>
      <div id="walletPill" class="wallet-pill" style="display:none;">
        <span class="wallet-addr" id="walletAddr">0x...</span>
        <span class="wallet-bal" id="walletBalances">$0.00 USDC</span>
        <button class="wallet-disconnect" onclick="disconnectWallet()" title="Disconnect">✕</button>
      </div>
    </div>
  </div>
</header>

<div class="workspace-layout" id="workspaceLayout">

  <!-- ── LEFT: MAIN FLOW ─────────────────────────────── -->
  <main>
    <div class="flow-header">
      <span class="flow-label">Protection request</span>
      <span class="flow-divider"></span>
      <span class="flow-step-status" id="flowStepLabel">STEP 1 / 5 · CONSTRAINT</span>
    </div>

    <!-- ── STEP 1 ─────────────────────────────── -->
    <section class="step-card active" id="step1">
      <div class="step-card-header">
        <span class="step-num-badge">1</span>
        <span class="step-title">Say what you need, in a sentence</span>
        <span style="flex: 1;"></span>
      </div>
      <div class="step-card-body">
        <textarea id="sentenceInput" class="nl-textarea" rows="2" placeholder="e.g. I need my 1 ETH worth at least $2,300 in two weeks" autofocus></textarea>
        
        <div class="nl-action-row">

          <span style="flex: 1;"></span>
          <button class="btn-primary" id="readThisBtn" onclick="parseNL()">Read this →</button>
        </div>
        <div id="nlError" style="color: var(--danger); font-size: 12.5px; margin-top: 6px;"></div>

        <div class="example-pills">
          <span class="pill-label">TRY</span>
          <button class="example-pill" onclick="pickExample('I need my ETH worth at least $2,300 in two weeks', 'ETH', 1, 2300, 14)">Protect 1 ETH at $2,300 for 14 days</button>
          <button class="example-pill" onclick="pickExample('Keep my 0.5 BTC worth at least $29,000 for the next month', 'BTC', 0.5, 58000, 30)">Keep 0.5 BTC above $58k for a month</button>
          <button class="example-pill" onclick="pickExample('My 3 ETH must be worth $6,600 total by the end of the month', 'ETH', 3, 2200, 21)">Floor 3 ETH at $6,600 total</button>
        </div>

        <div class="understood-strip">
          <div class="strip-label">what I understood  edit anything</div>
          <div class="audit-grid">
            <label class="audit-field" id="assetField">
              <span class="cand-col-label">ASSET</span>
              <select id="asset">
                <option value="ETH" selected>ETH</option>
                <option value="BTC">BTC</option>
              </select>
              <span class="audit-field-note" id="assetNote"></span>
            </label>
            <label class="audit-field" id="amountField">
              <span class="cand-col-label">QUANTITY</span>
              <input id="amount" type="number" value="1" step="any" min="0.0001" />
              <span class="audit-field-note" id="amountNote"></span>
            </label>
            <label class="audit-field" id="unitFloorField">
              <span class="cand-col-label" id="unitFloorLabel">FLOOR · PER ETH</span>
              <input id="unitFloor" type="number" value="2300" step="10" />
            </label>
            <label class="audit-field" id="floorField">
              <span class="cand-col-label">TOTAL FLOOR ($)</span>
              <input id="floor" type="number" value="2300" step="any" />
              <span class="audit-field-note" id="floorNote"></span>
            </label>
            <label class="audit-field" id="daysField">
              <span class="cand-col-label">HORIZON · DAYS</span>
              <input id="days" type="number" value="14" min="1" max="90" />
              <span class="audit-field-note" id="daysNote"></span>
            </label>
          </div>

          <p class="restated-text" id="restatedSentence">
            You keep <b>1 ETH</b> and every dollar of upside. If ETH is below <b class="accent">$2,300</b> in <b>14 days</b>, the option pays you the difference in cash. If it is above, it pays nothing and you have lost only the premium.
          </p>

          <div class="find-btn-row">
            <button class="btn-primary" onclick="findFloors()">Find real offers on Thetanuts →</button>
          </div>
      </div>
    </section>

    <!-- ── STEP 2 ─────────────────────────────── -->
    <section class="step-card inactive" id="step2">
      <div class="step-card-header">
        <span class="step-num-badge">2</span>
        <span class="step-title">Live offers that actually match</span>
        <span style="flex: 1;"></span>
        <button id="toggleNoMatchBtn" onclick="toggleNoMatchState()" style="font-family: var(--font-mono); font-size: 10.5px; letter-spacing: 0.08em; padding: 5px 10px; border-radius: var(--radius-sm); background: none; border: 1px solid var(--border); color: var(--text-muted); cursor: pointer;">preview no-match state</button>
      </div>

      <div class="step-card-body">
        <div class="query-subhead" id="querySubhead">
          <span>Querying the live Base orderbook...</span>
        </div>

        <div id="candLoading" style="display:none; padding: 20px 0; color: var(--text-dim);">
          <span class="spinner"></span> Querying live Base orderbook...
        </div>

        <div id="candStale" class="alert-banner" style="display:none; margin-bottom: 12px;"></div>

        <div id="matchedOffersContainer">
          <!-- Hero Selected Card -->
          <div class="hero-card" id="heroCard">
            <div class="hero-flex">
              <div class="hero-left">
                <div class="hero-strike-row">
                  <span class="hero-strike" id="heroStrike">$2,300</span>
                  <span style="font-size: 15px; color: oklch(0.80 0.02 80);">floor</span>
                  <span class="badge-chip" id="heroBadge">CLOSEST MATCH · +0.0%</span>
                </div>
                <span class="hero-details" id="heroDetails">14.0d window · expires Mar 14, 2026 · maximum fill $4,120</span>
              </div>
              <div class="hero-right">
                <span class="hero-premium" id="heroPremium">$10.42 / ETH</span>
                <span class="hero-confirmed-tag">LIVE QUOTE · CONFIRMED</span>
              </div>
            </div>
          </div>

          <!-- Collapsible Other Offers Accordion -->
          <button class="disclosure-btn" id="disclosureBtn" onclick="toggleDisclosure()" style="display:none;">
            <span class="disclosure-caret" id="disclosureCaret">▸</span>
            <span id="disclosureSummary">Loading other live offers...</span>
          </button>

          <div class="other-offers-list" id="otherOffersList" style="display:none;"></div>

          <div id="candFarMiss" class="alert-banner" style="display:none;">
            <span class="alert-tag">FAR MISS</span>
            <p class="alert-body" id="candFarMissBody"></p>
          </div>
        </div>

        <!-- No Match View -->
        <div id="noMatchContainer" class="no-match-box" style="display:none;">
          <div style="width: 44px; height: 44px; margin: 0 auto 16px; border-radius: var(--radius); border: 1px dashed var(--border); display: grid; place-items: center;">
            <span style="width: 12px; height: 12px; transform: rotate(45deg); border: 1.5px solid oklch(0.62 0.01 75);"></span>
          </div>
          <div style="font-size: 18px; font-weight: 600; letter-spacing: -0.01em; margin-bottom: 8px;">No live offer fits this constraint right now.</div>
          <p style="max-width: 460px; margin: 0 auto 18px; font-size: 14.5px; color: oklch(0.74 0.01 78); line-height: 1.55;">Payung will not substitute the nearest option or estimate a price to fill the gap. Try loosening your horizon or picking a floor closer to current spot price.</p>
        </div>
      </div>
    </section>

    <!-- ── STEP 3 ─────────────────────────────── -->
    <section class="step-card inactive" id="step3">
      <div class="step-card-header">
        <span class="step-num-badge">3</span>
        <span class="step-title">The cost, and whether it's worth it</span>
        <span style="flex: 1;"></span>
        <span class="step-tag">DETERMINISTIC · NO LLM</span>
      </div>
      <div class="step-card-body">
        <div class="metrics-4grid">
          <div class="metric-cell">
            <span class="metric-label">PREMIUM YOU PAY</span>
            <span class="metric-value" id="premiumTotal">$10.42</span>
            <span class="metric-sub" id="premiumSub">$10.42 × 1 contracts</span>
          </div>
          <div class="metric-cell">
            <span class="metric-label">MAX LOSS</span>
            <span class="metric-value" id="maxLossVal">$10.42</span>
            <span class="metric-sub">the premium, and nothing else</span>
          </div>
          <div class="metric-cell">
            <span class="metric-label">GUARANTEED FLOOR</span>
            <span class="metric-value" id="guaranteedFloorVal" style="color: var(--accent);">$2,289.58</span>
            <span class="metric-sub">net of premium, at expiry</span>
          </div>
          <div class="metric-cell">
            <span class="metric-label">COST OF FLOOR</span>
            <span class="metric-value" id="costPctVal">0.45%</span>
            <span class="metric-sub">of the value protected</span>
          </div>
        </div>

        <div class="verdict-card" id="verdictCard">
          <span class="verdict-dot"></span>
          <div>
            <div class="verdict-title" id="verdictTitle">Worth it  0.45% to remove all downside below your floor</div>
            <p class="verdict-body" id="verdictBody">Volatile price movements historically exceed this cost. Paying the premium makes your floor unconditional.</p>
          </div>
        </div>

        <div class="gap-box">
          <span class="flow-label" style="white-space: nowrap; padding-top: 2px;">COVERAGE GAP</span>
          <p class="verdict-body" id="coverageBody">Protection covers the full window.</p>
        </div>
      </div>
    </section>

    <!-- ── STEP 4 ─────────────────────────────── -->
    <section class="step-card inactive" id="step4">
      <div class="step-card-header">
        <span class="step-num-badge">4</span>
        <span class="step-title">Simulate free, then confirm once</span>
        <span style="flex: 1;"></span>
        <span style="font-family: var(--font-mono); font-size: 10.5px; letter-spacing: 0.1em; color: var(--text-dim);" id="execStage">READY</span>
      </div>
      <div class="step-card-body">
        <div class="collat-row">
          <div style="flex: 1; min-width: 240px; display: flex; flex-direction: column; gap: 4px;">
            <span style="font-size: 15px; color: oklch(0.88 0.01 82);" id="collatExplainer">This put settles in <b>aBasUSDC</b>  Aave-wrapped USDC on Base, read off the live order, not assumed.</span>
            <span style="font-family: var(--font-mono); font-size: 12.5px; color: oklch(0.68 0.01 75);" id="walletCollatBalances">wallet: $0.00 USDC · $0.00 aBasUSDC · needed: $10.42</span>
          </div>
          <span class="badge-chip" id="collatPill">USDC READY</span>
        </div>

        <div class="log-list">
          <div class="log-row">
            <span class="log-dot" id="simDot"></span>
            <span class="log-label">Free dry run against the current chain state</span>
            <span class="log-meta" id="simLogMeta">PASS · 0 gas</span>
          </div>
          <div class="log-row">
            <span class="log-dot"></span>
            <span class="log-label">Order freshness re-checked immediately before fill</span>
            <span class="log-meta" id="expiryLogMeta" style="color: oklch(0.72 0.01 78);">verified</span>
          </div>
          <div class="log-row">
            <span class="log-dot" id="allowanceDot"></span>
            <span class="log-label">Allowance approved for the exact amount, never unlimited</span>
            <span class="log-meta" id="allowanceLogMeta" style="color: oklch(0.72 0.01 78);">$10.42 USDC</span>
          </div>
          <div class="log-row">
            <span class="log-dot dim"></span>
            <span class="log-label">Your ETH balance touched by this flow</span>
            <span class="log-meta" style="color: oklch(0.66 0.01 75);">0.00  never</span>
          </div>
        </div>

        <label class="confirm-check-label">
          <input type="checkbox" id="confirmCheck" onchange="onConfirmCheckChange()" />
          <span style="font-size: 14.5px; color: oklch(0.88 0.01 82);">
            I understand this spends <b style="font-family: var(--font-mono); font-weight: 500;" id="confirmSpendText">$10.42</b> of real funds on Base mainnet.
          </span>
        </label>

        <div class="exec-btn-row">
          <button class="btn-sim" id="simBtn" onclick="runSimulate()">Re-run free simulation</button>
          <button class="btn-exec" id="execBtn" onclick="runExecute()">Execute fillOrder on Base</button>
        </div>

        <div id="simResultBox"></div>

        <div id="receiptBox" class="receipt-box" style="display:none;">
          <div style="display: flex; align-items: center; gap: 10px; margin-bottom: 10px;">
            <span style="width: 8px; height: 8px; border-radius: 50%; background: var(--green);"></span>
            <span style="font-size: 16px; font-weight: 600; color: oklch(0.88 0.08 155); letter-spacing: -0.01em;">Protected. Your ETH never moved.</span>
          </div>
          <p style="margin: 0 0 12px; font-size: 14.5px; color: oklch(0.85 0.02 150); line-height: 1.55;" id="receiptLine">
            You bought put contracts on Base mainnet.
          </p>
          <div style="display: flex; align-items: center; gap: 10px; padding: 11px 14px; border-radius: var(--radius-sm); background: var(--input-bg); border: 1px solid var(--green-border);">
            <span style="font-family: var(--font-mono); font-size: 10.5px; letter-spacing: 0.1em; color: oklch(0.70 0.04 155);">TX</span>
            <span style="font-family: var(--font-mono); font-size: 12.5px; color: oklch(0.90 0.03 150); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" id="receiptTxHash">0x...</span>
            <span style="flex: 1;"></span>
            <a id="receiptExplorerLink" href="#0" target="_blank" rel="noopener" style="font-family: var(--font-mono); font-size: 12px; white-space: nowrap;">verify on BaseScan ↗</a>
          </div>
        </div>
      </div>
    </section>

    <span class="reset-link" onclick="resetFlow()">↻ start over</span>
  </main>

  <!-- ── DRAGGABLE SIDEBAR RESIZER ───────────────────── -->
  <div class="sidebar-resizer" id="sidebarResizer" role="separator" aria-label="Resize sidebar" aria-orientation="vertical" tabindex="0" title="Drag to resize sidebar (double-click to reset)">
    <div class="sidebar-resizer-handle"></div>
  </div>

  <!-- ── RIGHT: INSTRUMENT PANEL ─────────────────────── -->
  <aside id="instrumentAside">
    <!-- Section 1: History & Protection Window Chart -->
    <div>
      <div class="aside-sec-title" id="chartTitle">ETH / USD · 14d history + protection window</div>
      <div class="aside-chart-card">
        <svg id="payoffChart" viewBox="0 0 404 268" style="width: 100%; height: auto; display: block; user-select: none; touch-action: none;"></svg>
      </div>
      <div class="chart-legend-row">
        <span class="chart-legend-pill"><span style="width: 14px; height: 2px; background: var(--accent);"></span>DRAGGABLE FLOOR</span>
        <span class="chart-legend-pill"><span style="width: 14px; height: 2px; background: oklch(0.72 0.02 80); border-top: 1px dotted oklch(0.72 0.02 80);"></span>CHAINLINK SPOT</span>
        <span class="chart-legend-pill"><span style="width: 10px; height: 10px; background: var(--green); opacity: 0.35;"></span>PROTECTED ZONE</span>
      </div>
      <div id="chartAttribution" style="font-family: var(--font-mono); font-size: 10.5px; color: var(--text-dim); margin-top: 8px;"></div>
    </div>

    <!-- Section 2: Payoff at Expiry -->
    <div>
      <div class="aside-sec-title">Payoff at expiry</div>
      <div class="aside-chart-card">
        <svg id="expiryPayoffSvg" viewBox="0 0 404 130" style="width: 100%; height: auto; display: block;"></svg>
      </div>
    </div>

    <!-- Section 3: Where every number came from (Provenance) -->
    <div>
      <div class="aside-sec-title">Where every number came from</div>
      <div class="provenance-table" id="provenanceTable">
        <div class="provenance-row">
          <div class="cand-col">
            <span style="font-size: 13px; color: oklch(0.88 0.01 82);">Spot price</span>
            <span class="prov-source">Chainlink AggregatorV3 · 0x7104…Bb70</span>
          </div>
          <span class="prov-val" id="provSpotVal">$2,450.00</span>
        </div>
        <div class="provenance-row">
          <div class="cand-col">
            <span style="font-size: 13px; color: oklch(0.88 0.01 82);">Candle history</span>
            <span class="prov-source">Coinbase Exchange · ETH-USD · 14d</span>
          </div>
          <span class="prov-val" id="provCandlesVal">42 bars</span>
        </div>
        <div class="provenance-row">
          <div class="cand-col">
            <span style="font-size: 13px; color: oklch(0.88 0.01 82);">Premium</span>
            <span class="prov-source">Thetanuts previewFillOrder()</span>
          </div>
          <span class="prov-val" id="provPremiumVal">$10.42</span>
        </div>
        <div class="provenance-row">
          <div class="cand-col">
            <span style="font-size: 13px; color: oklch(0.88 0.01 82);">Strike</span>
            <span class="prov-source">derived · floorTotalUsd ÷ quantity</span>
          </div>
          <span class="prov-val" id="provStrikeVal">$2,300</span>
        </div>
        <div class="provenance-row">
          <div class="cand-col">
            <span style="font-size: 13px; color: oklch(0.88 0.01 82);">Maximum fill</span>
            <span class="prov-source">OptionBook order · availableAmount</span>
          </div>
          <span class="prov-val" id="provBudgetVal">$4,120</span>
        </div>
        <div class="provenance-row">
          <div class="cand-col">
            <span style="font-size: 13px; color: oklch(0.88 0.01 82);">Parsed fields</span>
            <span class="prov-source">Gonka Router · transcription only</span>
          </div>
          <span class="prov-val">4 fields</span>
        </div>
      </div>
      <p style="margin: 10px 0 0; font-family: var(--font-mono); font-size: 10.5px; line-height: 1.6; color: var(--text-muted);">
        Every figure resolves from a live call or deterministic math  the language model only ever transcribes the four user constraint fields.
      </p>
    </div>
  </aside>

</div>

`;
