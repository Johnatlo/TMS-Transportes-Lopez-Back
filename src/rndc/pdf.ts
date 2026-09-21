/**
 * Descarga del PDF del manifiesto.
 *
 * El RNDC entrega el PDF por un servicio APARTE del webservice SOAP: una API
 * REST en otro puerto [GUIA DE MANIFIESTO V7, seccion 9].
 *
 * Peticion (POST al recurso /Rest/rndc):
 * {
 *   "acceso":    { "usuario": "...", "clave": "..." },
 *   "solicitud": { "tipo": "21", "procesoid": "4" },
 *   "documento": { "IngresoId": "<radicado>", "InformeId": "1",
 *                  "formato": "Json", "Base64": "S" }
 * }
 *
 * tipo 21   = consultar el PDF de un proceso
 * procesoid 4 = manifiesto de carga
 * IngresoId = numero de radicado que devolvio el RNDC al expedirlo
 * InformeId = 1 (unico diseno por ahora)
 * Base64 "S" devuelve el PDF como cadena base64 dentro de un JSON, que es lo
 * aconsejado por la guia; con "N" el cuerpo de la respuesta es el PDF crudo.
 *
 * NOTA: el RNDC no expone un servicio equivalente para el PDF de la remesa. El
 * Manual de Operacion General dice que la empresa de transporte "podra generar
 * un documento en formato PDF" con los datos de la remesa radicada, bajo su
 * responsabilidad. Es decir, ese lo tenemos que componer nosotros.
 */

export class RndcPdfError extends Error {}

export interface ConfigPdf {
  /** Base REST, sin el recurso. Ej: http://plc.mintransporte.gov.co:8081 */
  urlBase: string;
  usuario: string;
  password: string;
  simular: boolean;
  timeoutMs?: number;
}

export interface ResultadoPdf {
  pdf: Buffer;
  /** Nombre sugerido para el archivo. */
  nombreArchivo: string;
}

/** procesoid del PDF segun el documento [GUIA V7 seccion 9]. */
export const PROCESO_PDF_MANIFIESTO = "4";

/**
 * procesoid que se intenta para el PDF de la remesa.
 *
 * OJO: NO esta documentado. La guia solo describe el 4 (manifiesto), pero
 * define el tipo 21 como "consultar el pdf de un proceso" en general y avisa
 * que "en el futuro pueden aparecer otros tipos de pdf". El 3 es el proceso de
 * remesa en el resto del webservice, asi que es la hipotesis razonable.
 *
 * Si el RNDC no lo soporta, el llamador debe caer a la representacion propia:
 * el Manual de Operacion General autoriza a la empresa de transporte a generar
 * su propio PDF con los datos de la remesa radicada.
 */
export const PROCESO_PDF_REMESA = "3";

/**
 * Pide el PDF de un manifiesto ya radicado.
 *
 * @param radicado Numero de radicado (ingresoid) devuelto al expedir.
 */
export async function descargarPdfManifiesto(
  config: ConfigPdf,
  radicado: string,
  consecutivoParaNombre?: string
): Promise<ResultadoPdf> {
  return descargarPdfProceso(
    config,
    PROCESO_PDF_MANIFIESTO,
    radicado,
    `manifiesto-${consecutivoParaNombre || radicado}.pdf`
  );
}

/**
 * Pide el PDF de una remesa radicada. Puede fallar si el RNDC no expone ese
 * proceso; el llamador decide si cae a la representacion propia.
 */
export async function descargarPdfRemesa(
  config: ConfigPdf,
  radicado: string,
  consecutivoParaNombre?: string
): Promise<ResultadoPdf> {
  return descargarPdfProceso(
    config,
    PROCESO_PDF_REMESA,
    radicado,
    `remesa-${consecutivoParaNombre || radicado}.pdf`
  );
}

