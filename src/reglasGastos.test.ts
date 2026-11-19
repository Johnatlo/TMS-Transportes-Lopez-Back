import { describe, expect, test } from "vitest";
import { causaciones, fechaDePeriodo } from "./prorrateo";
import { descripcionesParecidas, facturaComparable, periodosRecurrente, posiblesDuplicados, valorEn } from "./reglasGastos";

describe("quincenal", () => {
  test("fechas de cada quincena: el 5 y el 20; el 1 y el 16", () => {
    expect([0, 1, 2, 3].map((i) => fechaDePeriodo("2026-10-05", i, "QUINCENAL"))).toEqual(["2026-10-05", "2026-10-20", "2026-11-05", "2026-11-20"]);
    expect([0, 1, 2].map((i) => fechaDePeriodo("2026-11-01", i, "QUINCENAL"))).toEqual(["2026-11-01", "2026-11-16", "2026-12-01"]);
    expect(fechaDePeriodo("2026-10-05", 2, "MENSUAL")).toBe("2026-12-05");
  });
  test("un gasto diferido en 4 quincenas: 4 causaciones iguales", () => {
    expect(causaciones(400_000_00, "2026-10-01", 4, "QUINCENAL")).toEqual([
      { fecha: "2026-10-01", monto: 100_000_00 },
      { fecha: "2026-10-16", monto: 100_000_00 },
      { fecha: "2026-11-01", monto: 100_000_00 },
      { fecha: "2026-11-16", monto: 100_000_00 },
    ]);
  });
});

describe("gastos recurrentes", () => {
  test("periodos que ya tocaron hasta hoy (o hasta la fecha fin)", () => {
    expect(periodosRecurrente("2026-10-05", null, "2026-11-19", "MENSUAL")).toEqual(["2026-10-05", "2026-11-05"]);
    expect(periodosRecurrente("2026-10-01", null, "2026-11-19", "QUINCENAL")).toEqual(["2026-10-01", "2026-10-16", "2026-11-01", "2026-11-16"]);
    expect(periodosRecurrente("2026-10-05", "2026-10-31", "2026-12-19", "MENSUAL")).toEqual(["2026-10-05"]);
  });
  test("si el valor cambia desde una fecha, los periodos anteriores conservan el valor de su momento", () => {
    const valores = [
      { desde: "2026-10-01", monto: 1_500_000 },
      { desde: "2026-12-01", monto: 1_650_000 },
    ];
    expect([valorEn(valores, "2026-10-05"), valorEn(valores, "2026-11-05"), valorEn(valores, "2026-12-05"), valorEn(valores, "2026-09-05")]).toEqual([
      1_500_000,
      1_500_000,
      1_650_000,
      null,
    ]);
  });
});

describe("gastos repetidos (la factura que llega por correo y en fisico)", () => {
  const guardados = [
    { id: 1, empresa: "LOPEZ", descripcion: "Llantas Bridgestone SZX-880", numeroFactura: "FE-000123", fecha: "2026-11-10", monto: 2_400_000 },
    { id: 2, empresa: "LOPEZ", descripcion: "Lavada del carro", numeroFactura: null, fecha: "2026-11-12", monto: 80_000 },
    { id: 3, empresa: "MYC", descripcion: "Parqueadero", numeroFactura: "123", fecha: "2026-11-12", monto: 50_000 },
  ];
  test("misma factura con otro formato (FE123 = FE-000123) en la misma empresa", () => {
    expect(facturaComparable("FE-000123")).toBe(facturaComparable("fe 123"));
    const r = posiblesDuplicados({ empresa: "LOPEZ", descripcion: "llantas", numeroFactura: "fe123", fecha: "2026-11-11", monto: 2_400_000 }, guardados);
    expect(r.map((x) => [x.gasto.id, x.motivo])).toEqual([[1, "misma factura FE-000123"]]);
  });
  test("sin factura: mismo valor, misma fecha y descripcion parecida", () => {
    const r = posiblesDuplicados({ empresa: "LOPEZ", descripcion: "Lavada carro SZX", numeroFactura: null, fecha: "2026-11-12", monto: 80_000 }, guardados);
    expect(r.map((x) => x.gasto.id)).toEqual([2]);
    expect(descripcionesParecidas("Lavada del carro", "Compra de aceite")).toBe(false);
  });
  test("otra empresa, otro valor u otra fecha: no es el mismo", () => {
    expect(posiblesDuplicados({ empresa: "LOPEZ", descripcion: "Parqueadero", numeroFactura: "123", fecha: "2026-11-12", monto: 60_000 }, guardados)).toEqual(
      [],
    );
    expect(
      posiblesDuplicados({ empresa: "LOPEZ", descripcion: "Lavada del carro", numeroFactura: null, fecha: "2026-11-13", monto: 80_000 }, guardados),
    ).toEqual([]);
  });
  test("al editar no se compara consigo mismo", () => {
    expect(
      posiblesDuplicados({ id: 2, empresa: "LOPEZ", descripcion: "Lavada del carro", numeroFactura: null, fecha: "2026-11-12", monto: 80_000 }, guardados),
    ).toEqual([]);
  });
});
