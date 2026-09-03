# Precise Protection (Safe-module auto-roll) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user opt into unattended, auto-rolling put protection toward their exact target — funded once from a Safe smart account they own, executed by a permissionless keeper within on-chain limits they approved, cancellable any time — reachable from the existing "Or chain shorter puts" card and visible in `/my-protection`.

**Architecture:** A new Solidity Safe module (`PayungRollModule`) is the only thing that ever moves the user's money — the Safe stays the on-chain buyer of every leg, Payung never signs a spending transaction. A Gelato Web3 Function triggers rolls; the module's own on-chain checks (not the keeper) are what actually bound risk, so execution is deliberately permissionless. The backend adds a thin read/merge layer over the module's on-chain storage and Thetanuts' existing positions indexer — no new database. The frontend adds a Safe onboarding step, one new button on the existing results card, and a new section on the existing `/my-protection` page.

**Tech Stack:** Foundry (new — Solidity contract + tests), `@safe-global/protocol-kit` (new — Safe deploy/connect/transaction building from the browser), Gelato Web3 Functions (new — keeper), existing stack otherwise (Next.js route handlers, Vitest, ethers v6).

**Spec:** [docs/superpowers/specs/2026-09-03-precise-protection-design.md](/home/yang/Project/MUBA/docs/superpowers/specs/2026-09-03-precise-protection-design.md) — read it before starting; this plan argues from it and does not repeat its rationale.

## Global Constraints

- Payung must never sign a transaction that spends user funds or that could make Payung the on-chain buyer of an option (spec Invariant 3 / HANDOFF.md design rule 8).
- Every roll is bounded on-chain by limits the user approved at `open()` time — the module's own checks, never an off-chain-only policy (spec Invariant 4).
- `cancel()` stops future rolls only; it must never be described in code, comments, or UI copy as unwinding an active position (spec Invariant 5).
- No new database — the module's on-chain storage and Thetanuts' positions indexer (`positionsFor()`) are the only sources of truth (spec Invariant 6).
- `executeRoll` is permissionless by design — do not add an allowlisted-caller check (spec §4.2).
- All USD amounts in the module are 1e6-scaled (USDC decimals, matching `USDC_DECIMALS` in `src/core.ts`); strikes are 1e8-scaled (matching `STRIKE_DECIMALS`).
- Gelato's Safe **Relay** product was deprecated 2026-09-01 — this plan uses Web3 Functions/Automate instead (confirmed live on Base, unrelated product); re-verify exact current SDK calls before Task 12, don't trust this plan's code samples as frozen.
- Re-verify `@safe-global/protocol-kit`'s exact current method names before Task 8 — this plan's Safe SDK code is best-effort from established patterns, not independently doc-checked the way the Gelato section was.

---

## Phase 1 — On-chain module

### Task 1: Scaffold the Foundry project

**Files:**
- Create: `contracts/foundry.toml`
- Create: `contracts/src/interfaces/ISafe.sol`
- Create: `contracts/.gitignore`
- Modify: `/home/yang/Project/MUBA/.gitignore:1` (append `contracts/out/`, `contracts/cache/`)

**Interfaces:**
- Produces: `ISafe` interface (`Operation` enum, `execTransactionFromModule`, `isModuleEnabled`) — every later contract task consumes this.

- [x] **Step 1: Check Foundry is available, install if not**

Run: `forge --version`
Expected: a version string. If "command not found", run:
```bash
curl -L https://foundry.paradigm.xyz | bash
foundryup
```
Then re-run `forge --version` to confirm.

- [x] **Step 2: Initialize the Foundry project**

```bash
mkdir -p /home/yang/Project/MUBA/contracts
cd /home/yang/Project/MUBA/contracts
forge init --no-git --no-commit .
```

(`--no-git` because this lives inside the existing MUBA git repo, not its own.)

- [x] **Step 3: Write `contracts/foundry.toml`**

```toml
[profile.default]
src = "src"
out = "out"
libs = ["lib"]
solc_version = "0.8.24"
optimizer = true
optimizer_runs = 200

[rpc_endpoints]
base = "https://mainnet.base.org"
```

- [x] **Step 4: Write the minimal Safe interface this module needs**

Create `contracts/src/interfaces/ISafe.sol`:

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface ISafe {
    enum Operation { Call, DelegateCall }

    function execTransactionFromModule(
        address to,
        uint256 value,
        bytes calldata data,
        Operation operation
    ) external returns (bool success);

    function isModuleEnabled(address module) external view returns (bool);
}
```

- [x] **Step 5: Add contracts/ to root .gitignore and commit scaffolding**

Append to `/home/yang/Project/MUBA/.gitignore`:
```
contracts/out/
contracts/cache/
contracts/lib/
```

```bash
cd /home/yang/Project/MUBA
git add contracts/foundry.toml contracts/src/interfaces/ISafe.sol .gitignore
git commit -m "chore: scaffold Foundry project for the Precise Protection module"
```

---

### Task 2: `PayungRollModule` — storage, `open()`, `cancel()`

**Files:**
- Create: `contracts/src/PayungRollModule.sol`
- Test: `contracts/test/PayungRollModuleOpen.t.sol`

**Interfaces:**
- Consumes: `ISafe` from Task 1 (`contracts/src/interfaces/ISafe.sol`).
- Produces: `PayungRollModule.Commitment` struct, `PayungRollModule.open(Commitment calldata)`, `PayungRollModule.cancel()`, `PayungRollModule.commitments(address) returns (Commitment memory)` — Task 3 (`executeRoll`) and Task 4 (deploy script) both depend on this exact struct shape and these two functions.

- [x] **Step 1: Write the failing test for `open()` access control**

Create `contracts/test/PayungRollModuleOpen.t.sol`:

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/PayungRollModule.sol";

contract PayungRollModuleOpenTest is Test {
    PayungRollModule module;
    address constant OPTION_BOOK = address(0xBEEF);
    bytes4 constant FILL_ORDER_SELECTOR = bytes4(keccak256("fillOrder((uint256,uint256,uint256,address,bool,uint256,address,bytes),uint256,address)"));

    function setUp() public {
        module = new PayungRollModule(OPTION_BOOK, FILL_ORDER_SELECTOR);
    }

    function _commitment(address safe) internal view returns (PayungRollModule.Commitment memory) {
        return PayungRollModule.Commitment({
            safe: safe,
            isCall: false,
            underlyingFeed: address(0xFEED),
            quantity1e6: 1_000_000,
            targetStrike: 2_225 * 1e8,
            createdAt: block.timestamp,
            deadline: block.timestamp + 30 days,
            maxPremiumPerRollUsd: 25_000_000,
            totalSpendCapUsd: 100_000_000,
            spentUsd: 0,
            maxRolls: 10,
            rollsUsed: 0,
            active: false
        });
    }

    function test_openRevertsWhenCallerIsNotTheSafe() public {
        address safe = address(0x1234);
        PayungRollModule.Commitment memory c = _commitment(safe);
        vm.expectRevert(PayungRollModule.NotYourCommitment.selector);
        module.open(c); // called from the test contract, not `safe`
    }

    function test_openSucceedsWhenCallerIsTheSafe() public {
        address safe = address(0x1234);
        PayungRollModule.Commitment memory c = _commitment(safe);
        vm.prank(safe);
        module.open(c);

        (, , , uint256 quantity1e6, uint256 targetStrike, , , , , , , , bool active) = module.commitments(safe);
        assertEq(quantity1e6, 1_000_000);
        assertEq(targetStrike, 2_225 * 1e8);
        assertTrue(active);
    }
}
```

- [x] **Step 2: Run the test to verify it fails**

Run: `cd /home/yang/Project/MUBA/contracts && forge test --match-path test/PayungRollModuleOpen.t.sol -vv`
Expected: FAIL — `PayungRollModule.sol` does not exist yet (compile error).

- [x] **Step 3: Write `PayungRollModule.sol` — struct + `open()` + `cancel()` only (executeRoll comes in Task 3)**

Create `contracts/src/PayungRollModule.sol`:

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./interfaces/ISafe.sol";

