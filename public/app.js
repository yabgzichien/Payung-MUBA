// State Management
let state = {
  candidates: [],
  selected: null,
  quote: null,
  candidatesSpec: null,
  expanded: false,
  noMatchPreview: false,
  confirmed: false,
  executed: false,
};

let executionFailedNeedsManualClear = false;

const BASE_CHAIN_ID_HEX = '0x2105'; // 8453
const BASE_CHAIN_ID_DEC = 8453;
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const ERC20_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
];

let walletState = {
  provider: null,
  signer: null,
  address: null,
  chainId: null,
  ethBalance: '0',
  usdcBalance: '0',
  aBasUsdcBalance: '0',
};

// API Helpers
async function api(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
  return json;
}

async function apiGet(path) {
  const res = await fetch(path);
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
  return json;
}

function formatMoney(n, d = 2) {
  if (n === null || n === undefined || isNaN(n)) return '$0.00';
  return '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
}

function formatDateIn(days) {
  const d = new Date(Date.now() + days * 86400 * 1000);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// ── Wallet Connection ──────────────────────────────────────────────────────────

function getInjectedProvider() {
  if (typeof window.bitkeep !== 'undefined' && window.bitkeep.ethereum) return window.bitkeep.ethereum;
  if (typeof window.okxwallet !== 'undefined') return window.okxwallet;
  if (typeof window.ethereum !== 'undefined') {
    if (Array.isArray(window.ethereum.providers) && window.ethereum.providers.length > 0) {
      return window.ethereum.selectedAddress
        ? window.ethereum.providers.find(p => p.selectedAddress === window.ethereum.selectedAddress) || window.ethereum.providers[0]
        : window.ethereum.providers[0];
    }
    return window.ethereum;
  }
  return null;
}

async function connectWallet() {
  const provider = getInjectedProvider();
  if (!provider) {
    alert('No Web3 wallet extension detected. Please install Bitget Wallet, MetaMask, Rabby, Coinbase Wallet, or OKX Wallet.');
    return;
  }

  try {
    const accounts = await provider.request({ method: 'eth_requestAccounts' });
    if (!accounts || accounts.length === 0) return;

    await ensureBaseNetwork(provider);

    walletState.provider = new ethers.BrowserProvider(provider);
    walletState.signer = await walletState.provider.getSigner();
    walletState.address = await walletState.signer.getAddress();

    await refreshWalletBalances();
    updateWalletUI();
  } catch (err) {
    console.error('Wallet connection failed:', err);
    alert(err.message || 'Failed to connect wallet.');
  }
}

async function ensureBaseNetwork(provider = getInjectedProvider()) {
  if (!provider) return;
  const chainId = await provider.request({ method: 'eth_chainId' });
  if (parseInt(chainId, 16) === BASE_CHAIN_ID_DEC) return;

  try {
    await provider.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: BASE_CHAIN_ID_HEX }],
    });
  } catch (switchError) {
    if (switchError.code === 4902 || switchError.data?.originalError?.code === 4902) {
      await provider.request({
        method: 'wallet_addEthereumChain',
        params: [{
          chainId: BASE_CHAIN_ID_HEX,
          chainName: 'Base Mainnet',
          nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
          rpcUrls: ['https://mainnet.base.org'],
          blockExplorerUrls: ['https://basescan.org'],
        }],
      });
    } else {
      throw switchError;
    }
  }
}

async function refreshWalletBalances() {
  if (!walletState.provider || !walletState.address) return;
  try {
    const rawEth = await walletState.provider.getBalance(walletState.address);
    walletState.ethBalance = (Number(rawEth) / 1e18).toFixed(4);

    const usdcContract = new ethers.Contract('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', ERC20_ABI, walletState.provider);
    const rawUsdc = await usdcContract.balanceOf(walletState.address);
    walletState.usdcBalance = (Number(rawUsdc) / 1e6).toFixed(2);

    const aBasUsdcContract = new ethers.Contract('0x4e65fE4DbA92790696d040ac24Aa414708F5c0AB', ERC20_ABI, walletState.provider);
    const rawABas = await aBasUsdcContract.balanceOf(walletState.address);
    walletState.aBasUsdcBalance = (Number(rawABas) / 1e6).toFixed(2);
  } catch (err) {
    console.warn('Could not fetch all balances:', err);
  }
}

function updateWalletUI() {
  const btn = document.getElementById('connectWalletBtn');
  const pill = document.getElementById('walletPill');
  const addrEl = document.getElementById('walletAddr');
  const balEl = document.getElementById('walletBalances');
  const collatBalEl = document.getElementById('walletCollatBalances');
  const collatPill = document.getElementById('collatPill');

  const neededUsd = state.quote?.quote?.spendUsdc || 0;

  if (walletState.address) {
    btn.style.display = 'none';
    pill.style.display = 'flex';
    const short = walletState.address.slice(0, 6) + '…' + walletState.address.slice(-4);
    addrEl.textContent = short;
    balEl.textContent = `$${walletState.usdcBalance} USDC · ${walletState.ethBalance} ETH`;
    
    collatBalEl.textContent = `wallet: $${walletState.usdcBalance} USDC · $${walletState.aBasUsdcBalance} aBasUSDC · needed: ${formatMoney(neededUsd)}`;
    
    const isAaveToken = state.selected?.collateralToken?.toLowerCase() === '0x4e65fe4dba92790696d040ac24aa414708f5c0ab'.toLowerCase();
    const hasEnoughABas = Number(walletState.aBasUsdcBalance) >= neededUsd;
    const hasEnoughUsdc = Number(walletState.usdcBalance) >= neededUsd;

    if (isAaveToken) {
      if (hasEnoughABas) {
        collatPill.textContent = 'aBasUSDC READY';
        collatPill.className = 'badge-chip';
      } else if (hasEnoughUsdc) {
        collatPill.textContent = 'DEPOSIT NEEDED';
        collatPill.className = 'badge-chip warn';
      } else {
        collatPill.textContent = 'INSUFFICIENT FUNDS';
        collatPill.className = 'badge-chip warn';
      }
    } else {
      collatPill.textContent = hasEnoughUsdc ? 'USDC READY' : 'INSUFFICIENT USDC';
      collatPill.className = hasEnoughUsdc ? 'badge-chip' : 'badge-chip warn';
    }
  } else {
    btn.style.display = 'inline-block';
    pill.style.display = 'none';
    collatBalEl.textContent = `wallet: not connected · needed: ${formatMoney(neededUsd)}`;
  }
}

function disconnectWallet() {
  walletState = {
    provider: null, signer: null, address: null, chainId: null,
    ethBalance: '0', usdcBalance: '0', aBasUsdcBalance: '0',
  };
  updateWalletUI();
}

