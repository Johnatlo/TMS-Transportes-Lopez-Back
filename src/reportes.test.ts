import { describe, expect, test, vi } from "vitest";

// reportes importa la conexion a MySQL; estas pruebas no tocan la base.
vi.mock("./db", () => ({ pool: {} }));

import { estadoDeCuenta, motivoFechaRara, movimientosBomba, porMes, reporteBomba } from "./reportes";

describe("estado de cuenta", () => {
  const movs = [
    { fecha: "2026-08-20", tipo: "PRESTAMO", descripcion: "a", cargo: 1_000, abono: 0 },
    { fecha: "2026-09-02", tipo: "PAGO", descripcion: "b", cargo: 0, abono: 400 },
    { fecha: "2026-09-02", tipo: "PRESTAMO", descripcion: "c", cargo: 300, abono: 0 },
    { fecha: "2026-10-05", tipo: "PRESTAMO", descripcion: "d", cargo: 50, abono: 0 },
  ];

  test("saldo inicial con lo anterior, saldo de cada movimiento y saldo final", () => {
    const e = estadoDeCuenta(movs, "2026-09-01", "2026-09-30");
    expect(e.saldoInicial).toBe(1_000);
    // Del mismo dia, primero los cargos.
    expect(e.movimientos.map((m) => [m.descripcion, m.saldo])).toEqual([
      ["c", 1_300],
      ["b", 900],
    ]);
    expect([e.totalCargos, e.totalAbonos, e.saldoFinal]).toEqual([300, 400, 900]);
  });

  test("totales por mes y por tipo", () => {
    expect(porMes(movs).map((m) => [m.mes, m.cargos, m.abonos])).toEqual([
      ["2026-08", 1_000, 0],
      ["2026-09", 300, 400],
      ["2026-10", 50, 0],
    ]);
  });
});

describe("reporte de la bomba", () => {
  const datos = {
    entregas: [
      { fecha: "2026-09-01", bomba: "CHUSACA", flota: "LOPEZ", efectivo: 1_100_000, combustible: 1_100_000 },
      { fecha: "2026-09-01", bomba: "CHUSACA", flota: "TERCERO", efectivo: 700_000, combustible: 600_000 },
      { fecha: "2026-09-15", bomba: "S. ESTEBAN", flota: "MYC", efectivo: 900_000, combustible: 900_000 },
      { fecha: "2026-08-20", bomba: "CHUSACA", flota: "LOPEZ", efectivo: 500_000, combustible: 500_000 },
    ],
    // El socio abona 1.500.000 y la empresa paga el resto de la quincena.
    abonos: [{ fecha: "2026-09-28", socio: "RECICLAJES BOGOTA", valor: 1_500_000 }],
    pagos: [{ id: 1, fecha: "2026-10-08", valorPagado: 3_800_000, facturas: ["AE5043413"] }],
    pagosSueltos: [{ fecha: "2026-09-05", valor: 1_000_000 }],
  };

  test("cuanto presto la bomba, cuanto se le pago (empresa y socios) y la deuda", () => {
    const r = reporteBomba(datos, "2026-09-01", "2026-10-31");
    expect(r.resumen).toEqual({
      saldoInicial: 1_000_000,
      prestadoEfectivo: 2_700_000,
      prestadoCombustible: 2_600_000,
      prestado: 5_300_000,
      anticipos: 3,
      pagadoEmpresa: 4_800_000,
      abonadoSocios: 1_500_000,
      totalPagado: 6_300_000,
      saldoFinal: 0,
    });
    expect(r.porBomba.map((b) => [b.nombre, b.total, b.anticipos])).toEqual([
      ["CHUSACA", 3_500_000, 2],
      ["S. ESTEBAN", 1_800_000, 1],
    ]);
    expect(r.porEmpresaVehiculo.map((b) => b.nombre)).toEqual(["LOPEZ", "M&C", "TERCERO"]);
    expect(r.porMes).toEqual([
      { mes: "2026-09", prestado: 5_300_000, pagadoEmpresa: 1_000_000, abonadoSocios: 1_500_000 },
      { mes: "2026-10", prestado: 0, pagadoEmpresa: 3_800_000, abonadoSocios: 0 },
    ]);
  });

  test("los prestamos del mismo dia y bomba van en un solo movimiento", () => {
    const m = movimientosBomba(datos.entregas, [], [], []).filter((x) => x.fecha === "2026-09-01");
    expect(m).toEqual([{ fecha: "2026-09-01", tipo: "PRESTAMO", descripcion: "Anticipos CHUSACA (2)", cargo: 3_500_000, abono: 0 }]);
  });
});

describe("fechas de pago imposibles", () => {
  test("año imposible, antes del anticipo o en el futuro", () => {
    expect(motivoFechaRara("2026-10-11", "1909-10-30", "2026-10-23")).toMatch(/1909/);
    expect(motivoFechaRara("2026-10-11", "2026-10-05", "2026-10-23")).toMatch(/anterior/);
    expect(motivoFechaRara("2026-10-11", "2026-10-30", "2026-10-23")).toMatch(/no ha llegado/);
    expect(motivoFechaRara("2026-10-11", "2026-10-20", "2026-10-23")).toBeNull();
  });

  test("un pago de 1909 dejaba el saldo inicial negativo", () => {
    const r = reporteBomba(
      {
        entregas: [{ fecha: "2026-10-11", bomba: "S. ESTEBAN", flota: "LOPEZ", efectivo: 1_200_000, combustible: 1_007_100 }],
        abonos: [],
        pagos: [],
        pagosSueltos: [{ fecha: "1909-10-30", valor: 2_207_100 }],
      },
      "2026-08-23",
      "2026-10-23"
    );
    expect(r.resumen.saldoInicial).toBe(-2_207_100);
  });
});
