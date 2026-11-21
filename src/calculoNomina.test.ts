import { describe, expect, test } from "vitest";
import {
  calcularLinea,
  validarUpcs,
  CONCEPTOS_GASTO,
  diasPeriodo,
  diasPorVehiculo,
  errorReparto,
  gastoDeLinea,
  mesDe,
  pesosConductor,
  pila,
  porcentajesDe,
  producidoPorConductor,
} from "./calculoNomina";
import type { AsignacionVehiculo, EntradaLinea, ParametrosNomina, ViajeProducido } from "./calculoNomina";

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

describe("producido desde los viajes del sistema", () => {
  const SZX880 = 1;
  const SOR429 = 2;
  const SPI982 = 3;
  // Ferney manejo la SZX-880 hasta el 15/10 y desde el 16/10 la SOR-429; Julian la SPI-982 todo el mes.
  const asignaciones: AsignacionVehiculo[] = [
    { empleadoId: 10, vehiculoId: SZX880, desde: "2026-01-01", hasta: "2026-10-15" },
    { empleadoId: 10, vehiculoId: SOR429, desde: "2026-10-16", hasta: null },
    { empleadoId: 20, vehiculoId: SZX880, desde: "2026-10-16", hasta: null },
    { empleadoId: 30, vehiculoId: SPI982, desde: "2026-01-01", hasta: null },
  ];
  const viajes: ViajeProducido[] = [
    { id: 1, fecha: "2026-10-03", vehiculoId: SZX880, flete: 15_553_900 },
    { id: 2, fecha: "2026-10-12", vehiculoId: SZX880, flete: 15_553_900 },
    { id: 3, fecha: "2026-10-20", vehiculoId: SOR429, flete: 8_281_664 },
    { id: 4, fecha: "2026-10-22", vehiculoId: SZX880, flete: 4_000_000 },
    { id: 5, fecha: "2026-10-05", vehiculoId: SPI982, flete: 4_178_600 },
    { id: 6, fecha: "2026-10-09", vehiculoId: SPI982, flete: null },
    { id: 7, fecha: "2026-10-09", vehiculoId: 99, flete: 1_000_000 },
  ];
  const p = producidoPorConductor(viajes, asignaciones);

  test("Ferney octubre: 31.107.800 de la SZX-880 + 8.281.664 de la SOR-429 = 39.389.464 (hoja FERNEY OCTUBRE)", () => {
    const f = p.get(10)!;
    expect(f.total).toBe(39_389_464);
    expect(f.porVehiculo.map((x) => [x.vehiculoId, x.producido])).toEqual([
      [SZX880, 31_107_800],
      [SOR429, 8_281_664],
    ]);
  });
  test("el viaje de la SZX-880 despues del cambio es del conductor nuevo", () => {
    expect(p.get(20)!.total).toBe(4_000_000);
  });
  test("viaje sin tarifa no suma pero se cuenta; vehiculo sin conductor no es de nadie", () => {
    expect(p.get(30)!.total).toBe(4_178_600);
    expect(p.get(30)!.porVehiculo[0]).toMatchObject({ viajes: 2, sinTarifa: 1 });
    expect([...p.values()].some((x) => x.viajes.includes(7))).toBe(false);
  });
  test("mes calendario del inicio de la nomina", () => {
    expect(mesDe("2026-10-21")).toEqual({ desde: "2026-10-01", hasta: "2026-10-31" });
    expect(mesDe("2026-02-21")).toEqual({ desde: "2026-02-01", hasta: "2026-02-28" });
  });
});

describe("costo de un conductor que cambia de carro en el periodo", () => {
  const c = { variable: 1_000_000, viaticos: 1_250_000, devengado: 4_500_000 };
  test("dias por vehiculo segun la asignacion (cambio el 05/11 en una nomina del 21/10 al 20/11)", () => {
    const d = diasPorVehiculo(
      [
        { vehiculoId: 1, desde: "2026-01-01", hasta: "2026-11-04" },
        { vehiculoId: 2, desde: "2026-11-05", hasta: null },
      ],
      "2026-10-21",
      "2026-11-20",
    );
    expect([...d.entries()]).toEqual([
      [1, 15],
      [2, 16],
    ]);
  });
  test("lo del producido por producido y el resto por dias", () => {
    // La mitad del devengado sale del producido: 0,5 por producido (todo en el carro 1) y 0,5 por dias (15 y 16).
    const p = pesosConductor(
      c,
      new Map([[1, 30_000_000]]),
      new Map([
        [1, 15],
        [2, 16],
      ]),
    );
    expect(Math.round(p.get(1)! * 10000) / 10000).toBe(Math.round((0.5 + (0.5 * 15) / 31) * 10000) / 10000);
    expect(Math.round(p.get(2)! * 10000) / 10000).toBe(Math.round(((0.5 * 16) / 31) * 10000) / 10000);
  });
  test("sin producido, todo por dias; sin dias, todo por producido", () => {
    expect([
      ...pesosConductor(
        c,
        new Map(),
        new Map([
          [1, 10],
          [2, 30],
        ]),
      ).values(),
    ]).toEqual([0.25, 0.75]);
    expect([
      ...pesosConductor(
        c,
        new Map([
          [1, 1],
          [2, 3],
        ]),
        new Map(),
      ).values(),
    ]).toEqual([0.25, 0.75]);
  });
});

