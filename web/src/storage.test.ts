import { describe, expect, test } from "vitest";
import { defaultPreferences } from "./notify.ts";
import { readPreferences, readRemembered, remember, type StorageLike, writePreferences } from "./storage.ts";

// Finding 3 of docs/gui-review.md: the storage edge returns typed results; nothing it does can throw.
const memory = (): StorageLike & { items: Map<string, string> } => {
  const items = new Map<string, string>();
  return { items, getItem: (k) => items.get(k) ?? null, setItem: (k, v) => void items.set(k, v) };
};
const securityError = () => new DOMException("access denied", "SecurityError");

describe("storage", () => {
  test("a remembered path is read back; nothing remembered reads as the empty string", () => {
    const store = memory();
    expect(readRemembered(() => store)).toEqual({ ok: true, value: "" });
    expect(remember("/work/p", () => store)).toEqual({ ok: true, value: undefined });
    expect(readRemembered(() => store)).toEqual({ ok: true, value: "/work/p" });
  });

  test("a throwing acquisition, getItem or setItem, and absent storage, are failures, not exceptions", () => {
    const throwingGetter = () => {
      throw securityError();
    };
    expect(readRemembered(throwingGetter)).toEqual({ ok: false });
    expect(remember("/p", throwingGetter)).toEqual({ ok: false });
    expect(readRemembered(() => undefined)).toEqual({ ok: false });
    expect(remember("/p", () => undefined)).toEqual({ ok: false });
    const broken: StorageLike = {
      getItem: () => {
        throw securityError();
      },
      setItem: () => {
        throw securityError();
      },
    };
    expect(readRemembered(() => broken)).toEqual({ ok: false });
    expect(remember("/p", () => broken)).toEqual({ ok: false });
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

  test("the preferences and the remembered project do not disturb each other", () => {
    const store = memory();
    remember("/work/p", () => store);
    writePreferences({ desktop: "off", sound: "on" }, () => store);
    expect(readRemembered(() => store)).toEqual({ ok: true, value: "/work/p" });
    remember("/work/q", () => store);
    expect(readPreferences(() => store)).toEqual({ ok: true, value: { desktop: "off", sound: "on" } });
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
