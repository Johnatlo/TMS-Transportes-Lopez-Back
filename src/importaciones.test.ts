/**
 * Pruebas de la carga inicial de cartera y anticipos (src/importaciones.ts) y
 * del reparto de la cartera por dueno (src/seguimiento.ts).
 */
import { describe, expect, test } from "vitest";
import type { FilaCuadro } from "./cuadro";
import { anticipoDe, mismoCliente, proponerAnticipos, proponerCartera } from "./importaciones";
import type { AnticipoImportado, FacturaImportada } from "./importaciones";
import { agruparCartera, carteraDeDueno, repartirPorDueno } from "./seguimiento";

/** Viaje del cuadro con lo minimo; cada prueba cambia lo que necesita. */
const viaje = (c: Partial<FilaCuadro>): FilaCuadro =>
  ({
    id: 1,
    fecha: "2026-09-10",
    placa: "SKX202",
    empresa: "RECOLAM S.EN C.",
    dueno: null,
    anulado: false,
    manifiesto: "00006700",
    remision: null,
    valorFlete: null,
    facturaNumero: null,
    facturaFecha: null,
    facturaVence: null,
    facturaFechaPago: null,
    ...c,
  }) as FilaCuadro;

describe("cliente del Excel contra el del cuadro", () => {
  test("nombres cortos y alias", () => {
    expect(mismoCliente("CORAME", "CARTONES AMERICA")).toBe(true);
    expect(mismoCliente("VILLA PAPEL", "GESTIÓN AMBIENTAL VILLAPAPEL")).toBe(true);
    expect(mismoCliente("TP FORMULADOS", "TP PRODUCTOS FORMULADOS S.A.S")).toBe(true);
    expect(mismoCliente("EMPAQUES INDUSTRIALES", "EMPAQUES INDUSTRIALES DE COLOMBIA S.A.S.")).toBe(true);
    expect(mismoCliente("RECOLAM", "CARTONES AMERICA")).toBe(false);
    expect(mismoCliente("TOLUA GIRARDOTA", "TOLUA MADERAS Y HERRAJES SAS")).toBe(true);
  });
});

describe("propuesta de la cartera", () => {
  const factura = (c: Partial<FacturaImportada>): FacturaImportada => ({
    numero: "7300",
    empresa: "RECOLAM",
    fecha: "2026-09-20",
    vence: "2026-10-20",
    valor: 4_420_000,
    placas: [{ placa: "SKX-202", valor: 4_420_000 }],
    ...c,
  });

  test("antes de septiembre: saldo sin viaje", () => {
    const [p] = proponerCartera([factura({ fecha: "2026-08-19" })], [viaje({})]);
    expect(p.modo).toBe("SALDO");
  });

  test("desde septiembre: el viaje de la placa y del mismo cliente, seguro", () => {
    const [p] = proponerCartera([factura({})], [viaje({ id: 5 }), viaje({ id: 6, empresa: "CARTONES AMERICA" })]);
    expect(p.modo).toBe("VIAJES");
    expect(p.lineas[0].propuestos).toEqual([5]);
    expect(p.lineas[0].seguro).toBe(true);
  });

  test("dos facturas del mismo cliente no se proponen el mismo viaje", () => {
    const viajes = [viaje({ id: 5, fecha: "2026-09-05" }), viaje({ id: 6, fecha: "2026-09-12" })];
    const [a, b] = proponerCartera([factura({ numero: "7300" }), factura({ numero: "7301", fecha: "2026-09-21" })], viajes);
    expect(a.lineas[0].propuestos).toEqual([6]);
    expect(b.lineas[0].propuestos).toEqual([5]);
    expect(a.lineas[0].seguro).toBe(false);
  });

  test("sin viajes de la placa en el cuadro: se propone como saldo, con el motivo", () => {
    const [p] = proponerCartera([factura({})], [viaje({ placa: "JTY219" })]);
    expect(p.modo).toBe("SALDO");
    expect(p.motivo).toContain("SKX-202");
  });

  test("reimportar: el viaje que ya tiene este numero", () => {
    const [p] = proponerCartera([factura({})], [viaje({ id: 9, empresa: "OTRA", facturaNumero: "7300" })]);
    expect(p.lineas[0].propuestos).toEqual([9]);
    expect(p.lineas[0].seguro).toBe(true);
  });

  test("anticipo del cliente: placas menos lo que se debe", () => {
    expect(anticipoDe(factura({ valor: 1_195_840, placas: [{ placa: "SKX202", valor: 5_195_840 }] }))).toBe(4_000_000);
    expect(anticipoDe(factura({}))).toBe(0);
  });
});

