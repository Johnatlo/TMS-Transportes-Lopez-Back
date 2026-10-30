import { describe, expect, test } from "vitest";
import { buscarEnMatriz, calcular, grupoDe, leerRetenciones } from "./rentabilidad";
import type { EntradaRentabilidad } from "./rentabilidad";

/** Entrada de prueba: un viaje de socio de Cartones America, primera fila de todo. */
const entrada = (c: Partial<EntradaRentabilidad>): EntradaRentabilidad => ({
  grupo: "CELSO",
  valorEmpresa: 5_694_192,
  empresa: "CARTONES AMERICA",
  urbano: false,
  reconocido: false,
  primeraDeRemision: true,
  primeraDeManifiesto: true,
  efectivo: 0,
  combustible: 1_800_000,
  transferencia: 0,
  valorTercero: null,
  icaTerceroPorMil: 0,
  comisionMatriz: { cliente: "CORAME", comision: 130_000, tLopez: 50_000 },
  icaMatriz: 3.3,
  rentComision: null,
  rentTLopez: null,
  rentDescargue: null,
  rentPoliza: null,
  rentIcaPorMil: null,
  fechaPagoRentabilidad: null,
  rentRetenciones: {},
  rentOtrosDescuentos: null,
  rentOtrosConcepto: null,
  ...c,
});

describe("calcular: socios", () => {
  test("igual que la hoja CELSO, fila 396 (TEK-298, Cartones America)", () => {
    const c = calcular(entrada({}));
    expect([c.retencion, c.reteIca, c.anticipoRenta, c.bancaria, c.supertransporte]).toEqual([62_636, 18_791, 199_297, 27_777, 6_839]);
    expect([c.comision, c.tLopez, c.descargue, c.poliza, c.anticipo]).toEqual([130_000, 50_000, 198_000, 3_000, 1_800_000]);
    // En el Excel: 3.197.852,84 (sin redondear cada descuento).
    expect(c.saldoBeneficiario).toBe(3_197_852);
    expect(c.ganancia).toBe(180_000);
  });

  test("urbano, reconocido y dobletroque: sin descargue ni poliza; comision una vez por remision", () => {
    expect(calcular(entrada({ urbano: true, comisionMatriz: null })).descargue + calcular(entrada({ urbano: true })).poliza).toBe(0);
    expect(calcular(entrada({ reconocido: true })).descargue).toBe(0);
    // Sin flete aun: sin descargue ni poliza (no suman hasta que se facture).
    const sinFlete = calcular(entrada({ valorEmpresa: 0 }));
    expect([sinFlete.descargue, sinFlete.poliza, sinFlete.comision, sinFlete.tLopez]).toEqual([0, 0, 0, 0]);
    const xgj = calcular(entrada({ grupo: "XGJ-197" }));
    expect([xgj.descargue, xgj.poliza]).toEqual([0, 0]);
    const segunda = calcular(entrada({ primeraDeRemision: false, primeraDeManifiesto: false }));
    expect([segunda.comision, segunda.tLopez, segunda.descargue, segunda.poliza]).toEqual([0, 0, 0, 0]);
  });

  test("lo escrito a mano manda", () => {
    const c = calcular(entrada({ rentComision: 100_000, rentTLopez: 0, rentDescargue: 135_000, rentPoliza: 0, rentIcaPorMil: 8 }));
    expect([c.comision, c.tLopez, c.descargue, c.poliza, c.icaPorMil]).toEqual([100_000, 0, 135_000, 0, 8]);
  });
});

