import { describe, expect, test } from "vitest";
import { placaClave, puede, rolDe, veCuentasDe, veVehiculo } from "./roles";

describe("roles", () => {
  test("cada rol entra a sus areas", () => {
    expect(["RNDC", "OPERACION", "CUENTAS", "ADMINISTRACION", "USUARIOS"].every((a) => puede("TOTAL", a as never))).toBe(true);
    expect([puede("ADMINISTRATIVO", "OPERACION"), puede("ADMINISTRATIVO", "CUENTAS"), puede("ADMINISTRATIVO", "USUARIOS")]).toEqual([true, false, false]);
    expect([puede("MYC", "RNDC"), puede("MYC", "CUENTAS"), puede("MYC", "OPERACION"), puede("MYC", "ADMINISTRACION")]).toEqual([true, true, false, false]);
  });

  test("un rol desconocido queda con los permisos de administrativo", () => {
    expect([rolDe("MYC"), rolDe(null), rolDe("JEFE")]).toEqual(["MYC", "ADMINISTRATIVO", "ADMINISTRATIVO"]);
  });

  test("cuentas por vehiculo: total todo, M&C los suyos y los de todos, administrativo ninguno", () => {
    const lopez = { empresa: "LOPEZ", visibleTodos: false };
    const myc = { empresa: "MYC", visibleTodos: false };
    const volvo = { empresa: "LOPEZ", visibleTodos: true };
    const tercero = { empresa: null, visibleTodos: false };
    expect([lopez, myc, volvo, tercero].map((v) => veCuentasDe("TOTAL", v))).toEqual([true, true, true, true]);
    expect([lopez, myc, volvo, tercero].map((v) => veCuentasDe("MYC", v))).toEqual([false, true, true, false]);
    expect([lopez, myc, volvo, tercero].map((v) => veCuentasDe("ADMINISTRATIVO", v))).toEqual([false, false, false, false]);
    expect([lopez, myc, tercero].map((v) => veVehiculo("ADMINISTRATIVO", v))).toEqual([true, true, true]);
    expect([lopez, myc, volvo, null].map((v) => veVehiculo("MYC", v))).toEqual([false, true, true, false]);
  });

  test("placa comparable", () => {
    expect(placaClave(" xgj-197 ")).toBe("XGJ197");
  });
});
