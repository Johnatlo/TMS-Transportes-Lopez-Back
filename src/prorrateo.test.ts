import { describe, expect, test } from "vitest";
import { aCentavos, amortizar, aPesos, causaciones, causacionesPorDias, gmfDe, tasaImplicita, ErrorReparto, repartir, repartirGasto, sumarMeses } from "./prorrateo";
import type { Destino } from "./prorrateo";

/** N vehiculos marcados (una parte cada uno), con ids desde `desde`. */
const carros = (n: number, desde = 1): Destino[] => Array.from({ length: n }, (_, i) => ({ tipo: "VEHICULO", id: desde + i, modo: "PARTE", valor: 1 }));
const suma = (xs: Array<{ monto: number }>) => xs.reduce((s, x) => s + x.monto, 0);

describe("repartir", () => {
  test("la suma siempre da el total (los centavos sobrantes se reparten)", () => {
    const partes = repartir(aCentavos(1_000_000), Array(14).fill(1));
    expect(partes.reduce((s, p) => s + p, 0)).toBe(aCentavos(1_000_000));
    expect(Math.max(...partes) - Math.min(...partes)).toBeLessThanOrEqual(1);
  });
});

describe("repartirGasto con los casos del Excel de gastos", () => {
  test("credito 80 millones entre 12 carros: 2.122.647 / 12 = 176.887 por carro", () => {
    const r = repartirGasto(aCentavos(2_122_647), carros(12));
    expect(r).toHaveLength(12);
    expect(aPesos(r[0].monto)).toBeCloseTo(176_887.25, 2);
    expect(suma(r)).toBe(aCentavos(2_122_647));
  });

  test("grupos distintos: el mismo gasto entre 12, 13 o 14 carros", () => {
    expect(aPesos(repartirGasto(aCentavos(3_500_000), carros(14))[0].monto)).toBe(250_000);
    expect(repartirGasto(aCentavos(3_500_000), carros(13))).toHaveLength(13);
    expect(suma(repartirGasto(aCentavos(3_500_000), carros(13)))).toBe(aCentavos(3_500_000));
  });

  test("Miller paga dos partes porque tiene dos carros: honorarios (3.500.000 / 14) x 2 = 500.000", () => {
    // SKX-202 = id 1 y SZP-339 = id 2 son de Miller.
    const r = repartirGasto(aCentavos(3_500_000), carros(14));
    expect(aPesos(r[0].monto + r[1].monto)).toBe(500_000);
  });

  test("un gasto que no tiene un vehiculo (Bridgestone sin la SZX-826): solo se marcan los demas", () => {
    const sin826 = carros(14).filter((d) => d.id !== 7);
    const r = repartirGasto(aCentavos(1_300_000), sin826);
    expect(r.some((p) => p.id === 7)).toBe(false);
    expect(aPesos(r[0].monto)).toBe(100_000);
  });

  test("cuota Luisa solo entre Miller y Mauricio (partes directas a dos socios)", () => {
    const r = repartirGasto(aCentavos(250_000), [
      { tipo: "SOCIO", id: 1, modo: "PARTE", valor: 1 },
      { tipo: "SOCIO", id: 3, modo: "PARTE", valor: 1 },
    ]);
    expect(r.map((p) => aPesos(p.monto))).toEqual([125_000, 125_000]);
  });

  test("credito Chelo: 536.264 fijos a Celso y el resto (4.192.625) entre 13 carros = 322.510", () => {
    const r = repartirGasto(aCentavos(4_728_889), [{ tipo: "SOCIO", id: 2, modo: "FIJO", valor: 536_264 }, ...carros(13)]);
    expect(aPesos(r.find((p) => p.tipo === "SOCIO")!.monto)).toBe(536_264);
    const porCarro = r.filter((p) => p.tipo === "VEHICULO").map((p) => aPesos(p.monto));
    expect(porCarro).toHaveLength(13);
    expect(Math.round(porCarro[0])).toBe(322_510);
    expect(suma(r)).toBe(aCentavos(4_728_889));
  });

  test("porcentaje directo: 11,34 % a un socio y el resto a los carros", () => {
    const r = repartirGasto(aCentavos(1_000_000), [{ tipo: "SOCIO", id: 2, modo: "PORCENTAJE", valor: 11.34 }, ...carros(2)]);
    expect(r.map((p) => aPesos(p.monto))).toEqual([113_400, 443_300, 443_300]);
  });

  test("gasto adicional de un socio: todo a el", () => {
    expect(repartirGasto(aCentavos(1_583_000), [{ tipo: "SOCIO", id: 1, modo: "PARTE", valor: 1 }])).toEqual([
      { tipo: "SOCIO", id: 1, monto: aCentavos(1_583_000) },
    ]);
  });

  test("errores: sin destinos, lo fijo pasa del total, o queda algo sin repartir", () => {
    expect(() => repartirGasto(aCentavos(100), [])).toThrow(ErrorReparto);
    expect(() => repartirGasto(aCentavos(100), [{ tipo: "SOCIO", id: 1, modo: "FIJO", valor: 200 }])).toThrow(/mas que el valor/);
    expect(() => repartirGasto(aCentavos(100), [{ tipo: "SOCIO", id: 1, modo: "FIJO", valor: 40 }])).toThrow(/Faltan 60/);
  });
});

