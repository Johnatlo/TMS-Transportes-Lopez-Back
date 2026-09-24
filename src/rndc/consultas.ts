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
