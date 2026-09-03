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
