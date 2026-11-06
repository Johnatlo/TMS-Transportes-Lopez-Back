import { describe, expect, test } from "vitest";
import { cambiosDeMatriz, fechaVigencia, vigentesEn } from "./vigencias";

const fila = (id: number, cliente: string, valor: number, vigenteDesde: string | null, eliminado = false) => ({ id, cliente, valor, vigenteDesde, eliminado });

describe("vigentesEn", () => {
  const historial = [
    fila(1, "CORAME", 130_000, null),
    fila(2, "TOLUA", 100_000, null),
    fila(3, "CORAME", 150_000, "2026-11-01"),
    fila(4, "TOLUA", 0, "2026-12-01", true),
    fila(5, "NUEVO", 50_000, "2026-11-15"),
  ];
  const valores = (fecha: string) => vigentesEn(historial, (f) => f.cliente, fecha).map((f) => [f.cliente, f.valor]);

  test("cada viaje usa el valor de su fecha", () => {
    expect(valores("2026-10-20")).toEqual([["CORAME", 130_000], ["TOLUA", 100_000]]);
    expect(valores("2026-11-01")).toEqual([["CORAME", 150_000], ["TOLUA", 100_000]]);
    expect(valores("2026-11-20")).toEqual([["CORAME", 150_000], ["TOLUA", 100_000], ["NUEVO", 50_000]]);
    // Desde el 1 de diciembre TOLUA ya no esta.
    expect(valores("2026-12-05")).toEqual([["CORAME", 150_000], ["NUEVO", 50_000]]);
  });

  test("si dos cambios rigen el mismo dia, vale el ultimo guardado", () => {
    const h = [fila(1, "A", 1, "2026-11-01"), fila(2, "A", 2, "2026-11-01")];
    expect(vigentesEn(h, (f) => f.cliente, "2026-11-02")[0].valor).toBe(2);
  });
});

describe("cambiosDeMatriz", () => {
  test("solo guarda lo nuevo o cambiado, y quita lo que ya no esta", () => {
    const actuales = [fila(1, "CORAME", 130_000, null), fila(2, "TOLUA", 100_000, null)];
    const nuevas = [
      { cliente: "CORAME", valor: 130_000 },
      { cliente: "NUEVO", valor: 1 },
    ];
    const c = cambiosDeMatriz(actuales, nuevas, (a) => a.cliente, (n) => n.cliente, (a, n) => a.valor === n.valor);
    expect(c.guardar).toEqual([{ cliente: "NUEVO", valor: 1 }]);
    expect(c.quitar).toEqual(["TOLUA"]);
  });
});

test("fechaVigencia", () => {
  expect(fechaVigencia("2026-11-06")).toBe("2026-11-06");
  expect(fechaVigencia("ayer")).toBeNull();
});
