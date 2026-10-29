import { describe, expect, test } from "vitest";
import { deducirTarifa, fleteDeTarifa, parecido } from "./tarifasFlete";
import type { TarifaMatriz, ViajeParaTarifa } from "./tarifasFlete";

let id = 0;
const tarifa = (nombre: string, razonSocial: string | null, valor: number | null, tipo: TarifaMatriz["tipo"] = "TON", pesoMinimoKg: number | null = null): TarifaMatriz => ({
  id: ++id,
  nombre,
  razonSocial,
  valor,
  tipo,
  pesoMinimoKg,
  pesoFijoKg: null,
});

// Nombres reales de la matriz.
const TOLUA = "TOLUA MADERAS Y HERRAJES S.A.S.";
const MATRIZ = [
  tarifa("CORAME", "CARTONES AMERICA", 168000),
  tarifa("CORAME URBANO", "CARTONES AMERICA", 15000),
  tarifa("CORAME RECONOCIDO CARTULINA BOGOTA", "CARTONES AMERICA", 165000),
  tarifa("PAPELES NACIONALES SA CORAME", "CARTONES AMERICA", 100000),
  tarifa("RECICLAJES CARTON", "RECICLAJES BOGOTA N.S.", 122250, "TON", 34000),
  tarifa("RECICLAJES ARCHIVO", "RECICLAJES BOGOTA N.S.", 121500, "TON", 34000),
  tarifa("BODEGAS CARTON", "BODEGAS DE RECICLAJES", 122250),
  tarifa("BODEGAS ARCHIVO", "BODEGAS DE RECICLAJES", 121500),
  tarifa("INGENIERIA DE TUBOS DE CARTON S A S", "INGENIERIA DE TUBOS DE CARTON S A S", 160000),
  tarifa("TOLUA DUITAMA", TOLUA, 7192506, "FIJO"),
  tarifa("TOLUA DUITAMA 1 C. Y 1 CLI. ADIC", TOLUA, 7542506, "FIJO"),
  tarifa("TOLUA PEREIRA", TOLUA, 2564796, "FIJO"),
  tarifa("TOLUA PEREIRA / VOLVO", TOLUA, 1904605, "FIJO"),
  tarifa("ASHE S.A.S. BOGOTA", "ASHE S.A.S. BOGOTA", 165000),
  tarifa("ASHE S.A.S. ENVIGADO", "ASHE S.A.S. ENVIGADO", 160000),
  tarifa("PORCELATINO B/VENTURA BGTA", null, 190000),
  tarifa("DEKORANDO J&N PORCELATINOS S.A.S 2 CLIENTES", "PORCELATINOS S.A.S", 195000, "POR"),
  tarifa("PEGANTE NEIVA", "TP FORMULADOS SAS", null, "FIJO"),
];

const viaje = (c: Partial<ViajeParaTarifa>): ViajeParaTarifa => ({
  empresa: "CARTONES AMERICA",
  ruta: "CALI VALLE DEL CAUCA → MOSQUERA CUNDINAMARCA",
  urbano: false,
  configuracion: "3S3",
  producto: null,
  ...c,
});

describe("deducirTarifa: exactas", () => {
  test("Cartones America: CORAME (no la urbana, ni la de reconocidos de cartulina, ni Papeles Nacionales)", () => {
    expect(deducirTarifa(viaje({}), MATRIZ).exacta?.nombre).toBe("CORAME");
    // A Bogota tampoco toma la de cartulina reconocida a Bogota.
    expect(deducirTarifa(viaje({ ruta: "CALI VALLE DEL CAUCA → BOGOTA BOGOTA D. C." }), MATRIZ).exacta?.nombre).toBe("CORAME");
    expect(deducirTarifa(viaje({ urbano: true }), MATRIZ).exacta?.nombre).toBe("CORAME URBANO");
  });

  test("el producto de la remesa separa CARTON de ARCHIVO", () => {
    const r = (empresa: string, producto: string | null) => deducirTarifa(viaje({ empresa, ruta: "SOACHA CUNDINAMARCA → CALI VALLE DEL CAUCA", producto }), MATRIZ);
    expect(r("RECICLAJES BOGOTA N.S. S.A.S.", "CARTON RECICLADO").exacta?.nombre).toBe("RECICLAJES CARTON");
    expect(r("BODEGAS DE RECICLAJES SAS", "CARTON RECICLADO").exacta?.nombre).toBe("BODEGAS CARTON");
    // Sin producto (viaje sin manifiesto): no se sabe; quedan las dos para elegir.
    const sin = r("BODEGAS DE RECICLAJES SAS", null);
    expect(sin.exacta).toBeNull();
    expect(sin.posibles.map((p) => p.nombre).sort()).toEqual(["BODEGAS ARCHIVO", "BODEGAS CARTON"]);
  });
});

