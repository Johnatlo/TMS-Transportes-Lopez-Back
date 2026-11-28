import { describe, expect, test, vi } from "vitest";

// Estas pruebas no tocan la base de datos.
vi.mock("./db", () => ({ pool: {} }));

import { CLIENTES_ZORRO, esUrbano, estadoAnticipoEmpresa, estadoDe } from "./cuadro";
import type { FilaCuadro } from "./cuadro";
import type { AlertaDocumento } from "./alertas";
import {
  cifrasDelMes,
  diasDeCobro,
  grupo,
  MAX_ITEMS_GRUPO,
  mesAnterior,
  partesDelRol,
  prioridadDocumentos,
  prioridadFacturacion,
  prioridadIncidencias,
  prioridadPapeles,
} from "./inicioResumen";
import { validarDocumento } from "./documentosEmpresa";

const HOY = "2026-11-28";

/** Viaje de CORAME descargado ayer, papeles con el conductor; cada prueba cambia lo que necesita. */
function fila(cambios: Partial<FilaCuadro> = {}): FilaCuadro {
  const base = {
    id: 1,
    fecha: "2026-11-20",
    vehiculoId: 1,
    placa: "SKN250",
    flota: "TERCERO" as const,
    configuracion: "3S3",
    producto: null,
    fleteManual: false,
    tarifasPosibles: [],
    dueno: null,
    conductor: null,
    ruta: null,
    rutaManual: null,
    concepto: null,
    reconocidoDe: null,
    empresa: "CARTONES AMERICA",
    viajeId: 1,
    viajeRemesaId: 1,
    manifiesto: "00006775",
    remesa: "00006775",
    remision: null,
    remisionUrl: null,
    facturaUrl: null,
    pesoKg: 34_000,
    tipoFlete: "KILO" as const,
    tarifaKilo: 100,
    valorFijo: null,
    fleteAdicional: null,
    anticipoEmpresa: null,
    anticipoEmpresaFechaPago: null,
    anticipoEmpresaNoAplica: false,
    valorFlete: 3_400_000,
    fechaDescargue: "2026-11-21",
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
    valorTerceroTon: null,
    valorTerceroFijo: null,
    anticipoTransferencia: null,
    anticipoTransferenciaFecha: null,
    anticipoTransferenciaLink: null,
    fechaEntregaDocsTercero: null,
    cuentaCobroTercero: null,
    aplicaDescuentosTercero: false,
    icaTerceroPorMil: null,
    fechaPagoTerceroProgramada: null,
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
    tarifaFlete: null,
    notaFactura: null,
    enviadoFacturarEn: null,
    ...cambios,
  };
  return {
    ...base,
    ...estadoDe(base),
    estadoAnticipoEmpresa: estadoAnticipoEmpresa(base),
    anticipoEmpresaABomba: CLIENTES_ZORRO.test(base.empresa),
    urbano: esUrbano(base),
  };
}

/** Alerta de documento con lo minimo. */
function alerta(entidad: AlertaDocumento["origen"]["entidad"], dias: number, mensaje = "SOAT de SKN250 vence pronto"): AlertaDocumento {
  return {
    tipo: entidad === "conductor" ? "LICENCIA" : entidad === "empresa" ? "POLIZA" : "SOAT",
    sujeto: "x",
    identificacion: null,
    fechaVencimiento: null,
    diasRestantes: dias,
    severidad: dias < 0 ? "VENCIDO" : "POR_VENCER",
    mensaje,
    origen: { entidad, id: 1, campo: "fechaVencSoat" },
    activo: true,
  };
}