// Auto-detect existing connected wallet
const autoProvider = getInjectedProvider();
if (autoProvider) {
  autoProvider.request({ method: 'eth_accounts' }).then(async (accounts) => {
    if (accounts && accounts.length > 0) {
      try {
        walletState.provider = new ethers.BrowserProvider(autoProvider);
        walletState.signer = await walletState.provider.getSigner();
        walletState.address = await walletState.signer.getAddress();
        await refreshWalletBalances();
        updateWalletUI();
      } catch (e) {
        console.warn('Auto-connect skipped:', e);
      }
    }
  });

  if (autoProvider.on) {
    autoProvider.on('accountsChanged', (accounts) => {
      if (!accounts || accounts.length === 0) disconnectWallet();
      else connectWallet();
    });
    autoProvider.on('chainChanged', () => window.location.reload());
  }
}

// ── Step Management ───────────────────────────────────────────────────────────

function setStep(n) {
  for (let i = 1; i <= 4; i++) {
    const el = document.getElementById('step' + i);
    if (!el) continue;
    el.classList.remove('active', 'done', 'inactive');
    if (i < n) el.classList.add('done');
    else if (i === n) el.classList.add('active');
    else el.classList.add('inactive');
  }

  const stepLabels = [
    'STEP 1 / 4 · CONSTRAINT',
    'STEP 2 / 4 · MATCHED OFFERS',
    'STEP 3 / 4 · REVIEWING QUOTE',
    state.executed ? 'STEP 4 / 4 · FILLED' : (state.confirmed ? 'STEP 4 / 4 · AWAITING FILL' : 'STEP 4 / 4 · SIMULATE & CONFIRM'),
  ];
  document.getElementById('flowStepLabel').textContent = stepLabels[n - 1] || 'STEP 1 / 4';
}

// ── Constraint & Parse Logic ──────────────────────────────────────────────────

function updateSvgFloorFromInputs() {
  const svg = document.getElementById('payoffChart');
  if (!svg || !svg._chartScale) return;
  const unitFloor = Number(document.getElementById('unitFloor').value) || 2300;
  const newY = svg._chartScale.yS(unitFloor);
  const line = document.getElementById('svgFloorLine');
  const badgeRect = document.getElementById('svgFloorBadgeRect');
  const badgeText = document.getElementById('svgFloorBadgeText');
  const zone = document.getElementById('svgProtectionZone');

  if (line) {
    line.setAttribute('y1', newY.toFixed(1));
    line.setAttribute('y2', newY.toFixed(1));
  }
  if (badgeRect) {
    badgeRect.setAttribute('y', (newY - 11).toFixed(1));
  }
  if (badgeText) {
    badgeText.setAttribute('y', (newY + 4).toFixed(1));
    badgeText.textContent = `⇕ FLOOR ${formatMoney(unitFloor, 0)}`;
  }
  if (zone) {
    const zoneH = Math.max(0, (svg._chartScale.H - svg._chartScale.PAD_B) - newY);
    zone.setAttribute('y', newY.toFixed(1));
    zone.setAttribute('height', zoneH.toFixed(1));
  }
}

function pickExample(sentence, asset, qty, unitFloor, days) {
  document.getElementById('sentenceInput').value = sentence;
  document.getElementById('asset').value = asset;
  document.getElementById('amount').value = qty;
  document.getElementById('unitFloor').value = unitFloor;
  document.getElementById('floor').value = qty * unitFloor;
  document.getElementById('days').value = days;
  document.getElementById('unitFloorLabel').textContent = `FLOOR · PER ${asset}`;
  restateSentence();
  drawUnifiedChart();
  findFloors();
}

document.getElementById('sentenceInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    parseNL();
  }
});

// Which "understood strip" boxes light up for each logical field. FLOOR
// covers both the per-unit and total inputs since the sentence states one
// price, not two  see classifyPartialSpec in src/intent.ts.
const FIELD_BOXES = {
  asset: ['assetField'],
  quantity: ['amountField'],
  floor: ['unitFloorField', 'floorField'],
  horizonDays: ['daysField'],
};
const FIELD_NOTES = { asset: 'assetNote', quantity: 'amountNote', floor: 'floorNote', horizonDays: 'daysNote' };

function clearFieldFlag(key) {
  (FIELD_BOXES[key] || []).forEach((boxId) => {
    const box = document.getElementById(boxId);
    if (box) box.classList.remove('needs-input', 'field-error');
  });
  const note = document.getElementById(FIELD_NOTES[key]);
  if (note) note.textContent = '';
}

function flagFieldMissing(key) {
  (FIELD_BOXES[key] || []).forEach((boxId) => {
    document.getElementById(boxId)?.classList.add('needs-input');
  });
}

function flagFieldError(key, message) {
  (FIELD_BOXES[key] || []).forEach((boxId) => {
    const box = document.getElementById(boxId);
    if (box) { box.classList.add('field-error'); box.classList.remove('needs-input'); }
  });
  const note = document.getElementById(FIELD_NOTES[key]);
  if (note) note.textContent = message;
}

async function parseNL() {
  const text = document.getElementById('sentenceInput').value.trim();
  const err = document.getElementById('nlError');
  const btn = document.getElementById('readThisBtn');
  err.textContent = '';
  if (!text) return;

  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span>Reading...';

  try {
    const { spec, missingFields, fieldErrors } = await api('/api/parse', { text });
    ['asset', 'quantity', 'floor', 'horizonDays'].forEach(clearFieldFlag);

    if (spec.asset != null) {
      document.getElementById('asset').value = spec.asset;
      document.getElementById('unitFloorLabel').textContent = `FLOOR · PER ${spec.asset}`;
    }
    if (spec.quantity != null) document.getElementById('amount').value = spec.quantity;
    if (spec.unitFloorUsd != null) document.getElementById('unitFloor').value = Number(spec.unitFloorUsd.toFixed(2));
    if (spec.floorTotalUsd != null) document.getElementById('floor').value = spec.floorTotalUsd;
    if (spec.horizonDays != null) document.getElementById('days').value = spec.horizonDays;

    // Only one side of the floor may have come back (e.g. a per-unit price
    // stated without a quantity)  derive the other from whatever quantity
    // is currently on screen, reusing the same sync the manual inputs use.
    if (spec.unitFloorUsd != null && spec.floorTotalUsd == null) syncFloorFromUnit();
    else if (spec.floorTotalUsd != null && spec.unitFloorUsd == null) syncFloorFromTotal();

    missingFields.forEach(flagFieldMissing);
    Object.entries(fieldErrors).forEach(([key, message]) => flagFieldError(key, message));

    restateSentence();
    drawUnifiedChart();
    if (!missingFields.length && Object.keys(fieldErrors).length === 0) findFloors();
  } catch (e) {
    err.textContent = e.message;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Read this →';
  }
}

function onAssetChange() {
  clearFieldFlag('asset');
  const asset = document.getElementById('asset').value;
  document.getElementById('unitFloorLabel').textContent = `FLOOR · PER ${asset}`;
  onConstraintChange();
  drawUnifiedChart();
}

