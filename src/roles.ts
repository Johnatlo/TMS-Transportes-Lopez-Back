/**
 * Roles de los usuarios y lo que puede ver cada uno.
 *
 * - TOTAL: todo el aplicativo (hoy Principal y Admin).
 * - ADMINISTRATIVO: lo operativo del TMS (despacho, RNDC, Cuadro pagos,
 *   anticipos, cartera, pago a terceros...), sin las cuentas de los
 *   vehiculos (Rentabilidad, liquidacion a duenos, reparto de ganancias) ni
 *   la liquidacion de los empleados.
 * - MYC: Transportes M&C. Lo del RNDC (despachar, RNDC, plantillas, clientes,
 *   flota, conductores, preoperacional) y las cuentas solo de sus vehiculos
 *   (Rentabilidad, liquidacion y reparto de ganancias), sin los de Transportes
 *   Lopez ni los terceros.
 *
 * Que vehiculos ve cada rol lo dice vehiculos.empresa (LOPEZ o MYC) y
 * vehiculos.visibleTodos (los que ven todos, como el Volvo XGJ-197).
 * Sin dependencias de Express ni de la base: se prueba aparte (roles.test.ts).
 */

/** Rol de un usuario. */
export type Rol = "TOTAL" | "ADMINISTRATIVO" | "MYC";
export const ROLES: Rol[] = ["TOTAL", "ADMINISTRATIVO", "MYC"];

/** Rol valido o el de menos permisos cuando no se reconoce. */
export const rolDe = (r: unknown): Rol => (ROLES.includes(r as Rol) ? (r as Rol) : "ADMINISTRATIVO");

/** Empresa que liquida un vehiculo propio. */
export type EmpresaVehiculo = "LOPEZ" | "MYC";

/** Areas del aplicativo que se dan por rol. */
export type Area =
  /** Despachar, RNDC, plantillas, clientes, flota, conductores, preoperacional y perfil de vehiculos. */
  | "RNDC"
  /** Cuadro pagos, anticipos, cartera, pago a terceros, papeles y alertas. */
  | "OPERACION"
  /** Rentabilidad, liquidacion a duenos y reparto de ganancias (filtradas por vehiculo segun el rol). */
  | "CUENTAS"
  /** Configuracion de la empresa y la empresa de cada vehiculo. */
  | "ADMINISTRACION"
  /** Usuarios y sus roles. */
  | "USUARIOS";

const AREAS: Record<Rol, Area[]> = {
  TOTAL: ["RNDC", "OPERACION", "CUENTAS", "ADMINISTRACION", "USUARIOS"],
  ADMINISTRATIVO: ["RNDC", "OPERACION", "ADMINISTRACION"],
  MYC: ["RNDC", "CUENTAS"],
};

/** El rol tiene acceso a esa area. */
export const puede = (rol: Rol, area: Area) => AREAS[rol].includes(area);

/** Vehiculo con lo que define quien lo ve. */
export interface VisibilidadVehiculo {
  empresa: string | null;
  visibleTodos: boolean;
}

/**
 * El rol ve las cuentas de ese vehiculo: TOTAL todos (propios y terceros);
 * MYC solo los de M&C y los marcados para todos; ADMINISTRATIVO ninguno (no
 * ve cuentas de vehiculos).
 */
export function veCuentasDe(rol: Rol, v: VisibilidadVehiculo | null | undefined): boolean {
  if (rol === "TOTAL") return true;
  if (rol === "MYC") return !!v && (v.empresa === "MYC" || v.visibleTodos);
  return false;
}

/**
 * El rol ve ese vehiculo en lo operativo filtrado por empresa (perfil de
 * vehiculos, preoperacional): TOTAL y ADMINISTRATIVO todos; MYC los suyos y
 * los marcados para todos.
 */
export function veVehiculo(rol: Rol, v: VisibilidadVehiculo | null | undefined): boolean {
  if (rol !== "MYC") return true;
  return !!v && (v.empresa === "MYC" || v.visibleTodos);
}

/** Placa comparable (sin guion ni espacios, en mayuscula). */
export const placaClave = (p: unknown) => String(p ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");

/**
 * Empresa de los vehiculos al crear la columna (lo que dijo la gerencia el
 * 13/11/2026). Las sociedades de Lopez (SPI-982, SZX-880, XJB-207, SWK-973,
 * JTY-221) van con Lopez. El Volvo XGJ-197 es de Lopez pero lo ven todos.
 */
export const EMPRESA_INICIAL: Record<EmpresaVehiculo, string[]> = {
  LOPEZ: ["JTY219", "SRO029", "SWO594", "SPI982", "SZX880", "XJB207", "SWK973", "JTY221", "XGJ197"],
  MYC: ["SKX202", "SZP339", "SZX826", "TEK298", "TLN860", "SOR429"],
};
export const VISIBLES_PARA_TODOS_INICIAL = ["XGJ197"];

/** Nombres de los usuarios que quedan con acceso total al crear los roles; los demas quedan administrativos. */
export const NOMBRES_TOTAL_INICIAL = ["PRINCIPAL", "ADMIN"];
