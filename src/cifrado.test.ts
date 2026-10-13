import { afterEach, describe, expect, test } from "vitest";
import { cifrar, descifrar, ErrorCifrado } from "./cifrado";

const original = process.env.TMS_CLAVE_CIFRADO;
afterEach(() => {
  process.env.TMS_CLAVE_CIFRADO = original;
});

describe("cifrado de las claves del GPS", () => {
  test("ida y vuelta, y cada cifrado es distinto (iv aleatorio)", () => {
    process.env.TMS_CLAVE_CIFRADO = "una-clave-de-prueba-larga";
    const a = cifrar("Clave#2026");
    const b = cifrar("Clave#2026");
    expect(a).not.toBe(b);
    expect(a.startsWith("v1:")).toBe(true);
    expect(a).not.toContain("Clave#2026");
    expect(descifrar(a)).toBe("Clave#2026");
  });

  test("sin llave (o muy corta) no cifra", () => {
    process.env.TMS_CLAVE_CIFRADO = "corta";
    expect(() => cifrar("x")).toThrow(ErrorCifrado);
  });

  test("con otra llave o alterado no se puede leer", () => {
    process.env.TMS_CLAVE_CIFRADO = "una-clave-de-prueba-larga";
    const guardado = cifrar("Clave#2026");
    process.env.TMS_CLAVE_CIFRADO = "otra-clave-de-prueba-larga";
    expect(() => descifrar(guardado)).toThrow(ErrorCifrado);
    process.env.TMS_CLAVE_CIFRADO = "una-clave-de-prueba-larga";
    const alterado = guardado.slice(0, -4) + (guardado.endsWith("AAAA") ? "BBBB" : "AAAA");
    expect(() => descifrar(alterado)).toThrow(ErrorCifrado);
  });
});