describe("calcular: terceros", () => {
  test("como la hoja TERCEROS, fila 490 (SWN-623): la comision de la matriz se le descuenta a la empresa", () => {
    const c = calcular(
      entrada({
        grupo: "TERCEROS",
        valorEmpresa: 5_504_688,
        rentIcaPorMil: 4,
        valorTercero: 4_521_708,
        icaTerceroPorMil: 4,
        efectivo: 1_300_000,
        combustible: 1_300_000,
      })
    );
    // Lado empresa: 1 % + 0,1 %, ICA 4 por mil, 4 x 1000 + 5.000 y Supertransporte.
    expect([c.retencion, c.reteIca, c.supertransporte]).toEqual([60_552, 22_019, 6_611]);
    expect(c.comision).toBe(130_000);
    // La comision bancaria no se le descuenta a la empresa.
    expect(c.saldoEmpresa).toBe(5_504_688 - 60_552 - 22_019 - 6_611 - 130_000);
    // Lado tercero: 1 % + 0,1 %, ICA, Supertransporte y poliza 3.000 (sin comision). Como en el Excel: 4.445.451,81.
    // Gestion financiera: 4 x 1000 + 5.000 + Supertransporte, sobre el flete del tercero.
    expect([c.retencionTercero, c.reteIcaTercero, c.bancaria, c.supertransporteTercero, c.poliza]).toEqual([49_739, 18_087, 23_087, 5_431, 3_000]);
    expect(c.saldoBeneficiario).toBe(4_521_708 - 49_739 - 18_087 - 23_087 - 5_431 - 3_000);
    expect(c.rentabilidad).toBe(c.saldoEmpresa - c.saldoBeneficiario);
    expect(c.anticipoRenta).toBe(Math.round(c.rentabilidad * 0.035));
    expect(c.ganancia).toBe(c.rentabilidad - c.anticipoRenta);
    // El anticipo no se resta: ya va descontado en el pago al tercero.
    expect(c.anticipo).toBe(2_600_000);
  });

  test("los otros descuentos bajan el saldo del tercero pero no suben la rentabilidad", () => {
    const base = { grupo: "TERCEROS", valorEmpresa: 5_000_000, valorTercero: 4_000_000 };
    const sin = calcular(entrada(base));
    const con = calcular(entrada({ ...base, rentOtrosDescuentos: 200_000 }));
    expect(con.saldoBeneficiario).toBe(sin.saldoBeneficiario - 200_000);
    expect([con.saldoEmpresa, con.rentabilidad, con.anticipoRenta, con.ganancia]).toEqual([sin.saldoEmpresa, sin.rentabilidad, sin.anticipoRenta, sin.ganancia]);
  });

  test("sin flete no hay comision", () => {
    expect(calcular(entrada({ grupo: "TERCEROS", valorEmpresa: 0, valorTercero: 1_000_000 })).comision).toBe(0);
  });

  test("un reconocido no tiene pago al tercero: todo queda para la empresa", () => {
    const c = calcular(entrada({ grupo: "TERCEROS", valorEmpresa: 1_000_000, reconocido: true, valorTercero: null }));
    expect([c.poliza, c.saldoBeneficiario]).toEqual([0, 0]);
    expect(c.rentabilidad).toBe(c.saldoEmpresa);
  });
});

describe("retenciones editables y otros descuentos", () => {
  test("desmarcada no se descuenta; el valor escrito manda; lo calculado sigue disponible", () => {
    const c = calcular(entrada({ rentRetenciones: { reteIca: { valor: null, aplica: false }, retencion: { valor: 50_000, aplica: true } } }));
    expect([c.reteIca, c.retencion]).toEqual([0, 50_000]);
    expect(c.retencionesCalculadas.reteIca).toBe(18_791);
    expect(c.saldoBeneficiario).toBe(calcular(entrada({})).saldoBeneficiario + 18_791 + 12_636);
  });

  test("otros descuentos: se le restan al dueno y al tercero", () => {
    expect(calcular(entrada({ rentOtrosDescuentos: 100_000 })).saldoBeneficiario).toBe(calcular(entrada({})).saldoBeneficiario - 100_000);
    const t = (otros: number | null) => calcular(entrada({ grupo: "TERCEROS", valorTercero: 4_000_000, rentOtrosDescuentos: otros }));
    expect(t(100_000).saldoBeneficiario).toBe(t(null).saldoBeneficiario - 100_000);
  });

  test("leerRetenciones ignora lo que no sirve", () => {
    expect(leerRetenciones("no es json")).toEqual({});
    expect(leerRetenciones('{"reteIca":{"valor":"10","aplica":false},"otra":{}}')).toEqual({ reteIca: { valor: 10, aplica: false } });
  });
});

describe("grupoDe", () => {
  test("por placa, terceros, socio o propios", () => {
    expect(grupoDe("TEK-298", "TERCERO", "CELSO")).toBe("CELSO");
    expect(grupoDe("XJB207", "LOPEZ", "MAURICIO")).toBe("SOCIEDAD");
    expect(grupoDe("SPS199", "TERCERO", null)).toBe("TERCEROS");
    expect(grupoDe("ZAP745", "TERCERO", "CELSO")).toBe("CELSO");
    expect(grupoDe("ABC123", "LOPEZ", null)).toBe("PROPIOS");
  });
});

describe("buscarEnMatriz", () => {
  const matriz = [
    { cliente: "CORAME URBANO", comision: 0, tLopez: 0 },
    { cliente: "CORAME", comision: 130_000, tLopez: 50_000 },
    { cliente: "ECOAMBIENTAL", comision: 30_000, tLopez: 0 },
    { cliente: "RECICLAJES", comision: 30_000, tLopez: 0 },
  ];
  test("el nombre de la matriz dentro de la empresa, con sinonimos y urbanos", () => {
    expect(buscarEnMatriz(matriz, "ECOAMBIENTAL RECICLAJE S.A.S.")?.comision).toBe(30_000);
    expect(buscarEnMatriz(matriz, "CARTONES AMERICA")?.cliente).toBe("CORAME");
    expect(buscarEnMatriz(matriz, "CARTONES AMÉRICA", true)?.cliente).toBe("CORAME URBANO");
    expect(buscarEnMatriz(matriz, "RECOLAM S.EN C.")).toBeNull();
  });
});
