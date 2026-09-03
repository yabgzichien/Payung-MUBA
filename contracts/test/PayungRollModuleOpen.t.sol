// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/PayungRollModule.sol";
import "./mocks/MockSafe.sol";

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
}
