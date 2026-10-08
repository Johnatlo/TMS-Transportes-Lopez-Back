import { describe, expect, test } from "vitest";
import {
  baseRetenciones,
  calcularFopat,
  calcularNetoAPagar,
  calcularRetencionFuente,
  construirDatosCumplidoManifiesto,
  decimalesDe,
  diasHabilesEntre,
  formatearFecha,
  formatearFechaCalendario,
  formatearHora,
  mismaIdentificacion,
  normalizarCodigoMercancia,
  plazoCumplido,
  porcentajeTopeAnulaciones,
  radicadoDeDuplicado,
  revisarCoordenadaSede,
  validarCumplidoRemesa,
  valorFinalCumplido,
} from "./builders";
import type { DatosCumplidoRemesa } from "./builders";

describe("fechas para el RNDC (hora de Colombia)", () => {
  // 03:00 UTC del 1 de octubre = 22:00 del 30 de septiembre en Colombia (UTC-5).
  const noche = new Date("2026-10-01T03:00:00Z");

  test("formatearFecha usa el dia de Colombia, no el de UTC", () => {
    expect(formatearFecha(noche)).toBe("30/09/2026");
  });

  test("formatearHora en formato militar, hora de Colombia", () => {
    expect(formatearHora(noche)).toBe("22:00");
    expect(formatearHora(new Date("2026-10-01T16:30:00Z"))).toBe("11:30");
  });

  test("formatearFechaCalendario no corre un dia las fechas sin hora (DATE)", () => {
    // Una columna DATE llega como medianoche UTC; en hora de Colombia seria el dia anterior.
    expect(formatearFechaCalendario(new Date("2026-09-30T00:00:00Z"))).toBe("30/09/2026");
  });
});

describe("diasHabilesEntre", () => {
  test("no cuenta sabados ni domingos", () => {
    // Viernes 2 -> lunes 5 de octubre de 2026: solo el lunes es habil.
    expect(diasHabilesEntre(new Date("2026-10-02T17:00:00Z"), new Date("2026-10-05T17:00:00Z"))).toBe(1);
  });

  test("una semana completa son 5 dias habiles", () => {
    expect(diasHabilesEntre(new Date("2026-10-05T17:00:00Z"), new Date("2026-10-12T17:00:00Z"))).toBe(5);
  });

  test("el mismo dia es cero", () => {
    expect(diasHabilesEntre(new Date("2026-10-05T13:00:00Z"), new Date("2026-10-05T20:00:00Z"))).toBe(0);
  });
});

describe("plazoCumplido (5 dias habiles)", () => {
  test("cuenta lo que queda y marca vencido despues del quinto dia", () => {
    const entrega = new Date("2026-10-05T17:00:00Z"); // lunes
    expect(plazoCumplido(entrega, new Date("2026-10-07T17:00:00Z"))).toEqual({
      diasHabilesTranscurridos: 2,
      diasHabilesRestantes: 3,
      vencido: false,
    });
    expect(plazoCumplido(entrega, new Date("2026-10-13T17:00:00Z")).vencido).toBe(true);
  });

  test("una entrega futura no consume plazo", () => {
    expect(plazoCumplido(new Date("2026-12-01T17:00:00Z"), new Date("2026-10-07T17:00:00Z")).diasHabilesRestantes).toBe(5);
  });
});

