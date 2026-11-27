import { describe, expect, test } from "vitest";
import { liquidarConductor } from "./calculoConductores";
import { calcularLinea } from "./calculoNomina";
import type { ParametrosNomina } from "./calculoNomina";

/** Parametros 2026 (los del Excel de nomina). */
const P2026: ParametrosNomina = {
  anio: 2026,
  smmlv: 1_750_905,
  auxilioTransporte: 249_095,
  pensionEmpleador: 12,
  saludEmpleador: 0,
  arl: [0.522, 1.044, 2.436, 4.35, 6.96],
  caja: 4,
  prima: 8.33,
  cesantias: 8.33,
  interesesCesantias: 12,
  vacaciones: 4.17,
  saludEmpleado: 4,
  pensionEmpleado: 4,
  limiteNoSalarial: 40,
};

describe("liquidacion del conductor sin nomina (calculo provisional)", () => {
  // Un mes como el de la SWK-973: tres viajes con su flete conductor y su cuenta.
  const viajes = [
    { producido: 4_200_000, saldo: 350_000 },
    { producido: 5_200_000, saldo: -120_000 },
    { producido: 3_900_000, saldo: null }, // sin cuenta de viaje aun
  ];
  const base = liquidarConductor({ viajes, pctSalarial: 4, pctViaticos: 5, nomina: null, prestamos: 0 });
  // Lo que hace nomina.provisional: la linea del mes completo con ese producido.
  const linea = calcularLinea(
    {
      salarioBase: null,
      salarioAdicional: 0,
      pctSalarial: 4,
      pctViaticos: 5,
      auxilio: true,
      riesgoArl: 4,
      dias: 30,
      producido: base.producido,
      integro: base.integro,
      ajuste: 0,
    },
    P2026,
  );
  const liq = liquidarConductor({
    viajes,
    pctSalarial: 4,
    pctViaticos: 5,
    nomina: { devengado: linea.devengado, deducciones: linea.saludEmpleado + linea.pensionEmpleado, neto: linea.neto },
    prestamos: 500_000,
  });

  test("ya no queda sin total por falta de nomina", () => {
    expect(base.totalAPagar).toBeNull();
    expect(liq.totalAPagar).not.toBeNull();
  });

  test("el 9 % del flete conductor (4 % salarial + 5 % viaticos) y el rojo de las cuentas", () => {
    expect(liq.producido).toBe(13_300_000);
    expect(liq.salarial + liq.viaticos).toBe(1_197_000);
    expect(liq.saldoCuentas).toBe(230_000);
    expect(liq.viajesSinCuenta).toBe(1);
  });

  test("la hoja del conductor cuadra: % + rojo + sueldo + auxilio - seguro - prestamo = total", () => {
    const hoja = liq.salarial + liq.viaticos + liq.saldoCuentas + linea.basico + linea.auxilio - (linea.saludEmpleado + linea.pensionEmpleado) - 500_000;
    expect(Math.round(hoja * 100) / 100).toBe(liq.totalAPagar);
  });
});
