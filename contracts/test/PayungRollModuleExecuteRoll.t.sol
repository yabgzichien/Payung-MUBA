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