describe("retenciones y valores del manifiesto", () => {
  test("base de retenciones: valor a pagar menos los trayectos en vacio", () => {
    expect(baseRetenciones(4_000_000, 300_000, 200_000)).toBe(3_500_000);
    expect(baseRetenciones(100_000, 300_000)).toBe(0);
  });

  test("retencion en la fuente: 1% en pesos enteros", () => {
    // Manifiesto 00006765: flete 4.560.283 -> 45.603.
    expect(calcularRetencionFuente(4_560_283)).toBe(45_603);
  });

  test("regimen simple: retencion en la fuente cero", () => {
    expect(calcularRetencionFuente(4_560_283, 0.01, true)).toBe(0);
  });

  test("FOPAT: 0,1% redondeado al peso; null si el vehiculo no lo causa", () => {
    // Manifiesto 00006775: 4.019.761 -> 4.020.
    expect(calcularFopat(4_019_761, true)).toBe(4_020);
    expect(calcularFopat(4_019_761, false)).toBeNull();
  });

  test("neto a pagar: valor menos las tres retenciones", () => {
    expect(calcularNetoAPagar(4_597_761, 45_978, 0, 4_598)).toBe(4_547_185);
  });

  test("valor final del cumplido: flete + adicionales - descuento", () => {
    // 00006775: flete 4.019.761 + $578.000 por horas de cargue = 4.597.761 (paso en el RNDC).
    expect(valorFinalCumplido({ valorFlete: 4_019_761, valorAdicionalHorasCargue: 578_000 })).toBe(4_597_761);
    expect(
      valorFinalCumplido({
        valorFlete: 1_000_000,
        valorAdicionalHorasCargue: 50_000,
        valorAdicionalHorasDescargue: 20_000,
        valorAdicionalFlete: 10_000,
        valorDescuentoFlete: 30_000,
      })
    ).toBe(1_050_000);
  });
});

describe("construirDatosCumplidoManifiesto (proceso 6)", () => {
  const base = {
    numManifiesto: "00006775",
    fechaEntregaDocumentos: new Date("2026-10-06T17:00:00Z"),
    retencionFuente: 45_978,
    retencionFopat: 4_598,
  };

  test("cumplido normal con fecha de entrega, retenciones y via del manifiesto", () => {
    const d = construirDatosCumplidoManifiesto({ ...base, codVia: "11693", valorAdicionalHorasCargue: 578_000 });
    expect(d).toMatchObject({
      NUMMANIFIESTOCARGA: "00006775",
      TIPOCUMPLIDOMANIFIESTO: "C",
      FECHAENTREGADOCUMENTOS: "06/10/2026",
      CODVIA: "11693",
      VALORADICIONALHORASCARGUE: 578_000,
      RETENCIONFUENTEMANIFIESTO: 45_978,
      RETENCIONFOPAT: 4_598,
    });
  });

  test("los ceros y vacios no se envian (quedan en null)", () => {
    const d = construirDatosCumplidoManifiesto({ ...base, valorAdicionalHorasCargue: 0, observaciones: "  " });
    expect(d.VALORADICIONALHORASCARGUE).toBeNull();
    expect(d.CODVIA).toBeNull();
    expect(d.OBSERVACIONES).toBeNull();
  });

  test("el motivo solo va si hay valor adicional o descuento", () => {
    const sin = construirDatosCumplidoManifiesto({ ...base, motivoValorAdicional: "R", motivoDescuento: "T" });
    expect(sin.MOTIVOVALORADICIONAL).toBeNull();
    expect(sin.MOTIVOVALORDESCUENTOMANIFIESTO).toBeNull();
    const con = construirDatosCumplidoManifiesto({
      ...base,
      valorAdicionalFlete: 10_000,
      motivoValorAdicional: "R",
      valorDescuentoFlete: 5_000,
      motivoDescuento: "T",
    });
    expect(con.MOTIVOVALORADICIONAL).toBe("R");
    expect(con.MOTIVOVALORDESCUENTOMANIFIESTO).toBe("T");
  });

  test("vehiculo sin FOPAT: la etiqueta no se envia", () => {
    expect(construirDatosCumplidoManifiesto({ ...base, retencionFopat: null }).RETENCIONFOPAT).toBeNull();
  });
});

