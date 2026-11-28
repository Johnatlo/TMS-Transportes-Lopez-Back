import { describe, expect, test } from "vitest";
import {
  esIntegro,
  fleteConductorEn,
  liquidarConductor,
  mesConductores,
  mesesDelViaje,
  periodoConductores,
  problemaAlMover,
  tarifaConductorDeducida,
  nombreComparable,
  producidoConductor,
  saldoCuenta,
  saldoPrestamo,
  tipoFleteConductor,
  totalGastos,
} from "./calculoConductores";

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

describe("flete conductor INTEGRO", () => {
  const conUrbano = [...fletes, { tarifaFleteId: 40, valor: 200_000, tipo: "INTEGRO" as const, desde: "1999-04-01" }]; // ABURRA URBANO
  test("vale el valor por viaje (como fijo) y se marca integro", () => {
    expect(producidoConductor({ fecha: "2026-10-05", tarifaFleteId: 40, pesoKg: 8_000 }, conUrbano)).toBe(200_000);
    expect(esIntegro({ fecha: "2026-10-05", tarifaFleteId: 40 }, conUrbano)).toBe(true);
    expect(esIntegro({ fecha: "2026-10-05", tarifaFleteId: 17 }, conUrbano)).toBe(false);
  });

  test("el tipo se lee del Excel con o sin tilde", () => {
    expect(["integro", "Íntegro", "FIJO", "ton", ""].map(tipoFleteConductor)).toEqual(["INTEGRO", "INTEGRO", "FIJO", "TON", "TON"]);
  });

  test("liquidacion: el integro no va al %, se paga completo", () => {
    const l = liquidarConductor({
      viajes: [
        { producido: 4_200_000, saldo: null },
        { producido: 200_000, saldo: null, integro: true },
      ],
      pctSalarial: 4,
      pctViaticos: 5,
      nomina: null,
      prestamos: 0,
    });
    expect([l.producido, l.integro]).toEqual([4_200_000, 200_000]);
    expect(l.salarial + l.viaticos).toBeCloseTo(4_200_000 * 0.09 + 200_000, 2);
  });
});

describe("corte de las cuentas de los conductores (del 27 al 26)", () => {
  test("el periodo de un mes va del 27 del mes anterior al 26", () => {
    expect(periodoConductores("2026-11")).toEqual({ desde: "2026-10-27", hasta: "2026-11-26" });
    expect(periodoConductores("2026-01")).toEqual({ desde: "2025-12-27", hasta: "2026-01-26" });
    expect(periodoConductores("2026-03")).toEqual({ desde: "2026-02-27", hasta: "2026-03-26" });
  });

  test("un viaje despues del 26 cuenta en el mes siguiente", () => {
    expect(mesConductores("2026-11-26")).toBe("2026-11");
    expect(mesConductores("2026-11-27")).toBe("2026-12");
    expect(mesConductores("2026-11-30")).toBe("2026-12");
    expect(mesConductores("2026-12-28")).toBe("2027-01");
    expect(mesConductores("2026-11-01")).toBe("2026-11");
  });
});

describe("flete conductor de los viajes sin tarifa en el Cuadro", () => {
  const fletes = [
    { tarifaFleteId: 300, valor: 120000, tipo: "FIJO" as const, desde: "2026-01-01" },
    { tarifaFleteId: 425, valor: 90000, tipo: "FIJO" as const, desde: "2026-01-01" },
    { tarifaFleteId: 426, valor: 90000, tipo: "FIJO" as const, desde: "2026-01-01" },
    { tarifaFleteId: 427, valor: 95000, tipo: "FIJO" as const, desde: "2026-01-01" },
  ];

  test("la tarifa exacta que deduce el Cuadro", () => {
    expect(tarifaConductorDeducida("2026-11-10", 300, [], fletes)).toBe(300);
  });

  test("varias posibles con el mismo flete conductor: sirve cualquiera", () => {
    expect(tarifaConductorDeducida("2026-11-10", null, [425, 426], fletes)).toBe(425);
  });

  test("varias posibles con distinto valor, alguna sin valor o ninguna: no se sabe", () => {
    expect(tarifaConductorDeducida("2026-11-10", null, [425, 427], fletes)).toBeNull();
    expect(tarifaConductorDeducida("2026-11-10", null, [425, 999], fletes)).toBeNull();
    expect(tarifaConductorDeducida("2026-11-10", null, [], fletes)).toBeNull();
    // Antes de que rija el valor, tampoco.
    expect(tarifaConductorDeducida("2025-12-31", null, [425, 426], fletes)).toBeNull();
  });
});

describe("pasar un viaje a la liquidacion de otro mes", () => {
  test("solo a su mes o a los vecinos (por el corte del 27 al 26)", () => {
    expect(mesesDelViaje("2026-10-28")).toEqual({ anterior: "2026-10", suyo: "2026-11", siguiente: "2026-12" });
    expect(mesesDelViaje("2026-12-30")).toEqual({ anterior: "2026-12", suyo: "2027-01", siguiente: "2027-02" });
  });

  test("el viaje del 28/10 que ya se pago en octubre se puede sacar de noviembre aunque octubre este liquidado", () => {
    expect(problemaAlMover("2026-11", "2026-10", new Set(["2026-10"]))).toBeNull();
  });

  test("no se saca de una liquidacion hecha ni se pasa a una posterior ya hecha", () => {
    expect(problemaAlMover("2026-11", "2026-10", new Set(["2026-11"]))).toMatch(/2026-11.*quitala primero para sacar/);
    expect(problemaAlMover("2026-11", "2026-12", new Set(["2026-12"]))).toMatch(/2026-12.*quitala primero para pasarle/);
    expect(problemaAlMover("2026-11", "2026-11", new Set(["2026-11"]))).toBeNull();
  });
});