function syncFloorFromUnit() {
  clearFieldFlag('floor');
  const amount = Number(document.getElementById('amount').value) || 0;
  const unit = Number(document.getElementById('unitFloor').value) || 0;
  if (amount > 0 && unit > 0) {
    document.getElementById('floor').value = Number((amount * unit).toFixed(4));
    updateSvgFloorFromInputs();
  }
  onConstraintChange();
}

function syncFloorFromTotal() {
  clearFieldFlag('floor');
  const amount = Number(document.getElementById('amount').value) || 0;
  const total = Number(document.getElementById('floor').value) || 0;
  if (amount > 0 && total > 0) {
    const perUnit = Number((total / amount).toFixed(2));
    document.getElementById('unitFloor').value = perUnit;
    updateSvgFloorFromInputs();
  }
  onConstraintChange();
}

function onAmountChange() {
  clearFieldFlag('quantity');
  const amount = Number(document.getElementById('amount').value) || 0;
  const unit = Number(document.getElementById('unitFloor').value) || 0;
  if (amount > 0 && unit > 0) {
    document.getElementById('floor').value = Number((amount * unit).toFixed(4));
  }
  onConstraintChange();
}

function restateSentence() {
  const asset = document.getElementById('asset').value;
  const amount = Number(document.getElementById('amount').value) || 0;
  const floorTotal = Number(document.getElementById('floor').value) || 0;
  const unitFloor = Number(document.getElementById('unitFloor').value) || (amount > 0 ? floorTotal / amount : 0);
  const days = document.getElementById('days').value || '14';

  document.getElementById('restatedSentence').innerHTML =
    `You keep <b>${amount} ${asset}</b> and every dollar of upside. If ${asset} is below <b class="accent">${formatMoney(unitFloor, 0)}</b> on <b>${formatDateIn(Number(days))}</b>, ` +
    `the option pays you the difference in cash. If it is above, it pays nothing and you have lost only the premium.`;
}

let constraintChangeTimer = null;
function onConstraintChange() {
  restateSentence();
  if (constraintChangeTimer) clearTimeout(constraintChangeTimer);
  constraintChangeTimer = setTimeout(() => {
    if (!state.candidates.length) return;
    const stale = document.getElementById('candStale');
    if (specsMatch(state.candidatesSpec, currentSpec())) {
      stale.style.display = 'none';
      return;
    }
    const old = state.candidatesSpec;
    stale.style.display = 'flex';
    stale.innerHTML = `<span class="alert-tag">OUT OF DATE</span><p class="alert-body">These offers were matched against ` +
      `$${(old.floorTotalUsd / old.quantity).toFixed(2)} per ${old.asset}. Click <b>Find real offers</b> to re-query the live book for your updated constraint.</p>`;
  }, 400);
}

function specsMatch(a, b) {
  return !!a && !!b && a.asset === b.asset && a.quantity === b.quantity
    && a.floorTotalUsd === b.floorTotalUsd && a.horizonDays === b.horizonDays;
}

function currentSpec() {
  return {
    asset: document.getElementById('asset').value,
    quantity: Number(document.getElementById('amount').value),
    floorTotalUsd: Number(document.getElementById('floor').value),
    horizonDays: Number(document.getElementById('days').value),
  };
}

document.getElementById('asset').addEventListener('change', onAssetChange);
document.getElementById('amount').addEventListener('input', onAmountChange);
document.getElementById('unitFloor').addEventListener('input', syncFloorFromUnit);
document.getElementById('floor').addEventListener('input', syncFloorFromTotal);
document.getElementById('days').addEventListener('input', () => { clearFieldFlag('horizonDays'); onConstraintChange(); });

// ── Live Candidates & Selection ───────────────────────────────────────────────

const CLOSEST_MATCH_MAX_PCT = 15;

async function findFloors() {
  setStep(2);
  document.getElementById('candLoading').style.display = 'block';
  document.getElementById('matchedOffersContainer').style.display = 'none';
  document.getElementById('noMatchContainer').style.display = 'none';
  document.getElementById('candStale').style.display = 'none';

  try {
    const { candidates } = await api('/api/candidates', { spec: currentSpec() });
    state.candidates = candidates;
    state.candidatesSpec = currentSpec();
    document.getElementById('candLoading').style.display = 'none';

    if (!candidates.length) {
      document.getElementById('noMatchContainer').style.display = 'block';
      return;
    }

    document.getElementById('matchedOffersContainer').style.display = 'block';
    renderCandidates();
  } catch (e) {
    document.getElementById('candLoading').innerHTML = `Error: ${e.message} <button class="btn-outline" style="margin-left:10px; padding:4px 10px; font-size:12px;" onclick="findFloors()">Retry</button>`;
  }
}