describe("propuesta de los anticipos", () => {
  const fila = (c: Partial<AnticipoImportado>): AnticipoImportado => ({
    fila: 2,
    fecha: "2026-09-01",
    placa: "SWO-594",
    cliente: "CORONA",
    efectivo: 1_100_000,
    combustible: 1_100_000,
    galones: 98.39,
    descuento: 0,
    eds: "CHUSACA",
    facturaBomba: "AE5043413",
    fechaFacturaBomba: "2026-09-16",
    fechaPago: "2026-10-08",
    ...c,
  });

  test("dos anticipos el mismo dia: cada uno a su cliente (ida y regreso)", () => {
    const viajes = [
      viaje({ id: 1, placa: "SWO594", fecha: "2026-09-01", empresa: "CORONA S.A." }),
      viaje({ id: 2, placa: "SWO594", fecha: "2026-09-03", empresa: "MADEIROS L&D SAS" }),
    ];
    const [a, b] = proponerAnticipos([fila({}), fila({ fila: 3, cliente: "MADEIROS L&D", efectivo: 839_996 })], viajes, new Map());
    expect(a.propuesto).toBe(1);
    expect(b.propuesto).toBe(2);
    expect(a.seguro && b.seguro).toBe(true);
  });

  test("dos anticipos del mismo cliente el mismo dia: el segundo al viaje siguiente de la placa", () => {
    const viajes = [
      viaje({ id: 1, placa: "SWK973", fecha: "2026-09-02", empresa: "PORCELATINO S.A.S" }),
      viaje({ id: 2, placa: "SWK973", fecha: "2026-09-05", empresa: "RECOLAM S.EN C." }),
    ];
    const [a, b] = proponerAnticipos(
      [fila({ placa: "SWK-973", fecha: "2026-09-03", cliente: "PORCELATINO" }), fila({ fila: 3, placa: "SWK-973", fecha: "2026-09-03", cliente: "PORCELATINO", efectivo: 900_000 })],
      viajes,
      new Map()
    );
    expect([a.propuesto, b.propuesto]).toEqual([1, 2]);
  });

  test("un anticipo sin viaje de su cliente no le quita el viaje al que si es de ese cliente", () => {
    const viajes = [viaje({ id: 7, placa: "SWO594", fecha: "2026-09-03", empresa: "MADEIROS L&D SAS" }), viaje({ id: 8, placa: "SWO594", fecha: "2026-09-12", empresa: "BODEGAS" })];
    const [corona, madeiros] = proponerAnticipos(
      [fila({ cliente: "CORONA" }), fila({ fila: 3, cliente: "MADEIROS L&D", efectivo: 839_996 })],
      viajes,
      new Map()
    );
    expect(madeiros.propuesto).toBe(7);
    expect(corona.propuesto).toBe(8);
  });

  test("un anticipo ya cargado se marca para no repetirlo", () => {
    const [a] = proponerAnticipos([fila({})], [viaje({ placa: "SWO594", fecha: "2026-09-01" })], new Map([["SWO594|2026-09-01|1100000|1100000", 1]]));
    expect(a.yaImportado).toBe(true);
  });

  test("dos filas iguales del mismo Excel (ida y vuelta) se cargan las dos; reimportar las salta", () => {
    const viajes = [viaje({ id: 1, placa: "SWO594", fecha: "2026-09-01", empresa: "CORONA" }), viaje({ id: 2, placa: "SWO594", fecha: "2026-09-04", empresa: "CORONA" })];
    const filas = [fila({}), fila({ fila: 3 })];
    const nuevas = proponerAnticipos(filas, viajes, new Map());
    expect(nuevas.map((a) => [a.yaImportado, a.propuesto])).toEqual([[false, 1], [false, 2]]);
    const otraVez = proponerAnticipos(filas, viajes, new Map([["SWO594|2026-09-01|1100000|1100000", 2]]));
    expect(otraVez.every((a) => a.yaImportado)).toBe(true);
    const unaYa = proponerAnticipos(filas, viajes, new Map([["SWO594|2026-09-01|1100000|1100000", 1]]));
    expect(unaYa.map((a) => a.yaImportado)).toEqual([true, false]);
  });

  test("sin viaje de la placa cerca de la fecha: sin propuesta", () => {
    const [a] = proponerAnticipos([fila({})], [viaje({ placa: "SWO594", fecha: "2026-10-15" })], new Map());
    expect(a.propuesto).toBeNull();
  });
});

describe("cartera por dueno", () => {
  test("el neto se reparte en proporcion a cada placa y suma exacto", () => {
    const reparto = repartirPorDueno(
      [
        { placa: "SKX202", dueno: "MILLER", valor: 4_000_000 },
        { placa: "SPS199", dueno: "TERCEROS", valor: 2_000_001 },
      ],
      5_000_000
    );
    expect(reparto.MILLER! + reparto.TERCEROS!).toBe(5_000_000);
    expect(reparto.MILLER).toBe(3_333_333);
  });

  test("saldos sin viaje y facturas del cuadro, con anticipo del cliente y filtro por dueno", () => {
    const filas = [
      viaje({ id: 1, placa: "SKX202", dueno: "MILLER", facturaNumero: "7300", facturaFecha: "2026-09-20", valorFlete: 4_000_000 }),
      viaje({ id: 2, placa: "SPS199", dueno: null, facturaNumero: "7300", facturaFecha: "2026-09-20", valorFlete: 2_000_000 }),
    ];
    const facturas = agruparCartera(filas, new Map(), new Map(), "2026-10-17", {
      saldos: [
        {
          facturaNumero: "7074",
          empresa: "VILLA PAPEL",
          fechaFactura: "2026-08-01",
          fechaVence: "2026-08-31",
          placas: [{ placa: "XJB207", dueno: "MAURICIO", valor: 4_149_700 }],
        },
      ],
      anticipos: new Map([["7300|RECOLAM S.EN C.", 1_200_000]]),
    });
    const f7300 = facturas.find((f) => f.facturaNumero === "7300")!;
    expect(f7300.valorBruto).toBe(6_000_000);
    expect(f7300.valor).toBe(4_800_000);
    expect(f7300.porDueno).toEqual({ MILLER: 3_200_000, TERCEROS: 1_600_000 });
    const saldo = facturas.find((f) => f.facturaNumero === "7074")!;
    expect(saldo.sinViaje).toBe(true);
    expect(saldo.vence).toBe("2026-08-31");
    expect(saldo.diasVencida).toBe(47);
    expect(carteraDeDueno(facturas, "MILLER").map((f) => [f.facturaNumero, f.valor])).toEqual([["7300", 3_200_000]]);
    expect(carteraDeDueno(facturas, "MAURICIO").map((f) => f.facturaNumero)).toEqual(["7074"]);
  });
});
