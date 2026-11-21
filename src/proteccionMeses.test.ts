import { describe, expect, test } from "vitest";
import { mesesTocados, primerDiaLibre } from "./proteccionMeses";

describe("meses congelados (cerrados, reparto aprobado, nomina aprobada, liquidacion pagada)", () => {
  const congelados = new Set(["2026-09", "2026-10"]);
  test("una vigencia que cae en un mes congelado (o antes) no se deja: debe empezar el 1 del mes siguiente al ultimo", () => {
    expect(primerDiaLibre(congelados, "2026-10-15")).toBe("2026-11-01");
    expect(primerDiaLibre(congelados, "2026-08-01")).toBe("2026-11-01");
    expect(primerDiaLibre(new Set(["2026-12"]), "2026-12-05")).toBe("2027-01-01");
  });
  test("desde el mes siguiente al ultimo congelado, libre", () => {
    expect(primerDiaLibre(congelados, "2026-11-01")).toBeNull();
    expect(primerDiaLibre(new Set(), "2020-01-01")).toBeNull();
  });
  test("fletes conductor: solo cuentan los viajes de la tarifa en el tramo donde rige el valor", () => {
    const viajes = ["2026-09-30", "2026-10-05", "2026-11-02", "2026-12-01"];
    // El valor rige del 01/10 al 30/11: toca octubre (congelado) y noviembre (libre).
    expect(mesesTocados(viajes, "2026-10-01", "2026-12-01", congelados)).toEqual(["2026-10"]);
    // Un valor nuevo desde el 01/11 no toca nada congelado.
    expect(mesesTocados(viajes, "2026-11-01", null, congelados)).toEqual([]);
    // Corregir el valor de siempre (desde 1999) toca septiembre y octubre.
    expect(mesesTocados(viajes, "1999-04-01", null, congelados)).toEqual(["2026-09", "2026-10"]);
  });
});
