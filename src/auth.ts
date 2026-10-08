/**
 * Autenticacion: usuarios con email + contrasena y sesiones en cookie.
 *
 * - Contrasenas con scrypt (incluido en Node, sin dependencias) y sal propia
 *   por usuario. Nunca se guarda ni se registra la contrasena en claro.
 * - La sesion es un token aleatorio en una cookie HttpOnly: el JavaScript del
 *   navegador no puede leerlo (protege contra XSS) y viaja solo, lo que
 *   permite abrir los PDF del manifiesto en otra pestana. En la base se guarda
 *   el HASH del token: si alguien lee la tabla, no puede usar las sesiones.
 * - La sesion vence tras 12 horas sin actividad; cada peticion la renueva.
 * - Tras varios intentos fallidos se bloquea el login un rato (en memoria).
 *
 * Por ahora no hay roles: todo usuario activo puede todo.
 */

import { createHash, randomBytes, scrypt, timingSafeEqual } from "crypto";
import type { NextFunction, Request, Response } from "express";
import { RowDataPacket, ResultSetHeader } from "mysql2";
import { pool } from "./db";

export const COOKIE_SESION = "tms_sesion";
const INACTIVIDAD_MS = 12 * 60 * 60 * 1000;
const LARGO_MINIMO_CLAVE = 8;

// ---------------------------------------------------------------------------
// Contrasenas
// ---------------------------------------------------------------------------

const PARAMETROS_SCRYPT = { N: 16384, r: 8, p: 1 };

/**
 * Version con promesa de crypto.scrypt: deriva una llave de 'largo' bytes a
 * partir de la contrasena y la sal, con los parametros de PARAMETROS_SCRYPT.
 */
function scryptAsync(clave: string, sal: Buffer, largo: number): Promise<Buffer> {
  return new Promise((ok, falla) =>
    scrypt(clave, sal, largo, PARAMETROS_SCRYPT, (err, llave) => (err ? falla(err) : ok(llave)))
  );
}

/** "scrypt$<sal base64>$<hash base64>" */
export async function hashClave(clave: string): Promise<string> {
  const sal = randomBytes(16);
  const llave = await scryptAsync(clave, sal, 64);
  return `scrypt$${sal.toString("base64")}$${llave.toString("base64")}`;
}

/**
 * Comprueba una contrasena contra el hash guardado ("scrypt$sal$hash").
 *
 * Vuelve a derivar la llave con la misma sal y la compara en tiempo constante
 * (timingSafeEqual), para no revelar por el tiempo de respuesta cuantos bytes
 * coincidieron. Un formato desconocido devuelve false.
 */
export async function verificarClave(clave: string, guardado: string): Promise<boolean> {
  const [algoritmo, salB64, hashB64] = guardado.split("$");
  if (algoritmo !== "scrypt" || !salB64 || !hashB64) return false;
  const esperado = Buffer.from(hashB64, "base64");
  const llave = await scryptAsync(clave, Buffer.from(salB64, "base64"), esperado.length);
  // Comparacion en tiempo constante: no revela cuantos bytes coincidieron.
  return llave.length === esperado.length && timingSafeEqual(llave, esperado);
}

/**
 * Reglas de una contrasena nueva: minimo LARGO_MINIMO_CLAVE caracteres, con
 * letras y numeros. Devuelve el mensaje del problema o null si sirve.
 */
export function problemaConClave(clave: string): string | null {
  if (clave.length < LARGO_MINIMO_CLAVE) return `La contrasena debe tener al menos ${LARGO_MINIMO_CLAVE} caracteres.`;
  if (!/[A-Za-z]/.test(clave) || !/\d/.test(clave)) return "La contrasena debe tener letras y numeros.";
  return null;
}

/** Contrasena temporal legible (sin 0/O ni 1/l para dictarla sin confusiones). */
export function claveTemporal(): string {
  const letras = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz";
  const digitos = "23456789";
  const bytes = randomBytes(10);
  let s = "";
  for (let i = 0; i < 8; i++) s += letras[bytes[i] % letras.length];
  return s + digitos[bytes[8] % digitos.length] + digitos[bytes[9] % digitos.length];
}

// ---------------------------------------------------------------------------
// Usuarios
// ---------------------------------------------------------------------------

