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
    // El "titular del manifiesto" es el TENEDOR/PROPIETARIO del vehiculo (una
    // persona o empresa registrada contra ese vehiculo), confirmado en un
    // ejemplo real del portal RNDC -- NO es el contratante de la carga (ese es
    // un rol distinto, ver 'contratante' abajo, usado como propietario de la carga).
    tenedorCodTipoId: string;
    tenedorNumId: string | null;
  };
  remolque: {
    placa: string | null; // el remolque USADO ESTA NOCHE (puede variar por viaje)
  };
  conductor: {
    codTipoId: string;
    cedula: string;
  };
  conductor2: {
    codTipoId: string;
    cedula: string;
  } | null;
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
    retencionIcaManifiesto: number;
    codResponsablePagoCargue: string;
    codResponsablePagoDescargue: string;
    aceptacionElectronica: string;
    codMunicipioPagoSaldo: string | null;
    tomadorPolizaCarga: string;
    numeroPolizaTransporte: string | null;
    companiaSeguro: string | null;
    fechaVencimientoPolizaCarga: Date | null;
  };
  pesoReal: number | null;
  cantidadReal: number | null;
  valorFleteReal: number | null;
  fechaHoraCargue: Date;
  valorAnticipoManifiesto: number;
  fechaPagoSaldo: Date | null;
  nitMonitoreoFlota: string | null;
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
    // Seguro de mercancia -- confirmado en el formulario real del RNDC ("Seguro
    // Mercancia"). DUENOPOLIZA se envia como texto por ahora; verificar contra
    // el diccionario si espera un codigo en vez de texto libre.
    DUENOPOLIZA: p.tomadorPolizaCarga,
    NUMPOLIZATRANSPORTE: p.numeroPolizaTransporte,
    COMPANIASEGURO: p.companiaSeguro,
    FECHAVENCIMIENTOPOLIZACARGA: p.fechaVencimientoPolizaCarga ? formatearFecha(p.fechaVencimientoPolizaCarga) : null,
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
    // Titular del manifiesto: CONFIRMADO contra un ejemplo real del portal RNDC
    // que es el TENEDOR/PROPIETARIO registrado del vehiculo (una persona), no
    // el contratante de la carga. Antes este codigo (incorrectamente) usaba el
    // contratante -- corregido tras revisar un caso real.
    CODIDTITULARMANIFIESTO: v.vehiculo.tenedorCodTipoId,
    NUMIDTITULARMANIFIESTO: v.vehiculo.tenedorNumId,
    NUMPLACA: v.vehiculo.placa,
    // El remolque se define en el DESPACHO de esa noche, no en el vehiculo
    // (los vehiculos intercambian de remolque entre viajes).
    NUMPLACAREMOLQUE: v.remolque.placa,
    CODIDCONDUCTOR: v.conductor.codTipoId,
    NUMIDCONDUCTOR: v.conductor.cedula,
    // Segundo conductor: opcional, solo se envia si el despacho lo especifico.
    CODIDCONDUCTOR2: v.conductor2?.codTipoId ?? null,
    NUMIDCONDUCTOR2: v.conductor2?.cedula ?? null,
    // Empresa de monitoreo de flota (GPS) -- confirmada en el diccionario oficial
    // (NITMONITOREOFLOTA) y visible en el formulario real del RNDC.
    NITMONITOREOFLOTA: v.nitMonitoreoFlota,
    VALORFLETEPACTADOVIAJE: v.valorFleteReal ?? p.valorFleteBase,
    // Estos 4 campos vienen de la plantilla (condiciones comerciales pactadas
    // con el cliente) y del despacho de esa noche (anticipo y fecha de pago,
    // que varian viaje a viaje) -- ya no son valores fijos.
    RETENCIONICAMANIFIESTOCARGA: p.retencionIcaManifiesto,
    VALORANTICIPOMANIFIESTO: v.valorAnticipoManifiesto,
    CODMUNICIPIOPAGOSALDO: p.codMunicipioPagoSaldo ?? p.ruta.codigoDestinoRndc,
    FECHAPAGOSALDOMANIFIESTO: v.fechaPagoSaldo ? formatearFecha(v.fechaPagoSaldo) : fecha,
    CODRESPONSABLEPAGOCARGUE: p.codResponsablePagoCargue,
    CODRESPONSABLEPAGODESCARGUE: p.codResponsablePagoDescargue,
    ACEPTACIONELECTRONICA: p.aceptacionElectronica,
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
