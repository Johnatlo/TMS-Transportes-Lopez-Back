import { describe, expect, test } from "vitest";
import { cascadas, cuentaSocio, estadoEmpresa, finDeMes, participacionesEn, participacionPonderada, pasoDe, repartoMes } from "./calculoUtilidades";
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
  empresa: "LOPEZ",
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

describe("fondo por vehiculo (hoja de la SWK-973)", () => {
  const SWK973 = 3;
  const cascada = (vehiculoId: number, utilidad: number) => ({ ...cascadas([vehiculoId], [], [])[0], utilidad });
  const base = (extra: Partial<Parameters<typeof repartoMes>[0]> = {}) => ({
    lista: [cascada(SWK973, 13_854_672.16)],
    fondos: new Map([[SWK973, { base: 10_000_000, saldoAnterior: 4_537_623 }]]),
    liquidado: new Map<number, number>(),
    repartimos: new Map<number, number>(),
    participaciones: [
      { vehiculoId: SWK973, socioId: MAURICIO, porcentaje: 50, desde: "2000-01-01", hasta: null },
      { vehiculoId: SWK973, socioId: CELSO, porcentaje: 50, desde: "2000-01-01", hasta: null },
    ],
    partidas: [] as PartidaGasto[],
    desde: "2026-09-01",
    hasta: "2026-09-30",
    receptor: new Map<number, number>(),
    gmfPorMil: 4,
    ...extra,
  });

  test("septiembre: queda 13.854.672,16 + mes anterior 4.537.623 - repartimos 8.000.000 = 10.392.295,16", () => {
    const { fondos } = repartoMes(base({ repartimos: new Map([[SWK973, 8_000_000]]) }));
    expect(fondos[0]).toMatchObject({
      antesDeRepartir: 18_392_295.16,
      disponible: 8_392_295.16,
      sugerido: 8_392_295,
      repartimos: 8_000_000,
      saldoFinal: 10_392_295.16,
    });
  });

  test("sin decir cuanto, se sugiere el disponible; con saldo negativo (motor Cummins) no se sugiere nada", () => {
    expect(repartoMes(base()).fondos[0]).toMatchObject({ repartimos: 8_392_295, saldoFinal: 10_000_000.16 });
    const abril = repartoMes(base({ lista: [cascada(SWK973, -41_994_983.46)], fondos: new Map([[SWK973, { base: 10_000_000, saldoAnterior: 12_097_282 }]]) }));
    expect(abril.fondos[0]).toMatchObject({ antesDeRepartir: -29_897_701.46, sugerido: 0, repartimos: 0, saldoFinal: -29_897_701.46 });
  });

  test("lo repartido se divide segun la participacion y a cada socio se le descuenta el 4 x 1000", () => {
    const { socios } = repartoMes(base({ repartimos: new Map([[SWK973, 8_000_000]]) }));
    const m = socios.find((x) => x.socioId === MAURICIO)!;
    expect([m.repartido, m.gmf, m.neto]).toEqual([4_000_000, 16_000, 3_984_000]);
  });

  test("lo liquidado al dueno sale del fondo; en la sociedad el que lo recibio le queda debiendo al otro", () => {
    const r = repartoMes(base({ liquidado: new Map([[SWK973, 2_000_000]]), repartimos: new Map([[SWK973, 0]]), receptor: new Map([[SWK973, MAURICIO]]) }));
    expect(r.fondos[0].antesDeRepartir).toBe(16_392_295.16);
    const de = (id: number) => r.socios.find((x) => x.socioId === id)!;
    expect([de(MAURICIO).liquidado, de(MAURICIO).recibido, de(MAURICIO).neto]).toEqual([1_000_000, 2_000_000, -1_000_000]);
    expect([de(CELSO).liquidado, de(CELSO).recibido, de(CELSO).neto]).toEqual([1_000_000, 0, 1_000_000]);
  });

  test("dueno al 100 %: lo liquidado y lo recibido se cancelan", () => {
    const r = repartoMes(
      base({
        participaciones: [{ vehiculoId: SWK973, socioId: MAURICIO, porcentaje: 100, desde: "2000-01-01", hasta: null }],
        liquidado: new Map([[SWK973, 2_000_000]]),
        repartimos: new Map([[SWK973, 0]]),
        receptor: new Map([[SWK973, MAURICIO]]),
      }),
    );
    expect(r.socios[0].neto).toBe(0);
  });

  test("los gastos propios del socio se le descuentan solo a el (Chelo: 536.264 a Celso)", () => {
    const r = repartoMes(base({ repartimos: new Map([[SWK973, 0]]), partidas: [partida(20, 536_264, "GENERAL", null, CELSO)] }));
    expect(r.socios.find((x) => x.socioId === CELSO)!.neto).toBe(-536_264);
  });

  test("participacion por dias: 100 % de A del 1 al 15 y 50/50 desde el 16 (octubre, 31 dias)", () => {
    const ps = participacionPonderada(
      [
        { vehiculoId: SWK973, socioId: MAURICIO, porcentaje: 100, desde: "2000-01-01", hasta: "2026-10-15" },
        { vehiculoId: SWK973, socioId: MAURICIO, porcentaje: 50, desde: "2026-10-16", hasta: null },
        { vehiculoId: SWK973, socioId: CELSO, porcentaje: 50, desde: "2026-10-16", hasta: null },
      ],
      SWK973,
      "2026-10-01",
      "2026-10-31",
    );
    expect(ps).toEqual([
      { socioId: MAURICIO, porcentaje: 74.1935 },
      { socioId: CELSO, porcentaje: 25.8065 },
    ]);
    expect(participacionesEn([], SWK973, "2026-10-01")).toEqual([]);
  });

  test("vehiculo que reparte sin participacion completa queda aparte", () => {
    const r = repartoMes(base({ participaciones: [{ vehiculoId: SWK973, socioId: LUISA, porcentaje: 60, desde: "2000-01-01", hasta: null }] }));
    expect([r.sinParticipacion, r.socios]).toEqual([[SWK973], []]);
  });
});

