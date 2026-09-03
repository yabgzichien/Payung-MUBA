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