export interface Usuario {
  id: number;
  email: string;
  nombre: string;
  activo: boolean;
  /** true si entro con una clave temporal y debe cambiarla. */
  debeCambiarClave: boolean;
  ultimoAcceso: Date | null;
  creadoEn: Date;
}

/**
 * Fila de la tabla usuarios -> objeto Usuario (sin el hash de la clave, que
 * solo sale de este modulo en conClavePorEmail).
 */
function mapUsuario(r: any): Usuario {
  return {
    id: r.id,
    email: r.email,
    nombre: r.nombre,
    activo: !!r.activo,
    debeCambiarClave: !!r.debeCambiarClave,
    ultimoAcceso: r.ultimoAcceso ?? null,
    creadoEn: r.creadoEn,
  };
}

/** Correo sin espacios y en minuscula: asi se guarda y asi se busca. */
export const normalizarEmail = (e: unknown) => String(e ?? "").trim().toLowerCase();
/** Validacion basica de formato de correo (algo@dominio.ext). */
export const emailValido = (e: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);

/** Repositorio de usuarios del sistema (tabla usuarios). */
export const usuarios = {
  /** Todos los usuarios, ordenados por nombre. */
  async listar(): Promise<Usuario[]> {
    const [rows] = await pool.query<RowDataPacket[]>("SELECT * FROM usuarios ORDER BY nombre");
    return rows.map(mapUsuario);
  },
  /** Un usuario por id, o null. */
  async porId(id: number): Promise<Usuario | null> {
    const [rows] = await pool.query<RowDataPacket[]>("SELECT * FROM usuarios WHERE id = ?", [id]);
    return rows[0] ? mapUsuario(rows[0]) : null;
  },
  /** Usuario con su hash de clave, para verificar el login. Solo lo usa la ruta de login. */
  async conClavePorEmail(email: string): Promise<(Usuario & { claveHash: string }) | null> {
    const [rows] = await pool.query<RowDataPacket[]>("SELECT * FROM usuarios WHERE email = ?", [email]);
    return rows[0] ? { ...mapUsuario(rows[0]), claveHash: rows[0].claveHash } : null;
  },
  /**
   * Crea un usuario guardando el hash de la clave (nunca la clave).
   * debeCambiar=true obliga a cambiarla al primer ingreso (clave temporal).
   */
  async crear(email: string, nombre: string, clave: string, debeCambiar: boolean): Promise<Usuario> {
    const [res] = await pool.query<ResultSetHeader>(
      "INSERT INTO usuarios (email, nombre, claveHash, debeCambiarClave) VALUES (?, ?, ?, ?)",
      [email, nombre, await hashClave(clave), debeCambiar ? 1 : 0]
    );
    return (await this.porId(res.insertId))!;
  },
  /**
   * Reemplaza la clave de un usuario (guarda el hash nuevo) y fija si debe
   * cambiarla en el proximo ingreso.
   */
  async cambiarClave(id: number, clave: string, debeCambiar: boolean): Promise<void> {
    await pool.query("UPDATE usuarios SET claveHash = ?, debeCambiarClave = ? WHERE id = ?", [
      await hashClave(clave),
      debeCambiar ? 1 : 0,
      id,
    ]);
  },
  /** Cambia nombre y/o estado activo. Los campos ausentes no se tocan. */
  async actualizar(id: number, datos: { nombre?: string; activo?: boolean }): Promise<void> {
    if (datos.nombre !== undefined) await pool.query("UPDATE usuarios SET nombre = ? WHERE id = ?", [datos.nombre, id]);
    if (datos.activo !== undefined) await pool.query("UPDATE usuarios SET activo = ? WHERE id = ?", [datos.activo ? 1 : 0, id]);
  },
  /** Cuantos usuarios activos hay (para no desactivar al ultimo). */
  async contarActivos(): Promise<number> {
    const [rows] = await pool.query<RowDataPacket[]>("SELECT COUNT(*) n FROM usuarios WHERE activo = 1");
    return Number(rows[0].n);
  },
};

// ---------------------------------------------------------------------------
// Sesiones
// ---------------------------------------------------------------------------

