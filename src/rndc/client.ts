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

/** Falla de comunicacion con el RNDC o envio bloqueado (no es un rechazo del documento). */
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
  /**
   * true = este cliente solo puede enviar consultas (tipo 6). Es el que apunta
   * al servidor de consultas de produccion; cualquier otro mensaje se rechaza
   * aqui antes de salir, para que un registro nunca llegue a produccion por el.
   */
  soloConsultas?: boolean;
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
    "Falta el NIT de la empresa de monitoreo de flota (NITMONITOREOFLOTA). Eligela en el despacho " +
    "o asignale una por defecto al vehiculo en el catalogo.",
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

/**
 * Limpia el texto de una etiqueta de la respuesta: quita CDATA, decodifica
 * las entidades XML (&amp;, &lt;, &#233;...) y recorta espacios.
 */
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

/**
 * true si el mensaje es de solo lectura: tipo 3 (consultar registros propios)
 * o tipo 6 (consultar maestros especiales) [Guia Uso del Web Service V5,
 * seccion 5]. Ninguno de los dos crea nada en el RNDC.
 */
function esConsulta(xmlMensaje: string): boolean {
  return /<tipo>\s*[36]\s*<\/tipo>/i.test(xmlMensaje);
}

/** Pausa de 'ms' milisegundos (entre reintentos). */
function esperar(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Cliente SOAP del web service del RNDC.
 *
 * Un solo metodo publico, enviar(xml): manda el mensaje y devuelve el
 * resultado ya interpretado (radicado o error). Tres protecciones:
 * - soloConsultas: rechaza antes de salir cualquier mensaje que no sea
 *   consulta (tipo 3 o 6), para clientes que apuntan a produccion.
 * - simular: no envia nada y responde un radicado SIMULADO (desarrollo).
 * - Reintentos solo ante fallas de red, nunca ante un rechazo del RNDC.
 */
export class RndcClient {
  /** Recibe la URL del WSDL, credenciales, modo simulacion, reintentos y soloConsultas. */
  constructor(private config: RndcClientConfig) {}

  /**
   * Envia un mensaje XML al RNDC y devuelve el resultado interpretado.
   *
   * Como funciona:
   * 1. Bloquea el envio si el cliente es solo de consultas y el mensaje no lo es.
   * 2. En simulacion responde un radicado ficticio sin conectarse.
   * 3. Crea el cliente SOAP desde el WSDL y llama AtenderMensajeRNDC con la
   *    parte "Request"; la respuesta viene en "return".
   * 4. Si falla la red, reintenta con espera creciente (2 s, 4 s...).
   * 5. Interpreta la respuesta con parsearRespuesta.
   * Si todos los intentos fallan por red, lanza RndcError.
   */
  async enviar(xmlMensaje: string, procesoId?: string): Promise<ResultadoRndc> {
    if (this.config.soloConsultas && !esConsulta(xmlMensaje)) {
      throw new RndcError(
        "Este cliente es solo para consultas (tipo 6) y apunta al servidor de consultas de " +
          "PRODUCCION. Se bloqueo el envio de un mensaje que no es consulta."
      );
    }
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
        // El WSDL define la entrada como la parte "Request" y la salida como
        // "return" (ambas xs:string) [Guia Uso del Web Service V5, WSDL pag. 5-6;
        // verificado contra /wsdl/IBPMServices]. Con otro nombre la libreria
        // manda el mensaje vacio y el RNDC contesta vacio.
        const [result] = await client.AtenderMensajeRNDCAsync({ Request: xmlMensaje });
        const salida = result?.return;
        const respuestaXml: string =
          typeof salida === "string" ? salida : salida?.$value ?? "";
        return this.parsearRespuesta(respuestaXml, procesoId, esConsulta(xmlMensaje));
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

  /**
   * Convierte el XML de respuesta en un ResultadoRndc.
   *
   * - Busca errores en ErrorMSG, ErrorMessage o error (las guias no documentan
   *   la etiqueta; se prueban las conocidas).
   * - Consulta (tipo 3/6) sin error y con <documento>: exito sin radicado.
   * - Sin radicado y sin error: se trata como FALLO ("no se pudo interpretar"),
   *   para no dar por expedido algo que quiza no lo esta.
   * - Con error: extrae el codigo (MAN045, CRE111...) y una explicacion en
   *   espanol (explicarError).
   * - Con radicado: exito, con MEC y codigo de seguridad QR si vienen.
   */
  private parsearRespuesta(xml: string, procesoId?: string, consulta = false): ResultadoRndc {
    // Los nombres de etiqueta de error NO estan documentados en las guias
    // oficiales; se prueban las variantes conocidas. Si aparece otra en
    // produccion, agregarla aqui.
    const errores = [
      ...leerEtiquetas(xml, "ErrorMSG"),
      ...leerEtiquetas(xml, "ErrorMessage"),
      ...leerEtiquetas(xml, "error"),
    ];

    const radicado = leerEtiqueta(xml, "ingresoid");

    // Una consulta (tipo 6) no genera radicado: la respuesta buena es un
    // <root><documento>...</documento></root> con los campos pedidos
    // [Manual WebServicePlaca, pag. 4]. Solo se acepta asi cuando lo enviado
    // era una consulta, para que un registro sin radicado siga siendo error.
    if (consulta && errores.length === 0 && /<documento[\s>]/i.test(xml)) {
      return {
        ok: true,
        radicado: null,
        mec: null,
        qr: null,
        error: null,
        codigoError: null,
        errorCrudo: null,
        xmlRespuesta: xml,
      };
    }

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