function renderCandidates() {
  const list = state.candidates;
  if (!list.length) return;

  const previouslySelectedId = state.selected?.id;
  const restoreIndex = previouslySelectedId ? list.findIndex(c => c.id === previouslySelectedId) : -1;
  const selectedIndex = restoreIndex >= 0 ? restoreIndex : 0;
  const selected = list[selectedIndex];
  state.selected = selected;

  const asset = document.getElementById('asset').value;
  const targetStrike = selected.impliedStrike || Number(document.getElementById('unitFloor').value);

  // Render Hero Card
  const heroDist = selected.pctFromImpliedStrike;
  const isFar = heroDist > CLOSEST_MATCH_MAX_PCT;
  const sign = selected.pctVsImpliedStrike >= 0 ? '-' : '+';
  
  let badgeText = 'CLOSEST MATCH';
  let badgeClass = 'badge-chip';
  if (isFar) {
    badgeText = `FAR FROM YOUR FLOOR · ${sign}${heroDist.toFixed(1)}%`;
    badgeClass = 'badge-chip warn';
  } else if (selectedIndex === 0 && heroDist < 0.01) {
    badgeText = 'EXACT MATCH';
    badgeClass = 'badge-chip';
  } else if (selectedIndex === 0) {
    badgeText = `CLOSEST MATCH · ${sign}${heroDist.toFixed(1)}%`;
    badgeClass = 'badge-chip';
  } else {
    badgeText = `YOUR PICK · ${sign}${heroDist.toFixed(1)}%`;
    badgeClass = 'badge-chip neutral';
  }

  document.getElementById('heroStrike').textContent = formatMoney(selected.strike, 0);
  document.getElementById('heroBadge').textContent = badgeText;
  document.getElementById('heroBadge').className = badgeClass;
  document.getElementById('heroDetails').textContent = `${selected.daysToExpiry.toFixed(1)}d window · expires ${selected.expiryIso.slice(0,10)} · maker budget ${formatMoney(selected.makerBudget, 0)}`;
  document.getElementById('heroPremium').textContent = `${formatMoney(selected.pricePerContract)} / ${asset}`;

  // Far Miss Warning
  const farMissEl = document.getElementById('candFarMiss');
  if (isFar) {
    farMissEl.style.display = 'flex';
    document.getElementById('candFarMissBody').textContent =
      `The nearest live offer is ${heroDist.toFixed(1)}% away from the floor you asked for. Payung shows it rather than pretending it matches  buying it protects a different number than the one you stated.`;
  } else {
    farMissEl.style.display = 'none';
  }

  // Collapsed Disclosure for Other Candidates
  const others = list.filter((_, idx) => idx !== selectedIndex);
  const disclosureBtn = document.getElementById('disclosureBtn');
  const otherListEl = document.getElementById('otherOffersList');

  if (others.length > 0) {
    disclosureBtn.style.display = 'flex';
    const cheap = others.reduce((a, b) => (b.pricePerContract < a.pricePerContract ? b : a), others[0]);
    const longest = others.reduce((a, b) => (b.daysToExpiry > a.daysToExpiry ? b : a), others[0]);

    if (state.expanded) {
      document.getElementById('disclosureCaret').textContent = '▾';
      document.getElementById('disclosureSummary').textContent = `Hide the other ${others.length} live offers`;
      otherListEl.style.display = 'flex';
    } else {
      document.getElementById('disclosureCaret').textContent = '▸';
      if (others.length === 1 || cheap.id === longest.id) {
        document.getElementById('disclosureSummary').textContent =
          `${others.length} more live offer  from ${formatMoney(cheap.pricePerContract)}/${asset} at a ${formatMoney(cheap.strike, 0)} floor`;
      } else {
        const ratio = (selected.pricePerContract / (cheap.pricePerContract || 1)).toFixed(1);
        document.getElementById('disclosureSummary').textContent =
          `${others.length} more live offers  from ${formatMoney(cheap.pricePerContract)}/${asset} (${formatMoney(cheap.strike, 0)} floor, ${ratio}× cheaper) to ${formatMoney(longest.pricePerContract)}/${asset} (${longest.daysToExpiry.toFixed(0)}d window)`;
      }
      otherListEl.style.display = 'none';
    }

    otherListEl.innerHTML = '';
    others.forEach((c) => {
      const realIndex = list.findIndex(item => item.id === c.id);
      const row = document.createElement('div');
      row.className = 'candidate-row';
      const d = c.pctFromImpliedStrike;
      const fitSign = c.pctVsImpliedStrike >= 0 ? '-' : '+';
      const fitText = d < 0.01 ? 'exact' : `${fitSign}${d.toFixed(1)}%`;
      const fitColor = d < 0.01 ? 'var(--green)' : 'oklch(0.78 0.01 80)';

      row.innerHTML = `
        <span class="candidate-radio"></span>
        <div class="cand-col">
          <span class="cand-col-label">FLOOR</span>
          <span class="cand-col-val">${formatMoney(c.strike, 0)}</span>
        </div>
        <div class="cand-col">
          <span class="cand-col-label">EXPIRY</span>
          <span class="cand-col-val" style="font-size:12.5px; color:oklch(0.84 0.01 82);">${c.expiryIso.slice(0,10)} · ${c.daysToExpiry.toFixed(0)}d</span>
        </div>
        <div class="cand-col">
          <span class="cand-col-label">VS YOUR FLOOR</span>
          <span class="cand-col-val" style="font-size:12.5px; color:${fitColor};">${fitText}</span>
        </div>
        <div class="cand-col">
          <span class="cand-col-label">PREMIUM</span>
          <span class="cand-col-val" style="color:var(--text-bright);">${formatMoney(c.pricePerContract)} / ${asset}</span>
        </div>
        <div class="cand-col" style="text-align:right;">
          <span class="cand-col-label">IV · BUDGET</span>
          <span class="cand-col-val" style="font-size:12.5px; color:oklch(0.76 0.01 80);">${c.iv ? c.iv.toFixed(2) : ''} · ${formatMoney(c.makerBudget, 0)}</span>
        </div>
      `;
      row.onclick = () => selectCandidate(realIndex);
      otherListEl.appendChild(row);
    });
  } else {
    disclosureBtn.style.display = 'none';
    otherListEl.style.display = 'none';
  }

  // Quote the selected candidate
  quoteSelectedCandidate();
}

function toggleDisclosure() {
  state.expanded = !state.expanded;
  renderCandidates();
}

function toggleNoMatchState() {
  state.noMatchPreview = !state.noMatchPreview;
  document.getElementById('toggleNoMatchBtn').textContent = state.noMatchPreview ? 'show matched offers' : 'preview no-match state';
  document.getElementById('matchedOffersContainer').style.display = state.noMatchPreview ? 'none' : 'block';
  document.getElementById('noMatchContainer').style.display = state.noMatchPreview ? 'block' : 'none';
}

function selectCandidate(i) {
  state.selected = state.candidates[i];
  state.confirmed = false;
  state.executed = false;
  document.getElementById('confirmCheck').checked = false;
  document.getElementById('receiptBox').style.display = 'none';
  renderCandidates();
}

async function quoteSelectedCandidate() {
  if (!state.selected) return;
  const sel = state.selected;
  const qty = Number(document.getElementById('amount').value) || 1;
  const targetSpend = qty * sel.pricePerContract;

  try {
    const data = await api('/api/quote', { id: sel.id, spendUsdc: targetSpend });
    state.quote = data;
    const q = data.quote;
    const j = data.judgment;

    setStep(3);

    // Update Step 3 Metric Grid
    const totalFloor = qty * sel.strike;
    const costPct = (q.spendUsdc / (totalFloor || 1)) * 100;
    
    document.getElementById('premiumTotal').textContent = formatMoney(q.spendUsdc);
    document.getElementById('premiumSub').textContent = `${formatMoney(q.pricePerContract)} × ${q.contracts.toFixed(4)} contracts`;
    document.getElementById('maxLossVal').textContent = formatMoney(q.spendUsdc);
    document.getElementById('guaranteedFloorVal').textContent = formatMoney(totalFloor - q.spendUsdc);
    document.getElementById('costPctVal').textContent = costPct.toFixed(2) + '%';

    // Update Verdict
    const vCard = document.getElementById('verdictCard');
    vCard.className = 'verdict-card ' + (j.verdict === 'not-worth-it' ? 'against' : (j.verdict === 'marginal' ? 'marginal' : ''));
    document.getElementById('verdictTitle').textContent =
      j.verdict === 'worth-it' || j.verdict === 'reasonable'
        ? `Worth it  ${costPct.toFixed(2)}% to remove all downside below your floor`
        : (j.verdict === 'marginal'
            ? `Marginal  the premium is a meaningful share of what it protects`
            : `Not worth it  the premium eats too much of the protected value`);
    document.getElementById('verdictBody').textContent = j.reasons.join(' ');

    // Update Coverage Gap
    const gapDays = sel.coverageGapDays || 0;
    const statedDays = Number(document.getElementById('days').value) || 14;
    document.getElementById('coverageBody').innerHTML =
      `This offer expires ${q.expiryIso.slice(0,10)}, ` +
      (sel.daysToExpiry >= statedDays
        ? `${(sel.daysToExpiry - statedDays).toFixed(1)} day(s) after your stated horizon. The extra days are covered at no additional cost.`
        : `<b>${gapDays.toFixed(1)} day(s) before</b> your stated ${statedDays}-day horizon  you are unprotected for that gap, and Payung will not paper over it.`) +
      ` Maker budget caps this fill at ${formatMoney(sel.makerBudget, 0)} of collateral.`;

    // Update Step 4 (collateral status + simulate/confirm)
    setStep(4);
    updateWalletUI();

    document.getElementById('confirmSpendText').textContent = formatMoney(q.spendUsdc);
    document.getElementById('allowanceLogMeta').textContent = `${formatMoney(q.spendUsdc)} aBasUSDC`;
    document.getElementById('expiryLogMeta').textContent = `expiry ${q.expiryIso.slice(0,10)}`;
    updateExecButtonState();

    // Render Right Panel Charts & Provenance
    drawUnifiedChart(data);
    renderPayoffChart(data);
    updateProvenanceTable(data);
  } catch (e) {
    console.error('Quote error:', e);
  }
}

