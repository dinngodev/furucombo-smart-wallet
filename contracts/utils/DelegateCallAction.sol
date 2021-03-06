// SPDX-License-Identifier: MIT
pragma solidity ^0.6.0;

/**
 * @dev Can only be delegate call.
 */
abstract contract DelegateCallAction {
    address private immutable self;

    modifier delegateCallOnly() {
        require(self != address(this), "Delegate call only");
        _;
    }

    constructor() internal {
        self = address(this);
    }
}
