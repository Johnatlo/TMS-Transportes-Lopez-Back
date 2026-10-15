import { describe, expect, test, vi } from "vitest";

// Estas pruebas no tocan la base.
vi.mock("./db", () => ({ pool: {} }));

import { ErrorCuadro } from "./cuadro";
import { normalizarTarifa } from "./facturacion";

describe("tarifas de la matriz de fletes", () => {
  test("normaliza tipo, valor y peso minimo", () => {
    expect(
      normalizarTarifa({ nombre: " APROREC ", razonSocial: "APROREC SAS", valor: "130000", tipo: "ton", pesoMinimoKg: "34000" })
    ).toEqual({ nombre: "APROREC", razonSocial: "APROREC SAS", valor: 130000, tipo: "TON", pesoMinimoKg: 34000, pesoFijoKg: null, observaciones: null });
  });

  test("valor raro ('?') o vacio queda sin valor; tipo desconocido pasa a TON", () => {
    const t = normalizarTarifa({ nombre: "PEGANTE NEIVA", valor: "?", tipo: "OTRO" });
    expect(t.valor).toBeNull();
    expect(t.tipo).toBe("TON");
  });

  test("POR y POR3 se conservan (su regla esta en las observaciones)", () => {
    expect(normalizarTarifa({ nombre: "X 2 CLIENTES", tipo: "POR" }).tipo).toBe("POR");
    expect(normalizarTarifa({ nombre: "X 3 CLIENTES", tipo: "POR3" }).tipo).toBe("POR3");
  });

  test("sin nombre no se acepta", () => {
    expect(() => normalizarTarifa({ nombre: "  " })).toThrow(ErrorCuadro);
  });
});