/// @notice Lets a Safe delegate strictly-bounded, unattended put-option rolls to a permissionless
/// keeper. The Safe itself remains the on-chain buyer for every fill — this module never custodies
/// funds and never becomes the option owner.
/// @dev See docs/superpowers/specs/2026-09-03-precise-protection-design.md for full rationale.
contract PayungRollModule {
    struct Commitment {
        address safe;
        bool isCall;
        address underlyingFeed;
        uint256 quantity1e6;
        uint256 targetStrike;
        uint256 createdAt;
        uint256 deadline;
        uint256 maxPremiumPerRollUsd;
        uint256 totalSpendCapUsd;
        uint256 spentUsd;
        uint256 maxRolls;
        uint256 rollsUsed;
        bool active;
    }

    address public immutable optionBook;
    bytes4 public immutable fillOrderSelector;

    mapping(address => Commitment) public commitments;

    event CommitmentOpened(address indexed safe, uint256 quantity1e6, uint256 targetStrike, uint256 deadline);
    event RollExecuted(address indexed safe, uint256 strike, uint256 expiry, uint256 premiumUsd, uint256 rollsUsed);
    event CommitmentCancelled(address indexed safe);

    error NotYourCommitment();
    error CommitmentInactive();

    constructor(address _optionBook, bytes4 _fillOrderSelector) {
        optionBook = _optionBook;
        fillOrderSelector = _fillOrderSelector;
    }

    /// @notice Called BY the Safe itself, typically bundled via multisend with enabling this module.
    function open(Commitment calldata c) external {
        if (msg.sender != c.safe) revert NotYourCommitment();
        Commitment memory fresh = c;
        fresh.spentUsd = 0;
        fresh.rollsUsed = 0;
        fresh.active = true;
        commitments[c.safe] = fresh;
        emit CommitmentOpened(c.safe, c.quantity1e6, c.targetStrike, c.deadline);
    }

    /// @notice Only the Safe itself may cancel its own commitment. Does not unwind any already-open
    /// position — the protocol has no early-exit for a put buyer; cancelling stops future rolls only.
    function cancel() external {
        Commitment storage c = commitments[msg.sender];
        if (!c.active) revert CommitmentInactive();
        c.active = false;
        emit CommitmentCancelled(msg.sender);
    }
}
```

- [x] **Step 4: Run the test to verify it passes**

Run: `cd /home/yang/Project/MUBA/contracts && forge test --match-path test/PayungRollModuleOpen.t.sol -vv`
Expected: 2 passed (`test_openRevertsWhenCallerIsNotTheSafe`, `test_openSucceedsWhenCallerIsTheSafe`).

- [x] **Step 5: Write and run the `cancel()` tests**

Add to `contracts/test/PayungRollModuleOpen.t.sol`:

```solidity
    function test_cancelRevertsIfNoActiveCommitment() public {
        vm.expectRevert(PayungRollModule.CommitmentInactive.selector);
        vm.prank(address(0x1234));
        module.cancel();
    }

    function test_cancelSetsActiveFalseAndOnlyTheSafeCanCallIt() public {
        address safe = address(0x1234);
        vm.prank(safe);
        module.open(_commitment(safe));

        vm.prank(safe);
        module.cancel();

        (, , , , , , , , , , , , bool active) = module.commitments(safe);
        assertFalse(active);
    }

    function test_cancelDoesNotResetSpendOrRollCounters() public {
        address safe = address(0x1234);
        PayungRollModule.Commitment memory c = _commitment(safe);
        vm.prank(safe);
        module.open(c);
        // Note: no way to advance spentUsd/rollsUsed without executeRoll (Task 3) —
        // this test is a placeholder assertion of the zero-state until Task 3 lands,
        // and MUST be extended there to actually roll once, then cancel, then assert
        // spentUsd/rollsUsed are unchanged by cancel().
        vm.prank(safe);
        module.cancel();
        (, , , , , , , , uint256 spentUsd, , , uint256 rollsUsed, ) = module.commitments(safe);
        assertEq(spentUsd, 0);
        assertEq(rollsUsed, 0);
    }
```

Run: `forge test --match-path test/PayungRollModuleOpen.t.sol -vv`
Expected: 5 passed.

- [x] **Step 6: Commit**

```bash
cd /home/yang/Project/MUBA
git add contracts/src/PayungRollModule.sol contracts/test/PayungRollModuleOpen.t.sol
git commit -m "feat: PayungRollModule open()/cancel() with Safe-only access control"
```

---

### Task 3: `executeRoll()` — the permissionless, bounded roll

**Files:**
- Modify: `contracts/src/PayungRollModule.sol`
- Modify: `contracts/test/PayungRollModuleOpen.t.sol` (Step 6 extends `test_cancelDoesNotResetSpendOrRollCounters` to actually exercise a roll)
- Create: `contracts/test/mocks/MockSafe.sol`
- Test: `contracts/test/PayungRollModuleExecuteRoll.t.sol`

**Interfaces:**
- Consumes: `PayungRollModule.Commitment`/`open()` from Task 2; `ISafe` from Task 1.
- Produces: `PayungRollModule.executeRoll(address safe, bytes calldata fillOrderCalldata, uint256 usdcAmount, uint256 orderStrike, uint256 orderExpiry)` — Task 7's `next-roll` route and Task 12's Gelato resolver both encode calls matching this exact signature.

- [x] **Step 1: Write a mock Safe for testing `execTransactionFromModule`**

Create `contracts/test/mocks/MockSafe.sol`:

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../../src/interfaces/ISafe.sol";

/// @dev Records every call it's asked to forward, and can be told to fail on demand — used to test
/// both the happy path and PayungRollModule's SafeCallFailed() branch.
contract MockSafe is ISafe {
    bool public shouldFail;
    address public lastTo;
    bytes public lastData;
    uint256 public callCount;

    function setShouldFail(bool v) external {
        shouldFail = v;
    }

    function execTransactionFromModule(
        address to,
        uint256, /* value */
        bytes calldata data,
        Operation /* operation */
    ) external override returns (bool success) {
        if (shouldFail) return false;
        lastTo = to;
        lastData = data;
        callCount += 1;
        return true;
    }

    function isModuleEnabled(address) external pure override returns (bool) {
        return true;
    }
}
```

- [x] **Step 2: Write the failing tests for `executeRoll`'s revert conditions and happy path**

Create `contracts/test/PayungRollModuleExecuteRoll.t.sol`:

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/PayungRollModule.sol";
import "./mocks/MockSafe.sol";

contract PayungRollModuleExecuteRollTest is Test {
    PayungRollModule module;
    MockSafe safe;
    bytes4 constant FILL_ORDER_SELECTOR = bytes4(0xaaaaaaaa);
    uint256 constant TARGET_STRIKE = 2_225 * 1e8; // matches _commitment()

    function setUp() public {
        module = new PayungRollModule(address(0xBEEF), FILL_ORDER_SELECTOR);
        safe = new MockSafe();

        PayungRollModule.Commitment memory c = PayungRollModule.Commitment({
            safe: address(safe),
            isCall: false,
            underlyingFeed: address(0xFEED),
            quantity1e6: 1_000_000,
            targetStrike: TARGET_STRIKE,
            createdAt: block.timestamp,
            deadline: block.timestamp + 30 days,
            maxPremiumPerRollUsd: 25_000_000,   // $25
            totalSpendCapUsd: 60_000_000,       // $60
            spentUsd: 0,
            maxRolls: 2,
            rollsUsed: 0,
            active: false
        });
        vm.prank(address(safe));
        module.open(c);
    }

    function _validCalldata() internal pure returns (bytes memory) {
        return abi.encodePacked(FILL_ORDER_SELECTOR, uint256(1)); // selector + dummy payload
    }

    function test_executeRollSucceeds_updatesStateAndCallsSafe() public {
        module.executeRoll(address(safe), _validCalldata(), 9_270_000, TARGET_STRIKE, block.timestamp + 3 days);

        (, , , , , , , , , uint256 spentUsd, , uint256 rollsUsed, ) = module.commitments(address(safe));
        assertEq(spentUsd, 9_270_000);
        assertEq(rollsUsed, 1);
        assertEq(safe.callCount(), 1);
        assertEq(safe.lastTo(), address(0xBEEF));
    }

    function test_executeRollIsCallableByAnyAddress() public {
        vm.prank(address(0xC0FFEE)); // not Payung, not the safe, not a designated keeper
        module.executeRoll(address(safe), _validCalldata(), 9_270_000, TARGET_STRIKE, block.timestamp + 3 days);
        (, , , , , , , , , uint256 spentUsd, , , ) = module.commitments(address(safe));
        assertEq(spentUsd, 9_270_000);
    }

    function test_executeRollRevertsWhenInactive() public {
        vm.prank(address(safe));
        module.cancel();
        vm.expectRevert(PayungRollModule.CommitmentInactive.selector);
        module.executeRoll(address(safe), _validCalldata(), 9_270_000, TARGET_STRIKE, block.timestamp + 3 days);
    }

    function test_executeRollRevertsPastDeadline() public {
        vm.warp(block.timestamp + 31 days);
        vm.expectRevert(PayungRollModule.PastDeadline.selector);
        module.executeRoll(address(safe), _validCalldata(), 9_270_000, TARGET_STRIKE, block.timestamp + 3 days);
    }

    function test_executeRollRevertsOverPerRollPremiumCap() public {
        vm.expectRevert(PayungRollModule.PremiumOverCap.selector);
        module.executeRoll(address(safe), _validCalldata(), 25_000_001, TARGET_STRIKE, block.timestamp + 3 days);
    }

    function test_executeRollRevertsOverTotalSpendCap() public {
        module.executeRoll(address(safe), _validCalldata(), 25_000_000, TARGET_STRIKE, block.timestamp + 3 days);
        module.executeRoll(address(safe), _validCalldata(), 25_000_000, TARGET_STRIKE, block.timestamp + 3 days);
        // spentUsd is now 50_000_000; cap is 60_000_000 — a third roll of 25_000_000 would exceed it.
        // But maxRolls is 2, so RollLimitReached fires first — assert that specific error, it's the
        // one that will actually trigger, proving the cap ordering is deliberate, not accidental.
        vm.expectRevert(PayungRollModule.RollLimitReached.selector);
        module.executeRoll(address(safe), _validCalldata(), 5_000_000, TARGET_STRIKE, block.timestamp + 3 days);
    }

    function test_executeRollRevertsOnWrongSelector() public {
        bytes memory badCalldata = abi.encodePacked(bytes4(0xdeadbeef), uint256(1));
        vm.expectRevert(PayungRollModule.WrongSelector.selector);
        module.executeRoll(address(safe), badCalldata, 9_270_000, TARGET_STRIKE, block.timestamp + 3 days);
    }

    function test_executeRollRevertsOnStrikeOutsideTolerance() public {
        uint256 farStrike = TARGET_STRIKE * 2; // 100% off — well outside the 10% band
        vm.expectRevert(PayungRollModule.StrikeOutOfRange.selector);
        module.executeRoll(address(safe), _validCalldata(), 9_270_000, farStrike, block.timestamp + 3 days);
    }

    function test_executeRollRevertsWhenSafeCallFails() public {
        safe.setShouldFail(true);
        vm.expectRevert(PayungRollModule.SafeCallFailed.selector);
        module.executeRoll(address(safe), _validCalldata(), 9_270_000, TARGET_STRIKE, block.timestamp + 3 days);
    }
}
```

- [x] **Step 3: Run the tests to verify they fail**

Run: `cd /home/yang/Project/MUBA/contracts && forge test --match-path test/PayungRollModuleExecuteRoll.t.sol -vv`
Expected: FAIL — `executeRoll` does not exist yet (compile error).

- [x] **Step 4: Implement `executeRoll()`**

Add to `contracts/src/PayungRollModule.sol` (inside the `PayungRollModule` contract, after `cancel()`):

```solidity
    error PastDeadline();
    error RollLimitReached();
    error PremiumOverCap();
    error SpendCapExceeded();
    error WrongSelector();
    error StrikeOutOfRange();
    error SafeCallFailed();

    /// @dev How far a roll's strike may sit from the commitment's own target before it's rejected.
    /// A generous but bounded symmetric band — wide enough to admit any book-real candidate the
    /// off-chain ranking would surface, tight enough that a bad caller can't roll into an unrelated strike.
    uint256 public constant STRIKE_TOLERANCE_BPS = 1000; // 10%

    /// @notice Permissionless — see design rationale in the spec (§4.2). Any caller may trigger a due
    /// roll; the checks below are the only thing standing between "anyone can call this" and safety.
    function executeRoll(
        address safe,
        bytes calldata fillOrderCalldata,
        uint256 usdcAmount,
        uint256 orderStrike,
        uint256 orderExpiry
    ) external {
        Commitment storage c = commitments[safe];
        if (!c.active) revert CommitmentInactive();
        if (block.timestamp >= c.deadline) revert PastDeadline();
        if (c.rollsUsed >= c.maxRolls) revert RollLimitReached();
        if (usdcAmount > c.maxPremiumPerRollUsd) revert PremiumOverCap();
        if (c.spentUsd + usdcAmount > c.totalSpendCapUsd) revert SpendCapExceeded();
        if (bytes4(fillOrderCalldata[:4]) != fillOrderSelector) revert WrongSelector();

        uint256 lower = (c.targetStrike * (10000 - STRIKE_TOLERANCE_BPS)) / 10000;
        uint256 upper = (c.targetStrike * (10000 + STRIKE_TOLERANCE_BPS)) / 10000;
        if (orderStrike < lower || orderStrike > upper) revert StrikeOutOfRange();
        if (orderExpiry > c.deadline + 3 days) revert StrikeOutOfRange();

        c.spentUsd += usdcAmount;
        c.rollsUsed += 1;

        bool ok = ISafe(safe).execTransactionFromModule(optionBook, 0, fillOrderCalldata, ISafe.Operation.Call);
        if (!ok) revert SafeCallFailed();

        emit RollExecuted(safe, orderStrike, orderExpiry, usdcAmount, c.rollsUsed);
    }
