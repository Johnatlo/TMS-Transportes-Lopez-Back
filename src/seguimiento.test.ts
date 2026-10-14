import { describe, expect, test, vi } from "vitest";

// Estas pruebas no tocan la base de datos.
vi.mock("./db", () => ({ pool: {} }));

import { estadoDe } from "./cuadro";
import type { FilaCuadro } from "./cuadro";
import {
  agruparCartera,
  alertaFactura,
  alertaFacturacion,
  alertaPapeles,
  alertasDe,
  diasEntre,
  resumirPorCliente,
} from "./seguimiento";

const HOY = "2026-10-10";

/** Viaje de CORAME descargado ayer, papeles con el conductor; cada prueba cambia lo que necesita. */
function fila(cambios: Partial<FilaCuadro> = {}): FilaCuadro {
  const base = {
    id: 1,
    fecha: "2026-10-08",
    vehiculoId: 1,
    placa: "SKN250",
    flota: "TERCERO" as const,
    conductor: null,
    empresa: "CARTONES AMERICA",
    viajeId: 1,
    viajeRemesaId: 1,
    manifiesto: "00006775",
    remesa: "00006775",
    remision: null,
    pesoKg: 34_000,
    tipoFlete: "KILO" as const,
    tarifaKilo: 100,
    valorFijo: null,
    valorFlete: 3_400_000,
    fechaDescargue: "2026-10-09",
    estadoPapeles: "CONDUCTOR" as const,
    flujoCorame: true,
    fechaRadicado: null,
    facturado: false,
    facturaNumero: null,
    facturaFecha: null,
    facturaVence: null,
    facturaFechaPago: null,
    fechaPagoSaldo: null,
    venceSaldo: null,
    revisadoContabilidadPor: null,
    revisadoContabilidadEn: null,
    revisadoGerenciaPor: null,
    revisadoGerenciaEn: null,
    anulado: false,
    totalAnticipos: 0,
    anticiposSinPagar: 0,
    notas: 0,
    ultimaNota: null,
    papelesTiene: null,
    papelesCompletos: null,
    papelesFaltan: null,
    papelesRevisadoEn: null,
    papelesRevisadoPor: null,
    pesoFacturadoKg: null,
    tarifaFleteId: null,
    notaFactura: null,
    enviadoFacturarEn: null,
    ...cambios,
  };
  return { ...base, ...estadoDe(base) };
}

describe("diasEntre", () => {
  test("cuenta dias de calendario y es negativo hacia atras", () => {
    expect(diasEntre("2026-10-01", "2026-10-31")).toBe(30);
    expect(diasEntre("2026-10-10", "2026-10-09")).toBe(-1);
  });
});

