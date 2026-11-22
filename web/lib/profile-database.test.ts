import { describe, expect, it } from "vitest";
import { profileSchema } from "./profile-database";
import { profileName } from "./profiles";

describe("profile identifiers and settings", () => {
  it("leaves the existing account in public and gives a UUID its own schema", () => {
    expect(profileSchema("default")).toBe("public");
    expect(profileSchema("8b1b9af0-ddc8-4e4b-8209-4d436f93bb0e")).toBe("h2g_8b1b9af0ddc84e4b82094d436f93bb0e");
  });
  it("refuses names or SQL fragments as schema identifiers", () => {
    for (const value of ["", "public", "someone", "default,public", 'x"; DROP SCHEMA public']) {
      expect(() => profileSchema(value)).toThrow();
    }
  });
  it("validates and trims display names without using them as identifiers", () => {
    expect(profileName("  My profile  ")).toBe("My profile");
    for (const value of [null, " ", "x".repeat(81)]) expect(() => profileName(value)).toThrow();
  });
});
