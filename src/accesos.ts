/**
 * Accesos por rol en la API (ver src/roles.ts): filtros de Express por area y
 * la visibilidad de cada vehiculo (empresa y visibleTodos) para filtrar las
 * cuentas y lo operativo de M&C.
 */
import type { NextFunction, Request, Response } from "express";
import type { RowDataPacket } from "mysql2";
import { pool } from "./db";
import { placaClave, puede, rolDe, veCuentasDe, veVehiculo } from "./roles";
import type { Area, Rol, VisibilidadVehiculo } from "./roles";

/** Rol del usuario de la peticion. */
export const rolDePeticion = (req: Request): Rol => rolDe(req.usuario?.rol);

/** Mensaje cuando el rol no puede entrar. */
export const SIN_PERMISO = "Tu usuario no tiene permiso para esta seccion.";

/** Filtro de Express: deja pasar solo a los roles con esa area. */
export function exigirArea(area: Area) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (puede(rolDePeticion(req), area)) return next();
    res.status(403).json({ error: SIN_PERMISO });
  };
}

/** Empresa y visibilidad de cada vehiculo, por placa comparable. */
export async function visibilidadVehiculos(): Promise<Map<string, VisibilidadVehiculo>> {
  const [filas] = await pool.query<RowDataPacket[]>("SELECT placa, empresa, visibleTodos FROM vehiculos");
  return new Map(filas.map((f) => [placaClave(f.placa), { empresa: f.empresa ?? null, visibleTodos: !!f.visibleTodos }]));
}

/** Funcion que dice si el rol ve las cuentas de una placa (TOTAL: todas sin consultar la base). */
export async function filtroCuentas(rol: Rol): Promise<(placa: unknown) => boolean> {
  if (rol === "TOTAL") return () => true;
  const mapa = await visibilidadVehiculos();
  return (placa) => veCuentasDe(rol, mapa.get(placaClave(placa)));
}

/** Funcion que dice si el rol ve un vehiculo en lo operativo filtrado (perfil, preoperacional). */
export async function filtroVehiculos(rol: Rol): Promise<(placa: unknown) => boolean> {
  if (rol !== "MYC") return () => true;
  const mapa = await visibilidadVehiculos();
  return (placa) => veVehiculo(rol, mapa.get(placaClave(placa)));
}

/**
 * Cuadro pagos: los roles con OPERACION entran a todo. M&C solo puede editar
 * desde Rentabilidad los viajes de sus vehiculos (PUT /:id y POST /:id/revision).
 */
export async function accesoCuadro(req: Request, res: Response, next: NextFunction) {
  const rol = rolDePeticion(req);
  if (puede(rol, "OPERACION")) return next();
  const m = /^\/(\d+)(\/revision)?\/?$/.exec(req.path);
  const permitido = puede(rol, "CUENTAS") && m && ((req.method === "PUT" && !m[2]) || (req.method === "POST" && !!m[2]));
  if (permitido) {
    const [filas] = await pool.query<RowDataPacket[]>("SELECT placa FROM cuadro_viajes WHERE id = ?", [Number(m![1])]);
    const ve = await filtroCuentas(rol);
    if (filas[0] && ve(filas[0].placa)) return next();
  }
  res.status(403).json({ error: SIN_PERMISO });
}

/**
 * Seguimiento: Rentabilidad y la liquidacion a duenos son de CUENTAS (las
 * matrices solo las cambia el rol total); lo demas (cartera, terceros,
 * papeles, anticipos de empresas) es de OPERACION. Las alertas de la campana
 * a quien no tiene OPERACION le llegan vacias.
 */
export function accesoSeguimiento(req: Request, res: Response, next: NextFunction) {
  const rol = rolDePeticion(req);
  if (req.path.startsWith("/rentabilidad")) {
    if (req.method === "PUT" && req.path.startsWith("/rentabilidad/matrices") && rol !== "TOTAL") {
      return res.status(403).json({ error: "Solo el rol total puede cambiar las matrices." });
    }
    return puede(rol, "CUENTAS") ? next() : res.status(403).json({ error: SIN_PERMISO });
  }
  if (req.method === "GET" && req.path === "/alertas" && !puede(rol, "OPERACION")) {
    return res.json({ hoy: new Date().toISOString().slice(0, 10), urgentes: 0, alertas: [] });
  }
  return puede(rol, "OPERACION") ? next() : res.status(403).json({ error: SIN_PERMISO });
}
