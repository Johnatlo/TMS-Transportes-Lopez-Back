import { describe, expect, test } from "vitest";
import { cascadas, finDeMes, participacionesEn, pasoDe, repartirUtilidades } from "./calculoUtilidades";
import type { Participacion, PartidaGasto, ViajeCascada } from "./calculoUtilidades";

const SZX880 = 1;
const XJB207 = 2;
const MAURICIO = 10;
const CELSO = 20;
const LUISA = 30;

/** Un viaje con los descuentos de Rentabilidad (flete 4.399.200, como el ejemplo del Excel). */
const viaje = (id: number, vehiculoId: number, extra: Partial<ViajeCascada> = {}): ViajeCascada => ({
  id,
  vehiculoId,
  fecha: "2026-10-05",
  manifiesto: null,
  cliente: "CARTONES AMERICA",
  flete: 4_399_200,
  retencion: 48_391,
  reteIca: 30_794,
  anticipoRenta: 153_972,
  bancaria: 22_597,
  supertransporte: 5_283,
  comision: 0,
  tLopez: 0,
  descargue: 198_000,
  poliza: 3_000,
  otrosDescuentos: 0,
  anticipo: 1_500_000,
  saldoBeneficiario: 2_437_163,
  ...extra,
});
const partida = (gastoId: number, monto: number, paso: PartidaGasto["paso"], vehiculoId: number | null, socioId: number | null = null): PartidaGasto => ({
  gastoId,
  descripcion: `Gasto ${gastoId}`,
  categoria: "OTROS",
  monto,
  vehiculoId,
  socioId,
  paso,
});

describe("cascada de un vehiculo", () => {
  const viajes = [viaje(1, SZX880), viaje(2, SZX880), viaje(3, XJB207)];
  const partidas = [
    partida(10, 820_000, "DIRECTO", SZX880), // llantas de la SZX-880
    partida(11, 5_451_355.03, "CONDUCTOR", SZX880), // nomina de su conductor
    partida(12, 176_887, "GENERAL", SZX880), // su parte del credito de 80M
    partida(12, 176_887, "GENERAL", XJB207),
    partida(13, -50_000, "GENERAL", SZX880), // un ingreso repartido
  ];
  const [szx, xjb] = cascadas([SZX880, XJB207], viajes, partidas);

  test("paso a paso", () => {
    expect(szx.viajes).toBe(2);
    expect(szx.ingresos).toBe(8_798_400);
    expect(szx.descuentos.descargue).toBe(396_000);
    expect(szx.totalDescuentos).toBe(924_074);
    expect([szx.anticipos, szx.totalDirectos]).toEqual([3_000_000, 3_820_000]);
    expect(szx.totalConductor).toBe(5_451_355.03);
    expect(szx.totalGenerales).toBe(126_887);
    // 8.798.400 - 924.074 - 3.820.000 - 5.451.355,03 - 126.887
    expect(szx.utilidad).toBe(-1_523_916.03);
    expect(szx.saldoViajes).toBe(4_874_326);
  });

  test("cada vehiculo con lo suyo", () => {
    expect([xjb.ingresos, xjb.totalConductor, xjb.totalGenerales, xjb.utilidad]).toEqual([4_399_200, 0, 176_887, 4_399_200 - 462_037 - 1_500_000 - 176_887]);
  });

  test("vehiculo sin viajes ni gastos: todo en cero", () => {
    expect(cascadas([99], viajes, partidas)[0]).toMatchObject({ viajes: 0, ingresos: 0, utilidad: 0 });
  });
});

describe("reparto por socio", () => {
  const participaciones: Participacion[] = [
    { vehiculoId: SZX880, socioId: MAURICIO, porcentaje: 100, desde: "2000-01-01", hasta: "2026-09-30" },
    // Desde octubre la SZX-880 es sociedad 50/50 Mauricio y Celso.
    { vehiculoId: SZX880, socioId: MAURICIO, porcentaje: 50, desde: "2026-10-01", hasta: null },
    { vehiculoId: SZX880, socioId: CELSO, porcentaje: 50, desde: "2026-10-01", hasta: null },
    { vehiculoId: XJB207, socioId: LUISA, porcentaje: 100, desde: "2000-01-01", hasta: null },
  ];
  const lista = [
    { ...cascadas([SZX880], [viaje(1, SZX880)], [])[0], utilidad: 1_000_001, saldoViajes: 2_437_163 },
    { ...cascadas([XJB207], [viaje(2, XJB207)], [])[0], utilidad: 500_000, saldoViajes: 2_437_163 },
  ];
  // Chelo: 536.264 fijos a Celso (va solo a el).
  const partidas = [partida(20, 536_264, "GENERAL", null, CELSO)];
  const { socios, sinParticipacion } = repartirUtilidades(lista, participaciones, partidas, "2026-10-31");
  const de = (id: number) => socios.find((s) => s.socioId === id)!;

  test("la participacion vigente al cierre del mes: sociedad 50/50", () => {
    expect(participacionesEn(participaciones, SZX880, "2026-09-15").map((p) => p.socioId)).toEqual([MAURICIO]);
    expect(de(MAURICIO).utilidadVehiculos + de(CELSO).utilidadVehiculos).toBe(1_000_001);
    expect([de(MAURICIO).utilidadVehiculos, de(CELSO).utilidadVehiculos]).toEqual([500_000.5, 500_000.5]);
  });

  test("los gastos propios del socio se le descuentan solo a el", () => {
    expect(de(CELSO).totalGastosPropios).toBe(536_264);
    expect(de(CELSO).total).toBe(500_000.5 - 536_264);
    expect(de(MAURICIO).total).toBe(500_000.5);
    expect(de(LUISA).total).toBe(500_000);
  });

  test("diferencia contra lo ya liquidado por los viajes", () => {
    expect(de(LUISA).saldoViajes).toBe(2_437_163);
    expect(de(LUISA).diferencia).toBe(500_000 - 2_437_163);
  });

  test("vehiculo sin participacion (o que no suma 100 %) queda aparte", () => {
    const r = repartirUtilidades(lista, [{ vehiculoId: XJB207, socioId: LUISA, porcentaje: 60, desde: "2000-01-01", hasta: null }], [], "2026-10-31");
    expect(r.sinParticipacion).toEqual([SZX880, XJB207]);
    expect(r.socios).toEqual([]);
  });
});

describe("paso de un gasto del libro", () => {
  test("nomina de conductor, directo, general", () => {
    expect(pasoDe({ esNominaConductor: true, destinosVehiculo: 1, destinosSocio: 0 })).toBe("CONDUCTOR");
    expect(pasoDe({ esNominaConductor: false, destinosVehiculo: 1, destinosSocio: 0 })).toBe("DIRECTO");
    expect(pasoDe({ esNominaConductor: false, destinosVehiculo: 13, destinosSocio: 1 })).toBe("GENERAL");
    expect(pasoDe({ esNominaConductor: false, destinosVehiculo: 1, destinosSocio: 1 })).toBe("GENERAL");
  });
  test("fin de mes", () => {
    expect([finDeMes("2026-10"), finDeMes("2026-02"), finDeMes("2028-02")]).toEqual(["2026-10-31", "2026-02-28", "2028-02-29"]);
  });
});