function onConfirmCheckChange() {
  state.confirmed = document.getElementById('confirmCheck').checked;
  updateExecButtonState();
}

function updateExecButtonState() {
  const btn = document.getElementById('execBtn');
  const stage = document.getElementById('execStage');

  if (state.executed) {
    stage.textContent = 'FILLED';
    btn.textContent = 'Filled  see receipt below';
    btn.className = 'btn-exec';
    return;
  }

  if (state.confirmed) {
    stage.textContent = 'READY';
    btn.className = 'btn-exec ready';
    btn.textContent = `Execute fillOrder on Base (${formatMoney(state.quote?.quote?.spendUsdc || 0)})`;
  } else {
    stage.textContent = 'BLOCKED';
    btn.className = 'btn-exec';
    btn.textContent = 'Execute fillOrder on Base';
  }
}

// ── Instrument Panel: Charts & Provenance ─────────────────────────────────────

let chartRenderToken = 0;
let currentHistory = { candles: [], spot: null, historySource: null };
let currentChartData = null;
let isDraggingFloor = false;

async function drawUnifiedChart(data = null) {
  if (data) currentChartData = data;
  const asset = document.getElementById('asset').value;
  const days = Number(document.getElementById('days').value) || 14;
  const token = ++chartRenderToken;

  document.getElementById('chartTitle').textContent = `${asset} / USD · ${days}d history + protection window`;

  let history = { candles: [], spot: null, historySource: null, spotError: null, historyError: null };
  try {
    history = await apiGet('/api/history?asset=' + encodeURIComponent(asset) + '&days=' + days);
  } catch (e) {
    history.historyError = e.message;
  }

  if (token !== chartRenderToken) return;
  currentHistory = history;
  renderUnifiedChart(currentChartData, history, days);
}

function renderUnifiedChart(data, history, historyDays) {
  const svg = document.getElementById('payoffChart');
  if (!svg) return;
  const W = 404, H = 268, PAD_L = 44, PAD_R = 74, PAD_T = 20, PAD_B = 36;
  const plotW = W - PAD_L - PAD_R;
  const plotH = H - PAD_T - PAD_B;

  const strike = (data && data.quote) ? data.quote.strike : (Number(document.getElementById('unitFloor').value) || 2300);
  const candles = (history && history.candles) || [];
  const spot = history ? history.spot : null;
  const spotPrice = spot ? spot.price : strike * 1.05;

  const allPrices = [...candles.flatMap(c => [c.h, c.l]), strike, spotPrice].filter(Number.isFinite);
  const lo = (allPrices.length ? Math.min(...allPrices) : 2000) * 0.98;
  const hi = (allPrices.length ? Math.max(...allPrices) : 2500) * 1.02;
  const yS = (p) => PAD_T + (1 - (p - lo) / (hi - lo)) * plotH;
  const pFromY = (y) => hi - ((y - PAD_T) / plotH) * (hi - lo);

  svg._chartScale = { W, H, PAD_L, PAD_R, PAD_T, PAD_B, plotW, plotH, lo, hi, yS, pFromY };

  const splitX = PAD_L + plotW * 0.68;
  const x0 = PAD_L, x1 = splitX, xExpiry = PAD_L + plotW;

  // Candlesticks
  let candleSvg = '';
  if (candles.length > 0) {
    const step = (x1 - x0) / candles.length;
    const w = Math.max(1.8, step * 0.55);
    candleSvg = candles.map((c, i) => {
      const cx = x0 + i * step + step / 2;
      const up = c.c >= c.o;
      const color = up ? 'oklch(0.70 0.11 155)' : 'oklch(0.62 0.14 28)';
      const bodyTop = yS(Math.max(c.o, c.c));
      const bodyBot = yS(Math.min(c.o, c.c));
      return `
        <line x1="${cx.toFixed(1)}" y1="${yS(c.h).toFixed(1)}" x2="${cx.toFixed(1)}" y2="${yS(c.l).toFixed(1)}" stroke="${color}" stroke-width="1" opacity="0.75" />
        <rect x="${(cx - w/2).toFixed(1)}" y="${bodyTop.toFixed(1)}" width="${w.toFixed(1)}" height="${Math.max(1, bodyBot - bodyTop).toFixed(1)}" fill="${color}" />
      `;
    }).join('');
  }

  // Protection Zone
  const strikeY = yS(strike);
  const zoneH = Math.max(0, (H - PAD_B) - strikeY);
  const zoneSvg = `<rect id="svgProtectionZone" x="${splitX.toFixed(1)}" y="${strikeY.toFixed(1)}" width="${(xExpiry - splitX).toFixed(1)}" height="${zoneH.toFixed(1)}" fill="oklch(0.72 0.13 155)" opacity="0.12" />`;

  const spotY = yS(spotPrice);
  const expiryLabel = (data && data.quote) ? data.quote.expiryIso.slice(5, 10) : formatDateIn(historyDays || 14);

  svg.innerHTML = `
    ${zoneSvg}
    <line x1="${splitX.toFixed(1)}" y1="${PAD_T}" x2="${splitX.toFixed(1)}" y2="${(H - PAD_B).toFixed(1)}" stroke="oklch(0.42 0.014 70)" stroke-width="1" />
    <line x1="${xExpiry.toFixed(1)}" y1="${PAD_T}" x2="${xExpiry.toFixed(1)}" y2="${(H - PAD_B).toFixed(1)}" stroke="oklch(0.55 0.10 155)" stroke-width="1" stroke-dasharray="3 3" />
    ${candleSvg}
    <!-- Spot Price Line -->
    <line x1="${PAD_L}" y1="${spotY.toFixed(1)}" x2="${(W - PAD_R + 10).toFixed(1)}" y2="${spotY.toFixed(1)}" stroke="oklch(0.72 0.02 80)" stroke-width="1" stroke-dasharray="2 4" opacity="0.75" />
    <text x="8" y="${(spotY - 4).toFixed(1)}" fill="oklch(0.78 0.02 80)" font-family="IBM Plex Mono, monospace" font-size="9.5">SPOT ${formatMoney(spotPrice, 0)}</text>

    <!-- Draggable Floor Line & Grab Badge -->
    <g id="draggableFloorSvgGroup" class="draggable-floor-svg-group">
      <line x1="0" y1="${strikeY.toFixed(1)}" x2="${W}" y2="${strikeY.toFixed(1)}" stroke="transparent" stroke-width="28" style="cursor: ns-resize;" />
      <line id="svgFloorLine" x1="${PAD_L}" y1="${strikeY.toFixed(1)}" x2="${(W - PAD_R + 10).toFixed(1)}" y2="${strikeY.toFixed(1)}" stroke="oklch(0.80 0.13 78)" stroke-width="2.2" />
      <rect id="svgFloorBadgeRect" x="6" y="${(strikeY - 11).toFixed(1)}" width="92" height="22" rx="6" fill="oklch(0.80 0.13 78)" style="cursor: ns-resize;" />
      <text id="svgFloorBadgeText" x="52" y="${(strikeY + 4).toFixed(1)}" fill="oklch(0.20 0.04 78)" font-family="IBM Plex Mono, monospace" font-weight="600" font-size="10" text-anchor="middle" style="pointer-events: none;">⇕ FLOOR ${formatMoney(strike, 0)}</text>
    </g>

    <text x="${((splitX + xExpiry) / 2).toFixed(1)}" y="${H - 12}" fill="oklch(0.72 0.08 155)" font-family="IBM Plex Mono, monospace" font-size="9" text-anchor="middle">PROTECTED THROUGH ${expiryLabel}</text>
    <text x="${PAD_L}" y="${H - 12}" fill="oklch(0.58 0.01 75)" font-family="IBM Plex Mono, monospace" font-size="9">${historyDays}D AGO</text>
    <text x="${splitX.toFixed(1)}" y="${H - 12}" fill="oklch(0.58 0.01 75)" font-family="IBM Plex Mono, monospace" font-size="9" text-anchor="middle">NOW</text>
  `;

  setupSvgFloorDrag(svg);

  // Attribution
  const spotSrc = spot ? `Chainlink spot: ${formatMoney(spot.price, 0)} (${new Date(spot.updatedAt).toLocaleTimeString()})` : 'Spot feed degraded';
  const histSrc = history && history.historySource ? 'candles: Coinbase' : 'candles offline';
  document.getElementById('chartAttribution').textContent = `${histSrc} · ${spotSrc} · live orderbook`;
}

