import { describe, expect, test, vi } from "vitest";

// terceros importa la conexion a MySQL; estas pruebas no tocan la base.
vi.mock("./db", () => ({ pool: {} }));

import { estadoPagoTercero, icaSugerido, liquidar, resumirTerceros, viernesDePago } from "./terceros";
import type { ViajeTercero } from "./terceros";

/** Viaje de tercero sin nada pactado; cada prueba cambia lo que necesita. */
const viaje = (cambios: Partial<Parameters<typeof liquidar>[0]> = {}): Parameters<typeof liquidar>[0] => ({
  empresa: "CORAME",
  pesoKg: 32_884,
  valorTerceroTon: null,
  valorTerceroFijo: null,
  anticipoTransferencia: null,
  aplicaDescuentosTercero: false,
  icaTerceroPorMil: null,
  ...cambios,
});

describe("viernesDePago", () => {
  test("lunes y martes: el viernes de esa semana", () => {
    expect(viernesDePago("2026-10-19")).toBe("2026-10-23");
    expect(viernesDePago("2026-10-20")).toBe("2026-10-23");
  });

  test("de miercoles a domingo: el viernes de la semana siguiente", () => {
    expect(viernesDePago("2026-10-21")).toBe("2026-10-30");
    expect(viernesDePago("2026-10-23")).toBe("2026-10-30");
    expect(viernesDePago("2026-10-24")).toBe("2026-10-30");
    expect(viernesDePago("2026-10-25")).toBe("2026-10-30");
  });
});

describe("liquidar", () => {
  test("valor fijo menos efectivo y combustible (Edier SWM-227, manifiesto 00006699)", () => {
    const l = liquidar(viaje({ valorTerceroFijo: 5_750_000 }), { efectivo: 3_325_000, combustible: 700_000 });
    expect(l.valorTercero).toBe(5_750_000);
    expect(l.valorAPagar).toBe(1_725_000);
  });

  test("por tonelada (Aura TLN-362, manifiesto 00005991)", () => {
    const l = liquidar(viaje({ empresa: "RECOLAM", pesoKg: 33_200, valorTerceroTon: 100_000 }), { efectivo: 1_100_000, combustible: 1_100_000 });
    expect(l.valorTercero).toBe(3_320_000);
    expect(l.valorAPagar).toBe(1_120_000);
    expect(l.ica).toBe(0); // RECOLAM no lleva ICA
  });

  test("el fijo manda sobre el de por tonelada", () => {
    expect(liquidar(viaje({ valorTerceroTon: 200_000, valorTerceroFijo: 5_000_000 }), { efectivo: 0, combustible: 0 }).valorTercero).toBe(5_000_000);
  });

  test("las retenciones se muestran siempre pero solo se restan si aplican", () => {
    const sin = liquidar(viaje({ valorTerceroFijo: 5_000_000 }), { efectivo: 0, combustible: 0 });
    // Retefuente 1 % + ICA 3,3 por mil (CORAME) + FOPAT 0,1 % + poliza.
    expect([sin.retefuente, sin.ica, sin.fopat, sin.poliza]).toEqual([50_000, 16_500, 5_000, 3_000]);
    expect(sin.valorAPagar).toBe(5_000_000);
    const con = liquidar(viaje({ valorTerceroFijo: 5_000_000, aplicaDescuentosTercero: true }), { efectivo: 0, combustible: 0 });
    expect(con.valorAPagar).toBe(5_000_000 - 74_500);
  });

  test("la transferencia es un tercer anticipo", () => {
    expect(liquidar(viaje({ valorTerceroFijo: 5_000_000, anticipoTransferencia: 400_000 }), { efectivo: 1_000_000, combustible: 0 }).valorAPagar).toBe(3_600_000);
  });

  test("el ICA del viaje manda sobre el sugerido", () => {
    expect(liquidar(viaje({ valorTerceroFijo: 1_000_000, icaTerceroPorMil: 8 }), { efectivo: 0, combustible: 0 }).ica).toBe(8_000);
  });

  test("sin pactar no hay valor a pagar", () => {
    const l = liquidar(viaje(), { efectivo: 500_000, combustible: 0 });
    expect(l.valorTercero).toBeNull();
    expect(l.valorAPagar).toBeNull();
  });
});

describe("icaSugerido", () => {
  test("por cliente, como en la matriz", () => {
    expect(icaSugerido("CORAME")).toBe(3.3);
    expect(icaSugerido("BODEGAS DE RECICLAJE")).toBe(4);
    expect(icaSugerido("CENCORE")).toBe(8);
    expect(icaSugerido("APROREC")).toBe(0);
  });
});

describe("estadoPagoTercero", () => {
  const pactado = { valorTercero: 1_000_000 };
  const hoy = "2026-10-20";
  test("en orden: pagado, falta pactar, faltan documentos, vencido, por pagar", () => {
    const f = { fechaPagoSaldo: null, fechaEntregaDocsTercero: "2026-10-15", venceSaldo: "2026-10-23" };
    expect(estadoPagoTercero({ ...f, fechaPagoSaldo: "2026-10-16" }, pactado, hoy)).toBe("PAGADO");
    expect(estadoPagoTercero(f, { valorTercero: null }, hoy)).toBe("FALTA_PACTAR");
    expect(estadoPagoTercero({ ...f, fechaEntregaDocsTercero: null }, pactado, hoy)).toBe("FALTAN_DOCUMENTOS");
    expect(estadoPagoTercero({ ...f, venceSaldo: "2026-10-16" }, pactado, hoy)).toBe("VENCIDO");
    expect(estadoPagoTercero(f, pactado, hoy)).toBe("POR_PAGAR");
  });
});

describe("resumirTerceros", () => {
  test("suma por tercero lo listo para pagar y cuenta lo que falta", () => {
    const v = (tercero: string, placa: string, estadoPagoTercero: ViajeTercero["estadoPagoTercero"], valorAPagar: number | null) =>
      ({ tercero, placa, estadoPagoTercero, valorAPagar }) as ViajeTercero;
    const r = resumirTerceros([
      v("ANA", "VZI168", "POR_PAGAR", 1_000),
      v("ANA", "VZI168", "VENCIDO", 500),
      v("ANA", "XJA411", "FALTAN_DOCUMENTOS", 2_000),
      v("BETO", "TNC172", "FALTA_PACTAR", null),
      v("BETO", "TNC172", "PAGADO", 9_000),
    ]);
    expect(r[0]).toMatchObject({ tercero: "ANA", placas: ["VZI168", "XJA411"], viajes: 3, porPagar: 1_500, vencido: 500, faltanDocumentos: 1 });
    expect(r[1]).toMatchObject({ tercero: "BETO", porPagar: 0, faltaPactar: 1 });
  });
});
