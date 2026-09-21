/**
 * Cliente para consumir el Web Service SOAP del RNDC.
 *
 * El metodo documentado es 'AtenderMensajeRNDC', que recibe el XML armado en
 * rndc/builders.ts como un unico parametro de texto.
 *
 * Antes de produccion:
 * 1. Descarga y revisa el WSDL vigente (rndcws.mintransporte.gov.co:8080/ws).
 * 2. Verifica que el nombre del metodo y sus parametros coincidan con el WSDL real.
 * 3. Prueba primero con RNDC_SIMULAR=true para validar que el XML se arma bien.
 */

export class RndcError extends Error {}

export interface ResultadoRndc {
  ok: boolean;
  radicado: string | null;
  mec: string | null;
  qr: string | null;
  /** Mensaje ya traducido a algo accionable, listo para mostrar en pantalla. */
  error: string | null;
  /** Codigo crudo del RNDC (ej. "REM112"), util para soporte. */
  codigoError: string | null;
  /** Texto original del RNDC, sin tocar. Se guarda para trazabilidad. */
  errorCrudo: string | null;
  xmlRespuesta: string;
}

export interface RndcClientConfig {
  wsdlUrl: string;
  usuario: string;
  password: string;
  simular: boolean;
  /** Reintentos ante fallas de red (no ante rechazos del RNDC). */
  reintentos?: number;
}

// ---------------------------------------------------------------------------
// Traduccion de codigos de error
// ---------------------------------------------------------------------------

/**
 * Explicaciones de los codigos de error del RNDC.
 *
 * IMPORTANTE: aqui solo van codigos leidos textualmente del diccionario de
 * errores en las guias oficiales (MANIFIESTO V7 Figura 16, REMESA V5 Figura 64).
 * No se inventan mensajes: cualquier codigo que no este en esta tabla se le
 * muestra al usuario tal como lo devolvio el RNDC, con la ruta para consultarlo.
 *
 * La tabla se puede ampliar consultando en el portal del RNDC:
 * Consultar -> Consultar Maestros -> Diccionario de Errores, filtrando por
 * proceso 3 (remesa) o 4 (manifiesto).
 */
const EXPLICACIONES: Record<string, string> = {
  // --- Remesa (proceso 3) ---
  REM099:
    "El codigo de mercancia para un contenedor vacio debe ser 9990. Revisa el codigo en la plantilla.",
  REM112:
    "Esta mercancia necesita el codigo de SUBPARTIDA (2 digitos). Consultalo en el portal del RNDC " +
    "(Consultar Maestros -> Subpartidas Productos) y agregalo a la plantilla. Solo hay que hacerlo una vez.",
  REM118:
    "Esta mercancia necesita el CODIGO DE ARANCEL (2 digitos) ademas de la subpartida. Consultalo en el " +
    "portal del RNDC (Consultar Maestros -> Codigos de Arancel) y agregalo a la plantilla.",
  REM119:
    "El codigo de arancel que enviaste no existe para esa combinacion de capitulo, partida y subpartida. " +
    "Verificalo en el portal del RNDC (Consultar Maestros -> Codigos de Arancel).",

  // --- Manifiesto (proceso 4) ---
  MAN006:
    "Cuando el titular del manifiesto es la misma empresa de transporte (flota propia), el valor a pagar " +
    "debe ser 0. Revisa quien figura como tenedor del vehiculo.",
  MAN007:
    "La empresa de monitoreo de flota no tiene NIT registrado en el RNDC para el reporte de tiempos logisticos.",
  MAN051:
    "No hay registro de topes para el valor a pagar de este manifiesto. Verifica con el grupo de logistica " +
    "del Ministerio que la ruta tenga topes cargados.",
  MAN055:
    "El RNDC clasifica esta mercancia como peligrosa y exige registrarla con naturaleza de residuo o " +
    "mercancia peligrosa. Este sistema solo maneja carga general: no despaches este viaje por aqui y " +
    "consulta el codigo de producto antes de volver a usar esta plantilla.",
  MAN067:
    "Falta el NIT de la empresa de monitoreo de flota (NITMONITOREOFLOTA). Configuralo en la variable " +
    "RNDC_NIT_MONITOREO_FLOTA del backend.",
};

/** Extrae el codigo tipo REM112 / MAN006 del texto que devuelve el RNDC. */
export function extraerCodigoError(mensaje: string): string | null {
  const match = mensaje.match(/\b(REM|MAN|REC|CUM)\d{3}\b/i);
  return match ? match[0].toUpperCase() : null;
}

/**
 * Convierte el error del RNDC en algo que el despachador pueda resolver solo.
 * Si el codigo no esta en la tabla, se devuelve el mensaje original mas la ruta
 * para buscarlo: es preferible a inventar una explicacion equivocada.
 */
export function explicarError(mensajeCrudo: string, procesoId?: string): string {
  const codigo = extraerCodigoError(mensajeCrudo);
  if (codigo && EXPLICACIONES[codigo]) {
    return `${codigo}: ${EXPLICACIONES[codigo]}`;
  }
  const proceso = procesoId ? ` (proceso ${procesoId})` : "";
  const prefijo = codigo ? `${codigo}: ` : "";
  return (
    `${prefijo}${mensajeCrudo.trim()}\n\n` +
    `Puedes consultar este error en el portal del RNDC: Consultar -> Consultar Maestros -> ` +
    `Diccionario de Errores${proceso}.`
  );
}

