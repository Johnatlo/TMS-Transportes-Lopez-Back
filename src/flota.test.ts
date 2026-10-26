import { describe, expect, it } from "vitest";
import { NIT_MYC, sqlFlota } from "./flota";

describe("sqlFlota", () => {
  it("respeta la flota escrita y deduce la propia por el NIT de M&C", () => {
    const sql = sqlFlota("x");
    expect(sql).toContain("WHEN x.flota IN ('LOPEZ', 'MYC') THEN x.flota");
    expect(sql).toContain(`'${NIT_MYC}' IN (LEFT(REGEXP_REPLACE(COALESCE(x.propietarioNit, '')`);
    expect(sql).toContain("ELSE 'TERCERO' END");
  });
});