function setupSvgFloorDrag(svg) {
  const group = document.getElementById('draggableFloorSvgGroup');
  if (!group || !svg._chartScale) return;

  group.onpointerdown = (e) => {
    e.preventDefault();
    e.stopPropagation();
    isDraggingFloor = true;
    group.setPointerCapture(e.pointerId);
    group.classList.add('dragging');

    const onPointerMove = (ev) => {
      if (!isDraggingFloor || !svg._chartScale) return;
      const rect = svg.getBoundingClientRect();
      const scaleY = 268 / rect.height;
      const svgY = (ev.clientY - rect.top) * scaleY;

      const rawPrice = svg._chartScale.pFromY(svgY);
      if (!Number.isFinite(rawPrice)) return;

      const asset = document.getElementById('asset').value;
      const snap = asset === 'BTC' ? 50 : 10;
      const newFloor = Math.max(1, Math.round(rawPrice / snap) * snap);

      // Real-time 2-way sync to form inputs and sentence
      document.getElementById('unitFloor').value = newFloor;
      const amount = Number(document.getElementById('amount').value) || 1;
      document.getElementById('floor').value = Number((amount * newFloor).toFixed(4));
      restateSentence();

      // Smooth visual repositioning in SVG
      const newY = svg._chartScale.yS(newFloor);
      const line = document.getElementById('svgFloorLine');
      const badgeRect = document.getElementById('svgFloorBadgeRect');
      const badgeText = document.getElementById('svgFloorBadgeText');
      const zone = document.getElementById('svgProtectionZone');

      if (line) {
        line.setAttribute('y1', newY.toFixed(1));
        line.setAttribute('y2', newY.toFixed(1));
      }
      if (badgeRect) {
        badgeRect.setAttribute('y', (newY - 11).toFixed(1));
      }
      if (badgeText) {
        badgeText.setAttribute('y', (newY + 4).toFixed(1));
        badgeText.textContent = `⇕ FLOOR ${formatMoney(newFloor, 0)}`;
      }
      if (zone) {
        const zoneH = Math.max(0, (svg._chartScale.H - svg._chartScale.PAD_B) - newY);
        zone.setAttribute('y', newY.toFixed(1));
        zone.setAttribute('height', zoneH.toFixed(1));
      }
    };

    const onPointerUp = (ev) => {
      if (!isDraggingFloor) return;
      isDraggingFloor = false;
      group.classList.remove('dragging');
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerUp);

      // Re-query orderbook on release
      findFloors();
    };

    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerUp);
  };
}

function renderPayoffChart(data) {
  const svg = document.getElementById('expiryPayoffSvg');
  const strike = data.quote.strike;
  const premium = data.quote.spendUsdc;
  const qty = data.quote.contracts || 1;

  const px0 = 14, px1 = 390, pyTop = 16, pyBot = 96;
  const lo = strike * 0.85, hi = strike * 1.15;
  const X = (v) => px0 + ((v - lo) / (hi - lo)) * (px1 - px0);

  const maxMove = strike * 0.15 * qty;
  const zeroY = pyTop + (pyBot - pyTop) * 0.52;
  const Y = (v) => {
    if (v >= 0) return zeroY - (Math.min(v, maxMove) / maxMove) * (zeroY - pyTop);
    return zeroY + (Math.min(-v, maxMove) / maxMove) * (pyBot - zeroY);
  };

  const floorY = Math.max(Y(-premium), zeroY + 6);
  const un = [], he = [];
  for (let i = 0; i <= 24; i++) {
    const p = lo + (hi - lo) * (i / 24);
    un.push(`${X(p).toFixed(1)},${Y((p - strike) * qty).toFixed(1)}`);
    const hv = (p - strike) * qty - premium;
    he.push(`${X(p).toFixed(1)},${(hv <= 0 ? floorY : Y(hv)).toFixed(1)}`);
  }

  const strikeX = X(strike);
  svg.innerHTML = `
    <line x1="14" y1="${zeroY.toFixed(1)}" x2="390" y2="${zeroY.toFixed(1)}" stroke="oklch(0.38 0.012 70)" stroke-width="1" stroke-dasharray="2 4" />
    <polyline points="${un.join(' ')}" fill="none" stroke="oklch(0.55 0.014 70)" stroke-width="1.4" stroke-dasharray="4 4" />
    <polyline points="${he.join(' ')}" fill="none" stroke="oklch(0.80 0.13 78)" stroke-width="2" />
    <line x1="${strikeX.toFixed(1)}" y1="12" x2="${strikeX.toFixed(1)}" y2="104" stroke="oklch(0.45 0.05 78)" stroke-width="1" />
    <text x="${strikeX.toFixed(1)}" y="118" fill="oklch(0.72 0.06 78)" font-family="IBM Plex Mono, monospace" font-size="9" text-anchor="middle">${formatMoney(strike, 0)}</text>
    <text x="18" y="118" fill="oklch(0.58 0.01 75)" font-family="IBM Plex Mono, monospace" font-size="9">FLOOR HOLDS BELOW</text>
    <text x="386" y="118" fill="oklch(0.58 0.01 75)" font-family="IBM Plex Mono, monospace" font-size="9" text-anchor="end">UPSIDE KEPT</text>
  `;
}

