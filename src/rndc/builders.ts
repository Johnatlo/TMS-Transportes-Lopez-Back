/**
 * Construccion del XML que exige el Web Service del RNDC.
 *
 * Esta version fue verificada contra el manual oficial "GUIA Uso del Web
 * Service en el RNDC - V5" (Ministerio de Transporte, mayo 2026). Referencias
 * a numeros de pagina corresponden a ese documento.
 *
 * Estructura general (pag. 8-10):
 * <root>
 *   <acceso><username/><password/></acceso>
 *   <solicitud><tipo/><procesoid/></solicitud>
 *   <variables>...</variables>
 *   <documento>...</documento>  (solo para consultas, tipo=3, no usado aqui)
 * </root>
 *
 * IMPORTANTE: el manual declara encoding ISO-8859-1 en todos sus ejemplos
 * (no UTF-8). Se respeta esa convencion en el XML generado.
 */

// IDs de proceso confirmados contra el diccionario del manual (pag. 9-10):
export const TIPO_SOLICITUD_REGISTRAR = "1"; // Registrar informacion en procesos y maestros
export const PROCESO_ID_REMESA = "3"; // Expedir Remesa Terrestre de Carga
export const PROCESO_ID_MANIFIESTO = "4"; // Expedir Manifiesto de Carga
export const PROCESO_ID_TERCERO = "11"; // Crear o Actualizar datos de Tercero (Maestro)
export const PROCESO_ID_VEHICULO = "12"; // Crear o Actualizar datos de Vehiculo (Maestro)

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

/** Formatea una fecha como DD/MM/AAAA, tal como exige el manual (pag. 13-15). */
function formatearFecha(fecha: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(fecha.getDate())}/${pad(fecha.getMonth() + 1)}/${fecha.getFullYear()}`;
}

/** Formatea una hora como HH:MM, en campo separado de la fecha (pag. 13-15). */
function formatearHora(fecha: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(fecha.getHours())}:${pad(fecha.getMinutes())}`;
}

export interface CredencialesRndc {
  usuario: string;
  password: string;
  nitEmpresa: string;
}

/**
 * Arma el XML generico de peticion al RNDC.
 * @param tipoSolicitud normalmente "1" (registrar). Ver pag. 9 para otros tipos.
 */
export function construirXmlMensaje(
  credenciales: CredencialesRndc,
  procesoId: string,
  datos: Record<string, unknown>,
  tipoSolicitud: string = TIPO_SOLICITUD_REGISTRAR,
  xmlCrudoAdicional: string = ""
): string {
  const variablesXml = Object.entries(datos)
    .map(([k, v]) => tag(k, v))
    .join("");

  return `<?xml version='1.0' encoding='ISO-8859-1' ?>
<root>
  <acceso>
    <username>${escapeXml(credenciales.usuario)}</username>
    <password>${escapeXml(credenciales.password)}</password>
  </acceso>
  <solicitud>
    <tipo>${tipoSolicitud}</tipo>
    <procesoid>${procesoId}</procesoid>
  </solicitud>
  <variables>
    <NUMNITEMPRESATRANSPORTE>${escapeXml(credenciales.nitEmpresa)}</NUMNITEMPRESATRANSPORTE>
    ${variablesXml}
    ${xmlCrudoAdicional}
  </variables>
</root>`;
}

/**
 * Datos de un viaje ya combinados con su plantilla, tal como los necesita
 * el armado del XML de remesa y de manifiesto.
 */
export interface DatosViajeParaRndc {
  vehiculo: {
    placa: string;
    placaRemolque: string | null;
  };
  conductor: {
    codTipoId: string;
    cedula: string;
  };
  plantilla: {
    ruta: {
      codigoOrigenRndc: string | null;
      codigoDestinoRndc: string | null;
    };
    // El "propietario de la carga" y el "titular del manifiesto" no tienen un
    // concepto propio en nuestro modelo todavia -- se asume que es el
    // contratante. Ajustar aqui si tu operacion distingue estos roles.
    contratante: { codTipoId: string; nit: string; codSede: string };
    remitente: { codTipoId: string; nit: string; codSede: string };
    destinatario: { codTipoId: string; nit: string; codSede: string };
    codOperacionTransporte: string;
    codNaturalezaCarga: string;
    codUnidadMedida: string;
    codTipoEmpaque: string;
    codMercancia: string | null;
    tipoMercancia: string | null; // usado como DESCRIPCIONCORTAPRODUCTO
    observaciones: string | null;
    horasPactoCargue: number;
    minutosPactoCargue: number;
    horasPactoDescargue: number;
    minutosPactoDescargue: number;
    valorFleteBase: number | null;
  };
  pesoReal: number | null;
  cantidadReal: number | null;
  valorFleteReal: number | null;
  fechaHoraCargue: Date;
}

/**
 * Diccionario de datos de Remesa Terrestre de Carga (procesoid=3), pag. 12-13.
 *
 * NOTA sobre CODNATURALEZACARGA, UNIDADMEDIDACAPACIDAD, CODTIPOEMPAQUE y
 * MERCANCIAREMESA: son codigos de catalogo del RNDC (no texto libre). Los
 * valores por defecto ('1', '1', '0') funcionan como placeholder generico
 * mientras se consultan los codigos reales en "Consultar Maestros" del
 * portal RNDC (ver manual, pag. 24) y se configuran en cada plantilla.
 */