describe("causaciones", () => {
  test("un seguro anual se causa en 12 cuotas mensuales que suman el total", () => {
    const c = causaciones(aCentavos(10_000_000), "2026-10-15", 12);
    expect(c).toHaveLength(12);
    expect([c[0].fecha, c[3].fecha, c[11].fecha]).toEqual(["2026-10-15", "2027-01-15", "2027-09-15"]);
    expect(suma(c)).toBe(aCentavos(10_000_000));
  });

  test("fin de mes: el 31 pasa al ultimo dia de los meses cortos", () => {
    expect([sumarMeses("2026-10-31", 1), sumarMeses("2027-01-31", 1), sumarMeses("2026-12-20", 1)]).toEqual(["2026-11-30", "2027-02-28", "2027-01-20"]);
  });
});

describe("amortizar", () => {
  test("credito 80 millones, 60 cuotas desde 20/01/2023 con cuota 2.122.647: saldo siempre visible y termina en cero", () => {
    // 1,6725 % mensual es la tasa que da esa cuota.
    const t = amortizar(aCentavos(80_000_000), 0.016725, 60, "2023-01-20", aCentavos(2_122_647));
    expect(t).toHaveLength(60);
    expect([t[0].fecha, t[59].fecha]).toEqual(["2023-01-20", "2027-12-20"]);
    expect(aPesos(t[0].interes)).toBe(1_338_000);
    expect(aPesos(t[0].capital)).toBe(784_647);
    expect(aPesos(t[0].saldo)).toBe(79_215_353);
    expect(t[59].saldo).toBe(0);
    expect(t.reduce((s, c) => s + c.capital, 0)).toBe(aCentavos(80_000_000));
    // La ultima cuota se ajusta a lo que quede (unos pesos de diferencia con la fija).
    expect(Math.abs(aPesos(t[59].cuota) - 2_122_647)).toBeLessThan(2_000);
  });

  test("sin cuota fija la calcula con la tasa (queda a pocos pesos de la del banco)", () => {
    const t = amortizar(aCentavos(80_000_000), 0.016725, 60, "2023-01-20");
    expect(Math.abs(aPesos(t[0].cuota) - 2_122_647)).toBeLessThan(200);
  });

  test("36 cuotas desde el 30 de octubre: febrero cae el 28", () => {
    const t = amortizar(aCentavos(200_000_000), 0.015, 36, "2024-10-30");
    expect([t[0].fecha, t[4].fecha, t[35].fecha]).toEqual(["2024-10-30", "2025-02-28", "2027-09-30"]);
    expect(t[35].saldo).toBe(0);
  });

  test("tasa cero: solo capital", () => {
    const t = amortizar(aCentavos(1_200_000), 0, 12, "2026-10-01");
    expect(t.every((c) => c.interes === 0 && aPesos(c.capital) === 100_000)).toBe(true);
  });
});

describe("causaciones por dias (nomina)", () => {
  test("nomina del 21/10 al 20/11: 11 dias a octubre y 20 a noviembre", () => {
    const c = causacionesPorDias(aCentavos(3_100_000), "2026-10-21", "2026-11-20");
    expect(c.map((x) => [x.fecha, aPesos(x.monto)])).toEqual([
      ["2026-10-21", 1_100_000],
      ["2026-11-01", 2_000_000],
    ]);
  });
  test("un mes completo queda en una sola causacion; tres meses suman exacto", () => {
    expect(causacionesPorDias(100_00, "2026-11-01", "2026-11-30")).toEqual([{ fecha: "2026-11-01", monto: 100_00 }]);
    const c = causacionesPorDias(1_000_001, "2026-12-15", "2027-02-10");
    expect(c.map((x) => x.fecha)).toEqual(["2026-12-15", "2027-01-01", "2027-02-01"]);
    expect(c.reduce((s, x) => s + x.monto, 0)).toBe(1_000_001);
  });
  test("periodo al reves: error", () => {
    expect(() => causacionesPorDias(100, "2026-11-20", "2026-10-21")).toThrow();
  });
});

describe("costo de un conductor entre sus vehiculos segun su producido", () => {
  test("Ferney octubre: 726.158 de prestaciones entre SZX-880 (31.107.800) y SOR-429 (8.281.664), como la hoja FERNEY", () => {
    const partes = repartirGasto(aCentavos(726_158), [
      { tipo: "VEHICULO", id: 1, modo: "PARTE", valor: 31_107_800 },
      { tipo: "VEHICULO", id: 2, modo: "PARTE", valor: 8_281_664 },
    ]);
    // Proporcional al producido (78,97 % y 21,03 %). El Excel da 577.400 y 148.758 porque reparte cada concepto con otra proporcion.
    expect(partes.map((x) => Math.round(aPesos(x.monto)))).toEqual([573_483, 152_675]);
    expect(partes.reduce((s, x) => s + x.monto, 0)).toBe(aCentavos(726_158));
  });
});

describe("tasa que da la cuota del banco y 4 x 1000 de la cuota", () => {
  test("credito 80M a 60 cuotas de 2.122.647: 1,6725 % mensual (la tabla queda igual que con la tasa escrita)", () => {
    const t = tasaImplicita(80_000_000, 60, 2_122_647);
    expect(Math.round(t * 1_000_000) / 10_000).toBe(1.6725);
    const tabla = amortizar(aCentavos(80_000_000), t, 60, "2023-01-20", aCentavos(2_122_647));
    expect([aPesos(tabla[0].interes), aPesos(tabla[0].capital), aPesos(tabla.at(-1)!.saldo)]).toEqual([1_338_000, 784_647, 0]);
  });
  test("sin interes y cuota que no alcanza", () => {
    expect(tasaImplicita(1_200_000, 12, 100_000)).toBe(0);
    expect(() => tasaImplicita(1_200_000, 12, 90_000)).toThrow();
  });
  test("4 x 1000 de la cuota de 2.122.647: 8.491", () => {
    expect(aPesos(gmfDe(aCentavos(2_122_647), 4))).toBe(8_491);
  });
});
