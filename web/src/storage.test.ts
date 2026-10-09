import { describe, expect, test } from "vitest";
import { defaultPreferences } from "./notify.ts";
import { readPreferences, type StorageLike, writePreferences } from "./storage.ts";

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
