import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { ownName } from "../../src/hostDir.ts";
import { tabTitle } from "./title.ts";

// Issue #29: the tab's title is the directory's own name, an em dash and Interloq; Interloq alone without a location.
describe("tabTitle", () => {
  it("names the directory's own name before Interloq, never the full path", () => {
    expect(tabTitle("/home/mackler/work/interloq-dev")).toBe("interloq-dev — Interloq");
    expect(tabTitle("/workspace")).toBe("workspace — Interloq");
    expect(tabTitle("/")).toBe("/ — Interloq");
    expect(tabTitle(null)).toBe("Interloq");
  });
  it("property: begins with the location's own name, the top bar's headline, and ends with Interloq", () => {
    fc.assert(
      fc.property(fc.string(), (location) => {
        const title = tabTitle(location);
        expect(title.startsWith(ownName(location))).toBe(true);
        expect(title.endsWith(" — Interloq")).toBe(true);
      }),
      { numRuns: 200 },
    );
  });
});
