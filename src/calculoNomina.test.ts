import { describe, expect, test } from "vitest";
import { calcularLinea, diasPeriodo, pila } from "./calculoNomina";
import type { EntradaLinea, ParametrosNomina } from "./calculoNomina";

/** Parametros 2026 del Excel. */
const P2026: ParametrosNomina = {
  anio: 2026,
  smmlv: 1_750_905,
  auxilioTransporte: 249_095,
  pensionEmpleador: 12,
  saludEmpleador: 0,
  arl: [0.522, 1.044, 2.436, 4.35, 6.96],
  caja: 4,
  prima: 8.33,
  cesantias: 8.33,
  interesesCesantias: 12,
  vacaciones: 4.17,
  saludEmpleado: 4,
  pensionEmpleado: 4,
  limiteNoSalarial: 40,
};
const CONDUCTOR: EntradaLinea = {
  salarioBase: null,
  salarioAdicional: 0,
  pctSalarial: 4,
  pctViaticos: 5,
  auxilio: false,
  riesgoArl: 4,
  dias: 30,
  producido: 0,
  ajuste: 0,
};
const OFICINA: EntradaLinea = { ...CONDUCTOR, pctSalarial: 0, pctViaticos: 0, riesgoArl: 1 };

describe("nomina Oct-Nov 2026 (Excel Modelo Nomina)", () => {
  test("Julian Rodriguez, conductor, producido 27.713.800", () => {
    const r = calcularLinea({ ...CONDUCTOR, producido: 27_713_800 }, P2026);
    expect([r.basico, r.variable, r.viaticos, r.salarial, r.devengado]).toEqual([1_750_905, 1_108_552, 1_385_690, 2_859_457, 4_245_147]);
    // Aportes redondeados como en el Excel (columnas J, L, O, Q, S).
    expect([r.saludEmpleado, r.pensionEmpleado, r.pensionEmpleador, r.saludEmpleador, r.arl, r.caja]).toEqual([114_400, 114_400, 343_200, 0, 124_400, 114_400]);
    expect([r.prima, r.cesantias, r.interesesCesantias, r.vacaciones]).toEqual([238_192.77, 238_192.77, 28_583.13, 119_239.36]);
    expect(r.neto).toBe(4_016_347);
    expect(r.costoEmpleador).toBe(1_206_208.03);
    expect(r.costoTotal).toBe(5_451_355.03);
  });

  test("Karen Tamara, oficina riesgo I: el costo real es 671.715,57 (el Excel suma 961.100 porque cuenta pension, ARL y caja dos veces)", () => {
    const r = calcularLinea(OFICINA, P2026);
    expect([r.pensionEmpleador, r.arl, r.caja, r.prima, r.interesesCesantias, r.vacaciones]).toEqual([
      210_200, 9_200, 70_100, 145_850.39, 17_502.05, 73_012.74,
    ]);
    expect(r.costoEmpleador).toBe(671_715.57);
    expect(r.neto).toBe(1_610_705);
  });

  test("Victor Beltran trabajo 12 dias: basico 700.362", () => {
    const r = calcularLinea({ ...CONDUCTOR, dias: 12, producido: 15_150_000 }, P2026);
    expect([r.basico, r.variable, r.viaticos, r.salarial]).toEqual([700_362, 606_000, 757_500, 1_306_362]);
    expect([r.pensionEmpleador, r.arl, r.prima]).toEqual([156_800, 56_900, 108_819.95]);
  });

  test("Leidy Gomez: minimo + 200.000", () => {
    const r = calcularLinea({ ...OFICINA, salarioAdicional: 200_000 }, P2026);
    expect([r.salarial, r.pensionEmpleador, r.arl, r.prima, r.vacaciones]).toEqual([1_950_905, 234_200, 10_200, 162_510.39, 81_352.74]);
  });

  test("Jorge Malagon con los ajustes del Excel (+100 pension, -15.200 ARL, -14.000 caja) en el campo de ajuste", () => {
    const sin = calcularLinea({ ...CONDUCTOR, producido: 47_888_200 }, P2026);
    expect([sin.salarial, sin.viaticos, sin.pensionEmpleador, sin.arl, sin.caja]).toEqual([3_666_433, 2_394_410, 440_000, 159_500, 146_700]);
    const con = calcularLinea({ ...CONDUCTOR, producido: 47_888_200, ajuste: 100 - 15_200 - 14_000 }, P2026);
    expect(con.costoEmpleador).toBe(sin.costoEmpleador - 29_100);
    // En el Excel: 440.100 + 144.300 + 132.700 = 717.100 en aportes redondeados del empleador.
    expect(sin.pensionEmpleador + sin.arl + sin.caja + con.ajuste).toBe(717_100);
  });
});

describe("reglas", () => {
  test("auxilio de transporte solo hasta 2 minimos y proporcional a los dias", () => {
    expect(calcularLinea({ ...OFICINA, auxilio: true }, P2026).auxilio).toBe(249_095);
    expect(calcularLinea({ ...OFICINA, auxilio: true, dias: 15 }, P2026).auxilio).toBe(124_547.5);
    expect(calcularLinea({ ...CONDUCTOR, auxilio: true, producido: 47_888_200 }, P2026).auxilio).toBe(0);
    // El auxilio entra a prima y cesantias, no a vacaciones.
    const r = calcularLinea({ ...OFICINA, auxilio: true }, P2026);
    expect([r.prima, r.vacaciones]).toEqual([166_600, 73_012.74]);
  });

  test("viaticos por encima del 40 % del total entran al IBC (Ley 1393)", () => {
    // Producido alto con 30 % de viaticos: 1.750.905 + 4 % y 30 % de 10M.
    const r = calcularLinea({ ...CONDUCTOR, pctViaticos: 30, producido: 10_000_000 }, P2026);
    const total = r.salarial + r.viaticos;
    expect(r.ibc).toBe(Math.round((r.salarial + r.viaticos - total * 0.4) * 100) / 100);
    // Ninguno de los conductores del Excel pasa el limite: su IBC es el salarial.
    expect(calcularLinea({ ...CONDUCTOR, producido: 47_888_200 }, P2026).ibc).toBe(3_666_433);
  });

  test("redondeo PILA hacia arriba a la centena", () => {
    expect([pila(70_036.2), pila(70_100), pila(0), pila(343_134.84)]).toEqual([70_100, 70_100, 0, 343_200]);
  });

  test("dias del periodo en mes comercial", () => {
    expect([
      diasPeriodo("2026-10-21", "2026-11-20"),
      diasPeriodo("2026-11-01", "2026-11-30"),
      diasPeriodo("2026-02-01", "2026-02-28"),
      diasPeriodo("2026-11-10", "2026-11-20"),
    ]).toEqual([30, 30, 28, 11]);
  });
});
