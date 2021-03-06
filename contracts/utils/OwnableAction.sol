// SPDX-License-Identifier: MIT
pragma solidity ^0.6.0;

/**
 * @dev Create immutable owner for action contract
 */
abstract contract OwnableAction {
    address payable public immutable actionOwner;

    constructor(address payable _owner) internal {
        actionOwner = _owner;
    }
}
