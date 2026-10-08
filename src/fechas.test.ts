import { describe, expect, test } from "vitest";
import { fechaHoraColombia } from "./fechas";

describe("fechaHoraColombia", () => {
  test("una hora escrita sin zona es hora de Colombia (UTC-5)", () => {
    // El bug de produccion: 11:30 escrito en el formulario quedaba como 06:30 en el RNDC
    // porque el servidor corre en UTC.
    expect(fechaHoraColombia("2026-10-01T11:30").toISOString()).toBe("2026-10-01T16:30:00.000Z");
  });

  test("acepta segundos y milisegundos", () => {
    expect(fechaHoraColombia("2026-10-01T11:30:15").toISOString()).toBe("2026-10-01T16:30:15.000Z");
    expect(fechaHoraColombia("2026-10-01T11:30:15.250").toISOString()).toBe("2026-10-01T16:30:15.250Z");
  });

  test("si ya trae zona, se respeta", () => {
    expect(fechaHoraColombia("2026-10-01T11:30:00Z").toISOString()).toBe("2026-10-01T11:30:00.000Z");
    expect(fechaHoraColombia("2026-10-01T11:30:00-05:00").toISOString()).toBe("2026-10-01T16:30:00.000Z");
  });

  test("un Date se devuelve igual", () => {
    const d = new Date("2026-10-01T16:30:00Z");
    expect(fechaHoraColombia(d)).toBe(d);
  });

  test("un texto invalido da una fecha invalida (la valida quien la usa)", () => {
    expect(Number.isNaN(fechaHoraColombia("no es fecha").getTime())).toBe(true);
    expect(Number.isNaN(fechaHoraColombia(undefined).getTime())).toBe(true);
  });
});
