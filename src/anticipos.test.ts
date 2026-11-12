import { describe, expect, test, vi } from "vitest";

// Estas pruebas no tocan la base.
vi.mock("./db", () => ({ pool: {} }));

import { ErrorCuadro } from "./cuadro";
import { avisosRepetido, combustibleSegunFormula, descuentoSugerido, placaNormal, resumirBomba, validarAnticipo } from "./anticipos";

describe("anticipo que se registra en un viaje", () => {
  test("un solo recorrido: efectivo y combustible, sin vuelta", () => {
    const a = validarAnticipo({ fecha: "2026-10-14", bombaId: 3, efectivo: "1100000", combustible: "1100000" });
    expect(a).toMatchObject({ efectivo: 1100000, combustible: 1100000, idaYVuelta: false, efectivoVuelta: 0, combustibleVuelta: 0 });
  });

  test("ida y vuelta: guarda el anticipo de vuelta", () => {
    const a = validarAnticipo({
      fecha: "2026-10-14",
      bombaId: 3,
      efectivo: 1100000,
      combustible: 1100000,
      idaYVuelta: true,
      efectivoVuelta: 620000,
      combustibleVuelta: 1180000,
      facturaBomba: " AE5027109 ",
    });
    expect(a).toMatchObject({ idaYVuelta: true, efectivoVuelta: 620000, combustibleVuelta: 1180000, facturaBomba: "AE5027109" });
  });

  test("ida y vuelta sin valor de vuelta: se pide", () => {
    expect(() => validarAnticipo({ fecha: "2026-10-14", bombaId: 3, efectivo: 1000, idaYVuelta: true })).toThrow(
      /anticipo de vuelta/
    );
  });

  test("con combustible la bomba es obligatoria; solo efectivo no la necesita", () => {
    expect(() => validarAnticipo({ fecha: "2026-10-14", combustible: 900000 })).toThrow(/bomba/);
    expect(validarAnticipo({ fecha: "2026-10-14", efectivo: 900000 }).bombaId).toBeNull();
  });

  test("sin valor o sin fecha no se acepta", () => {
    expect(() => validarAnticipo({ fecha: "2026-10-14", bombaId: 3 })).toThrow(ErrorCuadro);
    expect(() => validarAnticipo({ efectivo: 1000 })).toThrow(/fecha/);
  });

  test("compatibilidad: 'valor' sin desglose se toma como combustible", () => {
    expect(validarAnticipo({ fecha: "2026-10-14", bombaId: 3, valor: 500000 })).toMatchObject({ efectivo: 0, combustible: 500000 });
  });

  test("placa comparable sin guion", () => {
    expect(placaNormal("szp-339")).toBe("SZP339");
  });
});

describe("cuentas con la bomba", () => {
  test("deuda, pagado, abonado del socio, pendiente y cupo disponible", () => {
    const r = resumirBomba(
      [
        { bombaId: 1, valor: 2_200_000, fechaPago: "2026-10-10" },
        { bombaId: 1, valor: 1_800_000, fechaPago: null },
        { bombaId: 1, valor: 3_000_000, fechaPago: null },
        // Solo efectivo, sin bomba: no es deuda con la bomba.
        { bombaId: null, valor: 900_000, fechaPago: null },
      ],
      1_000_000,
      { cupoBomba: 500_000_000, precioGalonBomba: 11390 }
    );
    expect(r).toMatchObject({ deuda: 7_000_000, pagado: 2_200_000, abonadoSocio: 1_000_000, pendiente: 3_800_000, cupoDisponible: 496_200_000 });
  });

  test("los abonos ya descontados en un pago a la bomba no se restan dos veces", () => {
    // El abono de 1.000.000 se uso en el pago: sus tramos ya estan pagados.
    const r = resumirBomba(
      [
        { bombaId: 1, valor: 2_200_000, fechaPago: "2026-10-10" },
        { bombaId: 1, valor: 1_800_000, fechaPago: null },
      ],
      1_000_000,
      { cupoBomba: 500_000_000, precioGalonBomba: 11390 },
      0
    );
    expect(r).toMatchObject({ abonadoSocio: 1_000_000, pendiente: 1_800_000 });
  });

  test("los abonos del socio sin cruzar no se descuentan de la deuda", () => {
    // Abono de 500.000 registrado pero sin cruzar: la deuda sigue completa.
    const r = resumirBomba(
      [{ bombaId: 1, valor: 1_800_000, fechaPago: null }],
      0,
      { cupoBomba: 500_000_000, precioGalonBomba: 11390 },
      0,
      500_000
    );
    expect(r).toMatchObject({ abonadoSocio: 0, abonadoPorCruzar: 500_000, pendiente: 1_800_000 });
  });

  test("combustible con la formula del Excel: round(galones x precio - descuento)", () => {
    // Filas reales de la hoja "EDS CHUSACA - RETORNO - S ESTE" (columna COMBUST.).
    expect(combustibleSegunFormula(100.182, 11230, 25044)).toBe(1100000); // =(F175*11230)-25044
    expect(combustibleSegunFormula(107.471, 11230, 26867)).toBe(1180032); // =(F176*11230)-26867
    expect(combustibleSegunFormula(101.57, 11080, 25396)).toBe(1100000); // =(F187*11080)-25396
  });

  test("descuento sugerido: galones x descuento por galon, en pesos", () => {
    // En el Excel el descuento ronda los 250 por galon (25.044 / 100,182).
    expect(descuentoSugerido(100.182, 250)).toBe(25046);
    expect(descuentoSugerido(91.075, 250)).toBe(22769);
  });
});

describe("aviso de anticipo repetido", () => {
  // Casos reales encontrados al cuadrar con el reporte de la empresa.
  test("mismo valor el mismo dia (SDO-355: la ida otra vez)", () => {
    const avisos = avisosRepetido([1_200_000], [
      { tramo: "IDA", total: 1_200_000, manifiesto: "00006816" },
      { tramo: "VUELTA", total: 1_200_000, manifiesto: null },
    ]);
    expect(avisos[0]).toBe("Ya hay un anticipo de 1.200.000 ese dia en esta placa (ida del manifiesto 00006816).");
  });

  test("el total de dos ya registrados (SWN-623: 2.435.962 = 1.300.000 + 1.135.962)", () => {
    const existentes = [
      { tramo: "IDA" as const, total: 1_300_000, manifiesto: "00006922" },
      { tramo: "IDA" as const, total: 1_135_962, manifiesto: "00006922" },
    ];
    expect(avisosRepetido([2_435_962], existentes)).toEqual(["2.435.962 es la suma de dos anticipos ya registrados ese dia (1.300.000 + 1.135.962)."]);
    // Al reves: ya estaba el total y se registra una parte.
    const alReves = avisosRepetido([1_135_962], [existentes[0], { tramo: "IDA", total: 2_435_962, manifiesto: "00006922" }]);
    expect(alReves).toEqual(["Ya hay un anticipo de 2.435.962 ese dia que seria la suma de este y otro (ida del manifiesto 00006922)."]);
  });

  test("sin anticipos ese dia, o con otro valor, no avisa", () => {
    expect(avisosRepetido([2_200_000], [])).toEqual([]);
    expect(avisosRepetido([2_200_000, 0], [{ tramo: "IDA", total: 1_800_000, manifiesto: null }])).toEqual([]);
  });
});