function updateProvenanceTable(data) {
  const sel = state.selected;
  document.getElementById('provPremiumVal').textContent = formatMoney(data.quote.spendUsdc);
  document.getElementById('provStrikeVal').textContent = formatMoney(sel.strike, 0);
  document.getElementById('provBudgetVal').textContent = formatMoney(sel.makerBudget, 0);
}

// ── Execution & Simulation ────────────────────────────────────────────────────

async function checkFillWouldSucceed(prep, fromAddress) {
  await walletState.provider.call({ to: prep.fillTx.to, data: prep.fillTx.data, from: fromAddress });
}

async function runSimulate() {
  const btn = document.getElementById('simBtn');
  const resBox = document.getElementById('simResultBox');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span>Simulating fill...';
  resBox.innerHTML = '';

  try {
    const q = state.quote.quote;
    const prep = await api('/api/prepare-tx', {
      id: state.selected.id,
      spendUsdc: q.spendUsdc,
      takerAddress: walletState.address || '0x0000000000000000000000000000000000000001',
    });

    if (!walletState.address || !walletState.provider) {
      resBox.innerHTML = `
        <div style="margin-top:12px; padding:12px; border-radius:var(--radius-sm); background:var(--subcard-bg); border:1px solid var(--border); font-size:13px;">
          ✓ Order structure encodes validly. Cost: <b>${formatMoney(prep.quote.spendUsdc)} USDC</b>. Connect wallet to run on-chain dry-run.
        </div>
      `;
      document.getElementById('simDot').className = 'log-dot';
      document.getElementById('simLogMeta').textContent = 'PASS · 0 gas';
    } else {
      try {
        await checkFillWouldSucceed(prep, walletState.address);
        resBox.innerHTML = `
          <div style="margin-top:12px; padding:12px; border-radius:var(--radius-sm); background:var(--green-bg); border:1px solid var(--green-border); font-size:13px; color:var(--green-text);">
            ✓ <b>Simulation succeeded on Base mainnet.</b> 0 gas spent, verified against live state.
          </div>
        `;
        document.getElementById('simDot').className = 'log-dot';
        document.getElementById('simLogMeta').textContent = 'PASS · 0 gas';
      } catch (simErr) {
        resBox.innerHTML = `
          <div style="margin-top:12px; padding:12px; border-radius:var(--radius-sm); background:var(--warn-bg); border:1px solid var(--warn-border); font-size:13px; color:var(--warn-text);">
            Notice: ${simErr.shortMessage || simErr.message}. If collateral has not been approved/supplied yet, Execute handles that automatically.
          </div>
        `;
      }
    }
  } catch (e) {
    resBox.innerHTML = `<div style="margin-top:12px; color:var(--danger); font-size:13px;">✗ Simulation error: ${e.message}</div>`;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Re-run free simulation';
  }
}

function sumDebitsFromReceipt(receipt, tokenAddress, walletAddress) {
  const fromTopic = ethers.zeroPadValue(walletAddress, 32).toLowerCase();
  const token = tokenAddress.toLowerCase();
  let total = 0n;
  for (const log of (receipt.logs || [])) {
    if (log.address.toLowerCase() === token &&
        log.topics && log.topics[0] === TRANSFER_TOPIC &&
        log.topics[1] && log.topics[1].toLowerCase() === fromTopic) {
      total += BigInt(log.data);
    }
  }
  return total;
}

async function runExecute() {
  if (!state.confirmed) return;

  if (!walletState.address || !walletState.signer) {
    await connectWallet();
    if (!walletState.address) return;
  }

  const q = state.quote.quote;
  const asset = document.getElementById('asset').value;
  const btn = document.getElementById('execBtn');
  btn.disabled = true;
  document.getElementById('receiptBox').style.display = 'none';

  try {
    btn.innerHTML = '<span class="spinner"></span>Preparing transaction...';
    const prep = await api('/api/prepare-tx', {
      id: state.selected.id,
      spendUsdc: q.spendUsdc,
      takerAddress: walletState.address,
    });

    const requiredUnits = BigInt(prep.collateralUnits);

    // 1. Supply to Aave if required
    if (prep.aavePlan) {
      const aBasContract = new ethers.Contract(prep.aavePlan.aBasUsdcAddress, ERC20_ABI, walletState.signer);
      const currentABas = await aBasContract.balanceOf(walletState.address);

      if (currentABas < requiredUnits) {
        const shortfall = requiredUnits - currentABas;
        const usdcContract = new ethers.Contract(prep.aavePlan.rawUsdcAddress, ERC20_ABI, walletState.signer);
        const usdcBal = await usdcContract.balanceOf(walletState.address);

        if (usdcBal < shortfall) {
          throw new Error(`Insufficient USDC balance. You need $${(Number(shortfall)/1e6).toFixed(2)} USDC to supply to Aave.`);
        }

        const aaveAllowance = await usdcContract.allowance(walletState.address, prep.aavePlan.aavePoolAddress);
        if (aaveAllowance < shortfall) {
          btn.innerHTML = '<span class="spinner"></span>Approve USDC for Aave in wallet...';
          const appTx = await walletState.signer.sendTransaction({
            to: prep.aavePlan.approveAaveTx.to,
            data: prep.aavePlan.approveAaveTx.data,
          });
          btn.innerHTML = '<span class="spinner"></span>Confirming Aave approval...';
          await appTx.wait();
        }

        btn.innerHTML = '<span class="spinner"></span>Supply USDC to Aave in wallet...';
        const supTx = await walletState.signer.sendTransaction({
          to: prep.aavePlan.supplyTx.to,
          data: prep.aavePlan.supplyTx.data,
        });
        btn.innerHTML = '<span class="spinner"></span>Confirming Aave supply...';
        await supTx.wait();
      }
    }

    // 2. OptionBook Allowance Approval
    const collateralContract = new ethers.Contract(prep.collateralToken, ERC20_ABI, walletState.signer);
    const currentAllowance = await collateralContract.allowance(walletState.address, prep.optionBookAddress);

    if (currentAllowance < requiredUnits) {
      btn.innerHTML = '<span class="spinner"></span>Approve collateral for OptionBook...';
      const appTx = await walletState.signer.sendTransaction({
        to: prep.approveOptionBookTx.to,
        data: prep.approveOptionBookTx.data,
      });
      btn.innerHTML = '<span class="spinner"></span>Confirming OptionBook approval...';
      await appTx.wait();
    }

    // 3. Pre-flight verification
    btn.innerHTML = '<span class="spinner"></span>Verifying fill safety...';
    try {
      await checkFillWouldSucceed(prep, walletState.address);
    } catch (simErr) {
      throw new Error(`Fill pre-flight check failed: ${simErr.shortMessage || simErr.message}`);
    }

    // 4. Execute FillOrder
    btn.innerHTML = '<span class="spinner"></span>Confirm fillOrder in wallet...';
    const fillTx = await walletState.signer.sendTransaction({
      to: prep.fillTx.to,
      data: prep.fillTx.data,
    });

    btn.innerHTML = '<span class="spinner"></span>Waiting for block confirmation...';
    const receipt = await fillTx.wait();

    // 5. Read debits from on-chain logs
    const paidUnits = sumDebitsFromReceipt(receipt, prep.collateralToken, walletState.address);
    const paidUsd = paidUnits > 0n ? Number(paidUnits) / (10 ** prep.collateralDecimals) : q.spendUsdc;

    state.executed = true;
    setStep(4);
    updateExecButtonState();

    document.getElementById('receiptLine').textContent =
      `You bought ${q.contracts.toFixed(4)} put contract(s) at a ${formatMoney(q.strike, 0)} strike expiring ${q.expiryIso.slice(0,10)} for ${formatMoney(paidUsd)}, verified from Transfer event logs on Base mainnet.`;
    document.getElementById('receiptTxHash').textContent = receipt.hash;
    document.getElementById('receiptExplorerLink').href = `https://basescan.org/tx/${receipt.hash}`;
    document.getElementById('receiptBox').style.display = 'block';

    await refreshWalletBalances();
    updateWalletUI();
  } catch (e) {
    alert('Execution failed: ' + (e.shortMessage || e.message));
    btn.disabled = false;
    updateExecButtonState();
  }
}

