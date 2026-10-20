// Issue #147 (S11): the chain's state every hello fixture of the page's tests carries, from one place.
import { DEFAULT_SETTINGS, initialState } from "../../src/chain.ts";

export const helloChain = initialState(DEFAULT_SETTINGS);