describe("Sofi te cuenta", () => {
  test("documentos: separa flota, conductores y empresas; urgente a 7 dias o menos", () => {
    const p = prioridadDocumentos(
      [alerta("vehiculo", 20), alerta("vehiculo", 3), alerta("conductor", -2), alerta("empresa", 10)],
      [
        { id: 1, empresa: "MYC", nombre: "Camara de comercio", numero: "123", fechaVencimiento: "2026-12-05", nota: null },
        { id: 2, empresa: "LOPEZ", nombre: "Habilitacion", numero: null, fechaVencimiento: "2027-06-01", nota: null },
        { id: 3, empresa: "LOPEZ", nombre: "Sin fecha", numero: null, fechaVencimiento: null, nota: null },
      ],
      HOY,
    );
    expect(p.numero).toBe(1);
    const [flota, conductores, empresas] = p.grupos;
    expect(flota.total).toBe(2);
    expect(flota.urgentes).toBe(1);
    expect(conductores.items[0].nivel).toBe("urgente");
    // La poliza de Lopez y la camara de M&C (la habilitacion vence en mas de 30 dias; la sin fecha no avisa).
    expect(empresas.items.map((i) => i.texto)).toEqual([
      "Camara de comercio de Transportes M&C vence en 7 dia(s)",
      "Poliza de carga de Transportes Lopez vence en 10 dia(s)",
    ]);
    expect(empresas.items[0].nivel).toBe("urgente");
  });

  test("papeles: los que se deben y los que ya entrego el conductor", () => {
    const p = prioridadPapeles(
      [
        fila({ id: 1, estadoPapeles: "CONDUCTOR" }),
        fila({ id: 2, estadoPapeles: "OFICINA" }),
        fila({ id: 3, estadoPapeles: "PARQUEADERO", fechaDescargue: "2026-11-27" }),
        fila({ id: 4, estadoPapeles: "RADICADO" }),
        fila({ id: 5, estadoPapeles: "OFICINA", facturaNumero: "F1" }),
      ],
      HOY,
      "2026-10-01",
    );
    const [deben, entregados] = p.grupos;
    expect(deben.items.map((i) => i.ruta)).toEqual(["/cuadro?papeles=1"]);
    // Descargo hace 7 dias (urgente) y ayer (atencion); el facturado ya no cuenta.
    expect(entregados.total).toBe(2);
    expect(entregados.items[0]).toMatchObject({ nivel: "urgente", ruta: "/cuadro?papeles=2" });
    expect(entregados.items[1].nivel).toBe("atencion");
  });

  test("facturacion: listos para facturar aparte de los enviados sin factura", () => {
    const p = prioridadFacturacion(
      [
        fila({ id: 1, estadoPapeles: "RADICADO", fechaRadicado: "2026-11-27" }),
        fila({ id: 2, estadoPapeles: "RADICADO", enviadoFacturarEn: "2026-11-27T10:00:00Z" }),
      ],
      HOY,
      "2026-10-01",
    );
    expect(p.grupos[0].items.map((i) => i.ruta)).toEqual(["/cuadro?viaje=1"]);
    expect(p.grupos[1].items.map((i) => i.ruta)).toEqual(["/cuadro?viaje=2"]);
  });

  test("incidencias: errores del RNDC, sincronizacion y lo que SOFI dejo para revisar", () => {
    const p = prioridadIncidencias({
      viajes: [{ id: 9, estado: "MANIFIESTO_ERROR", placa: "SKN250", consecutivoManifiesto: "100", dia: "2026-11-25", mensajeError: "MAN006" }],
      contingencias: [],
      cumplidosVencidos: [{ id: 3, placa: "TLN860", consecutivoManifiesto: "90", dias: 7 }],
      errorSincronizacion: "RNDC caido",
      fletesAutomaticos: 2,
      vueltasSinViaje: 0,
    });
    const [rndc, sistema] = p.grupos;
    expect(rndc.items[0].texto).toBe("SKN250 · manifiesto 100: Error en manifiesto desde el 25/11");
    expect(rndc.total).toBe(2);
    expect(sistema.items.map((i) => i.nivel)).toEqual(["urgente", "atencion"]);
  });

  test("un grupo muestra los urgentes primero y corta la lista", () => {
    const items = Array.from({ length: 8 }, (_, i) => ({ nivel: (i === 7 ? "urgente" : "atencion") as "urgente" | "atencion", texto: String(i), ruta: "/" }));
    const g = grupo("x", items, "/");
    expect(g.total).toBe(8);
    expect(g.items).toHaveLength(MAX_ITEMS_GRUPO);
    expect(g.items[0].texto).toBe("7");
  });
});

