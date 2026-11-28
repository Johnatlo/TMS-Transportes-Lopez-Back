/**
 * Inicio personalizado de cada usuario: que tarjetas tiene en su pagina de
 * inicio y donde (columna, fila, ancho y alto en la rejilla de 12 columnas).
 * Es una preferencia: no va a la bitacora.
 */
import { RowDataPacket } from "mysql2";
import { pool } from "./db";

/** Una tarjeta del inicio: su id (del catalogo del frontend) y su lugar en la rejilla. */
export interface TarjetaInicio {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Columnas de la rejilla y tope de tarjetas por inicio. */
export const COLUMNAS_INICIO = 12;
export const MAXIMO_TARJETAS = 40;

/** v si es un entero entre min y max; si no, null. */
const entero = (v: unknown, min: number, max: number): number | null =>
  Number.isInteger(v) && (v as number) >= min && (v as number) <= max ? (v as number) : null;

/**
 * Valida la disposicion que manda el navegador: una lista de tarjetas con id
 * corto (letras minusculas, numeros, guion y dos puntos) y un lugar dentro de
 * la rejilla. Sin ids repetidos ni mas de MAXIMO_TARJETAS. Devuelve null si
 * algo no cuadra (no guarda a medias).
 */
export function limpiarDisposicion(entrada: unknown): TarjetaInicio[] | null {
  if (!Array.isArray(entrada) || entrada.length > MAXIMO_TARJETAS) return null;
  const vistas = new Set<string>();
  const salida: TarjetaInicio[] = [];
  for (const t of entrada) {
    if (!t || typeof t !== "object") return null;
    const { id, x, y, w, h } = t as Record<string, unknown>;
    if (typeof id !== "string" || !/^[a-z0-9:-]{1,40}$/.test(id) || vistas.has(id)) return null;
    const ancho = entero(w, 1, COLUMNAS_INICIO);
    const columna = entero(x, 0, COLUMNAS_INICIO - 1);
    const fila = entero(y, 0, 500);
    const alto = entero(h, 1, 20);
    if (ancho === null || columna === null || fila === null || alto === null || columna + ancho > COLUMNAS_INICIO) return null;
    vistas.add(id);
    salida.push({ id, x: columna, y: fila, w: ancho, h: alto });
  }
  return salida;
}

/** Lectura y guardado del inicio de cada usuario (tabla inicio_usuario). */
export const inicioUsuario = {
  /** El inicio guardado del usuario, o null si usa el de su rol. */
  async leer(usuarioId: number): Promise<TarjetaInicio[] | null> {
    const [[f]] = await pool.query<RowDataPacket[]>("SELECT disposicion FROM inicio_usuario WHERE usuarioId = ?", [usuarioId]);
    if (!f) return null;
    try {
      return limpiarDisposicion(typeof f.disposicion === "string" ? JSON.parse(f.disposicion) : f.disposicion);
    } catch {
      return null;
    }
  },

  /** Guarda (o reemplaza) el inicio del usuario. */
  async guardar(usuarioId: number, tarjetas: TarjetaInicio[]): Promise<void> {
    await pool.query(
      "INSERT INTO inicio_usuario (usuarioId, disposicion) VALUES (?, ?) ON DUPLICATE KEY UPDATE disposicion = VALUES(disposicion), actualizadoEn = CURRENT_TIMESTAMP",
      [usuarioId, JSON.stringify(tarjetas)],
    );
  },

  /** Vuelve al inicio de su rol (borra el guardado). */
  async borrar(usuarioId: number): Promise<void> {
    await pool.query("DELETE FROM inicio_usuario WHERE usuarioId = ?", [usuarioId]);
  },
};
