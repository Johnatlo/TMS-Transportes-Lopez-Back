import { describe, expect, it } from "vitest";
import { construirHtmlManifiestoContingencia, enLetras } from "./manifiesto-contingencia";

describe("enLetras", () => {
  it("como en el manifiesto oficial", () => {
    expect(enLetras(4539071)).toBe("CUATRO MILLONES QUINIENTOS TREINTA Y NUEVE MIL SETENTA Y UNO PESOS");
    expect(enLetras(1000000)).toBe("UN MILLON DE PESOS");
    expect(enLetras(21_100_100)).toBe("VEINTIUN MILLONES CIEN MIL CIEN PESOS");
    expect(enLetras(1001)).toBe("MIL UNO PESOS");
  });
});

describe("construirHtmlManifiestoContingencia", () => {
  const datos = {
    empresa: { nombre: "TRANSPORTES LOPEZ C S.A.S", nit: "9013195831", direccion: "CALLE 46", telefono: "317", municipio: "SOACHA" },
    consecutivo: "00006900",
    radicado: null,
    generadoEn: new Date("2026-10-30T13:00:00Z"),
    motivo: "El RNDC no responde",
    fechaExpedicion: "30/10/2026",
    tipoManifiesto: "General",
    origen: "CALI VALLE DEL CAUCA",
    destino: "MOSQUERA CUNDINAMARCA",
    via: null,
    titular: { nombre: "TRANSPORTES LOPEZ C SAS", id: "9013195831", direccion: null, municipio: null },
    vehiculo: { placa: "SPI982", marca: "INTERNATIONAL", configuracion: "3S3", pesoVacio: 10000, remolque: "R78075", soatVence: "10/04/2027" },
    conductor: { nombre: "CONDUCTOR <PRUEBA>", cedula: "111", licencia: null, direccion: null, municipio: null },
    conductor2: null,
    remesas: [],
    valores: { total: 4539071, retencionFuente: 45391, icaPorMil: 0, retencionIca: 0, retencionFopat: 4539, anticipo: 0, lugarPago: "SOACHA", fechaPago: "27/10/2026", cargue: "REMITENTE", descargue: "DESTINATARIO" },
    observaciones: null,
  };

  it("dice que es de contingencia, sin radicado, con el motivo y el neto", () => {
    const html = construirHtmlManifiestoContingencia(datos);
    expect(html).toContain("DE CONTINGENCIA");
    expect(html).toContain("PENDIENTE (sin radicar en el RNDC)");
    expect(html).toContain("expedir e imprimir");
    expect(html).toContain("Motivo: El RNDC no responde");
    // Neto: 4.539.071 - 45.391 - 4.539.
    expect(html).toContain("4,489,141.00");
    // Escapa lo que viene de la base.
    expect(html).toContain("CONDUCTOR &lt;PRUEBA&gt;");
  });

  it("con radicado: solo falta imprimir el oficial", () => {
    const html = construirHtmlManifiestoContingencia({ ...datos, radicado: "999999999" });
    expect(html).toContain("Autorizacion: 999999999");
    expect(html).toContain("disponible para imprimir");
  });
});