```

- [x] **Step 5: Run the tests to verify they pass**

Run: `cd /home/yang/Project/MUBA/contracts && forge test --match-path test/PayungRollModuleExecuteRoll.t.sol -vv`
Expected: 9 passed.

- [x] **Step 6: Run the full contract suite together and fix any regressions**

Run: `cd /home/yang/Project/MUBA/contracts && forge test -vv`
Expected: all tests across both test files pass (14 total). If `test_cancelDoesNotResetSpendOrRollCounters` from Task 2 still only asserts the zero-state, extend it now to actually exercise a roll first:

Replace that test in `contracts/test/PayungRollModuleOpen.t.sol` with:

```solidity
    function test_cancelDoesNotResetSpendOrRollCounters() public {
        address safe = address(0x1234);
        MockSafe mockSafe = new MockSafe();
        PayungRollModule.Commitment memory c = _commitment(address(mockSafe));
        vm.prank(address(mockSafe));
        module.open(c);

        module.executeRoll(address(mockSafe), abi.encodePacked(FILL_ORDER_SELECTOR, uint256(1)), 9_270_000, 2_225 * 1e8, block.timestamp + 3 days);

        vm.prank(address(mockSafe));
        module.cancel();

        (, , , , , , , , , uint256 spentUsd, , uint256 rollsUsed, bool active) = module.commitments(address(mockSafe));
        assertEq(spentUsd, 9_270_000);
        assertEq(rollsUsed, 1);
        assertFalse(active);
    }
```

Add `import "./mocks/MockSafe.sol";` to the top of `contracts/test/PayungRollModuleOpen.t.sol`. Re-run `forge test -vv` and confirm all pass.

- [x] **Step 7: Commit**

```bash
cd /home/yang/Project/MUBA
git add contracts/src/PayungRollModule.sol contracts/test/PayungRollModuleExecuteRoll.t.sol contracts/test/mocks/MockSafe.sol contracts/test/PayungRollModuleOpen.t.sol
git commit -m "feat: PayungRollModule executeRoll() — permissionless, on-chain-bounded rolls"
```

---

### Task 4: Deploy script

**Files:**
- Create: `contracts/script/Deploy.s.sol`
- Create: `contracts/.env.example`

**Interfaces:**
- Consumes: `PayungRollModule` constructor `(address _optionBook, bytes4 _fillOrderSelector)` from Task 2.
- Produces: a deployed module address that Task 5 onward references as `PAYUNG_ROLL_MODULE_ADDRESS`.

- [x] **Step 1: Write the deploy script**

Create `contracts/script/Deploy.s.sol`:

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "../src/PayungRollModule.sol";

/// @dev OPTION_BOOK_ADDRESS and FILL_ORDER_SELECTOR must be read from the live Thetanuts SDK
/// config before running this against Base mainnet — see contracts/.env.example.
contract Deploy is Script {
    function run() external {
        address optionBook = vm.envAddress("OPTION_BOOK_ADDRESS");
        bytes4 selector = bytes4(vm.envBytes32("FILL_ORDER_SELECTOR"));

        vm.startBroadcast();
        PayungRollModule module = new PayungRollModule(optionBook, selector);
        vm.stopBroadcast();

        console.log("PayungRollModule deployed at:", address(module));
    }
}
```

- [x] **Step 2: Write `contracts/.env.example`**

```
# Base mainnet OptionBook address — read from client.getContractAddress('optionBook') in src/core.ts
OPTION_BOOK_ADDRESS=
# keccak256 selector of OptionBookModule.fillOrder((...),uint256,address) — compute once via
# `cast sig "fillOrder((uint256,uint256,uint256,address,bool,uint256,address,bytes),uint256,address)"`
# against the SDK's actual OrderWithSignature tuple shape (verify field order against
# node_modules/@thetanuts-finance/thetanuts-client/dist/index.d.ts before running this)
FILL_ORDER_SELECTOR=
PRIVATE_KEY=
BASE_RPC_URL=https://mainnet.base.org
```

- [x] **Step 3: Dry-run the script against a local fork to confirm it compiles and executes**

