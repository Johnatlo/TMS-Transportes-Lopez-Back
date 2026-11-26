import { describe, expect, test, vi } from "vitest";

// El modulo importa la conexion a MySQL; estas pruebas no tocan la base.
vi.mock("./db", () => ({ pool: {} }));

import { cambiosDe, TABLAS_BITACORA } from "./bitacora";

describe("bitacora de cambios", () => {
  test("al cambiar: cada campo que cambio con su antes y su despues", () => {
    expect(cambiosDe("CAMBIAR", { valorFlete: 4_200_000, remisionUrl: null }, { valorFlete: 4_400_000, remisionUrl: "https://x" })).toEqual([
      { campo: "valorFlete", antes: 4_200_000, despues: 4_400_000 },
      { campo: "remisionUrl", antes: null, despues: "https://x" },
    ]);
  });

  test("al crear o borrar: los datos que tenia (sin los vacios)", () => {
    expect(cambiosDe("CREAR", {}, { id: 7, texto: "hola", nota: null })).toEqual([
      { campo: "id", antes: null, despues: 7 },
      { campo: "texto", antes: null, despues: "hola" },
    ]);
    expect(cambiosDe("BORRAR", { id: 7, valor: 250_000, fecha: "" }, {})).toEqual([
      { campo: "id", antes: 7, despues: null },
      { campo: "valor", antes: 250_000, despues: null },
    ]);
  });

  test("solo se restauran desde la papelera las tablas simples", () => {
    const restaurables = Object.entries(TABLAS_BITACORA)
      .filter(([, t]) => t.restaurable)
      .map(([t]) => t)
      .sort();
    expect(restaurables).toEqual([
      "cartera_anticipos_cliente_registros",
      "cuadro_notas",
      "fletes_conductor",
      "notas_credito",
      "pagos_socios",
      "participaciones",
    ]);
    // Lo que se borra con otros datos (viajes, anticipos, nominas) queda solo para consulta.
    expect(TABLAS_BITACORA.cuadro_viajes.restaurable).toBeFalsy();
    expect(TABLAS_BITACORA.cuadro_anticipos.restaurable).toBeFalsy();
  });
});
