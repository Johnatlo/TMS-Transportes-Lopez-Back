import { describe, expect, test, vi } from "vitest";

vi.mock("./db", () => ({ pool: {} }));

import { totalesLiquidacion } from "./liquidacionDuenos";

describe("totalesLiquidacion", () => {
  // Como "Miller 01-07-26": viajes, conceptos y saldo pendiente.
  test("suma los viajes y los conceptos con su signo", () => {
    const t = totalesLiquidacion([{ saldo: 2_897_003 }, { saldo: 2_640_869 }, { saldo: 447_599 }], [{ valor: -1_085_576 }, { valor: 3_999_999.47 }, { valor: -3_400_000 }], null);
    expect(t.totalViajes).toBe(5_985_471);
    expect(t.total).toBe(5_499_894);
    expect([t.pagado, t.saldoPendiente]).toEqual([5_499_894, 0]);
  });

  test("lo que no se paga queda pendiente para la siguiente", () => {
    const t = totalesLiquidacion([{ saldo: 22_382_466 }], [], 18_382_466);
    expect(t.saldoPendiente).toBe(4_000_000);
  });

  test("con total negativo no se paga nada y el dueno queda debiendo", () => {
    const t = totalesLiquidacion([{ saldo: 100_000 }], [{ valor: -300_000 }], null);
    expect([t.total, t.pagado, t.saldoPendiente]).toEqual([-200_000, 0, -200_000]);
  });
});
