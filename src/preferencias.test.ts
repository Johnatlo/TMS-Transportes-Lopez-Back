import { describe, expect, test, vi } from "vitest";

// El modulo importa la conexion a MySQL; estas pruebas no tocan la base.
vi.mock("./db", () => ({ pool: {} }));

import { temaDe } from "./auth";

describe("modo de la pantalla del usuario", () => {
  test("solo se guarda oscuro, claro o automatico", () => {
    expect(temaDe("oscuro")).toBe("oscuro");
    expect(temaDe("claro")).toBe("claro");
    expect(temaDe("auto")).toBe("auto");
    expect(temaDe("OSCURO")).toBeNull();
    expect(temaDe("azul")).toBeNull();
    expect(temaDe(null)).toBeNull();
    expect(temaDe(undefined)).toBeNull();
  });
});
