import { describe, expect, test } from "vitest";
import {
  aCabeceraMunicipal,
  calcularPisoSicetac,
  filasDeLaOperacion,
  horasPactadasTotales,
  periodoDe,
} from "./sicetac";
import type { FilaSicetac } from "./sicetac";

/** Fila de SICETAC con valores por defecto; cada prueba cambia lo que necesita. */
function fila(cambios: Partial<FilaSicetac>): FilaSicetac {
  return {
    periodo: "202610",
    origen: "76520000",
    nombreOrigen: "PALMIRA",
    destino: "11001000",
    nombreDestino: "BOGOTA",
    condicionCarga: "1",
    configuracion: "3S3",
    tipoCarga: "1",
    nombreTipoCarga: "Granel Sólido",
    unidadTransporte: "1",
    nombreUnidadTransporte: "ESTACAS",
    kilometros: 450,
    valorMoviliza: 3_647_929,
    valorHora: 92_958,
    horasRecorrido: 10,
    esEstandar: true,
    rutasId: "11693",
    via: "El Cerrito, Guacari, Buga...",
    ...cambios,
  };
}

describe("calcularPisoSicetac", () => {
  // Caso real: manifiesto 00006775 (Palmira -> Bogota, 3S3, via 11693).
  const via11693 = { valorMoviliza: 3_647_929, valorHora: 92_958 };

  test("piso de despacho = movilizacion + valor hora x horas pactadas (4 h)", () => {
    // El flete del manifiesto 00006775 fue exactamente este valor y el RNDC lo acepto.
    expect(calcularPisoSicetac(via11693, 4)).toBe(4_019_761);
  });

  test("piso del cumplido con horas desde la LLEGADA (espera incluida)", () => {
    // Cargue llegada 05:30 -> salida 13:43 (493 min) + descargue 11:30 -> 13:30 (120 min).
    const horas = (493 + 120) / 60;
    const piso = calcularPisoSicetac(via11693, horas)!;
    expect(piso).toBe(4_597_650);
    // Lo que paso en produccion el 2026-10-06:
    expect(4_551_761).toBeLessThan(piso); // rechazado con CMA045
    expect(4_597_761).toBeGreaterThanOrEqual(piso); // aceptado (+$578.000)
  });

  test("contar desde la ENTRADA da un piso menor que el que exige el RNDC", () => {
    const desdeEntrada = calcularPisoSicetac(via11693, (463 + 120) / 60)!;
    expect(desdeEntrada).toBe(4_551_171);
    expect(desdeEntrada).toBeLessThan(calcularPisoSicetac(via11693, (493 + 120) / 60)!);
  });

  test("redondea hacia arriba: un peso de menos basta para que el RNDC rechace (MAN045)", () => {
    expect(calcularPisoSicetac({ valorMoviliza: 1000.2, valorHora: 0 }, 0)).toBe(1001);
  });

  test("sin valor de movilizacion no hay piso", () => {
    expect(calcularPisoSicetac({ valorMoviliza: null, valorHora: 92_958 }, 4)).toBeNull();
  });

  test("sin valor hora solo cuenta la movilizacion", () => {
    expect(calcularPisoSicetac({ valorMoviliza: 3_000_000, valorHora: null }, 4)).toBe(3_000_000);
  });
});

describe("horasPactadasTotales", () => {
  test("suma horas y minutos de cargue y descargue", () => {
    expect(horasPactadasTotales([{ horas: 1, minutos: 0 }, { horas: 1, minutos: 0 }])).toBe(2);
    expect(horasPactadasTotales([{ horas: 2, minutos: 30 }, { horas: 1, minutos: 30 }])).toBe(4);
  });

  test("sin tiempos es cero", () => {
    expect(horasPactadasTotales([])).toBe(0);
  });
});

describe("aCabeceraMunicipal", () => {
  test("lleva un codigo DIVIPOLA a la cabecera del municipio (termina en 000)", () => {
    expect(aCabeceraMunicipal("76520001")).toBe("76520000");
    expect(aCabeceraMunicipal("11001000")).toBe("11001000");
  });

  test("completa con ceros a la izquierda (Antioquia empieza por 05)", () => {
    expect(aCabeceraMunicipal("5001000")).toBe("05001000");
  });

  test("vacio devuelve null", () => {
    expect(aCabeceraMunicipal(null)).toBeNull();
    expect(aCabeceraMunicipal("")).toBeNull();
  });
});

describe("periodoDe", () => {
  test("periodo AAAAMM en hora de Colombia, no en UTC", () => {
    // 1 de octubre a las 03:00 UTC es todavia 30 de septiembre en Colombia.
    expect(periodoDe(new Date("2026-10-01T03:00:00Z"))).toBe("202609");
    expect(periodoDe(new Date("2026-10-01T06:00:00Z"))).toBe("202610");
  });
});

describe("filasDeLaOperacion", () => {
  test("compara el tipo de carga sin tildes ('Granel Sólido' = 'Granel Solido')", () => {
    const filas = [fila({ nombreTipoCarga: "Granel Sólido", valorMoviliza: 3_647_929 })];
    const elegidas = filasDeLaOperacion(filas, "ESTACAS", "Granel Solido");
    expect(elegidas).toHaveLength(1);
    expect(elegidas[0].valorMoviliza).toBe(3_647_929);
  });

  test("descarta las filas de vehiculo vacio, que tienen un piso mucho menor", () => {
    // Antes se caia a la fila mas barata ("Contenedor vacio") y el RNDC rechazaba (MAN045).
    const filas = [
      fila({ nombreTipoCarga: "Contenedor vacío", valorMoviliza: 900_000 }),
      fila({ nombreTipoCarga: "General", valorMoviliza: 3_500_000 }),
    ];
    const elegidas = filasDeLaOperacion(filas, "ESTACAS", "Granel Solido");
    expect(elegidas.map((f) => f.valorMoviliza)).toEqual([3_500_000]);
  });

  test("prefiere la unidad de transporte de la empresa", () => {
    const filas = [
      fila({ nombreUnidadTransporte: "FURGON", valorMoviliza: 4_000_000 }),
      fila({ nombreUnidadTransporte: "ESTACAS", valorMoviliza: 3_647_929 }),
    ];
    expect(filasDeLaOperacion(filas, "ESTACAS", "Granel Solido")[0].valorMoviliza).toBe(3_647_929);
  });

  test("una fila por via, la de piso mas alto; la estandar primero", () => {
    const filas = [
      fila({ rutasId: "12667", esEstandar: false, valorMoviliza: 3_871_274, nombreUnidadTransporte: "OTRA" }),
      fila({ rutasId: "11693", esEstandar: true, valorMoviliza: 3_600_000, nombreUnidadTransporte: "OTRA" }),
      fila({ rutasId: "11693", esEstandar: true, valorMoviliza: 3_647_929, nombreUnidadTransporte: "OTRA2" }),
    ];
    const elegidas = filasDeLaOperacion(filas, "ESTACAS", "Granel Solido");
    expect(elegidas.map((f) => f.rutasId)).toEqual(["11693", "12667"]);
    expect(elegidas[0].valorMoviliza).toBe(3_647_929);
  });
});