describe("UPC adicional, conceptos que van al gasto y reparto por vehiculo (21/11/2026)", () => {
  test("UPC adicional: suma al costo de la empresa (con la salud) y no se le descuenta al empleado", () => {
    const sin = calcularLinea({ ...CONDUCTOR, producido: 27_713_800 }, P2026);
    const con = calcularLinea({ ...CONDUCTOR, producido: 27_713_800, upcAdicional: 98_200 }, P2026);
    expect(con.upcAdicional).toBe(98_200);
    expect(con.neto).toBe(sin.neto);
    expect(con.costoTotal).toBe(sin.costoTotal + 98_200);
  });
  test("sin exclusiones, el gasto es el costo total; la UPC va aparte (a su vehiculo)", () => {
    const c = calcularLinea({ ...CONDUCTOR, producido: 27_713_800, upcAdicional: 98_200 }, P2026);
    expect(gastoDeLinea(c)).toEqual({ general: c.costoTotal - 98_200, upc: 98_200, total: c.costoTotal });
  });
  test("Yeferson: al gasto solo van cesantias e intereses (sin sueldo, auxilio, caja, prima ni vacaciones)", () => {
    const c = calcularLinea(OFICINA, P2026);
    const soloCesantias = CONCEPTOS_GASTO.map(([k]) => k).filter((k) => k !== "cesantias" && k !== "interesesCesantias");
    expect(gastoDeLinea(c, soloCesantias).total).toBe(c.cesantias + c.interesesCesantias);
    expect(c.neto).toBe(1_610_705);
  });
  test("reparto del conductor en porcentajes que suman 100; uno escrito a mano se revisa", () => {
    expect(
      porcentajesDe(
        new Map([
          [1, 2 / 3],
          [2, 1 / 3],
        ]),
      ),
    ).toEqual([
      { vehiculoId: 1, porcentaje: 66.67 },
      { vehiculoId: 2, porcentaje: 33.33 },
    ]);
    expect(
      errorReparto([
        { vehiculoId: 1, porcentaje: 60 },
        { vehiculoId: 2, porcentaje: 40 },
      ]),
    ).toBeNull();
    expect(
      errorReparto([
        { vehiculoId: 1, porcentaje: 60 },
        { vehiculoId: 2, porcentaje: 30 },
      ]),
    ).toMatch(/suman 90/);
    expect(
      errorReparto([
        { vehiculoId: 1, porcentaje: 50 },
        { vehiculoId: 1, porcentaje: 50 },
      ]),
    ).toMatch(/repetido/);
  });
});

describe("UPC adicional por beneficiario (puede no ser empleado)", () => {
  test("cada uno con cedula, nombre, valor y vehiculo; la cedula queda solo con numeros y el nombre en mayuscula", () => {
    const r = validarUpcs([{ cedula: "1.023.456.789", nombre: " maria perez ", valor: "98200", vehiculoId: 39 }]);
    expect(r).toEqual({ upcs: [{ cedula: "1023456789", nombre: "MARIA PEREZ", valor: 98_200, vehiculoId: 39 }], error: null });
  });
  test("le falta algo o se repite: dice que", () => {
    expect(validarUpcs([{ cedula: "", nombre: "ANA", valor: 1, vehiculoId: 1 }]).error).toMatch(/cedula de ANA/);
    expect(validarUpcs([{ cedula: "123456", nombre: "ANA", valor: 0, vehiculoId: 1 }]).error).toMatch(/valor/);
    expect(validarUpcs([{ cedula: "123456", nombre: "ANA", valor: 5, vehiculoId: 0 }]).error).toMatch(/vehiculo/);
    expect(
      validarUpcs([
        { cedula: "123456", nombre: "ANA", valor: 5, vehiculoId: 1 },
        { cedula: "123.456", nombre: "ANA B", valor: 5, vehiculoId: 1 },
      ]).error,
    ).toMatch(/repetida/);
    expect(validarUpcs([]).error).toBeNull();
  });
});
