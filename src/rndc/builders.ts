/**
 * Construccion del XML que exige el Web Service del RNDC.
 *
 * IMPORTANTE: el Ministerio de Transporte publica el diccionario de datos exacto
 * (nombres de tags, obligatoriedad, formatos) en el Manual RNDC Web-Service vigente,
 * descargable en https://plc.mintransporte.gov.co (seccion Manuales RNDC).
 *
 * Antes de produccion, DEBES verificar contra el manual/WSDL vigente:
 * - El nombre exacto de cada tag
 * - Que IDs de proceso corresponden a cada operacion
 * - Formatos de fecha/hora exigidos
 */

// IDs de proceso del RNDC. TODO: confirmar valores exactos contra el manual/WSDL
// vigente antes de produccion.
export const PROCESO_ID_REMESA = "4";
export const PROCESO_ID_MANIFIESTO = "2";

function escapeXml(valor: string): string {
  return valor
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function tag(nombre: string, valor: unknown): string {
  if (valor === null || valor === undefined || valor === "") return "";
  return `<${nombre}>${escapeXml(String(valor))}</${nombre}>`;
}

export interface CredencialesRndc {
  usuario: string;
  password: string;
  nitEmpresa: string;
}

export function construirXmlMensaje(
  credenciales: CredencialesRndc,
  procesoId: string,
  datos: Record<string, unknown>
): string {
  const variablesXml = Object.entries(datos)
    .map(([k, v]) => tag(k, v))
    .join("");

  return `<?xml version="1.0" encoding="UTF-8"?>
<root>
  <acceso>
    <username>${escapeXml(credenciales.usuario)}</username>
    <password>${escapeXml(credenciales.password)}</password>
  </acceso>
  <solicitud>
    <tipo>1</tipo>
    <procesoid>${procesoId}</procesoid>
  </solicitud>
  <variables>
    <NITEMPRESATRANSPORTE>${escapeXml(credenciales.nitEmpresa)}</NITEMPRESATRANSPORTE>
    ${variablesXml}
  </variables>
</root>`;
}

export interface DatosViajeParaRndc {
  vehiculo: { placa: string; placaRemolque: string | null; configuracion: string | null };
  conductor: { cedula: string };
  plantilla: {
    ruta: { ciudadOrigen: string; ciudadDestino: string; codigoOrigenRndc: string | null; codigoDestinoRndc: string | null };
    contratante: { nit: string };
    remitente: { nit: string };
    destinatario: { nit: string };
    tipoMercancia: string | null;
    naturalezaCarga: string | null;
    unidadMedida: string | null;
    valorFleteBase: number | null;
    observaciones: string | null;
  };
  pesoReal: number | null;
  cantidadReal: number | null;
  valorFleteReal: number | null;
  fechaHoraCargue: Date;
}

export function construirDatosRemesa(v: DatosViajeParaRndc): Record<string, unknown> {
  const p = v.plantilla;
  return {
    CIUDADORIGEN: p.ruta.codigoOrigenRndc ?? p.ruta.ciudadOrigen,
    CIUDADDESTINO: p.ruta.codigoDestinoRndc ?? p.ruta.ciudadDestino,
    NITCONTRATANTE: p.contratante.nit,
    NITREMITENTE: p.remitente.nit,
    NITDESTINATARIO: p.destinatario.nit,
    TIPOMERCANCIA: p.tipoMercancia,
    NATURALEZACARGA: p.naturalezaCarga,
    UNIDADMEDIDACAPACIDAD: p.unidadMedida,
    CANTIDADCARGADA: v.cantidadReal,
    PESOCARGADO: v.pesoReal,
    VALORFLETE: v.valorFleteReal ?? p.valorFleteBase,
    FECHACITAPACTADACARGUE: formatearFecha(v.fechaHoraCargue),
    OBSERVACIONES: p.observaciones,
  };
}

export function construirDatosManifiesto(
  v: DatosViajeParaRndc,
  numeroRemesa: string
): Record<string, unknown> {
  const p = v.plantilla;
  return {
    NUMREMESA: numeroRemesa,
    PLACA: v.vehiculo.placa,
    PLACAREMOLQUE: v.vehiculo.placaRemolque,
    CEDULACONDUCTOR: v.conductor.cedula,
    CONFIGURACION: v.vehiculo.configuracion,
    CIUDADORIGEN: p.ruta.codigoOrigenRndc ?? p.ruta.ciudadOrigen,
    CIUDADDESTINO: p.ruta.codigoDestinoRndc ?? p.ruta.ciudadDestino,
    NITCONTRATANTE: p.contratante.nit,
    NITREMITENTE: p.remitente.nit,
    NITDESTINATARIO: p.destinatario.nit,
    VALORFLETE: v.valorFleteReal ?? p.valorFleteBase,
    FECHACITAPACTADACARGUE: formatearFecha(v.fechaHoraCargue),
    OBSERVACIONES: p.observaciones,
  };
}

function formatearFecha(fecha: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${fecha.getFullYear()}-${pad(fecha.getMonth() + 1)}-${pad(fecha.getDate())} ${pad(
    fecha.getHours()
  )}:${pad(fecha.getMinutes())}`;
}