describe("validarCumplidoRemesa", () => {
  const ahora = new Date("2026-10-07T17:00:00Z");
  const ok: DatosCumplidoRemesa = {
    consecutivoRemesa: "00006775",
    cantidadCargada: 34_000,
    cantidadEntregada: 34_000,
    entradaCargue: new Date("2026-10-05T11:00:00Z"),
    entradaDescargue: new Date("2026-10-06T16:30:00Z"),
  };

  test("un cumplido correcto no tiene problemas", () => {
    expect(validarCumplidoRemesa(ok, ahora)).toEqual([]);
  });

  test("kilos entregados: mayor a cero, al menos 10% y como maximo el doble de lo cargado", () => {
    expect(validarCumplidoRemesa({ ...ok, cantidadEntregada: 0 }, ahora)).toHaveLength(1);
    expect(validarCumplidoRemesa({ ...ok, cantidadEntregada: 3_000 }, ahora)[0]).toMatch(/10%/);
    expect(validarCumplidoRemesa({ ...ok, cantidadEntregada: 70_000 }, ahora)[0]).toMatch(/doble/);
  });

  test("las entradas no pueden ser futuras", () => {
    const futuro = { ...ok, entradaDescargue: new Date("2026-10-09T12:00:00Z") };
    expect(validarCumplidoRemesa(futuro, ahora)).toContain("Las fechas de entrada no pueden ser futuras.");
  });

  test("la entrada al descargue debe ser despues de la del cargue", () => {
    const alReves = { ...ok, entradaDescargue: new Date("2026-10-04T12:00:00Z") };
    expect(validarCumplidoRemesa(alReves, ahora)).toContain(
      "La entrada al descargue debe ser posterior a la entrada al cargue."
    );
  });

  test("sin fechas de entrada", () => {
    const sinFechas = { ...ok, entradaCargue: new Date("x") };
    expect(validarCumplidoRemesa(sinFechas, ahora)).toEqual(["Faltan la fecha y hora de entrada al cargue o al descargue."]);
  });
});

describe("radicadoDeDuplicado", () => {
  test("toma el radicado de un documento que ya existia en el RNDC", () => {
    expect(radicadoDeDuplicado("Error REM030: DUPLICADO:168864148 La remesa ya existe")).toBe("168864148");
    expect(radicadoDeDuplicado("duplicado: 119242852")).toBe("119242852");
  });

  test("cualquier otro error no es un duplicado", () => {
    expect(radicadoDeDuplicado("Error CMA045: valor a pagar menor a SICETAC")).toBeNull();
    expect(radicadoDeDuplicado(null)).toBeNull();
  });
});

describe("coordenadas de sedes", () => {
  test("cuenta los decimales", () => {
    expect(decimalesDe(3.45123)).toBe(5);
    expect(decimalesDe(-76.123456)).toBe(6);
    expect(decimalesDe(4)).toBe(0);
  });

  test("avisa si faltan decimales, pero nunca bloquea", () => {
    const r = revisarCoordenadaSede(3.45123, -76.53201, "Sede PRINCI");
    expect(r.ok).toBe(false);
    expect(r.bloqueante).toBe(false);
    expect(r.problema).toMatch(/6/);
  });

  test("detecta coordenadas fuera de Colombia (latitud y longitud invertidas)", () => {
    expect(revisarCoordenadaSede(-76.532012, 3.451234, "Sede").problema).toMatch(/fuera de Colombia/);
  });

  test("una coordenada correcta pasa", () => {
    expect(revisarCoordenadaSede(3.451234, -76.532012, "Sede")).toEqual({ ok: true, bloqueante: false, problema: null });
  });
});

describe("otras utilidades", () => {
  test("el NIT se compara con o sin digito de verificacion", () => {
    expect(mismaIdentificacion("901319583", "9013195831")).toBe(true);
    expect(mismaIdentificacion("901319583", "800123456")).toBe(false);
    expect(mismaIdentificacion(null, "901319583")).toBe(false);
  });

  test("codigo de mercancia con dos ceros a la izquierda", () => {
    expect(normalizarCodigoMercancia("4805")).toBe("004805");
    expect(normalizarCodigoMercancia("004805")).toBe("004805");
    expect(normalizarCodigoMercancia("")).toBeNull();
  });

  test("tope de anulaciones segun manifiestos expedidos en el mes", () => {
    expect(porcentajeTopeAnulaciones(100)).toBe(0.3);
    expect(porcentajeTopeAnulaciones(500)).toBe(0.2);
    expect(porcentajeTopeAnulaciones(2_500)).toBe(0.1);
  });
});
