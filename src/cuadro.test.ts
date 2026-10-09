import { describe, expect, test, vi } from "vitest";

// El cuadro importa la conexion a MySQL; estas pruebas no tocan la base.
vi.mock("./db", () => ({ pool: {} }));

import { CLIENTE_FLUJO_LARGO, datosAHeredar, estadoDe, sumarDias } from "./cuadro";
import type { FilaCuadro } from "./cuadro";

type Base = Omit<FilaCuadro, "estado" | "todoPagado">;

/** Viaje recien cargado; cada prueba cambia lo que necesita. */
function viaje(cambios: Partial<Base> = {}): Base {
  return {
    id: 1,
    fecha: "2026-10-05",
    vehiculoId: 1,
    placa: "SKN250",
    flota: "TERCERO",
    conductor: null,
    empresa: "CARTONES AMERICA",
    viajeId: 1,
    viajeRemesaId: 1,
    manifiesto: "00006775",
    remesa: "00006775",
    remision: null,
    pesoKg: 34_000,
    tipoFlete: "KILO",
    tarifaKilo: null,
    valorFijo: null,
    valorFlete: null,
    fechaDescargue: "2026-10-06",
    estadoPapeles: "EN_RUTA",
    flujoCorame: true,
    fechaRadicado: null,
    facturado: false,
    facturaNumero: null,
    facturaFecha: null,
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
    ...cambios,
  };
}

describe("estado del viaje en el cuadro (los colores del Excel)", () => {
  test("recien cargado: en proceso (blanco)", () => {
    expect(estadoDe(viaje()).estado).toBe("EN_RUTA");
  });

  test("descargo y los papeles no estan radicados: sin radicar (morado)", () => {
    for (const papeles of ["CONDUCTOR", "PARQUEADERO", "OFICINA"] as const) {
      expect(estadoDe(viaje({ estadoPapeles: papeles })).estado).toBe("SIN_RADICAR");
    }
  });

  test("papeles radicados en el cliente (verde)", () => {
    expect(estadoDe(viaje({ estadoPapeles: "RADICADO" })).estado).toBe("RADICADO");
  });

  test("facturado sin numero ni fecha (azul)", () => {
    expect(estadoDe(viaje({ estadoPapeles: "RADICADO", facturado: true })).estado).toBe("FACTURADO_SIN_DATOS");
  });

  test("con numero de factura: facturado", () => {
    expect(estadoDe(viaje({ facturado: true, facturaNumero: "7400" })).estado).toBe("FACTURADO");
  });

  test("el cliente pago la factura", () => {
    expect(estadoDe(viaje({ facturaNumero: "7400", facturaFechaPago: "2026-11-05" })).estado).toBe("PAGADO");
  });

  test("anulado gana sobre todo lo demas", () => {
    expect(estadoDe(viaje({ anulado: true, facturaFechaPago: "2026-11-05" }))).toEqual({ estado: "ANULADO", todoPagado: false });
  });
});

describe("todo pagado (amarillo)", () => {
  const cobrado = { facturaNumero: "7400", facturaFechaPago: "2026-11-05" };

  test("tercero: falta pagarle el saldo al dueno del vehiculo", () => {
    expect(estadoDe(viaje(cobrado)).todoPagado).toBe(false);
    expect(estadoDe(viaje({ ...cobrado, fechaPagoSaldo: "2026-10-21" })).todoPagado).toBe(true);
  });

  test("flota propia (Lopez o MYC): no hay saldo de tercero que pagar", () => {
    expect(estadoDe(viaje({ ...cobrado, flota: "LOPEZ" })).todoPagado).toBe(true);
    expect(estadoDe(viaje({ ...cobrado, flota: "MYC" })).todoPagado).toBe(true);
  });

  test("un anticipo sin pagar a la bomba impide el todo pagado", () => {
    expect(estadoDe(viaje({ ...cobrado, flota: "LOPEZ", totalAnticipos: 2_200_000, anticiposSinPagar: 1 })).todoPagado).toBe(false);
  });

  test("sin pago de la factura nunca es todo pagado", () => {
    expect(estadoDe(viaje({ flota: "LOPEZ", facturaNumero: "7400" })).todoPagado).toBe(false);
  });
});

describe("pago a terceros y flujo de papeles", () => {
  test("el saldo del tercero vence 15 dias despues del descargue", () => {
    expect(sumarDias("2026-10-06", 15)).toBe("2026-10-21");
    expect(sumarDias("2026-10-20", 15)).toBe("2026-11-04"); // cambio de mes
  });

  test("solo CORAME / Cartones America pasan por parqueadero y oficina", () => {
    expect(CLIENTE_FLUJO_LARGO.test("CARTONES AMERICA")).toBe(true);
    expect(CLIENTE_FLUJO_LARGO.test("CORAME URBANO")).toBe(true);
    expect(CLIENTE_FLUJO_LARGO.test("corame")).toBe(true);
    expect(CLIENTE_FLUJO_LARGO.test("TP FORMULADOS")).toBe(false);
  });
});

describe("manifiesto anulado y vuelto a expedir: que hereda la fila nueva", () => {
  const nueva = { estadoPapeles: "EN_RUTA", tipoFlete: "KILO", tarifaKilo: null, valorFijo: null, remision: null, facturado: 0 };

  test("pasa lo diligenciado en la anulada a los campos vacios de la nueva", () => {
    const anulada = {
      remision: "1300", tipoFlete: "FIJO", valorFijo: 945_900, tarifaKilo: null, estadoPapeles: "OFICINA",
      facturado: 1, facturaNumero: "7400", facturaFecha: "2026-10-07",
    };
    expect(datosAHeredar(anulada, nueva)).toEqual({
      remision: "1300", valorFijo: 945_900, tipoFlete: "FIJO", estadoPapeles: "OFICINA",
      facturado: 1, facturaNumero: "7400", facturaFecha: "2026-10-07",
    });
  });

  test("nunca pisa lo que la nueva ya tiene", () => {
    const yaDiligenciada = { ...nueva, remision: "2000", tarifaKilo: 122.25, estadoPapeles: "RADICADO" };
    const anulada = { remision: "1300", tipoFlete: "FIJO", valorFijo: 945_900, estadoPapeles: "OFICINA" };
    expect(datosAHeredar(anulada, yaDiligenciada)).toEqual({});
  });

  test("una anulada sin nada diligenciado no cambia nada", () => {
    expect(datosAHeredar({ ...nueva }, nueva)).toEqual({});
  });
});
