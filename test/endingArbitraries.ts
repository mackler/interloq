// Issue #44: arbitraries of every ending, for the property tests.
import fc from "fast-check";
import type { ConcludedEnding, Ending } from "../src/ending.ts";
import { ITEM_STATES } from "../src/tracker.ts";

const text = fc.string({ maxLength: 20 });
const state = fc.constantFrom(...ITEM_STATES);
const park = fc.oneof(
  fc.constant({ _tag: "Pending" as const }),
  fc.record({ _tag: fc.constant("Parked" as const), branch: text, commit: text }),
  fc.constant({ _tag: "NothingParked" as const }),
  fc.record({ _tag: fc.constant("ParkFailed" as const), message: text }),
);
const kept = fc.oneof(fc.record({ _tag: fc.constant("Parked" as const), branch: text, commit: text }), fc.constant({ _tag: "NothingParked" as const }));
const check = fc.oneof(fc.constant({ _tag: "NotSent" as const }), fc.constant({ _tag: "Unchecked" as const }), fc.record({ _tag: fc.constant("Held" as const), state }));
const item = fc.option(fc.oneof(fc.constant({ _tag: "Returned" as const }), fc.record({ _tag: fc.constant("NotReturned" as const), cause: text, check })), { nil: null });
const label = fc.oneof(
  fc.constant({ _tag: "SetRefined" as const }),
  fc.record({ _tag: fc.constant("StillHeld" as const), state, cause: text }),
  fc.record({ _tag: fc.constant("Unconfirmed" as const), cause: text }),
  fc.constant({ _tag: "KeptImplementing" as const }),
  fc.constant({ _tag: "Unchanged" as const }),
  fc.record({ _tag: fc.constant("SendBackUnfinished" as const), step: fc.constantFrom("comment" as const, "label" as const) }),
);
const work = fc.oneof(
  fc.constant({ _tag: "Refined" as const }),
  fc.record({ _tag: fc.constant("Obsolete" as const), labeled: fc.boolean() }),
  fc.record({ _tag: fc.constant("Implemented" as const), finalCommands: fc.array(text, { maxLength: 3 }) }),
);
const parkOrNone = fc.option(park, { nil: null });
export const arbConcluded: fc.Arbitrary<ConcludedEnding> = fc.oneof(
  fc.record({ _tag: fc.constant("Completed" as const), work }),
  fc.record({ _tag: fc.constant("SentBack" as const), missing: text, park: kept }),
  fc.record({ _tag: fc.constant("Halted" as const), reason: text, records: fc.option(text, { nil: null }), park: parkOrNone, item }),
  fc.record({ _tag: fc.constant("Interrupted" as const), park: parkOrNone, item }),
  fc.record({ _tag: fc.constant("Abandoned" as const), reason: text, park: parkOrNone, label }),
);
export const arbEnding: fc.Arbitrary<Ending> = fc.oneof(arbConcluded, fc.constant({ _tag: "Unestablished" as const }));
