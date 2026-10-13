import { describe, expect, test, vi } from "vitest";

// Estas pruebas no tocan la base ni el RNDC.
vi.mock("../db", () => ({ pool: {} }));

import { interpretarRegistro, variablesConductor, variablesRemolque, variablesTercero, variablesVehiculo } from "./maestros";
import type { FilaTercero } from "./maestros";

const tercero = (cambios: Partial<FilaTercero> = {}): FilaTercero => ({
  codTipoId: "N",
  nit: "9015051352",
  nombre: "CARTONES AMERICA",
  direccion: "CL 10 # 20-30",
  telefono: null,
  codMunicipioRndc: "76001000",
  codSede: "1",
  nombreSede: null,
  ciudad: "CALI",
  latitud: 3.451234,
  longitud: -76.531234,
  ...cambios,
});

describe("tercero (proceso 11)", () => {
  test("empresa: sin nombre de sede usa el municipio; coordenadas como texto", () => {
    const v = variablesTercero(tercero());
    expect(v).toMatchObject({
      CODTIPOIDTERCERO: "N",
      NUMIDTERCERO: "9015051352",
      NOMIDTERCERO: "CARTONES AMERICA",
      NOMENCLATURADIRECCION: "CL 10 # 20-30",
      CODMUNICIPIORNDC: "76001000",
      CODSEDETERCERO: "1",
      NOMSEDETERCERO: "CALI",
      LATITUD: "3.451234",
      LONGITUD: "-76.531234",
    });
    expect(v.NUMTELEFONOCONTACTO).toBeUndefined();
  });

  test("telefono: solo si tiene 10 digitos (con 7 el RNDC rechaza todo, TER190)", () => {
    expect(variablesTercero(tercero({ telefono: "601 602-6924" })).NUMTELEFONOCONTACTO).toBe("6016026924");
    expect(variablesTercero(tercero({ telefono: "3213221715" })).NUMTELEFONOCONTACTO).toBe("3213221715");
    expect(variablesTercero(tercero({ telefono: "6026924" })).NUMTELEFONOCONTACTO).toBeUndefined();
  });

  test("el nombre de sede escrito manda", () => {
    expect(variablesTercero(tercero({ nombreSede: "PLANTA YUMBO" })).NOMSEDETERCERO).toBe("PLANTA YUMBO");
  });

  test("persona natural: sede 0 por defecto y sin nombre de sede inventado", () => {
    const v = variablesTercero(tercero({ codTipoId: "C", codSede: null, ciudad: "CALI" }));
    expect(v.CODSEDETERCERO).toBe("0");
    expect(v.NOMSEDETERCERO).toBeUndefined();
  });

  test("sin coordenadas no se envian", () => {
    const v = variablesTercero(tercero({ latitud: null, longitud: null }));
    expect(v.LATITUD).toBeUndefined();
    expect(v.LONGITUD).toBeUndefined();
  });
});

describe("conductor (proceso 11, como tercero)", () => {
  test("persona natural con sede 0, direccion y municipio", () => {
    expect(
      variablesConductor({ codTipoId: "C", cedula: "80123456", nombre: "PEDRO PEREZ", direccion: "KR 1 # 2-3", codMunicipioRndc: "11001000" })
    ).toEqual({
      CODTIPOIDTERCERO: "C",
      NUMIDTERCERO: "80123456",
      NOMIDTERCERO: "PEDRO PEREZ",
      NOMENCLATURADIRECCION: "KR 1 # 2-3",
      CODMUNICIPIORNDC: "11001000",
      CODSEDETERCERO: "0",
    });
  });
});

describe("vehiculo y remolque (proceso 12)", () => {
  test("placa en mayuscula, peso en kg entero y tenedor", () => {
    expect(variablesVehiculo({ placa: "skn250", pesoVehiculoVacio: "9000.4", codTipoIdTenedor: "C", numIdTenedor: "31429004" })).toEqual({
      NUMPLACA: "SKN250",
      PESOVEHICULOVACIO: "9000",
      CODTIPOIDTENEDOR: "C",
      NUMIDTENEDOR: "31429004",
    });
  });

  test("sin tenedor no se envia el tipo de identificacion suelto", () => {
    const v = variablesVehiculo({ placa: "SKN250", pesoVehiculoVacio: 9000, codTipoIdTenedor: "C", numIdTenedor: null });
    expect(v.CODTIPOIDTENEDOR).toBeUndefined();
    expect(v.NUMIDTENEDOR).toBeUndefined();
  });

  test("remolque: solo la placa", () => {
    expect(variablesRemolque({ placa: "r37108" })).toEqual({ NUMPLACA: "R37108" });
  });
});

describe("respuesta del RNDC", () => {
  test("con radicado: registrado", () => {
    expect(interpretarRegistro({ ok: true, radicado: "900012746", error: null, errorCrudo: null })).toEqual({
      ok: true,
      radicado: "900012746",
      yaEstabaIgual: false,
      error: null,
    });
  });

  test("DUPLICADO (respuesta real de rndcpruebas): ya estaba al dia, con su radicado", () => {
    const crudo =
      "DUPLICADO:5446083 Error VEH015: La Placa que esta registrando ya existe con todos los datos iguales. No debe volver a registrarla.";
    expect(interpretarRegistro({ ok: false, radicado: null, error: "explicado", errorCrudo: crudo })).toEqual({
      ok: true,
      radicado: "5446083",
      yaEstabaIgual: true,
      error: null,
    });
  });

  test("rechazo: devuelve el mensaje del RNDC", () => {
    const r = interpretarRegistro({ ok: false, radicado: null, error: "Error TER130: No reporto la direccion", errorCrudo: "TER130" });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("TER130");
  });
});