describe("deducirTarifa: manuales con sus posibles", () => {
  test("Tolua: puede llevar clientes o ciudades adicionales", () => {
    const d = deducirTarifa(viaje({ empresa: "TOLUA MADERAS Y HERRAJES SAS", ruta: "YUMBO VALLE DEL CAUCA → DUITAMA BOYACA" }), MATRIZ);
    expect(d.exacta).toBeNull();
    // Solo las de Duitama (no las de Pereira con adicionales).
    expect(d.posibles.map((p) => p.nombre)).toEqual(["TOLUA DUITAMA", "TOLUA DUITAMA 1 C. Y 1 CLI. ADIC"]);
    // El camion rigido sube la de VOLVO de primera.
    const rigido = deducirTarifa(viaje({ empresa: "TOLUA MADERAS Y HERRAJES SAS", ruta: "YUMBO VALLE DEL CAUCA → PEREIRA RISARALDA", configuracion: "3" }), MATRIZ);
    expect(rigido.posibles[0].nombre).toBe("TOLUA PEREIRA / VOLVO");
  });

  test("Porcelatino (varios clientes sin remesa), empates y tarifas sin valor", () => {
    expect(deducirTarifa(viaje({ empresa: "PORCELATINO S.A.S", ruta: "BUENAVENTURA VALLE DEL CAUCA → BOGOTA BOGOTA D. C." }), MATRIZ).exacta).toBeNull();
    // ASHE a Bucaramanga: Bogota y Envigado quedan igual.
    const ashe = deducirTarifa(viaje({ empresa: "ASHE S.A.S.", ruta: "CALI VALLE DEL CAUCA → BUCARAMANGA SANTANDER" }), MATRIZ);
    expect(ashe.exacta).toBeNull();
    expect(ashe.posibles).toHaveLength(2);
    expect(deducirTarifa(viaje({ empresa: "TP FORMULADOS SAS", ruta: "TOCANCIPA CUNDINAMARCA → NEIVA HUILA" }), MATRIZ).exacta).toBeNull();
  });

  test("la tarifa nombra el origen pero no el destino: manual", () => {
    const laminados = [tarifa("LAMINADOS B/VENTURA", "LAMINADOS Y ENCHAPADOS", 6300000, "FIJO"), tarifa("LAMINADOS YUMBO", "LAMINADOS Y ENCHAPADOS", 3000000, "FIJO")];
    const d = (ruta: string) => deducirTarifa(viaje({ empresa: "LAMINADOS Y ENCHAPADOS SAS", ruta }), laminados);
    expect(d("BUENAVENTURA VALLE DEL CAUCA → MEDELLIN ANTIOQUIA").exacta).toBeNull();
    // Hacia la ciudad de la tarifa si es exacta.
    expect(d("CALI VALLE DEL CAUCA → YUMBO VALLE DEL CAUCA").exacta?.nombre).toBe("LAMINADOS YUMBO");
  });

  test("empatada con una que se parece menos al cliente: gana la de su nombre", () => {
    const empaques = [tarifa("EMPAQUES", "EMPAQUES INDUSTRIALES DE COLOMBIA S.A.S.", 4500000, "FIJO"), tarifa("EMPAQUES Y PAPELES WY SAS", "EMPAQUES Y PAPELES WY SAS", 165000)];
    expect(deducirTarifa(viaje({ empresa: "EMPAQUES Y PAPELES WY SAS", ruta: "CALI VALLE DEL CAUCA → BOGOTA BOGOTA D. C." }), empaques).exacta?.nombre).toBe("EMPAQUES Y PAPELES WY SAS");
  });

  test("cliente sin tarifas: nada; las palabras de enlace no hacen parecido", () => {
    expect(deducirTarifa(viaje({ empresa: "CLIENTE NUEVO SAS" }), MATRIZ)).toEqual({ exacta: null, posibles: [] });
    expect(parecido("BODEGAS DE RECICLAJES SAS", MATRIZ[8])).toBe(0);
  });
});

describe("fleteDeTarifa", () => {
  test("por tonelada con peso minimo, y fijo", () => {
    expect(fleteDeTarifa(MATRIZ[4], 33000)).toMatchObject({ tipoFlete: "KILO", tarifaKilo: 122.25, valorFijo: null, pesoFacturadoKg: 34000 });
    expect(fleteDeTarifa(MATRIZ[4], 35000).pesoFacturadoKg).toBeNull();
    expect(fleteDeTarifa(MATRIZ[9], 34000)).toMatchObject({ tipoFlete: "FIJO", tarifaKilo: null, valorFijo: 7192506 });
  });
});
