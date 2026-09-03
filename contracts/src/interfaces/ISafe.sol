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