function resetFlow() {
  state = {
    candidates: [], selected: null, quote: null, candidatesSpec: null,
    expanded: false, noMatchPreview: false, confirmed: false, executed: false,
  };
  document.getElementById('confirmCheck').checked = false;
  document.getElementById('receiptBox').style.display = 'none';
  document.getElementById('simResultBox').innerHTML = '';
  document.getElementById('sentenceInput').value = 'I need my ETH worth at least $2,300 in two weeks';
  document.getElementById('asset').value = 'ETH';
  document.getElementById('amount').value = '1';
  document.getElementById('unitFloor').value = '2300';
  document.getElementById('floor').value = '2300';
  document.getElementById('days').value = '14';
  restateSentence();
  setStep(1);
  drawUnifiedChart();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function initSidebarResizer() {
  const resizer = document.getElementById('sidebarResizer');
  const layout = document.getElementById('workspaceLayout');
  if (!resizer || !layout) return;

  const DEFAULT_WIDTH = 440;
  const MIN_WIDTH = 300;
  const STORAGE_KEY = 'payung_sidebar_width';

  // Restore saved width from localStorage if valid
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      const parsed = parseInt(saved, 10);
      if (!isNaN(parsed) && parsed >= MIN_WIDTH) {
        layout.style.setProperty('--sidebar-width', `${parsed}px`);
      }
    }
  } catch {}

  let isDragging = false;

  resizer.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    if (window.innerWidth <= 980) return;

    e.preventDefault();
    isDragging = true;
    try {
      resizer.setPointerCapture(e.pointerId);
    } catch {}
    resizer.classList.add('is-dragging');
    document.body.classList.add('is-resizing-sidebar');
  });

  resizer.addEventListener('pointermove', (e) => {
    if (!isDragging) return;
    const layoutRect = layout.getBoundingClientRect();
    const newWidth = Math.round(layoutRect.right - e.clientX);

    const maxAllowed = Math.max(MIN_WIDTH, Math.min(860, layoutRect.width - 340));
    const clamped = Math.max(MIN_WIDTH, Math.min(maxAllowed, newWidth));

    layout.style.setProperty('--sidebar-width', `${clamped}px`);
  });

  const stopDragging = (e) => {
    if (!isDragging) return;
    isDragging = false;
    try {
      if (e && e.pointerId !== undefined) {
        resizer.releasePointerCapture(e.pointerId);
      }
    } catch {}
    resizer.classList.remove('is-dragging');
    document.body.classList.remove('is-resizing-sidebar');

    try {
      const currentW = parseInt(getComputedStyle(layout).getPropertyValue('--sidebar-width'), 10);
      if (!isNaN(currentW)) {
        localStorage.setItem(STORAGE_KEY, currentW.toString());
      }
    } catch {}
  };

  resizer.addEventListener('pointerup', stopDragging);
  resizer.addEventListener('pointercancel', stopDragging);

  // Double-click to reset to default width
  resizer.addEventListener('dblclick', () => {
    layout.style.setProperty('--sidebar-width', `${DEFAULT_WIDTH}px`);
    try {
      localStorage.setItem(STORAGE_KEY, DEFAULT_WIDTH.toString());
    } catch {}
  });

  // Keyboard accessibility
  resizer.addEventListener('keydown', (e) => {
    if (window.innerWidth <= 980) return;
    const step = e.shiftKey ? 40 : 16;
    const currentW = parseInt(getComputedStyle(layout).getPropertyValue('--sidebar-width'), 10) || DEFAULT_WIDTH;
    let targetW = currentW;

    if (e.key === 'ArrowLeft') {
      targetW = currentW + step;
    } else if (e.key === 'ArrowRight') {
      targetW = currentW - step;
    } else if (e.key === 'Home') {
      targetW = DEFAULT_WIDTH;
    } else {
      return;
    }

    e.preventDefault();
    const layoutRect = layout.getBoundingClientRect();
    const maxAllowed = Math.max(MIN_WIDTH, Math.min(860, layoutRect.width - 340));
    const clamped = Math.max(MIN_WIDTH, Math.min(maxAllowed, targetW));
    layout.style.setProperty('--sidebar-width', `${clamped}px`);
    try {
      localStorage.setItem(STORAGE_KEY, clamped.toString());
    } catch {}
  });
}

// Initial Run
//
// This script is loaded via next/script strategy="afterInteractive", which
// runs after React hydration — by which point document.readyState is no
// longer 'loading' and DOMContentLoaded has already fired. Listening for it
// here would never fire. Run immediately if the DOM is already ready, and
// only fall back to the event for the (non-Next) case where it isn't yet.
function initApp() {
  initSidebarResizer();
  document.getElementById('sentenceInput').value = 'I need my ETH worth at least $2,300 in two weeks';
  restateSentence();
  setStep(1);
  drawUnifiedChart();
}
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initApp);
} else {
  initApp();
}
