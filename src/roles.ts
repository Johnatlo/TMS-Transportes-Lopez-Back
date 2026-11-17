/**
 * Roles de los usuarios y lo que puede ver cada uno.
 *
 * - TOTAL: todo el aplicativo (hoy Principal y Admin), incluido aprobar el
 *   reparto y cambiar participaciones, socios y fondos.
 * - ADMINISTRATIVO: ve y edita todo menos el reparto de los socios (fondos,
 *   reparto y cuentas de socios) y el cambio de roles (17/11/2026).
 * - MYC: Transportes M&C. Ve todo (tambien todos los gastos) menos la
 *   rentabilidad de los terceros y el cambio de roles (17/11/2026). Registra
 *   y cambia los gastos y empleados de su empresa.
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
  /** Rentabilidad (filtrada por vehiculo segun el rol). */
  | "CUENTAS"
  /** Liquidacion a duenos y la cascada de utilidades por vehiculo. */
  | "LIQUIDACION"
  /** Reparto de los socios: fondos de los vehiculos, reparto mensual y cuentas de socios. */
  | "REPARTO"
  /** Libro de gastos, creditos y nomina (M&C los ve todos; registra los de su empresa). */
  | "GASTOS"
  /** Configuracion de la empresa y la empresa de cada vehiculo. */
  | "ADMINISTRACION"
  /** Usuarios y sus roles. */
  | "USUARIOS";

const AREAS: Record<Rol, Area[]> = {
  TOTAL: ["RNDC", "OPERACION", "CUENTAS", "LIQUIDACION", "REPARTO", "GASTOS", "ADMINISTRACION", "USUARIOS"],
  ADMINISTRATIVO: ["RNDC", "OPERACION", "CUENTAS", "LIQUIDACION", "GASTOS", "ADMINISTRACION"],
  MYC: ["RNDC", "OPERACION", "CUENTAS", "LIQUIDACION", "REPARTO", "GASTOS", "ADMINISTRACION"],
};

/** El rol tiene acceso a esa area. */
export const puede = (rol: Rol, area: Area) => AREAS[rol].includes(area);

/** Vehiculo con lo que define quien lo ve. */
export interface VisibilidadVehiculo {
  empresa: string | null;
  visibleTodos: boolean;
}

/**
 * El rol ve las cuentas (rentabilidad) de ese vehiculo: TOTAL y
 * ADMINISTRATIVO todos; MYC los de la flota propia (Lopez y M&C) y los
 * marcados para todos, no los de terceros.
 */
export function veCuentasDe(rol: Rol, v: VisibilidadVehiculo | null | undefined): boolean {
  if (rol === "MYC") return !!v && (!!v.empresa || v.visibleTodos);
  return true;
}

/** El rol ve la rentabilidad de los viajes de terceros (M&C no). */
export const veRentabilidadTerceros = (rol: Rol) => rol !== "MYC";

/**
 * El rol ve ese vehiculo en lo operativo (perfil de vehiculos,
 * preoperacional). Desde el 17/11/2026 todos los roles ven todos.
 */
export function veVehiculo(rol: Rol, v: VisibilidadVehiculo | null | undefined): boolean {
  void rol;
  void v;
  return true;
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

/**
 * Cuentas que siempre tienen acceso total (se revisa al arrancar): la
 * principal de la empresa, para que nunca quede el sistema sin quien
 * administre los usuarios. Es el correo publico de la empresa.
 */
export const CORREOS_SIEMPRE_TOTAL = ["transporteslopezcsas@gmail.com"];

/**
 * Las cuentas con acceso total siempre: la principal y las que se pongan en
 * TMS_CORREOS_TOTAL (separadas por comas) en el .env del servidor. Los
 * correos personales van ahi y no en el codigo.
 */
export function correosSiempreTotal(): string[] {
  const extra = (process.env.TMS_CORREOS_TOTAL ?? "")
    .split(",")
    .map((c) => c.trim().toLowerCase())
    .filter(Boolean);
  return [...new Set([...CORREOS_SIEMPRE_TOTAL, ...extra])];
}

/** Nombres de los usuarios que quedan con acceso total al crear los roles; los demas quedan administrativos. */
export const NOMBRES_TOTAL_INICIAL = ["PRINCIPAL", "ADMIN"];
