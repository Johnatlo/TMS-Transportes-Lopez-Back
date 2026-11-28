import { describe, expect, test, vi } from "vitest";

// El modulo importa la conexion a MySQL; estas pruebas no tocan la base.
vi.mock("./db", () => ({ pool: {} }));

import { limpiarDisposicion, MAXIMO_TARJETAS } from "./inicioUsuario";

describe("inicio personalizado", () => {
  test("acepta tarjetas dentro de la rejilla de 12 columnas", () => {
    const t = [
      { id: "indicador-transito", x: 0, y: 0, w: 3, h: 2 },
      { id: "mapa", x: 8, y: 2, w: 4, h: 6, sobra: true },
    ];
    expect(limpiarDisposicion(t)).toEqual([
      { id: "indicador-transito", x: 0, y: 0, w: 3, h: 2 },
      { id: "mapa", x: 8, y: 2, w: 4, h: 6 },
    ]);
    expect(limpiarDisposicion([])).toEqual([]);
  });

  test("rechaza lo que se sale de la rejilla, ids raros o repetidos", () => {
    expect(limpiarDisposicion([{ id: "mapa", x: 10, y: 0, w: 4, h: 2 }])).toBeNull();
    expect(limpiarDisposicion([{ id: "mapa", x: 0, y: 0, w: 0, h: 2 }])).toBeNull();
    expect(limpiarDisposicion([{ id: "mapa", x: 0, y: 0, w: 2.5, h: 2 }])).toBeNull();
    expect(limpiarDisposicion([{ id: "<script>", x: 0, y: 0, w: 2, h: 2 }])).toBeNull();
    expect(
      limpiarDisposicion([
        { id: "mapa", x: 0, y: 0, w: 2, h: 2 },
        { id: "mapa", x: 2, y: 0, w: 2, h: 2 },
      ]),
    ).toBeNull();
    expect(limpiarDisposicion("mapa")).toBeNull();
    expect(limpiarDisposicion(Array.from({ length: MAXIMO_TARJETAS + 1 }, (_, i) => ({ id: `t${i}`, x: 0, y: i, w: 1, h: 1 })))).toBeNull();
  });
});