describe("alerta de papeles", () => {
  test("CORAME descargado y nadie ha preguntado: comunicarse con el conductor", () => {
    const a = alertaPapeles(fila(), HOY)!;
    expect(a.comunicarse).toBe(true);
    expect(a.nivel).toBe("atencion");
  });

  test("ya se pregunto hoy (hora Colombia): no hay alerta", () => {
    // 2026-10-10 14:00 en Colombia = 19:00 UTC.
    expect(alertaPapeles(fila({ papelesRevisadoEn: "2026-10-10T19:00:00.000Z" }), HOY)).toBeNull();
  });

  test("se pregunto ayer en la noche de Colombia (ya hoy en UTC): hay que volver a preguntar", () => {
    // 2026-10-09 22:00 en Colombia = 2026-10-10 03:00 UTC.
    expect(alertaPapeles(fila({ papelesRevisadoEn: "2026-10-10T03:00:00.000Z" }), HOY)?.comunicarse).toBe(true);
  });

  test("faltan papeles: urgente; se calla el dia en que se pregunto y vuelve al dia siguiente", () => {
    const faltan = { papelesCompletos: false, papelesFaltan: "cumplido firmado" };
    expect(alertaPapeles(fila({ ...faltan, papelesRevisadoEn: "2026-10-10T19:00:00.000Z" }), HOY)).toBeNull();
    const a = alertaPapeles(fila({ ...faltan, papelesRevisadoEn: "2026-10-09T19:00:00.000Z" }), HOY)!;
    expect(a.nivel).toBe("urgente");
    expect(a.comunicarse).toBe(true);
    expect(a.motivos.join(" ")).toContain("cumplido firmado");
  });

  test("descargo hace 5 dias o mas: urgente", () => {
    expect(alertaPapeles(fila({ fechaDescargue: "2026-10-05" }), HOY)?.nivel).toBe("urgente");
  });

  test("otros clientes: tambien desde el dia del descargue, todos los dias", () => {
    const otro = { flujoCorame: false, empresa: "SMURFIT" };
    expect(alertaPapeles(fila({ ...otro, fechaDescargue: HOY }), HOY)?.comunicarse).toBe(true);
    expect(alertaPapeles(fila({ ...otro, papelesRevisadoEn: "2026-10-09T19:00:00.000Z" }), HOY)?.comunicarse).toBe(true);
  });

  test("en ruta sin descargar, listo para facturar, facturado o anulado: sin alerta de papeles", () => {
    expect(alertaPapeles(fila({ estadoPapeles: "EN_RUTA", fechaDescargue: "2026-10-12" }), HOY)).toBeNull();
    expect(alertaPapeles(fila({ estadoPapeles: "RADICADO" }), HOY)).toBeNull();
    expect(alertaPapeles(fila({ facturado: true }), HOY)).toBeNull();
    expect(alertaPapeles(fila({ anulado: true }), HOY)).toBeNull();
  });

  test("viaje cargado antes de la fecha de inicio del seguimiento: sin alertas", () => {
    expect(alertaPapeles(fila({ fecha: "2026-09-20", fechaDescargue: "2026-09-22" }), HOY, "2026-10-01")).toBeNull();
    expect(alertaFacturacion(fila({ fecha: "2026-09-20", facturado: true }), HOY, "2026-10-01")).toBeNull();
    expect(alertaPapeles(fila(), HOY, "2026-10-01")).not.toBeNull();
  });

  test("en ruta pero la fecha de descargue ya paso: cuenta como descargado", () => {
    expect(alertaPapeles(fila({ estadoPapeles: "EN_RUTA" }), HOY)?.comunicarse).toBe(true);
  });
});

describe("alerta de facturacion", () => {
  test("radicados (CORAME): sin alerta de papeles y entra en por facturar", () => {
    expect(alertaPapeles(fila({ estadoPapeles: "RADICADOS" }), HOY)).toBeNull();
    expect(alertaFacturacion(fila({ estadoPapeles: "RADICADOS", fechaRadicado: HOY }), HOY)).not.toBeNull();
  });

  test("listo para facturar sin factura: avisa desde el mismo dia, urgente desde el quinto", () => {
    expect(alertaFacturacion(fila({ estadoPapeles: "RADICADO", fechaRadicado: HOY }), HOY)?.nivel).toBe("atencion");
    expect(alertaFacturacion(fila({ estadoPapeles: "RADICADO", fechaRadicado: "2026-10-05" }), HOY)?.nivel).toBe("urgente");
  });

  test("facturado sin numero o sin fecha no puede entrar a cartera", () => {
    expect(alertaFacturacion(fila({ facturado: true }), HOY)?.motivos[0]).toContain("numero");
    expect(alertaFacturacion(fila({ facturado: true, facturaNumero: "FE-10" }), HOY)?.motivos[0]).toContain("fecha");
    expect(alertaFacturacion(fila({ facturado: true, facturaNumero: "FE-10", facturaFecha: "2026-10-01" }), HOY)).toBeNull();
  });
});

describe("alerta de una factura", () => {
  test("vencida: urgente", () => {
    expect(alertaFactura("2026-10-01", null, HOY)?.nivel).toBe("urgente");
  });
  test("antes de que pase la fecha pago cliente (y el dia mismo) no avisa", () => {
    expect(alertaFactura("2026-10-15", null, HOY)).toBeNull();
    expect(alertaFactura(HOY, null, HOY)).toBeNull();
  });
  test("pasada la fecha pago cliente: llamar y cobrar", () => {
    expect(alertaFactura("2026-10-09", null, HOY)?.motivos[0]).toContain("llamar al cliente y cobrar");
  });
  test("con gestion de cobro hoy: se calla hasta manana, aunque este vencida", () => {
    expect(alertaFactura("2026-10-01", null, HOY, true)).toBeNull();
  });
  test("compromiso de pago que ya paso sin pago: urgente aunque no haya vencido", () => {
    expect(alertaFactura("2026-11-30", "2026-10-09", HOY)?.nivel).toBe("urgente");
    expect(alertaFactura("2026-11-30", HOY, HOY)).toBeNull();
  });
});

