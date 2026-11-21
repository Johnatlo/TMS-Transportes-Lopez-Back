import { describe, expect, test } from "vitest";
import { fleteConductorEn, liquidarConductor, nombreComparable, producidoConductor, saldoCuenta, saldoPrestamo, totalGastos } from "./calculoConductores";

const fletes = [
  { tarifaFleteId: 9, valor: 100_000, tipo: "TON" as const, desde: "1999-04-01" }, // BODEGAS
  { tarifaFleteId: 17, valor: 4_200_000, tipo: "FIJO" as const, desde: "1999-04-01" }, // CORAME
  { tarifaFleteId: 17, valor: 4_400_000, tipo: "FIJO" as const, desde: "2026-11-01" },
];

describe("producido conductor (matriz de fletes conductor)", () => {
  test("por tonelada: valor x toneladas reales (SWK-973, BODEGAS 33,6 t x 100.000 = 3.360.000)", () => {
    expect(producidoConductor({ fecha: "2026-09-30", tarifaFleteId: 9, pesoKg: 33_600 }, fletes)).toBe(3_360_000);
  });
  test("fijo por viaje, con el valor vigente en la fecha del viaje", () => {
    expect(producidoConductor({ fecha: "2026-10-20", tarifaFleteId: 17, pesoKg: 34_000 }, fletes)).toBe(4_200_000);
    expect(producidoConductor({ fecha: "2026-11-02", tarifaFleteId: 17, pesoKg: 34_000 }, fletes)).toBe(4_400_000);
    expect(fleteConductorEn(fletes, 17, "1990-01-01")).toBeNull();
  });
  test("escrito a mano manda; sin tarifa o sin peso no hay valor", () => {
    expect(producidoConductor({ fecha: "2026-10-20", tarifaFleteId: 17, pesoKg: 1 }, fletes, 8_500_000)).toBe(8_500_000);
    expect(producidoConductor({ fecha: "2026-10-20", tarifaFleteId: null, pesoKg: 34_000 }, fletes)).toBeNull();
    expect(producidoConductor({ fecha: "2026-10-20", tarifaFleteId: 9, pesoKg: null }, fletes)).toBeNull();
  });
});

describe("cuenta de viaje (la hoja del conductor)", () => {
  test("hoja del 24/09: gastos 3.238.241 y recibido 3.990.041 + 500.000: el conductor debe 1.251.800 (el rojo)", () => {
    const gastos = totalGastos({
      acpm: 1_990_041,
      peajes: 726_500,
      cargue: 100_000,
      descargue: 80_000,
      parqueo: 16_700,
      lavada: 150_000,
      comision: 35_000,
      propinas: 50_000,
      arreglos: 25_000,
      accesorios: 65_000,
    });
    expect(gastos).toBe(3_238_241);
    expect(saldoCuenta(gastos, 3_990_041 + 500_000)).toBe(-1_251_800);
  });
  test("sin anticipo: la empresa le debe todo lo gastado (hoja del 26/09: 951.900)", () => {
    expect(saldoCuenta(totalGastos({ peajes: 723_900, cargue: 70_000, descargue: 103_000, parqueo: 30_000, propinas: 25_000 }), 0)).toBe(951_900);
  });
  test("los gastos sin concepto claro (los 70.000 del cuadro) van en otros y suman igual", () => {
    expect(totalGastos({ acpm: 2_000_000, otros: -70_000 })).toBe(1_930_000);
  });
});

describe("prestamos y liquidacion del mes", () => {
  test("saldo del prestamo: monto menos lo descontado", () => {
    expect(saldoPrestamo(1_800_000, [600_000, 600_000])).toBe(600_000);
  });
  test("SWK-973 octubre: % sobre el producido conductor, saldo de cuentas y prestamo", () => {
    const viajes = [
      { producido: 3_360_000, saldo: 40_500 },
      { producido: 8_500_000, saldo: -1_398_502 },
      { producido: 4_750_000, saldo: -455_800 },
      { producido: null, saldo: null },
    ];
    const l = liquidarConductor({
      viajes,
      pctSalarial: 4,
      pctViaticos: 5,
      nomina: { devengado: 3_000_000, deducciones: 200_000, neto: 2_800_000 },
      prestamos: 600_000,
    });
    expect(l).toMatchObject({
      viajes: 4,
      producido: 16_610_000,
      viajesSinProducido: 1,
      salarial: 664_400,
      viaticos: 830_500,
      saldoCuentas: -1_813_802,
      viajesSinCuenta: 1,
    });
    expect(l.totalAPagar).toBe(2_800_000 - 1_813_802 - 600_000);
    expect(liquidarConductor({ viajes, pctSalarial: 4, pctViaticos: 5, nomina: null, prestamos: 0 }).totalAPagar).toBeNull();
  });
  test("nombres de la matriz comparables (CORAME = corame)", () => {
    expect(nombreComparable("Porcelatino B/Ventura Bgta")).toBe("PORCELATINO B VENTURA BGTA");
  });
});
