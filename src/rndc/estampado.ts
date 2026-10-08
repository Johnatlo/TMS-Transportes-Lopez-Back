/**
 * Logo de la empresa sobre los PDF oficiales del RNDC.
 *
 * Decision de la empresa (2026-09-28): se puede superponer el logo en el
 * manifiesto y en la remesa, siempre que el codigo QR quede visible, porque es
 * lo que escanea la policia para verificar que el documento es el original del
 * RNDC. Por eso el logo va en una zona fija que se midio sobre PDF oficiales
 * reales (docs/Manifiesto DE ejemplo.pdf y docs/Remesa de ejemplo.pdf): el
 * espacio en blanco entre los logos del Ministerio y el titulo. El QR del
 * manifiesto esta en el extremo opuesto de la pagina.
 *
 * Nunca se tapa nada: si el PDF no tiene la orientacion esperada (el RNDC
 * cambio el formato), no se estampa y se devuelve el original sin tocar.
 */

import { existsSync, readFileSync } from "fs";
import path from "path";
import { PDFDocument } from "pdf-lib";

export type DocumentoRndc = "manifiesto" | "remesa";

interface Zona {
  /** Tamano de la pagina de referencia sobre la que se midio la zona. */
  pagina: { ancho: number; alto: number };
  /** Caja libre donde cabe el logo, en puntos, medida desde ARRIBA-izquierda. */
  x: number;
  y: number;
  ancho: number;
  alto: number;
}

/**
 * Zonas medidas con PyMuPDF sobre los ejemplos oficiales:
 * - Manifiesto (855 x 612, horizontal): logos del Ministerio en x 31-131,
 *   titulo desde x 239, recuadro "FECHA HORA RADICACION" desde y 103. QR en
 *   [684, 30, 804, 150].
 * - Remesa (612 x 792, vertical): logos del Ministerio en x 57-157, titulo
 *   desde x 251, tabla desde y 126. La remesa no trae QR.
 */
const ZONAS: Record<DocumentoRndc, Zona> = {
  manifiesto: { pagina: { ancho: 855, alto: 612 }, x: 136, y: 32, ancho: 98, alto: 66 },
  remesa: { pagina: { ancho: 612, alto: 792 }, x: 162, y: 38, ancho: 84, alto: 82 },
};

/** Ruta del logo. Se puede cambiar con LOGO_EMPRESA en el .env. */
export function rutaLogo(): string {
  return process.env.LOGO_EMPRESA || path.join(__dirname, "..", "..", "assets", "logo-empresa.png");
}

let logoCache: Buffer | null | undefined;
/**
 * Lee el logo de la empresa una sola vez y lo guarda en memoria. Si no existe,
 * lo avisa en consola y devuelve null (los PDF salen sin logo).
 */
function leerLogo(): Buffer | null {
  if (logoCache !== undefined) return logoCache;
  const ruta = rutaLogo();
  logoCache = existsSync(ruta) ? readFileSync(ruta) : null;
  if (!logoCache) console.warn(`Logo de la empresa no encontrado en ${ruta}: los PDF salen sin logo.`);
  return logoCache;
}

/**
 * Devuelve el PDF con el logo estampado en la primera pagina. Si no hay logo
 * o la pagina no coincide con el formato esperado, devuelve el original.
 */
export async function estamparLogo(pdf: Buffer, documento: DocumentoRndc): Promise<Buffer> {
  const logo = leerLogo();
  if (!logo) return pdf;

  const doc = await PDFDocument.load(pdf);
  const pagina = doc.getPages()[0];
  if (!pagina) return pdf;
  const { width, height } = pagina.getSize();

  const zona = ZONAS[documento];
  const esperadoHorizontal = zona.pagina.ancho > zona.pagina.alto;
  if (width > height !== esperadoHorizontal) {
    console.warn(
      `PDF de ${documento} con orientacion inesperada (${width}x${height}): no se estampa el logo.`
    );
    return pdf;
  }

  // Si el RNDC entrega la pagina a otra escala, la zona escala igual.
  const ex = width / zona.pagina.ancho;
  const ey = height / zona.pagina.alto;

  const imagen = logo.subarray(1, 4).toString() === "PNG" ? await doc.embedPng(logo) : await doc.embedJpg(logo);
  // Cabe en la caja sin deformarse, centrado vertical dentro de ella.
  const escala = Math.min((zona.ancho * ex) / imagen.width, (zona.alto * ey) / imagen.height);
  const w = imagen.width * escala;
  const h = imagen.height * escala;
  const x = zona.x * ex;
  const yDesdeArriba = zona.y * ey + (zona.alto * ey - h) / 2;

  pagina.drawImage(imagen, {
    x,
    // pdf-lib mide y desde ABAJO de la pagina.
    y: height - yDesdeArriba - h,
    width: w,
    height: h,
  });
  return Buffer.from(await doc.save());
}

/** El logo como data URI, para incrustarlo en documentos HTML (la remesa). */
export function logoComoDataUri(): string | null {
  const logo = leerLogo();
  if (!logo) return null;
  const tipo = logo.subarray(1, 4).toString() === "PNG" ? "image/png" : "image/jpeg";
  return `data:${tipo};base64,${logo.toString("base64")}`;
}
