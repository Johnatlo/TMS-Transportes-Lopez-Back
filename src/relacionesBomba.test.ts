import { describe, expect, test, vi } from "vitest";

// Los modulos importan la conexion a MySQL; estas pruebas no tocan la base.
vi.mock("./db", () => ({ pool: {} }));

import { emparejarVales, estacionNormal, valorAPagarBomba } from "./relacionesBomba";
import type { TramoCruzable, ValeBomba } from "./relacionesBomba";
import { elegirIdaYVuelta, parejasIdaYVuelta } from "./anticipos";
import type { TanqueoSuelto } from "./anticipos";

describe("estacionNormal", () => {
  test("la bomba escribe la estacion distinto que el Excel", () => {
    expect(estacionNormal("EDS SAN ESTEBAN")).toBe("SAN ESTEBAN");
    expect(estacionNormal("S. ESTEBAN")).toBe("SAN ESTEBAN");
    expect(estacionNormal("EDS CHUSACA")).toBe(estacionNormal("CHUSACA"));
  });
});

describe("emparejarVales (relacion AE5044797, SWN-623)", () => {
  const vale = (fecha: string, valor: number, eds = "EDS SAN ESTEBAN", tipo: ValeBomba["tipo"] = "COMBUSTIBLE"): ValeBomba => ({
    tipo,
    eds,
    vale: `V${fecha}${valor}`,
    fecha,
    hora: null,
    placa: "SWN62 3",
    galones: tipo === "EFECTIVO" ? null : 53.6,
    valor,
  });
  const tramo = (id: number, fecha: string, combustible: number, bomba = "S. ESTEBAN", cruzado = false, efectivo = 1_200_000): TramoCruzable => ({
    id,
    placa: "SWN-623",
    fecha,
    bomba,
    combustible,
    efectivo,
    cruzadoCombustible: cruzado,
    cruzadoEfectivo: false,
  });

  test("ida y vuelta del mismo dia: cada vale a su tramo por el valor", () => {
    const r = emparejarVales([vale("2026-09-20", 594_435), vale("2026-09-20", 600_064)], [tramo(1, "2026-09-20", 600_000), tramo(2, "2026-09-20", 594_435)]);
    expect(r.map((v) => [v.tramoId, v.estado])).toEqual([
      [2, "COINCIDE"],
      [1, "COINCIDE"],
    ]);
  });

  test("misma placa y fecha con otro valor: diferencia; sin tramo: sin tanqueo", () => {
    const r = emparejarVales([vale("2026-09-26", 600_000), vale("2026-09-30", 1_000_000, "EDS CHUSACA")], [tramo(1, "2026-09-25", 650_000)]);
    expect(r.map((v) => v.estado)).toEqual(["DIFERENCIA", "SIN_TANQUEO"]);
  });

  test("la bomba tambien da efectivo: se compara con el efectivo del tramo, y el mismo tramo toma los dos vales", () => {
    const r = emparejarVales(
      [vale("2026-09-20", 600_064), vale("2026-09-20", 1_200_000, "EDS SAN ESTEBAN", "EFECTIVO"), vale("2026-09-20", 900_000, "EDS SAN ESTEBAN", "EFECTIVO")],
      [tramo(1, "2026-09-20", 600_064)]
    );
    expect(r.map((v) => [v.tipo, v.tramoId, v.estado])).toEqual([
      ["COMBUSTIBLE", 1, "COINCIDE"],
      ["EFECTIVO", 1, "COINCIDE"],
      // Un tramo va con un solo vale de efectivo.
      ["EFECTIVO", null, "SIN_TANQUEO"],
    ]);
  });

  test("no usa tramos de otra estacion, ya cruzados ni lejanos en fecha", () => {
    const r = emparejarVales(
      [vale("2026-09-18", 1_000_000, "EDS CHUSACA")],
      [tramo(1, "2026-09-18", 1_000_000, "S. ESTEBAN"), tramo(2, "2026-09-18", 1_000_000, "CHUSACA", true), tramo(3, "2026-09-25", 1_000_000, "CHUSACA")]
    );
    expect(r[0].estado).toBe("SIN_TANQUEO");
  });
});

describe("ida y vuelta", () => {
  const suelto = (cambios: Partial<TanqueoSuelto>): TanqueoSuelto => ({
    tanqueoId: 1,
    tramoId: 1,
    placa: "SWO594",
    fecha: "2026-09-01",
    bombaId: 1,
    cuadroViajeId: 1,
    fechaViaje: "2026-09-01",
    saleDeBogota: false,
    facturaBomba: null,
    ...cambios,
  });

  test("la ida es el viaje despachado mas cerca del tanqueo", () => {
    const cerca = suelto({ tanqueoId: 2, tramoId: 2, fechaViaje: "2026-09-01" });
    const lejos = suelto({ tanqueoId: 1, tramoId: 1, fechaViaje: "2026-09-04" });
    expect(elegirIdaYVuelta(lejos, cerca)).toEqual({ ida: cerca, vuelta: lejos });
  });

  test("si empatan, la que sale de Bogota o Soacha", () => {
    const cali = suelto({ tanqueoId: 1, tramoId: 1 });
    const soacha = suelto({ tanqueoId: 2, tramoId: 2, saleDeBogota: true });
    expect(elegirIdaYVuelta(cali, soacha).ida).toBe(soacha);
  });

  test("solo pares exactos de la misma placa, dia y bomba", () => {
    const parejas = parejasIdaYVuelta([
      suelto({ tanqueoId: 1, tramoId: 1 }),
      suelto({ tanqueoId: 2, tramoId: 2, fechaViaje: "2026-09-03" }),
      // Otra bomba ese dia: no es su pareja.
      suelto({ tanqueoId: 3, tramoId: 3, bombaId: 2 }),
      // Tres el mismo dia: no se sabe cuales van juntos.
      suelto({ tanqueoId: 4, tramoId: 4, placa: "JTY221" }),
      suelto({ tanqueoId: 5, tramoId: 5, placa: "JTY221" }),
      suelto({ tanqueoId: 6, tramoId: 6, placa: "JTY221" }),
    ]);
    expect(parejas.map((p) => [p.ida.tanqueoId, p.vuelta.tanqueoId])).toEqual([[1, 2]]);
  });

  test("no junta dos tanqueos con facturas de la bomba distintas", () => {
    expect(parejasIdaYVuelta([suelto({ tanqueoId: 1, tramoId: 1, facturaBomba: "AE1" }), suelto({ tanqueoId: 2, tramoId: 2, facturaBomba: "AE2" })])).toEqual([]);
  });
});

describe("pago a la bomba", () => {
  test("facturas de la quincena menos los abonos de los socios (ejemplo Vales Coesco)", () => {
    expect(valorAPagarBomba(125_653_812, 13_200_000 + 15_400_000 + 13_200_000)).toBe(83_853_812);
    // Si los abonos pasan las facturas, no se paga nada (no queda negativo).
    expect(valorAPagarBomba(1_000_000, 2_000_000)).toBe(0);
  });
});