// ---------------------------------------------------------------------------
// Lectura del XML de respuesta
// ---------------------------------------------------------------------------

const ENTIDADES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&apos;": "'",
};

function decodificar(texto: string): string {
  return texto
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&(?:amp|lt|gt|quot|apos);/g, (e) => ENTIDADES[e] ?? e)
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .trim();
}

/**
 * Lee el contenido de una etiqueta del XML de respuesta.
 *
 * Se hace a mano en vez de con una libreria porque la respuesta del RNDC es
 * plana y no vale la pena una dependencia mas. Pero a diferencia de la version
 * anterior, esta contempla lo que si aparece en respuestas reales: atributos en
 * la etiqueta, prefijos de namespace, contenido en varias lineas y CDATA.
 */
export function leerEtiqueta(xml: string, nombre: string): string | null {
  const re = new RegExp(
    `<(?:\\w+:)?${nombre}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:\\w+:)?${nombre}>`,
    "i"
  );
  const match = xml.match(re);
  if (!match) return null;
  const valor = decodificar(match[1]);
  return valor === "" ? null : valor;
}

/** Devuelve todas las ocurrencias: el RNDC puede reportar varios errores. */
export function leerEtiquetas(xml: string, nombre: string): string[] {
  const re = new RegExp(
    `<(?:\\w+:)?${nombre}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:\\w+:)?${nombre}>`,
    "gi"
  );
  const valores: string[] = [];
  for (const match of xml.matchAll(re)) {
    const valor = decodificar(match[1]);
    if (valor !== "") valores.push(valor);
  }
  return valores;
}

// ---------------------------------------------------------------------------
// Cliente
// ---------------------------------------------------------------------------

function esperar(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class RndcClient {
  constructor(private config: RndcClientConfig) {}

  async enviar(xmlMensaje: string, procesoId?: string): Promise<ResultadoRndc> {
    if (this.config.simular) {
      return {
        ok: true,
        radicado: `SIMULADO-${Math.floor(Math.random() * 100000)}`,
        mec: null,
        qr: null,
        error: null,
        codigoError: null,
        errorCrudo: null,
        xmlRespuesta: `[SIMULACION] Se habria enviado este XML:\n${xmlMensaje}`,
      };
    }

    // El RNDC se cae o se demora con frecuencia, y el despacho es de noche.
    // Un reintento evita tener que rehacer el viaje a mano por un timeout.
    // Solo se reintenta la falla de red: si el RNDC respondio rechazando el
    // documento, repetir el envio no cambia nada y puede duplicar registros.
    const intentos = Math.max(1, (this.config.reintentos ?? 1) + 1);
    let ultimoFallo: Error | null = null;

    for (let intento = 1; intento <= intentos; intento++) {
      try {
        // Import perezoso: la libreria 'soap' solo se necesita en modo real.
        const soap = await import("soap");
        const client = await soap.createClientAsync(this.config.wsdlUrl);
        const [result] = await client.AtenderMensajeRNDCAsync({ variables: xmlMensaje });
        const respuestaXml: string = result?.AtenderMensajeRNDCResult ?? "";
        return this.parsearRespuesta(respuestaXml, procesoId);
      } catch (exc) {
        ultimoFallo = exc as Error;
        if (intento < intentos) {
          await esperar(2000 * intento);
        }
      }
    }

    throw new RndcError(
      `Fallo de comunicacion con el RNDC despues de ${intentos} intento(s): ${ultimoFallo?.message}`
    );
  }

  private parsearRespuesta(xml: string, procesoId?: string): ResultadoRndc {
    // Los nombres de etiqueta de error NO estan documentados en las guias
    // oficiales; se prueban las variantes conocidas. Si aparece otra en
    // produccion, agregarla aqui.
    const errores = [
      ...leerEtiquetas(xml, "ErrorMSG"),
      ...leerEtiquetas(xml, "ErrorMessage"),
      ...leerEtiquetas(xml, "error"),
    ];

    const radicado = leerEtiqueta(xml, "ingresoid");

    // Defensa ante una respuesta que no se pudo interpretar: sin radicado y sin
    // error explicito, tratarla como exito seria peor que reportar el problema.
    if (errores.length === 0 && !radicado) {
      const crudo = xml.trim() || "(respuesta vacia)";
      return {
        ok: false,
        radicado: null,
        mec: null,
        qr: null,
        error:
          "El RNDC respondio algo que no se pudo interpretar: no trae radicado ni mensaje de error. " +
          "Revisa el XML de respuesta antes de reintentar, para no duplicar el documento.",
        codigoError: null,
        errorCrudo: crudo.slice(0, 2000),
        xmlRespuesta: xml,
      };
    }

    if (errores.length > 0) {
      const crudo = errores.join(" | ");
      return {
        ok: false,
        radicado: null,
        mec: null,
        qr: null,
        error: errores.map((e) => explicarError(e, procesoId)).join("\n\n"),
        codigoError: extraerCodigoError(crudo),
        errorCrudo: crudo,
        xmlRespuesta: xml,
      };
    }

    return {
      ok: true,
      radicado,
      mec: leerEtiqueta(xml, "MEC"),
      qr: leerEtiqueta(xml, "seguridadqr"),
      error: null,
      codigoError: null,
      errorCrudo: null,
      xmlRespuesta: xml,
    };
  }
}
