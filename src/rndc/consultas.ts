/**
 * Consultas de solo lectura al RNDC.
 *
 * Sirven para averiguar QUE EXISTE realmente en el ambiente al que estamos
 * apuntando, antes de intentar expedir nada. Es especialmente util contra el
 * ambiente de pruebas, que es una copia de produccion de una fecha pasada: un
 * vehiculo o un tercero que diste de alta el mes pasado puede sencillamente no
 * estar alli.
 *
 * A diferencia del registro (tipo de solicitud 1), las consultas usan el tipo 6
 * y llevan un bloque <documento> con los filtros.
 */

import { RndcClient, leerEtiqueta, leerEtiquetas } from "./client";
import { CredencialesRndc } from "./builders";

export const TIPO_SOLICITUD_CONSULTA = "6";

/**
 * Proceso 48 = maestro RNA (Registro Nacional Automotor). Permite verificar el
 * estado de una placa antes de intentar despacharla.
 * Fuente: "RNDC - Consulta por WebService de una placa" (Ministerio de
 * Transporte, febrero 2020) -> docs/Manual WebServicePlaca.pdf.
 */
export const PROCESO_ID_RNA_PLACA = "48";

function escapeXml(valor: string): string {
  return valor
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Texto de un elemento XML: solo hay que escapar &, < y >. Las comillas se
 * dejan tal cual porque los filtros de las consultas van entre comillas
 * sencillas ('TDM735') y el RNDC no esta documentado como decodificador de
 * &apos;.
 */
function escapeTexto(valor: string): string {
  return valor.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Arma el XML de una consulta (tipo 6).
 *
 * Formato segun el ejemplo de la guia de placa [Manual WebServicePlaca, pag. 3]:
 * - <variables> es una lista de nombres separados por coma, en texto plano; no
 *   un elemento vacio por campo.
 * - Los filtros van dentro de <documento> y su valor entre comillas sencillas:
 *   <PLACA>'TDM735'</PLACA>. Las comillas las pone esta funcion.
 *
 * @param variables Nombres de los campos que se quieren de vuelta.
 * @param filtros   Criterios de busqueda (van dentro de <documento>), sin comillas.
 */
export function construirXmlConsulta(
  credenciales: CredencialesRndc,
  procesoId: string,
  variables: string[],
  filtros: Record<string, string>
): string {
  const variablesXml = variables.join(", ");
  const filtrosXml = Object.entries(filtros)
    .map(([k, v]) => `<${k}>'${escapeTexto(v.replace(/'/g, ""))}'</${k}>`)
    .join("");

  return `<?xml version='1.0' encoding='ISO-8859-1' ?>
<root>
  <acceso>
    <username>${escapeXml(credenciales.usuario)}</username>
    <password>${escapeXml(credenciales.password)}</password>
  </acceso>
  <solicitud>
    <tipo>${TIPO_SOLICITUD_CONSULTA}</tipo>
    <procesoid>${procesoId}</procesoid>
  </solicitud>
  <variables>
    ${variablesXml}
  </variables>
  <documento>
    ${filtrosXml}
  </documento>
</root>`;
}

export interface EstadoPlaca {
  placa: string;
  encontrada: boolean;
  estadoMatricula: string | null;
  codConfiguracion: string | null;
  clase: string | null;
  fechaBloqueo: string | null;
  fechaDesbloqueo: string | null;
  /**
   * Si con este estado de matricula se puede expedir manifiesto, segun la tabla
   * de la guia [Manual WebServicePlaca, pag. 5]: solo "." (activa en el RUNT)
   * es "Si"; DESINTEGRADO requiere autorizacion expresa de la empresa; todo lo
   * demas es "No".
   */
  puedeManifestar: "si" | "autorizacion" | "no";
  /** Resumen legible de si la placa sirve para despachar. */
  diagnostico: string;
  xmlRespuesta: string;
}

/**
 * Consulta una placa en el RNA. El RNDC exige que la matricula este activa y
 * que el vehiculo sea de servicio publico y modalidad de carga
 * [MANIFIESTO V7 pag. 12].
 */
export async function consultarPlaca(
  cliente: RndcClient,
  credenciales: CredencialesRndc,
  placa: string
): Promise<EstadoPlaca> {
  const xml = construirXmlConsulta(
    credenciales,
    PROCESO_ID_RNA_PLACA,
    ["ESTADOMATRICULA", "FECHABLOQUEO", "FECHADESBLOQUEO", "CODCONFIGURACION", "CLASE"],
    { PLACA: placa }
  );

  const resultado = await cliente.enviar(xml, PROCESO_ID_RNA_PLACA);
  const respuesta = resultado.xmlRespuesta;

  // En la respuesta el RNDC usa "." como "sin valor": estadomatricula "." es
  // placa activa sin problema, fechadesbloqueo "." es que no hay fecha
  // [Manual WebServicePlaca, pag. 4]. Para las fechas se normaliza a null;
  // el estado se conserva tal cual porque "." es justamente el valor bueno.
  const sinPunto = (v: string | null) => (v === "." ? null : v);
  const estadoMatricula = leerEtiqueta(respuesta, "ESTADOMATRICULA");
  const codConfiguracion = sinPunto(leerEtiqueta(respuesta, "CODCONFIGURACION"));
  const clase = sinPunto(leerEtiqueta(respuesta, "CLASE"));
  const fechaBloqueo = sinPunto(leerEtiqueta(respuesta, "FECHABLOQUEO"));
  const fechaDesbloqueo = sinPunto(leerEtiqueta(respuesta, "FECHADESBLOQUEO"));
  const encontrada = estadoMatricula !== null;

  const estadoNormalizado = (estadoMatricula ?? "").trim().toUpperCase();
  const puedeManifestar: EstadoPlaca["puedeManifestar"] = !resultado.ok || !encontrada
    ? "no"
    : estadoNormalizado === "."
      ? "si"
      : estadoNormalizado === "DESINTEGRADO"
        ? "autorizacion"
        : "no";

  let diagnostico: string;
  if (!resultado.ok) {
    diagnostico = `El RNDC respondio con error: ${resultado.error}`;
  } else if (!encontrada) {
    diagnostico =
      "La placa no aparece en el RNA de este ambiente. Si estas en pruebas, puede " +
      "que el vehiculo se haya matriculado despues de la fecha de corte de la copia.";
  } else if (puedeManifestar === "si") {
    diagnostico = `Activa en el RUNT. Configuracion: ${codConfiguracion ?? "?"} (${clase ?? "?"}).`;
  } else if (puedeManifestar === "autorizacion") {
    diagnostico =
      "Matricula DESINTEGRADO: solo se puede manifestar con autorizacion expresa de la empresa.";
  } else {
    const bloqueo = fechaBloqueo
      ? ` Bloqueada desde ${fechaBloqueo}${fechaDesbloqueo ? `, desbloqueo ${fechaDesbloqueo}` : ""}.`
      : "";
    diagnostico = `Matricula ${estadoMatricula}: no se puede expedir manifiesto.${bloqueo}`;
  }

  return {
    placa,
    encontrada,
    estadoMatricula,
    codConfiguracion,
    clase,
    fechaBloqueo,
    fechaDesbloqueo,
    puedeManifestar,
    diagnostico,
    xmlRespuesta: respuesta,
  };
}

/**
 * Prueba de acceso: manda una consulta trivial solo para ver si el usuario y la
 * contrasena son validos y si el servidor responde.
 *
 * No hay un proceso documentado de "ping", asi que se reutiliza la consulta de
 * placa con una placa cualquiera: si las credenciales estan mal, el RNDC lo
 * dice antes de mirar el filtro.
 */
export async function probarAcceso(
  cliente: RndcClient,
  credenciales: CredencialesRndc,
  placaCualquiera: string
): Promise<{ ok: boolean; detalle: string; xmlRespuesta: string }> {
  const xml = construirXmlConsulta(
    credenciales,
    PROCESO_ID_RNA_PLACA,
    ["ESTADOMATRICULA"],
    { PLACA: placaCualquiera }
  );
  const resultado = await cliente.enviar(xml, PROCESO_ID_RNA_PLACA);

  // Un error de credenciales suele venir con estas palabras en el texto crudo.
  const crudo = (resultado.errorCrudo ?? "").toLowerCase();
  const pareceAuth =
    crudo.includes("usuario") || crudo.includes("clave") || crudo.includes("password");

  if (!resultado.ok && pareceAuth) {
    return {
      ok: false,
      detalle: `Credenciales rechazadas: ${resultado.errorCrudo}`,
      xmlRespuesta: resultado.xmlRespuesta,
    };
  }
  // Cualquier otra respuesta significa que el servidor nos atendio.
  return {
    ok: true,
    detalle: resultado.ok
      ? "Acceso correcto."
      : `Acceso correcto (el RNDC respondio, aunque con otro error: ${resultado.errorCrudo}).`,
    xmlRespuesta: resultado.xmlRespuesta,
  };
}

/** Lista cruda de valores de una etiqueta, para explorar respuestas nuevas. */
export function valoresDe(xml: string, etiqueta: string): string[] {
  return leerEtiquetas(xml, etiqueta);
}

// ---------------------------------------------------------------------------
// Documentos propios ya radicados (tipo 3)
// ---------------------------------------------------------------------------
//
// Tipo 3 = "Consultar documentos o registros de cualquier proceso" [Guia Uso
// del Web Service V5, pag. 9 y ejemplos pag. 18-19]. Verificado en produccion
// (2026-10-01) con el manifiesto y la remesa 00006740:
// - Proceso 4 por NUMMANIFIESTOCARGA y proceso 3 por CONSECUTIVOREMESA, con el
//   valor entre comillas sencillas (la remesa sin comillas da RNDC027).
// - Devuelve <documento> con las variables pedidas en minuscula; el manifiesto
//   acepta VALORFLETEPACTADOVIAJE, RETENCIONFOPAT, VALORANTICIPOMANIFIESTO y
//   CODVIA, ademas de INGRESOID (radicado), FECHAING y NUMPLACA.
// - Si no existe: RNDC11 "Documento no encontrado".

export const TIPO_SOLICITUD_DOCUMENTOS_PROPIOS = "3";

function xmlDocumentoPropio(
  credenciales: CredencialesRndc,
  procesoId: string,
  variables: string[],
  filtroEtiqueta: string,
  filtroValor: string
): string {
  return `<?xml version='1.0' encoding='ISO-8859-1' ?>
<root>
  <acceso>
    <username>${escapeXml(credenciales.usuario)}</username>
    <password>${escapeXml(credenciales.password)}</password>
  </acceso>
  <solicitud>
    <tipo>${TIPO_SOLICITUD_DOCUMENTOS_PROPIOS}</tipo>
    <procesoid>${procesoId}</procesoid>
  </solicitud>
  <variables>${variables.join(",")}</variables>
  <documento>
    <NUMNITEMPRESATRANSPORTE>${escapeXml(credenciales.nitEmpresa)}</NUMNITEMPRESATRANSPORTE>
    <${filtroEtiqueta}>'${escapeTexto(filtroValor.replace(/'/g, ""))}'</${filtroEtiqueta}>
  </documento>
</root>`;
}

/** null = el RNDC dice que no existe (RNDC11). Cualquier otro error se lanza. */
async function consultarDocumentoPropio(
  cliente: RndcClient,
  credenciales: CredencialesRndc,
  procesoId: string,
  variables: string[],
  filtroEtiqueta: string,
  filtroValor: string
): Promise<string | null> {
  const r = await cliente.enviar(
    xmlDocumentoPropio(credenciales, procesoId, variables, filtroEtiqueta, filtroValor),
    procesoId
  );
  if (r.ok) return r.xmlRespuesta ?? "";
  if (/RNDC11/i.test(r.errorCrudo ?? "")) return null;
  throw new Error(`No se pudo consultar el RNDC: ${r.errorCrudo ?? r.error}`);
}

export interface ManifiestoEnRndc {
  radicado: string;
  fecha: string | null;
  placa: string | null;
  valorFlete: number | null;
  retencionFopat: number | null;
  valorAnticipo: number | null;
  codVia: string | null;
}

const numeroDe = (v: string | null) => (v === null || v.trim() === "" ? null : Number(v));

/** El manifiesto con ese numero, si ya esta radicado en el RNDC para la empresa. */
export async function buscarManifiestoRadicado(
  cliente: RndcClient,
  credenciales: CredencialesRndc,
  numero: string
): Promise<ManifiestoEnRndc | null> {
  const xml = await consultarDocumentoPropio(
    cliente,
    credenciales,
    "4",
    ["INGRESOID", "FECHAING", "NUMMANIFIESTOCARGA", "NUMPLACA", "VALORFLETEPACTADOVIAJE", "RETENCIONFOPAT", "VALORANTICIPOMANIFIESTO", "CODVIA"],
    "NUMMANIFIESTOCARGA",
    numero
  );
  const radicado = xml === null ? null : leerEtiqueta(xml, "ingresoid");
  if (!xml || !radicado) return null;
  return {
    radicado,
    fecha: leerEtiqueta(xml, "fechaing"),
    placa: leerEtiqueta(xml, "numplaca"),
    valorFlete: numeroDe(leerEtiqueta(xml, "valorfletepactadoviaje")),
    retencionFopat: numeroDe(leerEtiqueta(xml, "retencionfopat")),
    valorAnticipo: numeroDe(leerEtiqueta(xml, "valoranticipomanifiesto")),
    codVia: leerEtiqueta(xml, "codvia") || null,
  };
}

/** Radicado de la remesa con ese consecutivo, si ya esta en el RNDC. */
export async function buscarRemesaRadicada(
  cliente: RndcClient,
  credenciales: CredencialesRndc,
  consecutivo: string
): Promise<string | null> {
  const xml = await consultarDocumentoPropio(
    cliente,
    credenciales,
    "3",
    ["INGRESOID", "FECHAING", "CONSECUTIVOREMESA"],
    "CONSECUTIVOREMESA",
    consecutivo
  );
  return xml === null ? null : leerEtiqueta(xml, "ingresoid");
}

/**
 * Tiempos reales de una remesa ya cumplida (tipo 3, proceso 5), como los
 * registro el RNDC: los del GPS si hubo cumplido inicial, o los que se
 * reportaron al cumplir. Verificado en produccion (2026-10-05, remesa 00006733)
 * y en pruebas (00010013). Devuelve null si la remesa no esta cumplida.
 */
export interface TiemposCumplidoRemesa {
  radicado?: string | null;
  fechaRegistro?: string | null;
  cantidadEntregada?: number | null;
  llegadaCargue: Date | null;
  entradaCargue: Date | null;
  salidaCargue: Date | null;
  llegadaDescargue: Date | null;
  entradaDescargue: Date | null;
  salidaDescargue: Date | null;
}

/** "29/09/2026" + "14:13" en hora de Colombia (UTC-5). */
function fechaHoraRndc(fecha: string | null, hora: string | null): Date | null {
  const f = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec((fecha ?? "").trim());
  const h = /^(\d{1,2}):(\d{2})$/.exec((hora ?? "").trim());
  if (!f || !h) return null;
  return new Date(Date.UTC(+f[3], +f[2] - 1, +f[1], +h[1] + 5, +h[2]));
}

export async function leerTiemposCumplidoRemesa(
  cliente: RndcClient,
  credenciales: CredencialesRndc,
  consecutivo: string
): Promise<TiemposCumplidoRemesa | null> {
  const pares = [
    ["llegadaCargue", "FECHALLEGADACARGUE", "HORALLEGADACARGUEREMESA"],
    ["entradaCargue", "FECHAENTRADACARGUE", "HORAENTRADACARGUEREMESA"],
    ["salidaCargue", "FECHASALIDACARGUE", "HORASALIDACARGUEREMESA"],
    ["llegadaDescargue", "FECHALLEGADADESCARGUE", "HORALLEGADADESCARGUECUMPLIDO"],
    ["entradaDescargue", "FECHAENTRADADESCARGUE", "HORAENTRADADESCARGUECUMPLIDO"],
    ["salidaDescargue", "FECHASALIDADESCARGUE", "HORASALIDADESCARGUECUMPLIDO"],
  ] as const;
  const xml = await consultarDocumentoPropio(
    cliente,
    credenciales,
    "5",
    ["INGRESOID", "FECHAING", "CANTIDADENTREGADA", ...pares.flatMap(([, f, h]) => [f, h])],
    "CONSECUTIVOREMESA",
    consecutivo
  );
  if (!xml || !leerEtiqueta(xml, "ingresoid")) return null;
  const cantidad = leerEtiqueta(xml, "cantidadentregada");
  const t: TiemposCumplidoRemesa = {
    radicado: leerEtiqueta(xml, "ingresoid"),
    fechaRegistro: leerEtiqueta(xml, "fechaing"),
    cantidadEntregada: cantidad === null ? null : Number(cantidad),
  } as TiemposCumplidoRemesa;
  for (const [campo, f, h] of pares) {
    t[campo] = fechaHoraRndc(leerEtiqueta(xml, f.toLowerCase()), leerEtiqueta(xml, h.toLowerCase()));
  }
  return t;
}

/**
 * Tiempos del cumplido inicial de la remesa (proceso 45), el que genera el
 * GPS. El portal los muestra bloqueados al cumplir y no hay que reenviarlos:
 * mandar otros distintos hace rechazar el cumplido (CRE111). Puede traer solo
 * el cargue (el GPS no siempre reporta el descargue).
 *
 * Nombres verificados en produccion (2026-10-06, solo lectura, remesa
 * 00006733, cumplido inicial 7869182): FECHALLEGADACARGUE + HORALLEGADACARGUE,
 * FECHASALIDACARGUE + HORASALIDACARGUE, y los mismos de DESCARGUE (sin el
 * sufijo REMESA/CUMPLIDO del proceso 5). Devuelve null si no hay cumplido inicial.
 */
export interface TiemposGps {
  radicado: string | null;
  llegadaCargue: Date | null;
  salidaCargue: Date | null;
  llegadaDescargue: Date | null;
  salidaDescargue: Date | null;
}

export async function leerCumplidoInicial(
  cliente: RndcClient,
  credenciales: CredencialesRndc,
  consecutivo: string
): Promise<TiemposGps | null> {
  const campos = [
    ["llegadaCargue", "FECHALLEGADACARGUE", "HORALLEGADACARGUE"],
    ["salidaCargue", "FECHASALIDACARGUE", "HORASALIDACARGUE"],
    ["llegadaDescargue", "FECHALLEGADADESCARGUE", "HORALLEGADADESCARGUE"],
    ["salidaDescargue", "FECHASALIDADESCARGUE", "HORASALIDADESCARGUE"],
  ] as const;
  const xml = await consultarDocumentoPropio(
    cliente,
    credenciales,
    "45",
    ["INGRESOID", ...campos.flatMap(([, f, h]) => [f, h])],
    "CONSECUTIVOREMESA",
    consecutivo
  );
  if (!xml) return null;
  // Puede haber mas de un registro (por ejemplo cargue y descargue por
  // separado): se toma el primer valor no vacio de cada tiempo.
  const documentos = xml.match(/<documento>[\s\S]*?<\/documento>/gi) ?? [];
  if (documentos.length === 0) return null;
  const t: TiemposGps = { radicado: leerEtiqueta(documentos[0] ?? "", "ingresoid"), llegadaCargue: null, salidaCargue: null, llegadaDescargue: null, salidaDescargue: null };
  for (const doc of documentos) {
    for (const [campo, f, h] of campos) {
      if (!t[campo]) t[campo] = fechaHoraRndc(leerEtiqueta(doc, f.toLowerCase()), leerEtiqueta(doc, h.toLowerCase()));
    }
  }
  return t;
}
