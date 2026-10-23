import { describe, expect, test } from "vitest";
import { clienteDeCobro } from "./clientesCobro";

describe("clienteDeCobro", () => {
  test("las variantes de Cartones America son el mismo cliente con su concepto", () => {
    expect(clienteDeCobro("RECONOCIDO CARTONES AMERICA")).toEqual({ cliente: "CARTONES AMERICA", concepto: "RECONOCIDO" });
    expect(clienteDeCobro("CARTONES AMERICA RECONOCIDO")).toEqual({ cliente: "CARTONES AMERICA", concepto: "RECONOCIDO" });
    expect(clienteDeCobro("Cartones America Urbano")).toEqual({ cliente: "CARTONES AMERICA", concepto: "URBANO" });
    expect(clienteDeCobro("CORAME RECONOCIDO CARTULINA BOGOTA")).toEqual({ cliente: "CARTONES AMERICA", concepto: "RECONOCIDO CARTULINA BOGOTA" });
    expect(clienteDeCobro("CARTONES AMERICA - URBANO")).toEqual({ cliente: "CARTONES AMERICA", concepto: "URBANO" });
  });

  test("el nombre normal no trae concepto, salvo el de un reconocido del cuadro", () => {
    expect(clienteDeCobro("CARTONES AMERICA")).toEqual({ cliente: "CARTONES AMERICA", concepto: null });
    expect(clienteDeCobro("CARTONES AMERICA", "4 CLIENTES CARTONES AMERICA")).toEqual({ cliente: "CARTONES AMERICA", concepto: "4 CLIENTES CARTONES AMERICA" });
  });

  test("Reciclajes Bogota, Bodegas de Reciclajes, Ecoambiental y TP Formulados con sus variantes", () => {
    // El nombre del cuadro (con sufijos legales) es el cliente, sin concepto.
    expect(clienteDeCobro("RECICLAJES BOGOTA N.S. S.A.S.")).toEqual({ cliente: "RECICLAJES BOGOTA N.S. S.A.S.", concepto: null });
    expect(clienteDeCobro("BODEGAS DE RECICLAJES SAS")).toEqual({ cliente: "BODEGAS DE RECICLAJES SAS", concepto: null });
    expect(clienteDeCobro("ECOAMBIENTAL RECICLAJE S.A.S.")).toEqual({ cliente: "ECOAMBIENTAL RECICLAJE S.A.S.", concepto: null });
    expect(clienteDeCobro("TP PRODUCTOS FORMULADOS S.A.S")).toEqual({ cliente: "TP PRODUCTOS FORMULADOS S.A.S", concepto: null });
    // Sus variantes (como en la matriz de fletes).
    expect(clienteDeCobro("RECICLAJES URBANO TOCANCIPA")).toEqual({ cliente: "RECICLAJES BOGOTA N.S. S.A.S.", concepto: "URBANO TOCANCIPA" });
    expect(clienteDeCobro("RECICLAJES BOGOTA URBANO")).toEqual({ cliente: "RECICLAJES BOGOTA N.S. S.A.S.", concepto: "URBANO" });
    expect(clienteDeCobro("BODEGAS ARCHIVO")).toEqual({ cliente: "BODEGAS DE RECICLAJES SAS", concepto: "ARCHIVO" });
    expect(clienteDeCobro("ECOAMBIENTAL CARTON")).toEqual({ cliente: "ECOAMBIENTAL RECICLAJE S.A.S.", concepto: "CARTON" });
    expect(clienteDeCobro("TP FORMULADOS SAS URBANO")).toEqual({ cliente: "TP PRODUCTOS FORMULADOS S.A.S", concepto: "URBANO" });
    expect(clienteDeCobro("PEGANTE URBANO")).toEqual({ cliente: "TP PRODUCTOS FORMULADOS S.A.S", concepto: "URBANO" });
  });

  test("los demas clientes quedan como estan", () => {
    expect(clienteDeCobro("RECOLAM S.EN C.")).toEqual({ cliente: "RECOLAM S.EN C.", concepto: null });
    expect(clienteDeCobro("EMPAQUES INDUSTRIALES DE COLOMBIA S.A.S.")).toEqual({ cliente: "EMPAQUES INDUSTRIALES DE COLOMBIA S.A.S.", concepto: null });
  });
});
