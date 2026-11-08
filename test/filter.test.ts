import { describe, expect, it } from "vitest";
import { buildFilter } from "../src/filter.js";

describe("buildFilter", () => {
  it("returns undefined for no conditions", () => {
    expect(buildFilter([])).toBeUndefined();
  });

  it("joins plain conditions", () => {
    expect(
      buildFilter([
        { field: "IsPaid", op: "eq", value: false },
        { field: "DateOfMaturity", op: "lt", value: "2026-11-08" },
      ]),
    ).toBe("(IsPaid~eq~false~and~DateOfMaturity~lt~2026-11-08)");
  });

  it("base64-encodes text with special characters", () => {
    expect(buildFilter([{ field: "CompanyName", op: "ct", value: "Seyfor a.s." }])).toBe(
      `(CompanyName~ct:base64~${Buffer.from("Seyfor a.s.").toString("base64")})`,
    );
  });
});