/** SHA-256 en hexadecimal del token de sesion: es lo que se guarda en la base. */
const hashToken = (t: string) => createHash("sha256").update(t).digest("hex");

/**
 * Sesiones abiertas (tabla sesiones). Se guarda el HASH SHA-256 del token,
 * nunca el token: quien lea la tabla no puede suplantar a nadie.
 */
export const sesiones = {
  /**
   * Abre una sesion: genera un token aleatorio de 32 bytes, guarda su hash con
   * vencimiento por inactividad, anota el ultimo acceso del usuario y devuelve
   * el token (que viaja en la cookie).
   */
  async crear(usuarioId: number): Promise<string> {
    const token = randomBytes(32).toString("base64url");
    await pool.query(
      "INSERT INTO sesiones (tokenHash, usuarioId, expiraEn) VALUES (?, ?, ?)",
      [hashToken(token), usuarioId, new Date(Date.now() + INACTIVIDAD_MS)]
    );
    await pool.query("UPDATE usuarios SET ultimoAcceso = UTC_TIMESTAMP() WHERE id = ?", [usuarioId]);
    return token;
  },

  /** Usuario de la sesion si es valida; ademas la renueva (inactividad). */
  async validar(token: string): Promise<Usuario | null> {
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT u.* FROM sesiones s JOIN usuarios u ON u.id = s.usuarioId
        WHERE s.tokenHash = ? AND s.expiraEn > UTC_TIMESTAMP() AND u.activo = 1`,
      [hashToken(token)]
    );
    if (!rows[0]) return null;
    await pool.query("UPDATE sesiones SET expiraEn = ? WHERE tokenHash = ?", [
      new Date(Date.now() + INACTIVIDAD_MS),
      hashToken(token),
    ]);
    return mapUsuario(rows[0]);
  },

  /** Cierra la sesion de ese token (logout). */
  async cerrar(token: string): Promise<void> {
    await pool.query("DELETE FROM sesiones WHERE tokenHash = ?", [hashToken(token)]);
  },

  /** Al desactivar un usuario o restablecer su clave, sus sesiones mueren. */
  async cerrarTodasDe(usuarioId: number, exceptoToken?: string): Promise<void> {
    if (exceptoToken) {
      await pool.query("DELETE FROM sesiones WHERE usuarioId = ? AND tokenHash <> ?", [usuarioId, hashToken(exceptoToken)]);
    } else {
      await pool.query("DELETE FROM sesiones WHERE usuarioId = ?", [usuarioId]);
    }
  },

  /** Borra las sesiones vencidas (mantenimiento). */
  async limpiarVencidas(): Promise<void> {
    await pool.query("DELETE FROM sesiones WHERE expiraEn <= UTC_TIMESTAMP()");
  },
};

// ---------------------------------------------------------------------------
// Cookie y filtro de la API
// ---------------------------------------------------------------------------

/** Saca el token de sesion de la cabecera Cookie de la peticion, o null si no viene. */
export function leerToken(req: Request): string | null {
  const cabecera = req.headers.cookie ?? "";
  for (const parte of cabecera.split(";")) {
    const [nombre, ...resto] = parte.trim().split("=");
    if (nombre === COOKIE_SESION) return decodeURIComponent(resto.join("="));
  }
  return null;
}

/**
 * Pone la cookie de sesion: HttpOnly (el JavaScript de la pagina no la lee),
 * SameSite=Lax, y Secure cuando la peticion llego por HTTPS.
 */
export function ponerCookie(res: Response, token: string, req: Request): void {
  res.cookie(COOKIE_SESION, token, {
    httpOnly: true,
    sameSite: "lax",
    // Solo por HTTPS cuando el sistema se sirva con HTTPS.
    secure: req.secure,
    path: "/",
  });
}

/** Borra la cookie de sesion del navegador (logout). */
export function borrarCookie(res: Response): void {
  res.clearCookie(COOKIE_SESION, { path: "/" });
}

declare module "express-serve-static-core" {
  interface Request {
    usuario?: Usuario;
  }
}

/** Filtro: toda ruta de la API (menos el login) exige una sesion valida. */
export async function exigirSesion(req: Request, res: Response, next: NextFunction) {
  const token = leerToken(req);
  const usuario = token ? await sesiones.validar(token) : null;
  if (!usuario) {
    return res.status(401).json({ error: "Tu sesion vencio o no has iniciado sesion.", sesion: false });
  }
  req.usuario = usuario;
  next();
}

// ---------------------------------------------------------------------------
// Limite de intentos de login (en memoria: se reinicia con el servidor)
// ---------------------------------------------------------------------------

const MAX_INTENTOS = 5;
const BLOQUEO_MS = 10 * 60 * 1000;
const intentos = new Map<string, { fallos: number; hasta: number }>();

/** Minutos que faltan si esta bloqueado; 0 si puede intentar. */
export function minutosBloqueado(clave: string): number {
  const r = intentos.get(clave);
  if (!r || r.fallos < MAX_INTENTOS) return 0;
  const falta = r.hasta - Date.now();
  if (falta <= 0) {
    intentos.delete(clave);
    return 0;
  }
  return Math.ceil(falta / 60000);
}
/**
 * Suma un intento fallido de login para esa clave (correo o IP). Al llegar a
 * MAX_INTENTOS bloquea durante BLOQUEO_MS (10 minutos).
 */
export function registrarFallo(clave: string): void {
  const r = intentos.get(clave) ?? { fallos: 0, hasta: 0 };
  r.fallos++;
  if (r.fallos >= MAX_INTENTOS) r.hasta = Date.now() + BLOQUEO_MS;
  intentos.set(clave, r);
}
/** Olvida los fallos de esa clave (tras un login correcto). */
export function limpiarFallos(clave: string): void {
  intentos.delete(clave);
}

// ---------------------------------------------------------------------------
// Recuperacion de contrasena por correo
// ---------------------------------------------------------------------------

export const MINUTOS_CODIGO = 15;
const MAX_INTENTOS_CODIGO = 5;

/** El hash lleva el id del usuario: el mismo codigo no sirve para otra cuenta. */
const hashCodigo = (usuarioId: number, codigo: string) =>
  createHash("sha256").update(`${usuarioId}:${codigo}`).digest("hex");

/**
 * Codigos de recuperacion de contrasena por correo (tabla recuperaciones).
 * Se guarda el hash del codigo, su vencimiento y los intentos fallidos.
 */
export const recuperaciones = {
  /** Genera un codigo nuevo de 6 digitos; anula los anteriores del usuario. */
  async crear(usuarioId: number): Promise<string> {
    const codigo = String(100000 + (randomBytes(4).readUInt32BE(0) % 900000));
    await pool.query("DELETE FROM recuperaciones WHERE usuarioId = ?", [usuarioId]);
    await pool.query("INSERT INTO recuperaciones (usuarioId, codigoHash, expiraEn) VALUES (?, ?, ?)", [
      usuarioId,
      hashCodigo(usuarioId, codigo),
      new Date(Date.now() + MINUTOS_CODIGO * 60 * 1000),
    ]);
    return codigo;
  },

  /**
   * true si el codigo es valido y vigente. Cada fallo suma un intento; al
   * llegar al maximo el codigo se anula y hay que pedir otro.
   */
  async verificar(usuarioId: number, codigo: string): Promise<boolean> {
    const [rows] = await pool.query<RowDataPacket[]>(
      "SELECT * FROM recuperaciones WHERE usuarioId = ? AND expiraEn > UTC_TIMESTAMP() ORDER BY id DESC LIMIT 1",
      [usuarioId]
    );
    const r = rows[0];
    if (!r) return false;
    const esperado = Buffer.from(r.codigoHash, "hex");
    const recibido = Buffer.from(hashCodigo(usuarioId, codigo.trim()), "hex");
    if (timingSafeEqual(esperado, recibido)) return true;
    if (r.intentos + 1 >= MAX_INTENTOS_CODIGO) {
      await pool.query("DELETE FROM recuperaciones WHERE id = ?", [r.id]);
    } else {
      await pool.query("UPDATE recuperaciones SET intentos = intentos + 1 WHERE id = ?", [r.id]);
    }
    return false;
  },

  /** Anula los codigos pendientes de un usuario (tras usarlos). */
  async borrarDe(usuarioId: number): Promise<void> {
    await pool.query("DELETE FROM recuperaciones WHERE usuarioId = ?", [usuarioId]);
  },
};
