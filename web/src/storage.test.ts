import { describe, expect, test } from "vitest";
import { defaultPreferences } from "./notify.ts";
import { readColumnWidths, readPanelLines, readPreferences, type StorageLike, writeColumnWidths, writePanelLines, writePreferences } from "./storage.ts";
import { DEFAULT_COLUMN_WIDTHS, leftPercentOf, railRemOf } from "./columnWidths.ts";
import { PANEL_LINES } from "./livePanel.ts";
import { panelLinesOf } from "./panelHeight.ts";
import { Result } from "effect";

// Finding 3 of docs/gui-review.md: the storage edge returns typed results; nothing it does can throw.
const memory = (): StorageLike & { items: Map<string, string> } => {
  const items = new Map<string, string>();
  return { items, getItem: (k) => items.get(k) ?? null, setItem: (k, v) => void items.set(k, v) };
};
const securityError = () => new DOMException("access denied", "SecurityError");

describe("storage", () => {
  test("a throwing acquisition, getItem or setItem, and absent storage, are failures, not exceptions", () => {
    const throwingGetter = () => {
      throw securityError();
    };
    expect(readPreferences(throwingGetter)).toEqual({ ok: false });
    expect(writePreferences({ desktop: "on", sound: "on" }, throwingGetter)).toEqual({ ok: false });
    expect(readPreferences(() => undefined)).toEqual({ ok: false });
    expect(writePreferences({ desktop: "on", sound: "on" }, () => undefined)).toEqual({ ok: false });
    const broken: StorageLike = {
      getItem: () => {
        throw securityError();
      },
      setItem: () => {
        throw securityError();
      },
    };
    expect(readPreferences(() => broken)).toEqual({ ok: false });
    expect(writePreferences({ desktop: "on", sound: "on" }, () => broken)).toEqual({ ok: false });
  });

  // Issue #16: the alert preferences, under a key of their own.
  test("the preferences: defaults when nothing or something unreadable is stored, and a written value read back", () => {
    const store = memory();
    expect(readPreferences(() => store)).toEqual({ ok: true, value: defaultPreferences });
    expect(writePreferences({ desktop: "on", sound: "off" }, () => store)).toEqual({ ok: true, value: undefined });
    expect(readPreferences(() => store)).toEqual({ ok: true, value: { desktop: "on", sound: "off" } });
    for (const unreadable of ["not json", "null", "[]", '{"desktop":"yes","sound":"off"}', '{"desktop":"on"}']) {
      store.items.set("interloq.alerts", unreadable);
      expect(readPreferences(() => store)).toEqual({ ok: true, value: defaultPreferences });
    }
  });

  test("a throwing or absent storage is a failure for the preferences too, not an exception", () => {
    const throwingGetter = () => {
      throw securityError();
    };
    const broken: StorageLike = {
      getItem: () => {
        throw securityError();
      },
      setItem: () => {
        throw securityError();
      },
    };
    for (const acquire of [throwingGetter, () => undefined, () => broken]) {
      expect(readPreferences(acquire)).toEqual({ ok: false });
      expect(writePreferences(defaultPreferences, acquire)).toEqual({ ok: false });
    }
  });
});

// Issue #221: the live panel's dragged height, remembered per browser.
describe("the panel's remembered height", () => {
  const lines = (n: number) => Result.getOrThrow(panelLinesOf(n));
  test("a height written is read back, under its own key", () => {
    const m = memory();
    expect(writePanelLines(lines(20), () => m)).toEqual({ ok: true, value: undefined });
    expect(m.items.get("interloq.livePanel")).toBe(JSON.stringify({ lines: 20 }));
    expect(readPanelLines(() => m)).toEqual({ ok: true, value: 20 });
  });

  test("nothing stored, garbage and a height out of range read as the default", () => {
    const m = memory();
    expect(readPanelLines(() => m)).toEqual({ ok: true, value: PANEL_LINES });
    for (const text of ["{", "[]", "null", JSON.stringify({ lines: 100 }), JSON.stringify({ lines: "12" }), JSON.stringify({ lines: 2.5 })]) {
      m.items.set("interloq.livePanel", text);
      expect(readPanelLines(() => m)).toEqual({ ok: true, value: PANEL_LINES });
    }
  });

  test("a throwing storage is a failure, not an exception", () => {
    const throwing = () => {
      throw securityError();
    };
    expect(readPanelLines(throwing)).toEqual({ ok: false });
    expect(writePanelLines(lines(12), throwing)).toEqual({ ok: false });
  });
});

// Issue #204: the run's column widths, remembered per browser, each field decoded on its own.
describe("the remembered column widths", () => {
  const widths = (rail: number, left: number) => ({ rail: Result.getOrThrow(railRemOf(rail)), left: Result.getOrThrow(leftPercentOf(left)) });
  test("widths written are read back, under their own key", () => {
    const m = memory();
    expect(writeColumnWidths(widths(20, 60), () => m)).toEqual({ ok: true, value: undefined });
    expect(m.items.get("interloq.columns")).toBe(JSON.stringify({ rail: 20, left: 60 }));
    expect(readColumnWidths(() => m)).toEqual({ ok: true, value: { rail: 20, left: 60 } });
  });

  test("nothing stored and garbage read as the defaults; a broken field takes its own default", () => {
    const m = memory();
    expect(readColumnWidths(() => m)).toEqual({ ok: true, value: DEFAULT_COLUMN_WIDTHS });
    for (const text of ["{", "[]", "null", "7"]) {
      m.items.set("interloq.columns", text);
      expect(readColumnWidths(() => m)).toEqual({ ok: true, value: DEFAULT_COLUMN_WIDTHS });
    }
    m.items.set("interloq.columns", JSON.stringify({ rail: 40, left: 50 }));
    expect(readColumnWidths(() => m)).toEqual({ ok: true, value: { rail: 14, left: 50 } });
    m.items.set("interloq.columns", JSON.stringify({ rail: 20, left: "x" }));
    expect(readColumnWidths(() => m)).toEqual({ ok: true, value: { rail: 20, left: 50 } });
  });

  test("a throwing storage is a failure, not an exception", () => {
    const throwing = () => {
      throw securityError();
    };
    const broken: StorageLike = {
      getItem: () => {
        throw securityError();
      },
      setItem: () => {
        throw securityError();
      },
    };
    for (const acquire of [throwing, () => broken]) {
      expect(readColumnWidths(acquire)).toEqual({ ok: false });
      expect(writeColumnWidths(widths(14, 50), acquire)).toEqual({ ok: false });
    }
  });
});
