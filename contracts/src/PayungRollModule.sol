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
}
