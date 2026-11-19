import { describe, expect, test } from "vitest";
import { pactoDeEntrada, pactoDeRemesa } from "./repo";

const PLANTILLA = { horasPactoCargue: 4, minutosPactoCargue: 0, horasPactoDescargue: 6, minutosPactoDescargue: 30 };

describe("tiempos pactados de cargue y descargue por remesa", () => {
  test("sin cambios al despachar: los de la plantilla", () => {
    expect(pactoDeRemesa({ horasPactoCargue: null, minutosPactoCargue: null, horasPactoDescargue: null, minutosPactoDescargue: null }, PLANTILLA)).toEqual(
      PLANTILLA,
    );
    expect(pactoDeRemesa(null, PLANTILLA)).toEqual(PLANTILLA);
  });
  test("cargaron mas rapido: lo escrito en la remesa, el resto de la plantilla", () => {
    expect(pactoDeRemesa({ horasPactoCargue: 2, minutosPactoCargue: 15 }, PLANTILLA)).toEqual({ ...PLANTILLA, horasPactoCargue: 2, minutosPactoCargue: 15 });
    // Cero tambien vale (no es "vacio").
    expect(pactoDeRemesa({ horasPactoDescargue: 0, minutosPactoDescargue: 45 }, PLANTILLA)).toMatchObject({
      horasPactoDescargue: 0,
      minutosPactoDescargue: 45,
    });
  });
  test("lo que llega del despacho: enteros en rango o null", () => {
    expect(pactoDeEntrada({ horasPactoCargue: "2", minutosPactoCargue: 75, horasPactoDescargue: "", minutosPactoDescargue: 30 })).toEqual({
      horasPactoCargue: 2,
      minutosPactoCargue: null,
      horasPactoDescargue: null,
      minutosPactoDescargue: 30,
    });
  });
});