```bash
cd /home/yang/Project/MUBA/contracts
forge script script/Deploy.s.sol --fork-url https://mainnet.base.org \
  --sig "run()" \
  -vvvv \
  --env OPTION_BOOK_ADDRESS=0x0000000000000000000000000000000000dEaD \
  --env FILL_ORDER_SELECTOR=0xaaaaaaaa
```
Expected: script runs, logs a deployed address, no revert. (This is a dry run against a fork — no real deployment yet. Real deployment to Base mainnet is a manual step outside this plan, done once the module has had its review pass per the spec's hard requirement.)

- [x] **Step 4: Commit**

```bash
cd /home/yang/Project/MUBA
git add contracts/script/Deploy.s.sol contracts/.env.example
git commit -m "feat: PayungRollModule deploy script"
```

---

## Phase 2 — Backend read/prepare layer

### Task 5: `src/precise.ts` — pure merge logic

**Files:**
- Create: `src/precise.ts`
- Test: `tests/precise.test.ts`
- Modify: `tests/fixtures.ts` (add a `makeRawOnChainCommitment` factory alongside the existing `makeCandidate`)

**Interfaces:**
- Consumes: `ShapedPosition` (from `src/positions.ts`), `ProtectionSpec` (from `src/spec.ts`).
- Produces: `PreciseCommitment` type, `mergePreciseCommitment(raw, currentLeg, history, assetForFeed)` — Task 6's API route consumes this exact function and type, and supplies a real `assetForFeed` backed by `client.chainConfig.priceFeeds`.

- [ ] **Step 1: Add the fixture factory**

Add to `tests/fixtures.ts` (after `makeCandidate`):

```ts
import type { RawOnChainCommitment } from '../src/precise.js';
export type { RawOnChainCommitment };

export function makeRawOnChainCommitment(over: Partial<RawOnChainCommitment> = {}): RawOnChainCommitment {
  return {
    safe: '0x00000000000000000000000000000000000005afe',
    active: true,
    underlyingFeed: FEED_ETH,
    quantity1e6: 1_000_000n,
    targetStrike: 222_500_000_000n, // $2,225 at 1e8
    createdAt: 1_800_000_000n,
    deadline: 1_802_592_000n, // +30 days
    maxPremiumPerRollUsd: 25_000_000n,
    totalSpendCapUsd: 100_000_000n,
    spentUsd: 0n,
    maxRolls: 10n,
    rollsUsed: 0n,
    ...over,
  };
}
```

(`FEED_ETH` already exists at the top of this file, defined for `makeCandidate`.)

- [ ] **Step 2: Write the failing tests**

Create `tests/precise.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { mergePreciseCommitment } from '../src/precise.js';
import { makeRawOnChainCommitment, FEED_ETH, FEED_BTC } from './fixtures.js';

const ethOrBtc = (feed: string) => (feed === FEED_BTC ? 'BTC' as const : 'ETH' as const);

describe('mergePreciseCommitment', () => {
  it('reconstructs the original spec from on-chain fields', () => {
    const raw = makeRawOnChainCommitment();
    const merged = mergePreciseCommitment(raw, null, [], ethOrBtc);
    expect(merged.spec.asset).toBe('ETH');
    expect(merged.spec.quantity).toBeCloseTo(1, 6);
    expect(merged.spec.floorTotalUsd).toBeCloseTo(2225, 2);
    expect(merged.spec.horizonDays).toBeCloseTo(30, 5);
  });

  it('resolves the commitment asset from the on-chain feed address via the supplied resolver', () => {
    const raw = makeRawOnChainCommitment({ underlyingFeed: FEED_BTC });
    const merged = mergePreciseCommitment(raw, null, [], ethOrBtc);
    expect(merged.spec.asset).toBe('BTC');
  });

  it('carries active/spend/roll fields through as plain numbers', () => {
    const raw = makeRawOnChainCommitment({ spentUsd: 34_500_000n, rollsUsed: 3n, active: false });
    const merged = mergePreciseCommitment(raw, null, [], ethOrBtc);
    expect(merged.active).toBe(false);
    expect(merged.spentUsd).toBeCloseTo(34.5, 6);
    expect(merged.rollsUsed).toBe(3);
    expect(merged.maxRolls).toBe(10);
    expect(merged.totalSpendCapUsd).toBeCloseTo(100, 6);
  });

  it('attaches the current leg when a matching position is supplied', () => {
    const raw = makeRawOnChainCommitment();
    const position = { id: 'pos-1', strike: 2225, daysToExpiry: 2.5 } as any;
    const merged = mergePreciseCommitment(raw, position, [], ethOrBtc);
    expect(merged.currentLeg).toBe(position);
  });

  it('carries roll history through unchanged, sorted oldest-first', () => {
    const raw = makeRawOnChainCommitment();
    const history = [
      { strike: 2225, expiryIso: '2026-10-01T00:00:00.000Z', premiumUsd: 9.27, txHash: '0xb' },
      { strike: 2225, expiryIso: '2026-09-25T00:00:00.000Z', premiumUsd: 8.5, txHash: '0xa' },
    ];
    const merged = mergePreciseCommitment(raw, null, history, ethOrBtc);
    expect(merged.history.map((h) => h.txHash)).toEqual(['0xa', '0xb']);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run tests/precise.test.ts`
Expected: FAIL — `src/precise.ts` does not exist.

- [ ] **Step 4: Implement `src/precise.ts`**

Create `src/precise.ts`:

```ts
/**
 * Read/merge layer for Precise Protection. No new database (spec Invariant 6) — every field here
 * is reconstructed from the on-chain module's own storage/events, plus Thetanuts' existing
 * positions indexer via ShapedPosition. This module never signs or sends anything, and stays
 * SDK-free (mirrors src/spot.ts's boundary) — asset resolution is injected via assetForFeed rather
 * than resolved internally, so the caller (the API route, which does hold a client) supplies it.
 */
import type { ProtectionSpec } from './spec';
import type { ShapedPosition } from './positions';

export type RawOnChainCommitment = {
  safe: string;
  active: boolean;
  underlyingFeed: string;
  quantity1e6: bigint;
  targetStrike: bigint;
  createdAt: bigint;
  deadline: bigint;
  maxPremiumPerRollUsd: bigint;
  totalSpendCapUsd: bigint;
  spentUsd: bigint;
  maxRolls: bigint;
  rollsUsed: bigint;
};

export type RollHistoryEntry = { strike: number; expiryIso: string; premiumUsd: number; txHash: string };

export type PreciseCommitment = {
  safe: string;
  active: boolean;
  spec: ProtectionSpec;
  spentUsd: number;
  totalSpendCapUsd: number;
  rollsUsed: number;
  maxRolls: number;
  currentLeg: ShapedPosition | null;
  history: RollHistoryEntry[];
};

const USDC_SCALE = 1_000_000;
const STRIKE_SCALE = 100_000_000;
const DAY_SECONDS = 86_400;

export function mergePreciseCommitment(
  raw: RawOnChainCommitment,
  currentLeg: ShapedPosition | null,
  history: RollHistoryEntry[],
  assetForFeed: (feed: string) => 'ETH' | 'BTC'
): PreciseCommitment {
  const horizonDays = Number(raw.deadline - raw.createdAt) / DAY_SECONDS;
  const quantity = Number(raw.quantity1e6) / USDC_SCALE;
  const unitStrike = Number(raw.targetStrike) / STRIKE_SCALE;

  return {
    safe: raw.safe,
    active: raw.active,
    spec: {
      asset: assetForFeed(raw.underlyingFeed),
      quantity,
      floorTotalUsd: unitStrike * quantity,
      horizonDays,
    },
    spentUsd: Number(raw.spentUsd) / USDC_SCALE,
    totalSpendCapUsd: Number(raw.totalSpendCapUsd) / USDC_SCALE,
    rollsUsed: Number(raw.rollsUsed),
    maxRolls: Number(raw.maxRolls),
    currentLeg,
    history: [...history].sort((a, b) => new Date(a.expiryIso).getTime() - new Date(b.expiryIso).getTime()),
  };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/precise.test.ts`
Expected: 5 passed.

- [ ] **Step 6: Typecheck and run the full suite**

Run: `npx tsc --noEmit && npx vitest run`
Expected: clean typecheck, all tests pass (no regressions).

- [ ] **Step 7: Commit**

```bash
cd /home/yang/Project/MUBA
git add src/precise.ts tests/precise.test.ts tests/fixtures.ts
git commit -m "feat: precise.ts — pure merge logic for Precise Protection, no database"
```

---

### Task 6: `GET /api/precise/commitment` route

**Files:**
- Create: `app/api/precise/commitment/route.ts`

**Interfaces:**
- Consumes: `mergePreciseCommitment` from Task 5, `readClient()`/`positionsFor()` (from `src/core.ts`/`src/watcher.ts`, unchanged), `jsonResponse`/`withErrorHandling`/`ClientError` from `src/api-shared.ts` (unchanged).
- Produces: `GET /api/precise/commitment?safe=0x...` → `{ commitment: PreciseCommitment | null }` — called from `/my-protection` (Task 11) via the `fetchPreciseCommitment` wrapper Task 9 adds to `app/protect/_lib/api.ts`.

**Note:** this task reads the module via a minimal ABI fragment (`commitments(address)` view + events), not the Thetanuts SDK — `readClient()` is used only for `positionsFor()`/`chainConfig`, matching how `app/api/history/route.ts` already mixes a plain `ethers.Provider` read with an SDK client.

- [ ] **Step 1: Write the route**

Create `app/api/precise/commitment/route.ts`:

```ts
import { ethers } from 'ethers';
import type { NextRequest } from 'next/server';
import { readClient } from '@/src/core';
import { positionsFor } from '@/src/watcher';
import { mergePreciseCommitment, type RawOnChainCommitment, type RollHistoryEntry } from '@/src/precise';
import { jsonResponse, withErrorHandling, ClientError } from '@/src/api-shared';

const MODULE_ADDRESS = process.env.PAYUNG_ROLL_MODULE_ADDRESS ?? '';

const MODULE_ABI = [
  'function commitments(address) view returns (address safe, bool isCall, address underlyingFeed, uint256 quantity1e6, uint256 targetStrike, uint256 createdAt, uint256 deadline, uint256 maxPremiumPerRollUsd, uint256 totalSpendCapUsd, uint256 spentUsd, uint256 maxRolls, uint256 rollsUsed, bool active)',
  'event RollExecuted(address indexed safe, uint256 strike, uint256 expiry, uint256 premiumUsd, uint256 rollsUsed)',
];

export async function GET(req: NextRequest) {
  return withErrorHandling(async () => {
    const safe = req.nextUrl.searchParams.get('safe');
    if (!safe || !ethers.isAddress(safe)) {
      throw new ClientError('safe must be a valid address');
    }
    if (!MODULE_ADDRESS) {
      throw new Error('PAYUNG_ROLL_MODULE_ADDRESS is not configured on the server.');
    }

    const client = readClient();
    const module = new ethers.Contract(MODULE_ADDRESS, MODULE_ABI, client.provider);

    const raw = await module.commitments(safe);
    const isOpen = raw.createdAt !== 0n;
    if (!isOpen) {
      return jsonResponse(200, { commitment: null });
    }

    const rawCommitment: RawOnChainCommitment = {
      safe: raw.safe,
      active: raw.active,
      quantity1e6: raw.quantity1e6,
      targetStrike: raw.targetStrike,
      createdAt: raw.createdAt,
      deadline: raw.deadline,
      maxPremiumPerRollUsd: raw.maxPremiumPerRollUsd,
      totalSpendCapUsd: raw.totalSpendCapUsd,
      spentUsd: raw.spentUsd,
      maxRolls: raw.maxRolls,
      rollsUsed: raw.rollsUsed,
      underlyingFeed: raw.underlyingFeed,
    };

    const assetForFeed = (feed: string): 'ETH' | 'BTC' => {
      const entries = Object.entries(client.chainConfig.priceFeeds) as [string, string][];
      const match = entries.find(([, addr]) => addr.toLowerCase() === feed.toLowerCase());
      if (!match) throw new Error(`Unrecognized price feed on commitment: ${feed}`);
      return match[0] as 'ETH' | 'BTC';
    };

    const nowSec = Math.floor(Date.now() / 1000);
    const positions = await positionsFor(safe, nowSec);
    const currentLeg =
      positions.find((p) => p.status === 'active' && p.strike === Number(raw.targetStrike) / 1e8) ?? null;

    const events = await module.queryFilter(module.filters.RollExecuted(safe));
    const history: RollHistoryEntry[] = events.map((e: any) => ({
      strike: Number(e.args.strike) / 1e8,
      expiryIso: '', // resolved by matching against `positions` client-side if needed; the event itself has no expiry field
      premiumUsd: Number(e.args.premiumUsd) / 1e6,
      txHash: e.transactionHash,
    }));

    const commitment = mergePreciseCommitment(rawCommitment, currentLeg, history, assetForFeed);
    return jsonResponse(200, { commitment });
  });
}
```

**Known gap to flag, not silently fix:** `RollExecuted` doesn't carry an expiry, so `history[].expiryIso` is currently always `''`. Leave it — fixing it means adding `expiry` to the `RollExecuted` event in Task 3's contract, which would mean reopening and re-testing Phase 1. Note this as a follow-up in the PR description when this ships; do not block this task on it.

- [ ] **Step 2: Manual verification (no live module deployed yet, so this is a shape check, not a live-data check)**

Run: `npx tsc --noEmit`
Expected: clean. There is no automated test for this route (matches the existing convention — no other `app/api/*/route.ts` in this codebase has a dedicated test file; see `app/api/candidates/route.ts`, `app/api/history/route.ts`).

- [ ] **Step 3: Commit**

```bash
cd /home/yang/Project/MUBA
git add app/api/precise/commitment/route.ts
git commit -m "feat: GET /api/precise/commitment — reads the module + positions indexer, no database"
```

---

### Task 7: `prepare-open` / `prepare-cancel` / `next-roll` routes

**Files:**
- Create: `app/api/precise/prepare-open/route.ts`
- Create: `app/api/precise/prepare-cancel/route.ts`
- Create: `app/api/precise/next-roll/route.ts`

**Interfaces:**
- Consumes: `impliedStrike`/`ProtectionSpec` from `src/spec.ts`, `validateSpec` from `src/intent.ts`, `readClient()`/`findCandidates()`/`quote()` from `src/core.ts`, `positionsFor()` from `src/watcher.ts` (all unchanged), `ClientError`/`jsonResponse`/`requireJsonContentType`/`withErrorHandling` from `src/api-shared.ts` (unchanged).
- Produces: `POST /api/precise/prepare-open {spec, safe, maxPremiumPerRollUsd, totalSpendCapUsd, maxRolls}` → `{ to, data }` (unsigned, matching the shape `app/protect/_lib/types.ts`'s existing `PrepareTxResponse.approveOptionBookTx` already uses) — called from Task 9 (onboarding page). `POST /api/precise/prepare-cancel {safe}` → `{ to, data }` — called from Task 11 (`/my-protection`). `GET /api/precise/next-roll?safe=0x...` → `{ due: false } | { due: true, safe, fillOrderCalldata, usdcAmount, orderStrike, orderExpiry }` — called from Task 12's Gelato resolver; this is what lets that resolver stay a thin HTTP call instead of needing to hold a live `ThetanutsClient` inside Gelato's sandboxed runtime.

- [ ] **Step 1: Write `prepare-open`**

Create `app/api/precise/prepare-open/route.ts`:

```ts
import { ethers } from 'ethers';
import { impliedStrike, type ProtectionSpec } from '@/src/spec';
import { validateSpec } from '@/src/intent';
import { ClientError, jsonResponse, requireJsonContentType, withErrorHandling } from '@/src/api-shared';

const MODULE_ADDRESS = process.env.PAYUNG_ROLL_MODULE_ADDRESS ?? '';
const STRIKE_SCALE = 100_000_000;
const USDC_SCALE = 1_000_000;

const MODULE_ABI = [
  'function open((address safe, bool isCall, address underlyingFeed, uint256 quantity1e6, uint256 targetStrike, uint256 createdAt, uint256 deadline, uint256 maxPremiumPerRollUsd, uint256 totalSpendCapUsd, uint256 spentUsd, uint256 maxRolls, uint256 rollsUsed, bool active))',
];

function parsePositiveNumber(raw: unknown, field: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new ClientError(`${field} must be a positive finite number`);
  return n;
}

export async function POST(req: Request) {
  const badContentType = requireJsonContentType(req);
  if (badContentType) return badContentType;

  return withErrorHandling(async () => {
    if (!MODULE_ADDRESS) throw new Error('PAYUNG_ROLL_MODULE_ADDRESS is not configured on the server.');
    const body = await req.json();

    let spec: ProtectionSpec;
    try {
      spec = validateSpec(body.spec);
    } catch (e: any) {
      throw new ClientError(e?.message ?? String(e));
    }
    if (typeof body.safe !== 'string' || !ethers.isAddress(body.safe)) {
      throw new ClientError('safe must be a valid address');
    }
    const maxPremiumPerRollUsd = parsePositiveNumber(body.maxPremiumPerRollUsd, 'maxPremiumPerRollUsd');
    const totalSpendCapUsd = parsePositiveNumber(body.totalSpendCapUsd, 'totalSpendCapUsd');
    const maxRolls = parsePositiveNumber(body.maxRolls, 'maxRolls');

    const feedEnv = spec.asset === 'ETH' ? process.env.CHAINLINK_FEED_ETH : process.env.CHAINLINK_FEED_BTC;
    if (!feedEnv) throw new Error(`No configured price feed for ${spec.asset}`);

    const nowSec = Math.floor(Date.now() / 1000);
    const commitment = {
      safe: body.safe,
      isCall: false,
      underlyingFeed: feedEnv,
      quantity1e6: BigInt(Math.round(spec.quantity * USDC_SCALE)),
      targetStrike: BigInt(Math.round(impliedStrike(spec) * STRIKE_SCALE)),
      createdAt: BigInt(nowSec),
      deadline: BigInt(nowSec + Math.round(spec.horizonDays * 86400)),
      maxPremiumPerRollUsd: BigInt(Math.round(maxPremiumPerRollUsd * USDC_SCALE)),
      totalSpendCapUsd: BigInt(Math.round(totalSpendCapUsd * USDC_SCALE)),
      spentUsd: 0n,
      maxRolls: BigInt(Math.round(maxRolls)),
      rollsUsed: 0n,
      active: false, // set true by open() itself — irrelevant here, encoded for struct-shape completeness
    };

    const iface = new ethers.Interface(MODULE_ABI);
    const data = iface.encodeFunctionData('open', [commitment]);

    return jsonResponse(200, { to: MODULE_ADDRESS, data });
  });
}
```

- [ ] **Step 2: Write `prepare-cancel`**

Create `app/api/precise/prepare-cancel/route.ts`:

```ts
import { ethers } from 'ethers';
import { ClientError, jsonResponse, requireJsonContentType, withErrorHandling } from '@/src/api-shared';

const MODULE_ADDRESS = process.env.PAYUNG_ROLL_MODULE_ADDRESS ?? '';
const MODULE_ABI = ['function cancel()'];

export async function POST(req: Request) {
  const badContentType = requireJsonContentType(req);
  if (badContentType) return badContentType;

  return withErrorHandling(async () => {
    if (!MODULE_ADDRESS) throw new Error('PAYUNG_ROLL_MODULE_ADDRESS is not configured on the server.');
    const body = await req.json();
    if (typeof body.safe !== 'string' || !ethers.isAddress(body.safe)) {
      throw new ClientError('safe must be a valid address');
    }
    const iface = new ethers.Interface(MODULE_ABI);
    const data = iface.encodeFunctionData('cancel', []);
    return jsonResponse(200, { to: MODULE_ADDRESS, data });
  });
}
```

- [ ] **Step 3: Write `next-roll`**

This is what the keeper (Task 12) actually calls. It does all the SDK-dependent work (reading positions, finding a replacement candidate, encoding the fill) server-side, so the Gelato resolver — which runs in a sandboxed runtime that cannot hold a live `ThetanutsClient` — only ever needs to make one HTTP call and forward the result.

Create `app/api/precise/next-roll/route.ts`:

```ts
import type { NextRequest } from 'next/server';
import { ethers } from 'ethers';
import { readClient, findCandidates, quote } from '@/src/core';
import { positionsFor } from '@/src/watcher';
import { jsonResponse, withErrorHandling, ClientError } from '@/src/api-shared';

const MODULE_ADDRESS = process.env.PAYUNG_ROLL_MODULE_ADDRESS ?? '';
const ROLL_TRIGGER_DAYS = 2; // matches DEFAULT_POLICY.rollWhenDaysToExpiry in src/policy.ts

const MODULE_ABI = [
  'function commitments(address) view returns (address safe, bool isCall, address underlyingFeed, uint256 quantity1e6, uint256 targetStrike, uint256 createdAt, uint256 deadline, uint256 maxPremiumPerRollUsd, uint256 totalSpendCapUsd, uint256 spentUsd, uint256 maxRolls, uint256 rollsUsed, bool active)',
];

export async function GET(req: NextRequest) {
  return withErrorHandling(async () => {
    const safe = req.nextUrl.searchParams.get('safe');
    if (!safe || !ethers.isAddress(safe)) throw new ClientError('safe must be a valid address');
    if (!MODULE_ADDRESS) throw new Error('PAYUNG_ROLL_MODULE_ADDRESS is not configured on the server.');

    const client = readClient();
    const module = new ethers.Contract(MODULE_ADDRESS, MODULE_ABI, client.provider);
    const c = await module.commitments(safe);
    const nowSec = Math.floor(Date.now() / 1000);

    if (!c.active || nowSec >= Number(c.deadline)) {
      return jsonResponse(200, { due: false });
    }

    const targetStrike = Number(c.targetStrike) / 1e8;
    const positions = await positionsFor(safe, nowSec);
    const currentLeg = positions.find((p) => p.status === 'active' && p.strike === targetStrike) ?? null;
    // No active leg yet means this commitment was just opened and never rolled — roll immediately
    // rather than waiting for a "days to expiry" reading that doesn't exist yet.
    if (currentLeg && (currentLeg.daysToExpiry ?? 0) > ROLL_TRIGGER_DAYS) {
      return jsonResponse(200, { due: false });
    }

    const asset = (Object.entries(client.chainConfig.priceFeeds) as [string, string][]).find(
      ([, addr]) => addr.toLowerCase() === (c.underlyingFeed as string).toLowerCase()
    )?.[0] as 'ETH' | 'BTC' | undefined;
    if (!asset) throw new Error(`Unrecognized price feed on commitment: ${c.underlyingFeed}`);

    const quantity = Number(c.quantity1e6) / 1e6;
    const remainingDays = Math.max(1, Math.ceil((Number(c.deadline) - nowSec) / 86400));
    const candidates = await findCandidates(
      { asset, quantity, floorTotalUsd: targetStrike * quantity, horizonDays: remainingDays },
      client
    );
    if (candidates.length === 0) return jsonResponse(200, { due: false });

    const best = candidates[0];
    const q = await quote(best, quantity * best.pricePerContract, client);
    const usdcAmount = Math.round(q.premiumUsdc * 1e6);
    if (usdcAmount > Number(c.maxPremiumPerRollUsd) || Number(c.spentUsd) + usdcAmount > Number(c.totalSpendCapUsd)) {
      return jsonResponse(200, { due: false });
    }

    const { data: fillOrderCalldata } = client.optionBook.encodeFillOrder(best.raw, BigInt(usdcAmount));

    return jsonResponse(200, {
      due: true,
      safe,
      fillOrderCalldata,
      usdcAmount,
      orderStrike: Math.round(best.strike * 1e8),
      orderExpiry: Math.floor(best.expiry.getTime() / 1000),
    });
  });
}
```

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
cd /home/yang/Project/MUBA
git add app/api/precise/prepare-open/route.ts app/api/precise/prepare-cancel/route.ts app/api/precise/next-roll/route.ts
git commit -m "feat: prepare-open/prepare-cancel/next-roll routes — unsigned calldata only, never server-signed"
```

---

## Phase 3 — Frontend

### Task 8: `app/protect/_lib/safe.ts` — Safe SDK wrapper

**Files:**
- Create: `app/protect/_lib/safe.ts`
- Modify: `/home/yang/Project/MUBA/package.json` (add `@safe-global/protocol-kit` dependency)

**Interfaces:**
- Consumes: `getSigner()`/`describeWalletError` from `app/protect/_lib/wallet.ts` (unchanged).
- Produces: `deployOrConnectSafe()`, `fundSafe(safeAddress, usdcAmount)`, `enableModuleAndOpen(safeAddress, openTx)` — Task 9 (onboarding page) consumes all three.

**Flag before starting:** per Global Constraints, verify `@safe-global/protocol-kit`'s exact current API (package name, `Safe.init`/`SafeFactory` method names) against its published docs before writing this file — the code below is best-effort from established Safe SDK patterns, not independently doc-checked the way Task 12's Gelato integration was.

- [ ] **Step 1: Add the dependency**

```bash
cd /home/yang/Project/MUBA
npm install @safe-global/protocol-kit
```

- [ ] **Step 2: Write `app/protect/_lib/safe.ts`**

Create `app/protect/_lib/safe.ts`:

```ts
'use client';

import Safe from '@safe-global/protocol-kit';
import { ethers } from 'ethers';
import { getSigner, describeWalletError, type TxRequest } from './wallet';

const USDC_ADDRESS_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const USDC_DECIMALS = 6;
const ERC20_ABI = ['function transfer(address to, uint256 amount) returns (bool)'];

/** Deploys a fresh 1-owner Safe for the connected wallet, or returns an existing one if already deployed at the predicted address. */
export async function deployOrConnectSafe(): Promise<string> {
  const signer = await getSigner();
  const owner = await signer.getAddress();
  try {
    const protocolKit = await Safe.init({
      provider: (signer.provider as any)?._getConnection?.()?.url ?? 'https://mainnet.base.org',
      signer: (signer as any).privateKey ?? owner, // browser signer path — see Step 1's verification flag
      predictedSafe: { safeAccountConfig: { owners: [owner], threshold: 1 } },
    });
    const safeAddress = await protocolKit.getAddress();
    const deployed = await protocolKit.isSafeDeployed();
    if (deployed) return safeAddress;

    const deploymentTx = await protocolKit.createSafeDeploymentTransaction();
    const sent = await signer.sendTransaction({ to: deploymentTx.to, value: deploymentTx.value, data: deploymentTx.data });
    await sent.wait();
    return safeAddress;
  } catch (e) {
    throw new Error(describeWalletError(e));
  }
}

/** A plain ERC-20 transfer of USDC from the connected wallet into the Safe. */
export async function fundSafe(safeAddress: string, usdcAmount: number): Promise<{ hash: string }> {
  const signer = await getSigner();
  const usdc = new ethers.Contract(USDC_ADDRESS_BASE, ERC20_ABI, signer);
  const amount = BigInt(Math.round(usdcAmount * 10 ** USDC_DECIMALS));
  try {
    const tx = await usdc.transfer(safeAddress, amount);
    await tx.wait();
    return { hash: tx.hash };
  } catch (e) {
    throw new Error(describeWalletError(e));
  }
}

/**
 * Bundles "enable PayungRollModule" + the server-prepared open() call into one Safe multisend
 * transaction, and sends it. moduleAddress and openTx.to must be the same deployed module address.
 */
export async function enableModuleAndOpen(safeAddress: string, moduleAddress: string, openTx: TxRequest): Promise<{ hash: string }> {
  const signer = await getSigner();
  try {
    const protocolKit = await Safe.init({
      provider: (signer.provider as any)?._getConnection?.()?.url ?? 'https://mainnet.base.org',
      signer: await signer.getAddress(),
      safeAddress,
    });
    const safeTx = await protocolKit.createTransaction({
      transactions: [
        { to: safeAddress, value: '0', data: encodeEnableModule(moduleAddress) },
        { to: openTx.to, value: '0', data: openTx.data },
      ],
    });
    const signedTx = await protocolKit.signTransaction(safeTx);
    const result = await protocolKit.executeTransaction(signedTx);
    return { hash: result.hash };
  } catch (e) {
    throw new Error(describeWalletError(e));
  }
}

function encodeEnableModule(moduleAddress: string): string {
  const iface = new ethers.Interface(['function enableModule(address module)']);
  return iface.encodeFunctionData('enableModule', [moduleAddress]);
}
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: clean, OR type errors from `@safe-global/protocol-kit`'s real API not matching the best-effort calls above — if so, this is exactly the "re-verify before Task 8" flag from Global Constraints firing as intended; fix the calls against the installed package's actual `.d.ts` (`node_modules/@safe-global/protocol-kit/dist/**/*.d.ts`) rather than guessing further.

- [ ] **Step 4: Commit**

```bash
cd /home/yang/Project/MUBA
git add app/protect/_lib/safe.ts package.json package-lock.json
git commit -m "feat: Safe SDK wrapper for Precise Protection onboarding"
```

---

### Task 9: Onboarding page

**Files:**
- Create: `app/protect/precise-setup/page.tsx`
- Create: `app/protect/precise-setup/page.module.css`
- Modify: `app/protect/_lib/types.ts` (add `PreciseCommitment` wire type + `PrepareOpenResponse`)
- Modify: `app/protect/_lib/api.ts` (add `fetchPrepareOpen`, `fetchPrepareCancel`, `fetchPreciseCommitment`)

**Interfaces:**
- Consumes: `deployOrConnectSafe`/`fundSafe`/`enableModuleAndOpen` from Task 8; `/api/precise/prepare-open` from Task 7; `rollEstimate` from `useProtectionFlow()` (existing, from the chained-roll-estimate feature).
- Produces: a working `/protect/precise-setup` route. Task 10 links to it.

- [ ] **Step 1: Add wire types**

Add to `app/protect/_lib/types.ts` (near the existing `RollEstimateCard`):

```ts
export type PreciseCommitmentWire = {
  safe: string;
  active: boolean;
  spec: { asset: Asset; quantity: number; floorTotalUsd: number; horizonDays: number };
  spentUsd: number;
  totalSpendCapUsd: number;
  rollsUsed: number;
  maxRolls: number;
  currentLeg: ShapedPosition | null;
  history: { strike: number; expiryIso: string; premiumUsd: number; txHash: string }[];
};

export type PrepareOpenResponse = { to: string; data: string };
```

- [ ] **Step 2: Add API wrappers**

Add to `app/protect/_lib/api.ts`:

```ts
export function fetchPrepareOpen(params: {
  spec: { asset: string; quantity: number; floorTotalUsd: number; horizonDays: number };
  safe: string;
  maxPremiumPerRollUsd: number;
  totalSpendCapUsd: number;
  maxRolls: number;
}): Promise<PrepareOpenResponse> {
  return postJson<PrepareOpenResponse>('/api/precise/prepare-open', params);
}

export function fetchPrepareCancel(safe: string): Promise<PrepareOpenResponse> {
  return postJson<PrepareOpenResponse>('/api/precise/prepare-cancel', { safe });
}

export async function fetchPreciseCommitment(safe: string): Promise<PreciseCommitmentWire | null> {
  const res = await fetch(`/api/precise/commitment?safe=${encodeURIComponent(safe)}`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || `precise commitment fetch failed with ${res.status}`);
  return data?.commitment ?? null;
}
```

Add the corresponding imports (`PrepareOpenResponse`, `PreciseCommitmentWire`) to the top of `app/protect/_lib/api.ts`.

- [ ] **Step 3: Write the onboarding page**

Create `app/protect/precise-setup/page.tsx`:

```tsx
'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Shell } from '../_lib/Shell';
import { useProtectionFlow } from '../_lib/FlowState';
import { deployOrConnectSafe, fundSafe, enableModuleAndOpen } from '../_lib/safe';
import { fetchPrepareOpen } from '../_lib/api';
import ui from '../_lib/ui.module.css';
import styles from './page.module.css';

const MODULE_ADDRESS = process.env.NEXT_PUBLIC_PAYUNG_ROLL_MODULE_ADDRESS ?? '';

type Step = 'idle' | 'deploying' | 'funding' | 'enabling' | 'done';

export default function PreciseSetupPage() {
  const router = useRouter();
  const { goal, rollEstimate } = useProtectionFlow();
  const [step, setStep] = useState<Step>('idle');
  const [error, setError] = useState<string | null>(null);
  const [safeAddress, setSafeAddress] = useState<string | null>(null);
  const suggestedBudget = rollEstimate ? rollEstimate.estimatedTotalPremiumUsd * 1.2 : 0;
  const [budget, setBudget] = useState(suggestedBudget);

  if (!goal || !rollEstimate) {
    return (
      <Shell>
        <div className={ui.errorBox}>
          Start from a protection search first — Precise Protection needs a goal and a live roll estimate to set up.
        </div>
      </Shell>
    );
  }

  async function runSetup() {
    setError(null);
    try {
      setStep('deploying');
      const safe = await deployOrConnectSafe();
      setSafeAddress(safe);

      setStep('funding');
      await fundSafe(safe, budget);

      setStep('enabling');
      const openTx = await fetchPrepareOpen({
        spec: { asset: goal!.asset, quantity: goal!.quantity, floorTotalUsd: goal!.floorTotalUsd, horizonDays: goal!.days },
        safe,
        maxPremiumPerRollUsd: rollEstimate!.anchorPremiumUsd * 1.5,
        totalSpendCapUsd: budget,
        maxRolls: rollEstimate!.estimatedLegs * 2,
      });
      await enableModuleAndOpen(safe, MODULE_ADDRESS, openTx);

      setStep('done');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStep('idle');
    }
  }

  return (
    <Shell>
      <h1 className={ui.title}>Set up Precise Protection</h1>
      <p className={ui.subtitle}>
        Payung will keep rolling your protection forward automatically until it covers your full{' '}
        {goal.days}-day floor or you cancel — no more signatures needed after this setup.
      </p>

      {error && <div className={ui.errorBox}>{error}</div>}

      <div className={styles.budgetRow}>
        <label className={styles.budgetLabel} htmlFor="budget">Funding budget (USDC)</label>
        <input
          id="budget"
          type="number"
          className={styles.budgetInput}
          value={budget}
          min={0}
          step={0.01}
          onChange={(e) => setBudget(Number(e.target.value))}
          disabled={step !== 'idle'}
        />
        <p className={styles.budgetHint}>
          Suggested: ${suggestedBudget.toFixed(2)} (the theoretical roll-chain estimate, plus a 20% buffer).
          This funds a Safe you own — Payung never holds it.
        </p>
      </div>

      <ol className={styles.steps}>
        <li className={step === 'deploying' ? styles.stepActive : safeAddress ? styles.stepDone : ''}>
          Deploy or connect your Safe
        </li>
        <li className={step === 'funding' ? styles.stepActive : ''}>Fund it with your budget</li>
        <li className={step === 'enabling' ? styles.stepActive : ''}>Enable Precise Protection</li>
      </ol>

      <button className={ui.btnPrimary} onClick={runSetup} disabled={step !== 'idle' && step !== 'done'}>
        {step === 'idle' ? 'Start setup →' : step === 'done' ? 'Set up ✓' : 'Working…'}
      </button>

      {step === 'done' && (
        <button className={ui.btnOutline} onClick={() => router.push('/my-protection')} style={{ marginTop: 12 }}>
          View in My Protection →
        </button>
      )}
    </Shell>
  );
}
```

- [ ] **Step 4: Write `app/protect/precise-setup/page.module.css`**

Create `app/protect/precise-setup/page.module.css`:

```css
.budgetRow {
  margin: 20px 0;
}

.budgetLabel {
  display: block;
  font-size: 13px;
  color: var(--text-dim);
  margin-bottom: 8px;
}

.budgetInput {
  width: 100%;
  padding: 12px 14px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--input-bg);
  color: var(--text-bright);
  font-size: 15px;
}

.budgetHint {
  font-size: 12.5px;
  color: var(--text-muted);
  margin: 8px 0 0;
  line-height: 1.5;
}

.steps {
  list-style: none;
  padding: 0;
  margin: 20px 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.steps li {
  padding: 10px 14px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  color: var(--text-dim);
  font-size: 14px;
}

.stepActive {
  border-color: var(--accent-border);
  color: var(--text-bright);
  background: var(--accent-bg);
}

.stepDone {
  border-color: var(--green-border);
  color: var(--green-text);
}
```

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
cd /home/yang/Project/MUBA
git add app/protect/precise-setup app/protect/_lib/types.ts app/protect/_lib/api.ts
git commit -m "feat: Precise Protection onboarding page — Safe deploy, fund, enable"
```

---

### Task 10: Results screen — "Set up Precise Protection" button

**Files:**
- Modify: `app/protect/results/page.tsx`

**Interfaces:**
- Consumes: `rollEstimate` from `useProtectionFlow()` (unchanged), `router.push` from `next/navigation`.
- Produces: nothing new consumed elsewhere — this is a leaf UI change.

- [ ] **Step 1: Add the button next to "Buy this first leg →"**

In `app/protect/results/page.tsx`, find:

```tsx
          <button className={ui.btnOutline} onClick={() => choose(rollEstimate.anchorQuote)}>
            Buy this first leg →
          </button>
```

Replace with:

```tsx
          <div className={styles.rollEstimateActions}>
            <button className={ui.btnOutline} onClick={() => choose(rollEstimate.anchorQuote)}>
              Buy this first leg →
            </button>
            <button className={ui.btnPrimary} onClick={() => router.push('/protect/precise-setup')}>
              Set up Precise Protection →
            </button>
          </div>
```

- [ ] **Step 2: Add the layout style**

Add to `app/protect/results/page.module.css`:

```css
.rollEstimateActions {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin: 16px 0;
}
```

- [ ] **Step 3: Verify in the browser**

Start the dev server (`preview_start` with the `payung-web` launch config), navigate through `/protect` → submit a goal that produces a `rollEstimate` (a horizon/floor combo the live book has no exact match for) → confirm both buttons render on the "Or chain shorter puts" card, and clicking "Set up Precise Protection →" navigates to `/protect/precise-setup` without a console error.

- [ ] **Step 4: Commit**

```bash
cd /home/yang/Project/MUBA
git add app/protect/results/page.tsx app/protect/results/page.module.css
git commit -m "feat: add Set up Precise Protection button to the chain-shorter-puts card"
```

---

### Task 11: `/my-protection` — Precise Protection section

**Files:**
- Modify: `app/my-protection/page.tsx`
- Modify: `app/my-protection/page.module.css`

**Interfaces:**
- Consumes: `fetchPreciseCommitment`/`fetchPrepareCancel` from `app/protect/_lib/api.ts` (both added in Task 9), `sendAndWait`/`getSigner` from `app/protect/_lib/wallet.ts` (unchanged — cancel is signed by the Safe owner's normal EOA the same way every other transaction in this app is signed).

- [ ] **Step 1: Add state and a fetch effect**

In `app/my-protection/page.tsx`, add to the imports:

```ts
import { fetchPreciseCommitment, fetchPrepareCancel } from '../protect/_lib/api';
import { getSigner, sendAndWait, describeWalletError } from '../protect/_lib/wallet';
import type { PreciseCommitmentWire } from '../protect/_lib/types';
```

Add state (alongside the existing `positions`/`positionsError` state):

```ts
  const [precise, setPrecise] = useState<PreciseCommitmentWire | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);
```

Extend the existing `useEffect` that fetches positions to also fetch the precise commitment (same dependency array, same guard):

```ts
    fetchPreciseCommitment(wallet.address).then(setPrecise).catch(() => setPrecise(null));
```

(Add this line directly after the existing `fetchPositions(wallet.address).then(...)` call inside that `useEffect`.)

- [ ] **Step 2: Add the cancel handler**

Add a function near the existing `handleConnect`:

```ts
  async function handleCancelPrecise() {
    if (!precise) return;
    setCancelling(true);
    setCancelError(null);
    try {
      const tx = await fetchPrepareCancel(precise.safe);
      const signer = await getSigner();
      await sendAndWait(signer, tx);
      const refreshed = await fetchPreciseCommitment(precise.safe);
      setPrecise(refreshed);
    } catch (e) {
      setCancelError(e instanceof Error ? e.message : describeWalletError(e));
    } finally {
      setCancelling(false);
    }
  }
```

- [ ] **Step 3: Render the section**

Add below the existing `{active.entryTxHash && (...)}` block, still inside the `active` branch's `<>...</>`:

```tsx
          {precise && (
            <>
              <h2 className={styles.sectionTitle}>Precise Protection</h2>
              <div className={styles.card}>
                <div className={styles.rows}>
                  <div className={styles.row}>
                    <span className={styles.rowLabel}>Status</span>
                    <span className={[styles.rowValue, precise.active ? styles.rowValueAccent : styles.rowValueWarn].join(' ')}>
                      {precise.active ? 'Active — auto-rolling' : 'Cancelled'}
                    </span>
                  </div>
                  <div className={styles.row}>
                    <span className={styles.rowLabel}>Spent so far</span>
                    <span className={styles.rowValue}>
                      ${precise.spentUsd.toFixed(2)} / ${precise.totalSpendCapUsd.toFixed(2)} cap
                    </span>
                  </div>
                  <div className={styles.row}>
                    <span className={styles.rowLabel}>Rolls used</span>
                    <span className={styles.rowValue}>{precise.rollsUsed} / {precise.maxRolls}</span>
                  </div>
                </div>
                {precise.history.length > 0 && (
                  <ul className={styles.rollHistory}>
                    {precise.history.map((h) => (
                      <li key={h.txHash}>
                        ${h.strike.toLocaleString()} floor · ${h.premiumUsd.toFixed(2)} ·{' '}
                        <a href={`https://basescan.org/tx/${h.txHash}`} target="_blank" rel="noreferrer">
                          {h.txHash.slice(0, 10)}…
                        </a>
                      </li>
                    ))}
                  </ul>
                )}
                {cancelError && <div className={ui.errorBox}>{cancelError}</div>}
                {precise.active && (
                  <button className={ui.btnOutline} onClick={handleCancelPrecise} disabled={cancelling}>
                    {cancelling ? <span className={ui.spinner} /> : null} Cancel protection
                  </button>
                )}
                <p className={styles.metaLine}>
                  Cancelling stops future rolls only — any protection currently active keeps running to its own expiry.
                </p>
              </div>
            </>
          )}
```

- [ ] **Step 4: Add the roll-history list style**

Add to `app/my-protection/page.module.css`:

```css
.rollHistory {
  list-style: none;
  padding: 0;
  margin: 12px 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 13px;
  color: var(--text-dim);
}

.rollHistory a {
  color: var(--accent);
}
```

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 6: Verify in the browser**

Navigate to `/my-protection` with a connected wallet. Confirm the page still renders correctly with `precise === null` (no Precise Protection section shown, no error) — this is the only state reachable without a live deployed module, so it's the one to actually verify end-to-end; the populated-state rendering can only be checked once Phase 1 is deployed.

- [ ] **Step 7: Commit**

```bash
cd /home/yang/Project/MUBA
git add app/my-protection/page.tsx app/my-protection/page.module.css
git commit -m "feat: Precise Protection section in My Protection — history + cancel"
```

---

## Phase 4 — Keeper

### Task 12: Gelato Web3 Function — resolver + registration script

**Files:**
- Create: `gelato/resolver.ts`
- Create: `gelato/register.ts`
- Modify: `/home/yang/Project/MUBA/package.json` (add `@gelatonetwork/web3-functions-sdk` + `@gelatonetwork/automate-sdk` dependencies, `gelato:register` script)
- Modify: `/home/yang/Project/MUBA/tsconfig.json` (add `gelato/**/*.ts` to `include`)

**Interfaces:**
- Consumes: `GET /api/precise/next-roll?safe=0x...` from Task 7 — this is what keeps the resolver itself thin (no `ThetanutsClient`, no `positionsFor()`, just one HTTP call per known Safe), the deployed module address from Task 4.
- Produces: nothing consumed by other tasks — this is the final, standalone piece.

**Flag before starting:** per Global Constraints, this is the piece most likely to have moved since the spec was written (Gelato's Relay product was deprecated 3 days before this plan was written). Check `docs.gelato.cloud/web3-functions` for the current SDK's exact resolver export shape before writing `gelato/resolver.ts` — the code below is a best-effort sketch of the well-established resolver pattern (return `{canExec, callData}`), not a doc-verified final implementation.

- [ ] **Step 1: Add the dependencies**

```bash
cd /home/yang/Project/MUBA
npm install --save-dev @gelatonetwork/web3-functions-sdk @gelatonetwork/automate-sdk
```

- [ ] **Step 2: Write the resolver**

The resolver only needs a plain `ethers.Provider` read against the module (to discover which Safes have ever opened a commitment — a genuinely light read Gelato's sandboxed runtime can do directly) and one `fetch` per Safe against Task 7's `next-roll` endpoint (which does all the SDK-dependent work). It never needs a `ThetanutsClient` or `positionsFor()` itself.

Create `gelato/resolver.ts`:

```ts
import { Web3Function, Web3FunctionContext } from '@gelatonetwork/web3-functions-sdk';
import { ethers } from 'ethers';

const MODULE_ABI = [
  'event CommitmentOpened(address indexed safe, uint256 quantity1e6, uint256 targetStrike, uint256 deadline)',
  'function executeRoll(address safe, bytes calldata fillOrderCalldata, uint256 usdcAmount, uint256 orderStrike, uint256 orderExpiry)',
];

type NextRollResponse =
  | { due: false }
  | { due: true; safe: string; fillOrderCalldata: string; usdcAmount: number; orderStrike: number; orderExpiry: number };

Web3Function.onRun(async (context: Web3FunctionContext) => {
  const { userArgs, multiChainProvider } = context;
  const moduleAddress = userArgs.moduleAddress as string;
  const apiBaseUrl = userArgs.apiBaseUrl as string; // Payung's deployed origin — set at registration time (Step 3)
  const provider = multiChainProvider.default();
  const module = new ethers.Contract(moduleAddress, MODULE_ABI, provider);

  const openedEvents = await module.queryFilter(module.filters.CommitmentOpened(), -50_000);
  const safes = [...new Set(openedEvents.map((e: any) => e.args.safe as string))];

  const iface = new ethers.Interface(MODULE_ABI);
  for (const safe of safes) {
    const res = await fetch(`${apiBaseUrl}/api/precise/next-roll?safe=${safe}`);
    if (!res.ok) continue;
    const data = (await res.json()) as NextRollResponse;
    if (!data.due) continue;

    const callData = iface.encodeFunctionData('executeRoll', [
      data.safe, data.fillOrderCalldata, data.usdcAmount, data.orderStrike, data.orderExpiry,
    ]);
    return { canExec: true, callData: [{ to: moduleAddress, data: callData }] };
  }

  return { canExec: false, message: 'no commitment due to roll' };
});
```

- [ ] **Step 3: Write the registration script**

Create `gelato/register.ts`:

```ts
import 'dotenv/config';
import { AutomateSDK } from '@gelatonetwork/automate-sdk';
import { ethers } from 'ethers';

async function main() {
  const provider = new ethers.JsonRpcProvider(process.env.BASE_RPC_URL || 'https://mainnet.base.org');
  const wallet = new ethers.Wallet(process.env.PRIVATE_KEY!, provider);
  const automate = new AutomateSDK(8453, wallet as any);

  const { taskId, tx } = await automate.createTask({
    execAddress: process.env.PAYUNG_ROLL_MODULE_ADDRESS!,
    execSelector: '0x00000000', // replaced by the Web3 Function's own dynamic call target at runtime
    dedicatedMsgSender: true,
    web3FunctionArgs: {
      moduleAddress: process.env.PAYUNG_ROLL_MODULE_ADDRESS!,
      apiBaseUrl: process.env.PAYUNG_API_BASE_URL!, // e.g. https://payung.example.com — the deployed Next.js app
    },
  });
  await tx.wait();
  console.log('Gelato task registered:', taskId);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
```

- [ ] **Step 4: Add the npm script**

Add to `package.json`'s `"scripts"`:

```json
    "gelato:register": "tsx gelato/register.ts",
```

- [ ] **Step 5: Typecheck**

Add `"gelato/**/*.ts"` to the `include` array in `tsconfig.json` (alongside the existing `src/**/*.ts`, `app/**/*.ts`, `mcp/**/*.ts` entries).

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
cd /home/yang/Project/MUBA
git add gelato/ package.json tsconfig.json
git commit -m "feat: Gelato Web3 Function for Precise Protection — resolver, next-roll integration, registration script"
```

---

## What's left after this plan

- Real deployment to Base mainnet (`forge script script/Deploy.s.sol --broadcast`), registering the live Gelato task (`npm run gelato:register` with real env vars), and the module's review pass — all explicitly out of this plan's scope per the spec's hard requirement that real money not go behind this contract without one.
- `RollExecuted`'s missing `expiry` field (flagged in Task 6) — a small Phase 1 revisit once it's clear the History UI actually needs it populated.
- `contracts/script/Deploy.s.sol` and `gelato/register.ts` both need the real `OPTION_BOOK_ADDRESS`/`FILL_ORDER_SELECTOR`/`PAYUNG_API_BASE_URL` values filled in against the actual deployment target before either is run for real — Task 4 and Task 12 leave these as env vars deliberately, not hardcoded guesses.
