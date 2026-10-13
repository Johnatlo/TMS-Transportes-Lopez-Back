/**
 * Cifrado de datos sensibles guardados en la base (hoy: la clave de la
 * plataforma GPS de cada vehiculo).
 *
 * AES-256-GCM con una llave derivada (scrypt) de TMS_CLAVE_CIFRADO del .env.
 * Quien lea la base sin el .env no ve las claves. GCM ademas detecta si el
 * texto guardado fue alterado.
 *
 * Formato guardado: "v1:" + base64(iv de 12 bytes | etiqueta de 16 | cifrado).
 *
 * Si se cambia TMS_CLAVE_CIFRADO, las claves guardadas ya no se pueden leer y
 * hay que volver a escribirlas.
 */
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "crypto";

/** Falta la llave o el dato guardado no se puede descifrar. */
export class ErrorCifrado extends Error {}

let llaveCache: { secreto: string; llave: Buffer } | null = null;

/** Llave de 32 bytes derivada de TMS_CLAVE_CIFRADO (minimo 16 caracteres). */
function llave(): Buffer {
  const secreto = process.env.TMS_CLAVE_CIFRADO ?? "";
  if (secreto.length < 16) {
    throw new ErrorCifrado(
      "Falta TMS_CLAVE_CIFRADO en el .env del servidor (minimo 16 caracteres): sin ella no se pueden guardar ni leer las claves del GPS."
    );
  }
  if (llaveCache?.secreto !== secreto) llaveCache = { secreto, llave: scryptSync(secreto, "tms-transportes-lopez/gps", 32) };
  return llaveCache.llave;
}

/** Cifra un texto para guardarlo en la base. */
export function cifrar(texto: string): string {
  const iv = randomBytes(12);
  const cifrador = createCipheriv("aes-256-gcm", llave(), iv);
  const cifrado = Buffer.concat([cifrador.update(texto, "utf8"), cifrador.final()]);
  return `v1:${Buffer.concat([iv, cifrador.getAuthTag(), cifrado]).toString("base64")}`;
}

/** Descifra lo que guardo cifrar(). Lanza ErrorCifrado si no se puede. */
export function descifrar(guardado: string): string {
  if (!guardado.startsWith("v1:")) throw new ErrorCifrado("Formato de clave guardada desconocido.");
  const datos = Buffer.from(guardado.slice(3), "base64");
  try {
    const descifrador = createDecipheriv("aes-256-gcm", llave(), datos.subarray(0, 12));
    descifrador.setAuthTag(datos.subarray(12, 28));
    return Buffer.concat([descifrador.update(datos.subarray(28)), descifrador.final()]).toString("utf8");
  } catch (exc) {
    if (exc instanceof ErrorCifrado) throw exc;
    throw new ErrorCifrado("No se pudo leer la clave guardada (¿cambio TMS_CLAVE_CIFRADO?). Vuelve a escribirla.");
  }
}
