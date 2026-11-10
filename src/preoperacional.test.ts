import { describe, expect, test, vi } from "vitest";

vi.mock("./db", () => ({ pool: {} }));

import { mismoConductor, placaComparable } from "./preoperacional";

describe("preoperacional", () => {
  test("el mismo conductor aunque el nombre venga distinto", () => {
    expect(mismoConductor("MAURICIO LOPEZ CUENCA", "CELSO MAURICIO LÓPEZ CUENCA")).toBe(true);
    expect(mismoConductor("VICTOR MANUEL BELTRAN ", "victor manuel beltran")).toBe(true);
    expect(mismoConductor("MAURICIO LOPEZ CUENCA", "VICTOR MANUEL BELTRAN")).toBe(false);
    expect(mismoConductor("", "VICTOR")).toBe(false);
  });

  test("placa sin guion", () => {
    expect(placaComparable("jty-219")).toBe("JTY219");
    expect(placaComparable(" SZX 826 ")).toBe("SZX826");
  });
});