describe("cuenta del socio: lo que no alcanza se acumula para el mes siguiente", () => {
  test("octubre debe 536.264 (no le alcanzo), noviembre recibe 1.000.000 y se le pagan 400.000", () => {
    const meses = cuentaSocio(
      0,
      new Map([
        ["2026-10", -536_264],
        ["2026-11", 1_000_000],
      ]),
      [{ fecha: "2026-11-30", monto: 400_000 }],
    );
    expect(meses).toEqual([
      { mes: "2026-10", saldoAnterior: 0, neto: -536_264, pagos: 0, saldo: -536_264 },
      { mes: "2026-11", saldoAnterior: -536_264, neto: 1_000_000, pagos: 400_000, saldo: 63_736 },
    ]);
  });
  test("arranca en su saldo inicial (lo que venia debiendo antes del sistema)", () => {
    expect(cuentaSocio(-200_000, new Map([["2026-10", 150_000]]), []).at(-1)!.saldo).toBe(-50_000);
  });
  test("la parte que va a la empresa es de la empresa", () => {
    expect(pasoDe({ esNominaConductor: false, destinosVehiculo: 3, destinosSocio: 0, aLaEmpresa: true })).toBe("EMPRESA");
  });
});

describe("estado de resultados de la empresa", () => {
  test("terceros (antes del anticipo) + reconocidos + T. Lopez - gastos; el anticipo de renta va aparte", () => {
    const e = estadoEmpresa({
      terceros: [
        { rentabilidad: 500_000, anticipoRenta: 17_500 },
        { rentabilidad: 300_000, anticipoRenta: 10_500 },
      ],
      reconocidos: [{ ingreso: 1_000_000, anticipoRenta: 35_000 }],
      tLopez: [{ total: 150_000 }, { total: 50_000 }],
      anticipoSocios: 200_000,
      totalGastos: 400_000,
    });
    expect([e.gananciaTerceros, e.reconocidos, e.tLopez, e.ingresos]).toEqual([800_000, 1_000_000, 200_000, 2_000_000]);
    expect(e.utilidad).toBe(1_600_000);
    expect(e.anticipoRenta).toEqual({ asumido: 63_000, descontadoSocios: 200_000, total: 263_000 });
    expect(e.despuesDeAnticipo).toBe(1_537_000);
  });
});
