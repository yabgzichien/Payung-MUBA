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
