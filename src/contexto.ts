/**
 * Quien hace cada peticion, para la bitacora de cambios (ver bitacora.ts).
 *
 * exigirSesion guarda aqui el usuario y la ruta (POST /api/cuadro/12...) y
 * todo lo que pase dentro de la peticion lo puede leer, aunque sea en otra
 * funcion o despues de un await (AsyncLocalStorage de Node). Antes de cada
 * escritura en la base, el pool pone esos dos datos en variables de sesion de
 * MySQL (@sofi_usuario y @sofi_origen) y los triggers de la bitacora los
 * guardan con el cambio. Lo que no viene de una peticion (la sincronizacion
 * del RNDC, el mantenimiento del cuadro) queda sin usuario: "Sistema".
 */
import { AsyncLocalStorage } from "node:async_hooks";

/** El usuario y la ruta de la peticion en curso. */
export interface ContextoPeticion {
  usuarioId: number | null;
  /** Metodo y ruta, p. ej. "PUT /api/cuadro/123". */
  origen: string | null;
}

export const contextoPeticion = new AsyncLocalStorage<ContextoPeticion>();

/** Los valores de @sofi_usuario y @sofi_origen para la escritura en curso (null fuera de una peticion). */
export function variablesBitacora(): [number | null, string | null] {
  const c = contextoPeticion.getStore();
  return [c?.usuarioId ?? null, c?.origen ? c.origen.slice(0, 200) : null];
}
