import { beforeEach, describe, expect, it, vi } from "vitest";
import { withProfile, activeProfileId } from "./profile-context";

const state = vi.hoisted(() => ({ fail: false, stores: [] as unknown[] }));
vi.mock("./profiles", () => ({ activeProfile: async () => ({ id: await activeProfileId(), name: "Test" }) }));
vi.mock("./db", () => ({ getDb: () => async () => [] }));
vi.mock("./profile-database", () => ({ profileSql: () => Object.assign(async () => [], { json: (v: unknown) => v }) }));
vi.mock("garmin-auth", () => ({
  DBTokenStore: class { constructor(readonly url: string) {} },
  GarminAuth: class {
    constructor(readonly options: { store: unknown }) {}
    async client() {
      state.stores.push(this.options.store);
      if (state.fail) { state.fail = false; throw new Error("Expired token"); }
      return { store: this.options.store };
    }
  },
}));
import { DBTokenStore } from "garmin-auth";
import { getGarminClient, resetGarminClient } from "./garmin-upload";

const first = "default";
const second = "9b1b9af0-ddc8-4e4b-8209-4d436f93bb0e";
beforeEach(() => { resetGarminClient(); state.stores.length = 0; state.fail = false; });

describe("cached Garmin clients belong to one profile", () => {
  it("never reuses one account's client for the other account", async () => {
    const a = await withProfile(first, () => getGarminClient("postgres://test"));
    const b = await withProfile(second, () => getGarminClient("postgres://test"));
    expect(a).not.toBe(b);
    expect(await withProfile(first, () => getGarminClient("postgres://test"))).toBe(a);
    expect(state.stores).toHaveLength(2);
    // The default profile keeps garmin-auth's own store; the added one reads its own schema.
    expect(state.stores[0]).toBeInstanceOf(DBTokenStore);
    expect(state.stores[1]).not.toBeInstanceOf(DBTokenStore);
    resetGarminClient(first);
    expect(await withProfile(second, () => getGarminClient("postgres://test"))).toBe(b);
    expect(await withProfile(first, () => getGarminClient("postgres://test"))).not.toBe(a);
  });

  it("does not cache a failed authentication attempt", async () => {
    state.fail = true;
    await expect(withProfile(second, () => getGarminClient("postgres://test"))).rejects.toThrow("Expired token");
    await expect(withProfile(second, () => getGarminClient("postgres://test"))).resolves.toBeTruthy();
  });
});