export function construirDatosRemesa(v: DatosViajeParaRndc, consecutivoRemesa: string): Record<string, unknown> {
  const p = v.plantilla;
  return {
    CONSECUTIVOREMESA: consecutivoRemesa,
    CODOPERACIONTRANSPORTE: p.codOperacionTransporte,
    CODNATURALEZACARGA: p.codNaturalezaCarga,
    CANTIDADCARGADA: v.cantidadReal,
    UNIDADMEDIDACAPACIDAD: p.codUnidadMedida,
    CODTIPOEMPAQUE: p.codTipoEmpaque,
    MERCANCIAREMESA: p.codMercancia,
    DESCRIPCIONCORTAPRODUCTO: p.tipoMercancia,
    CODTIPOIDREMITENTE: p.remitente.codTipoId,
    NUMIDREMITENTE: p.remitente.nit,
    CODSEDEREMITENTE: p.remitente.codSede,
    CODTIPOIDDESTINATARIO: p.destinatario.codTipoId,
    NUMIDDESTINATARIO: p.destinatario.nit,
    CODSEDEDESTINATARIO: p.destinatario.codSede,
    CODTIPOIDPROPIETARIO: p.contratante.codTipoId,
    NUMIDPROPIETARIO: p.contratante.nit,
    CODSEDEPROPIETARIO: p.contratante.codSede,
    HORASPACTOCARGA: p.horasPactoCargue,
    MINUTOSPACTOCARGA: p.minutosPactoCargue,
    HORASPACTODESCARGUE: p.horasPactoDescargue,
    MINUTOSPACTODESCARGUE: p.minutosPactoDescargue,
    FECHACITAPACTADACARGUE: formatearFecha(v.fechaHoraCargue),
    HORACITAPACTADACARGUE: formatearHora(v.fechaHoraCargue),
    FECHACITAPACTADADESCARGUE: formatearFecha(v.fechaHoraCargue),
    HORACITAPACTADADESCARGUEREMESA: formatearHora(v.fechaHoraCargue),
  };
}

/**
 * Diccionario de datos de Manifiesto de Carga (procesoid=4), pag. 15-16.
 *
 * IMPORTANTE: el manifiesto referencia la remesa por CONSECUTIVOREMESA
 * (el consecutivo PROPIO de la empresa, dentro del bloque <REMESASMAN>),
 * NO por el radicado (ingresoid) que devuelve el RNDC al crear la remesa.
 * Este es un punto donde la version anterior de este codigo estaba mal.
 */
export function construirDatosManifiesto(
  v: DatosViajeParaRndc,
  consecutivoManifiesto: string
): Record<string, unknown> {
  const p = v.plantilla;
  const fecha = formatearFecha(v.fechaHoraCargue);

  const base: Record<string, unknown> = {
    NUMMANIFIESTOCARGA: consecutivoManifiesto,
    CODOPERACIONTRANSPORTE: p.codOperacionTransporte,
    FECHAEXPEDICIONMANIFIESTO: fecha,
    CODMUNICIPIOORIGENMANIFIESTO: p.ruta.codigoOrigenRndc,
    CODMUNICIPIODESTINOMANIFIESTO: p.ruta.codigoDestinoRndc,
    // Titular del manifiesto: se asume el contratante (ver nota en DatosViajeParaRndc).
    CODIDTITULARMANIFIESTO: p.contratante.codTipoId,
    NUMIDTITULARMANIFIESTO: p.contratante.nit,
    NUMPLACA: v.vehiculo.placa,
    NUMPLACAREMOLQUE: v.vehiculo.placaRemolque,
    CODIDCONDUCTOR: v.conductor.codTipoId,
    NUMIDCONDUCTOR: v.conductor.cedula,
    VALORFLETEPACTADOVIAJE: v.valorFleteReal ?? p.valorFleteBase,
    // TODO: RETENCIONICAMANIFIESTOCARGA, VALORANTICIPOMANIFIESTO, CODMUNICIPIOPAGOSALDO
    // y FECHAPAGOSALDOMANIFIESTO dependen de la negociacion comercial de cada viaje
    // (retencion ICA real, anticipo pactado, ciudad y fecha de pago del saldo).
    // Se dejan en 0 / vacio por ahora; configurar cuando se defina esa logica de negocio.
    RETENCIONICAMANIFIESTOCARGA: 0,
    VALORANTICIPOMANIFIESTO: 0,
    CODMUNICIPIOPAGOSALDO: p.ruta.codigoDestinoRndc,
    FECHAPAGOSALDOMANIFIESTO: fecha,
    // 'E' = Empresa. Ver diccionario de datos del RNDC para otros codigos validos.
    CODRESPONSABLEPAGOCARGUE: "E",
    CODRESPONSABLEPAGODESCARGUE: "E",
    ACEPTACIONELECTRONICA: "NO",
    OBSERVACIONES: p.observaciones,
  };

  return base;
}

/**
 * Bloque <REMESASMAN> que enlaza el manifiesto con sus remesas asociadas
 * (pag. 15-16). El atributo procesoid="43" viene tal cual del ejemplo del
 * manual -- no confirmado contra el diccionario completo, verificar si el
 * RNDC lo exige literalmente antes de produccion.
 */
export function construirBloqueRemesasManifiesto(consecutivosRemesa: string[]): string {
  const remesas = consecutivosRemesa
    .map((c) => `<REMESA><CONSECUTIVOREMESA>${escapeXml(c)}</CONSECUTIVOREMESA></REMESA>`)
    .join("");
  return `<REMESASMAN procesoid="43">${remesas}</REMESASMAN>`;
}
