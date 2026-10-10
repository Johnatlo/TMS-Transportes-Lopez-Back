import { describe, expect, test, vi } from "vitest";

// La sincronizacion importa la conexion a MySQL; estas pruebas no tocan la base.
vi.mock("../db", () => ({ pool: {} }));

import {
  fechaConsulta,
  fechaHoraCitaRndc,
  fechaIngresoRndc,
  leerDocumentos,
  partesConsecutivoRemesa,
  tramosMensuales,
} from "./sincronizacion";

describe("fechas que entrega el RNDC (hora de Colombia)", () => {
  test("FECHAING con AM/PM y dia de uno o dos digitos", () => {
    // Formatos vistos en respuestas reales (2026-10-10).
    expect(fechaIngresoRndc("09/10/2026 10:08:12 p. m.")!.toISOString()).toBe("2026-10-10T03:08:12.000Z");
    expect(fechaIngresoRndc("1/10/2026 5:48:55 a. m.")!.toISOString()).toBe("2026-10-01T10:48:55.000Z");
  });

  test("12 del mediodia y 12 de la noche", () => {
    expect(fechaIngresoRndc("06/10/2026 12:01:01 p. m.")!.toISOString()).toBe("2026-10-06T17:01:01.000Z");
    expect(fechaIngresoRndc("06/10/2026 12:30:00 a. m.")!.toISOString()).toBe("2026-10-06T05:30:00.000Z");
  });

  test("texto sin ese formato da null", () => {
    expect(fechaIngresoRndc("")).toBeNull();
    expect(fechaIngresoRndc("2026-10-09")).toBeNull();
  });

  test("cita: fecha DD/MM/AAAA + hora HH:MM; sin hora, mediodia", () => {
    expect(fechaHoraCitaRndc("09/10/2026", "06:30")!.toISOString()).toBe("2026-10-09T11:30:00.000Z");
    expect(fechaHoraCitaRndc("30/10/2026")!.toISOString()).toBe("2026-10-30T17:00:00.000Z");
    expect(fechaHoraCitaRndc("")).toBeNull();
  });

  test("rango de consulta en AAAA/MM/DD del dia de Colombia", () => {
    // 03:00 UTC del 1 de octubre todavia es 30 de septiembre en Colombia.
    expect(fechaConsulta(new Date("2026-10-01T03:00:00Z"))).toBe("2026/09/30");
    expect(fechaConsulta(new Date("2026-10-01T17:00:00Z"))).toBe("2026/10/01");
  });
});

describe("tramos mensuales de consulta", () => {
  test("de septiembre a mitad de octubre: dos tramos, cortados al 1 de octubre", () => {
    const tramos = tramosMensuales(new Date("2026-09-01T12:00:00Z"), new Date("2026-10-11T12:00:00Z"));
    expect(tramos.map(([a, b]) => [fechaConsulta(a), fechaConsulta(b)])).toEqual([
      ["2026/09/01", "2026/10/01"],
      ["2026/10/01", "2026/10/11"],
    ]);
  });

  test("dentro del mismo mes: un solo tramo", () => {
    expect(tramosMensuales(new Date("2026-10-05T12:00:00Z"), new Date("2026-10-11T12:00:00Z"))).toHaveLength(1);
  });
});

describe("consecutivo de remesa y su manifiesto", () => {
  test("sin letra es la remesa 1 del manifiesto con el mismo numero", () => {
    expect(partesConsecutivoRemesa("00006692")).toEqual({ base: "00006692", orden: 1 });
  });

  test("las letras A, B... son las remesas 2, 3...", () => {
    expect(partesConsecutivoRemesa("00006692A")).toEqual({ base: "00006692", orden: 2 });
    expect(partesConsecutivoRemesa("00006692B")).toEqual({ base: "00006692", orden: 3 });
  });
});

describe("lectura de la respuesta", () => {
  test("cada <documento> con sus etiquetas en minuscula", () => {
    const xml = `<root><documento><ingresoid>3228096</ingresoid><nummanifiestocarga>00006805</nummanifiestocarga>
      <observaciones>Se digito mal la remesa</observaciones></documento><documento><ingresoid>1</ingresoid></documento></root>`;
    expect(leerDocumentos(xml)).toEqual([
      { ingresoid: "3228096", nummanifiestocarga: "00006805", observaciones: "Se digito mal la remesa" },
      { ingresoid: "1" },
    ]);
  });

  test("respuesta sin documentos (RNDC11) no trae nada", () => {
    expect(leerDocumentos("<root><ErrorMSG>Error RNDC11: Documento no encontrado</ErrorMSG></root>")).toEqual([]);
  });
});