describe("cartera", () => {
  const facturada = (id: number, cambios: Partial<FilaCuadro> = {}) =>
    fila({ id, estadoPapeles: "RADICADO", facturado: true, facturaNumero: "FE-1", facturaFecha: "2026-09-01", ...cambios });

  test("agrupa por factura y empresa, suma los fletes y vence a los dias de credito del cliente", () => {
    const facturas = agruparCartera(
      [facturada(1), facturada(2, { valorFlete: 1_000_000 }), facturada(3, { facturaNumero: "FE-2" })],
      new Map([["CARTONES AMERICA", 45]]),
      new Map(),
      HOY
    );
    expect(facturas).toHaveLength(2);
    const fe1 = facturas.find((f) => f.facturaNumero === "FE-1")!;
    expect(fe1.valor).toBe(4_400_000);
    expect(fe1.viajes).toHaveLength(2);
    expect(fe1.vence).toBe("2026-10-16");
    expect(fe1.diasVencida).toBe(-6);
  });

  test("la fecha pago cliente escrita en el cuadro manda sobre los dias de credito", () => {
    const [f] = agruparCartera([facturada(1, { facturaVence: "2026-10-20" })], new Map([["CARTONES AMERICA", 45]]), new Map(), HOY);
    expect(f.vence).toBe("2026-10-20");
    expect(f.venceManual).toBe(true);
    expect(f.alerta).toBeNull();
  });

  test("sin plazo configurado: 30 dias", () => {
    const [f] = agruparCartera([facturada(1)], new Map(), new Map(), HOY);
    expect(f.vence).toBe("2026-10-01");
    expect(f.diasVencida).toBe(9);
    expect(f.alerta?.nivel).toBe("urgente");
  });

  test("no entran los pagados, anulados ni los que no tienen numero o fecha", () => {
    const filas = [
      facturada(1, { facturaFechaPago: "2026-10-02" }),
      facturada(2, { anulado: true }),
      facturada(3, { facturaFecha: null }),
      fila({ id: 4 }),
    ];
    expect(agruparCartera(filas, new Map(), new Map(), HOY)).toHaveLength(0);
  });

  test("una gestion de cobro de hoy (hora Colombia) calla la factura; una de ayer no", () => {
    const gestion = (creadaEn: string) =>
      new Map([["FE-1|CARTONES AMERICA", { id: 1, facturaNumero: "FE-1", empresa: "CARTONES AMERICA", texto: "llame", compromisoPago: null, autor: null, creadaEn }]]);
    expect(agruparCartera([facturada(1)], new Map(), gestion("2026-10-10T15:00:00.000Z"), HOY)[0].alerta).toBeNull();
    // 2026-10-09 22:00 en Colombia: fue ayer.
    expect(agruparCartera([facturada(1)], new Map(), gestion("2026-10-10T03:00:00.000Z"), HOY)[0].alerta).not.toBeNull();
  });

  test("cuenta los viajes sin valor de flete", () => {
    const [f] = agruparCartera([facturada(1, { valorFlete: null })], new Map(), new Map(), HOY);
    expect(f.valor).toBe(0);
    expect(f.viajesSinValor).toBe(1);
  });

  test("totales por cliente por edades de vencimiento", () => {
    const facturas = agruparCartera(
      [
        facturada(1, { facturaNumero: "A", facturaFecha: "2026-10-01" }), // vence 31/10: por vencer
        facturada(2, { facturaNumero: "B", facturaFecha: "2026-08-20" }), // vencida 21 dias
        facturada(3, { facturaNumero: "C", facturaFecha: "2026-06-01" }), // vencida 101 dias
      ],
      new Map(),
      new Map(),
      HOY
    );
    const [r] = resumirPorCliente(facturas);
    expect(r.facturas).toBe(3);
    expect(r.total).toBe(10_200_000);
    expect(r.porVencer).toBe(3_400_000);
    expect(r.vencido1a30).toBe(3_400_000);
    expect(r.vencidoMas90).toBe(3_400_000);
  });
});

describe("lista de alertas", () => {
  test("las urgentes van primero", () => {
    const filas = [fila({ id: 1 }), fila({ id: 2, fechaDescargue: "2026-10-01" })];
    const alertas = alertasDe(filas, [], HOY);
    expect(alertas.map((a) => a.cuadroId)).toEqual([2, 1]);
    expect(alertas[0].nivel).toBe("urgente");
  });
});
