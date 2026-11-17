import { describe, expect, test } from "vitest";
import { correosSiempreTotal, placaClave, puede, rolDe, veCuentasDe, veRentabilidadTerceros, veVehiculo } from "./roles";

describe("roles", () => {
  test("cada rol entra a sus areas", () => {
    const todas = ["RNDC", "OPERACION", "CUENTAS", "LIQUIDACION", "REPARTO", "GASTOS", "ADMINISTRACION", "USUARIOS"];
    expect(todas.every((a) => puede("TOTAL", a as never))).toBe(true);
    // Administrativas: todo menos el reparto de los socios y el cambio de roles (17/11/2026).
    expect(todas.filter((a) => !puede("ADMINISTRATIVO", a as never))).toEqual(["REPARTO", "USUARIOS"]);
    // M&C: todo menos el cambio de roles (la rentabilidad de terceros se filtra por vehiculo).
    expect(todas.filter((a) => !puede("MYC", a as never))).toEqual(["USUARIOS"]);
    expect([veRentabilidadTerceros("TOTAL"), veRentabilidadTerceros("ADMINISTRATIVO"), veRentabilidadTerceros("MYC")]).toEqual([true, true, false]);
  });

  test("un rol desconocido queda con los permisos de administrativo", () => {
    expect([rolDe("MYC"), rolDe(null), rolDe("JEFE")]).toEqual(["MYC", "ADMINISTRATIVO", "ADMINISTRATIVO"]);
  });

  test("cuentas por vehiculo: total y administrativo todo, M&C la flota propia (no los terceros)", () => {
    const lopez = { empresa: "LOPEZ", visibleTodos: false };
    const myc = { empresa: "MYC", visibleTodos: false };
    const volvo = { empresa: "LOPEZ", visibleTodos: true };
    const tercero = { empresa: null, visibleTodos: false };
    expect([lopez, myc, volvo, tercero].map((v) => veCuentasDe("TOTAL", v))).toEqual([true, true, true, true]);
    expect([lopez, myc, volvo, tercero].map((v) => veCuentasDe("MYC", v))).toEqual([true, true, true, false]);
    expect([lopez, myc, volvo, tercero].map((v) => veCuentasDe("ADMINISTRATIVO", v))).toEqual([true, true, true, true]);
    expect([lopez, myc, tercero].map((v) => veVehiculo("ADMINISTRATIVO", v))).toEqual([true, true, true]);
    // Lo operativo (perfil, preoperacional): todos ven todos.
    expect([lopez, myc, volvo, null].map((v) => veVehiculo("MYC", v))).toEqual([true, true, true, true]);
  });

  test("placa comparable", () => {
    expect(placaClave(" xgj-197 ")).toBe("XGJ197");
  });
});

describe("cuentas con acceso total siempre", () => {
  test("la principal mas las del .env (TMS_CORREOS_TOTAL), sin repetir y en minusculas", () => {
    const antes = process.env.TMS_CORREOS_TOTAL;
    process.env.TMS_CORREOS_TOTAL = " Socio@Ejemplo.com , transporteslopezcsas@gmail.com,";
    expect(correosSiempreTotal()).toEqual(["transporteslopezcsas@gmail.com", "socio@ejemplo.com"]);
    delete process.env.TMS_CORREOS_TOTAL;
    expect(correosSiempreTotal()).toEqual(["transporteslopezcsas@gmail.com"]);
    if (antes !== undefined) process.env.TMS_CORREOS_TOTAL = antes;
  });
});