/** Descarga generica: tipo 21 = consultar el pdf de un proceso. */
export async function descargarPdfProceso(
  config: ConfigPdf,
  procesoId: string,
  radicado: string,
  nombreArchivo: string
): Promise<ResultadoPdf> {

  if (config.simular) {
    // Un PDF minimo pero valido, para poder probar el flujo de impresion
    // completo (boton, descarga, visor) sin contactar al Ministerio.
    return { pdf: pdfDePrueba(radicado), nombreArchivo };
  }

  const cuerpo = {
    acceso: { usuario: config.usuario, clave: config.password },
    solicitud: { tipo: "21", procesoid: procesoId },
    documento: {
      IngresoId: String(radicado),
      InformeId: "1",
      formato: "Json",
      Base64: "S",
    },
  };

  const controlador = new AbortController();
  const temporizador = setTimeout(() => controlador.abort(), config.timeoutMs ?? 30_000);

  let respuesta: Response;
  try {
    respuesta = await fetch(`${config.urlBase.replace(/\/$/, "")}/Rest/rndc`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(cuerpo),
      signal: controlador.signal,
    });
  } catch (exc) {
    throw new RndcPdfError(
      `No se pudo contactar el servicio de PDF del RNDC (${config.urlBase}): ${
        (exc as Error).message
      }`
    );
  } finally {
    clearTimeout(temporizador);
  }

  const texto = await respuesta.text();

  // El servicio responde 200 incluso con error de negocio, y el detalle viene
  // en el JSON. Ejemplo real de la guia:
  //   {"ErrorCode": 500, "ErrorText": "... El PDF del manifiesto solicitado no
  //    puede ser accesado por el usuario solicitante ..."}
  let json: any;
  try {
    json = JSON.parse(texto);
  } catch {
    throw new RndcPdfError(
      `El servicio de PDF respondio algo que no es JSON (HTTP ${respuesta.status}): ` +
        texto.slice(0, 300)
    );
  }

  if (json.ErrorCode || json.ErrorText) {
    // La guia advierte que este mismo mensaje sale cuando el radicado no existe
    // y cuando pertenece a otra empresa de transporte, asi que conviene
    // decirlo para no mandar al usuario a buscar el problema donde no esta.
    throw new RndcPdfError(
      `El RNDC no entrego el PDF: ${json.ErrorText ?? json.ErrorCode}. ` +
        `Suele significar que el radicado ${radicado} no existe, o que pertenece a otra ` +
        `empresa de transporte. Verifica que estes apuntando al mismo ambiente donde se ` +
        `expidio el manifiesto.`
    );
  }

  if (!json.Base64) {
    throw new RndcPdfError(
      `La respuesta no trae el PDF. Contenido recibido: ${texto.slice(0, 300)}`
    );
  }

  const pdf = Buffer.from(json.Base64, "base64");
  if (pdf.subarray(0, 4).toString() !== "%PDF") {
    throw new RndcPdfError("Lo que devolvio el RNDC no parece un PDF valido.");
  }

  return { pdf, nombreArchivo };
}

/** PDF de una sola pagina, generado a mano, para el modo simulacion. */
function pdfDePrueba(radicado: string): Buffer {
  const texto = `SIMULACION - Manifiesto ${radicado}`;
  const contenido = `BT /F1 14 Tf 60 760 Td (${texto}) Tj ET\nBT /F1 10 Tf 60 735 Td (Este PDF es de prueba. El RNDC no fue contactado.) Tj ET`;
  const objetos = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${contenido.length} >>\nstream\n${contenido}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];

  let pdf = "%PDF-1.4\n";
  const posiciones: number[] = [];
  objetos.forEach((obj, i) => {
    posiciones.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  });

  const inicioXref = pdf.length;
  pdf += `xref\n0 ${objetos.length + 1}\n0000000000 65535 f \n`;
  for (const pos of posiciones) {
    pdf += `${String(pos).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objetos.length + 1} /Root 1 0 R >>\nstartxref\n${inicioXref}\n%%EOF`;

  return Buffer.from(pdf, "latin1");
}