describe("cifras y cobros", () => {
  test("cifras del mes: compara con el mes anterior hasta el mismo dia y filtra por rol", () => {
    const c = cifrasDelMes(
      [
        fila({ id: 1, fecha: "2026-11-05", valorFlete: 1_000_000, facturaNumero: "F1", facturaFecha: "2026-11-10" }),
        fila({ id: 2, fecha: "2026-10-27", valorFlete: 500_000, facturaNumero: "F0", facturaFecha: "2026-10-30", facturaFechaPago: "2026-11-15" }),
        fila({ id: 3, fecha: "2026-10-29", valorFlete: 700_000 }),
        fila({ id: 4, fecha: "2026-11-06", valorFlete: 900_000, placa: "OTRA" }),
      ],
      HOY,
      (placa) => placa !== "OTRA",
      "2026-10-01",
    );
    expect(c).toMatchObject({ mes: "2026-11", viajes: 1, fletes: 1_000_000, viajesMesAnteriorAlDia: 1, fletesMesAnteriorAlDia: 500_000 });
    expect(c).toMatchObject({ facturado: 1_000_000, cobrado: 500_000, porCobrar: 1_000_000, sinFacturar: 700_000 });
  });

  test("dias de cobro: lo vencido aparte y lo proximo por dia", () => {
    const c = diasDeCobro(
      [
        { facturaNumero: "1", cliente: "A", vence: "2026-11-20", valor: 100, diasVencida: 8 },
        { facturaNumero: "2", cliente: "B", vence: "2026-12-01", valor: 200, diasVencida: 0 },
        { facturaNumero: "3", cliente: "C", vence: "2026-12-01", valor: 300, diasVencida: 0 },
        { facturaNumero: "4", cliente: "D", vence: "2027-01-30", valor: 400, diasVencida: 0 },
      ],
      HOY,
    );
    expect(c.vencido).toEqual({ total: 100, facturas: 1, clientes: 1 });
    expect(c.proximos).toHaveLength(1);
    expect(c.proximos[0]).toMatchObject({ fecha: "2026-12-01", total: 500 });
  });

  test("mes anterior cruza el ano", () => {
    expect(mesAnterior("2026-01")).toBe("2025-12");
    expect(mesAnterior("2026-11")).toBe("2026-10");
  });

  test("partes por rol: las administrativas no ven dinero", () => {
    expect(partesDelRol("ADMINISTRATIVO")).toEqual(["sofi", "cobros"]);
    expect(partesDelRol("MYC")).toEqual(["sofi", "cifras", "cobros", "rentabilidad", "reparto"]);
    expect(partesDelRol("TOTAL")).toEqual(["sofi", "cifras", "cobros", "rentabilidad", "reparto"]);
  });
});

describe("documentos de las empresas", () => {
  test("valida la empresa, el nombre y la fecha", () => {
    expect(validarDocumento({ empresa: "myc", nombre: " Camara ", fechaVencimiento: "2026-12-01" })).toEqual({
      empresa: "MYC",
      nombre: "Camara",
      numero: null,
      fechaVencimiento: "2026-12-01",
      nota: null,
    });
    expect(() => validarDocumento({ empresa: "OTRA", nombre: "x" })).toThrow(/empresa/);
    expect(() => validarDocumento({ empresa: "LOPEZ", nombre: "" })).toThrow(/nombre/);
    expect(() => validarDocumento({ empresa: "LOPEZ", nombre: "x", fechaVencimiento: "01/12/2026" })).toThrow(/fecha/);
  });
});
