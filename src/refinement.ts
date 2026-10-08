// The `Refined using Interloq` section of an item's body (issue #120, part 1), as a value: written and read by pure
// functions, so that what is written is what is read. The text the developer wrote is never changed.
import { type Brand, Result } from "effect";

/** A refinement: a text that is not blank and holds neither marker line of the section, built by refinementOf alone. */
export type Refinement = Brand.Branded<string, "Refinement">;
/** Why a text is not a refinement. */
export type InvalidRefinement = Readonly<{ _tag: "InvalidRefinement"; reason: "blank" | "markerLine" }>;
export const refinementOf = (_text: string): Result.Result<Refinement, InvalidRefinement> => Result.fail({ _tag: "InvalidRefinement", reason: "blank" });
