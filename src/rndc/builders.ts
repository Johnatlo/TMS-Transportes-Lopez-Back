/**
 * Construccion del XML que exige el Web Service del RNDC.
 *
 * Verificado contra:
 *  - "GUIA DE MANIFIESTO" V7 (Ministerio de Transporte, 02/09/2026) -> [MAN]
 *  - "GUIA REGISTRO REMESA" V5 (Ministerio de Transporte, 14/07/2026) -> [REM]
 *
 * Estructura general:
 * <root>
 *   <acceso><username/><password/></acceso>
 *   <solicitud><tipo/><procesoid/></solicitud>
 *   <variables>...</variables>
 * </root>
 *
 * ALCANCE DE ESTA EMPRESA (decision de negocio, no limitacion tecnica):
 *  - Solo se mueve carga general (reciclaje, triplex, pegantes base agua).
 *    Por eso CODNATURALEZACARGA queda fijo en "1" y NO se implementan los
 *    campos de mercancia peligrosa ni residuos peligrosos (CODIGOUN,
 *    GRUPOEMBALAJEENVASE, ESTADOMERCANCIA, RESIDUO, PELIGROSIDAD, etc.).
 *    Si algun dia entra una mercancia marcada como peligrosa en el maestro del
 *    RNDC, el sistema la rechazara con un error explicito -- no la enviara mal.
 *  - La poliza de carga es siempre la misma (la de la empresa), asi que los
 *    campos de seguro no se envian por webservice. Sus nombres de etiqueta no
 *    aparecen en ningun XML de ejemplo oficial y no vale la pena adivinarlos.
 */

// ---------------------------------------------------------------------------
// Constantes de proceso
// ---------------------------------------------------------------------------

export const TIPO_SOLICITUD_REGISTRAR = "1";
export const PROCESO_ID_REMESA = "3"; // Expedir Remesa Terrestre de Carga [REM pag. 47]
export const PROCESO_ID_MANIFIESTO = "4"; // Expedir Manifiesto de Carga [MAN pag. 20]
export const PROCESO_ID_TERCERO = "11"; // Crear/actualizar Tercero (maestro)
export const PROCESO_ID_VEHICULO = "12"; // Crear/actualizar Vehiculo (maestro)

/** Naturaleza de carga: 1 = Carga General. Unico valor que usa esta empresa. */
export const NATURALEZA_CARGA_GENERAL = "1";

/**
 * Tipo de manifiesto -- CODOPERACIONTRANSPORTE del proceso 4 [MAN pag. 7-8].
 * OJO: la remesa usa una etiqueta con el MISMO nombre pero otro dominio de
 * valores (ver TIPO_OPERACION_REMESA). Son dos conceptos distintos.
 */
export const TIPO_MANIFIESTO = {
  GENERAL: "G",
  VACIO: "W",
  IDA_Y_REGRESO: "I",
  MULTIPARADA: "M",
  URBANO: "U",
  VARIOS_VIAJES_DIA: "D",
} as const;
export type TipoManifiesto = (typeof TIPO_MANIFIESTO)[keyof typeof TIPO_MANIFIESTO];

/**
 * Tipo de operacion de la REMESA [REM pag. 8]. El unico codigo confirmado en
 * un XML de ejemplo oficial es "G" (General), que es el que usa esta empresa.
 * Los demas (mercancia consolidada, contenedor cargado, contenedor vacio)
 * existen pero su codigo hay que leerlo del maestro del RNDC antes de usarlo.
 */
export const TIPO_OPERACION_REMESA = {
  GENERAL: "G",
} as const;
export type TipoOperacionRemesa =
  (typeof TIPO_OPERACION_REMESA)[keyof typeof TIPO_OPERACION_REMESA];

/**
 * Unidad de medida COMERCIAL del producto -- UNIDADMEDIDAPRODUCTO [REM pag. 47-48].
 * Distinta de UNIDADMEDIDACAPACIDAD, que es la unidad de TRANSPORTE y siempre
 * va en kilos.
 */
export const UNIDAD_MEDIDA_PRODUCTO = {
  KILOGRAMO: "KGM",
  GALON: "GLL",
  METRO_CUBICO: "MTQ",
  CENTIMETRO_CUBICO: "CMQ",
  LITRO: "LTR",
  MILILITRO: "MLT",
  BARRIL: "BLL",
  UNIDAD: "UN",
} as const;
export type UnidadMedidaProducto =
  (typeof UNIDAD_MEDIDA_PRODUCTO)[keyof typeof UNIDAD_MEDIDA_PRODUCTO];

/** Unidad de medida del TRANSPORTE (UNIDADMEDIDACAPACIDAD). Siempre kilos. */
export const UNIDAD_MEDIDA_TRANSPORTE_KILOS = "1";

/**
 * Tarifa de retencion en la fuente por servicios de transporte de carga.
 * El 1% coincide con el ejemplo oficial del formato de manifiesto
 * [MAN Figura 18: valor total 6.000.000 -> retencion en la fuente 60.000].
 * Confirmar con el contador de la empresa antes de produccion; es
 * configurable justamente porque puede cambiar por normativa DIAN.
 */
export const TARIFA_RETENCION_FUENTE_DEFECTO = 0.01;

/**
 * Peso bruto vehicular a partir del cual aplica el aporte FOPAT
 * (Ley 2251 de 2022, art. 21) [MAN pag. 15].
 */
export const PBV_MINIMO_FOPAT_KG = 10500;

/** Factor del aporte FOPAT: 0.1% del valor a pagar [MAN pag. 15]. */
export const FACTOR_FOPAT = 0.001;

/**
 * Dias maximos entre la cita de cargue y la de descargue, o sea la duracion
 * del viaje en carretera [Manual de Operacion General del RNDC, 5.2.3].
 * La excepcion es maquinaria (capitulo 84) extradimensionada, que llega a 30.
 */
export const DIAS_MAXIMOS_VIAJE = 6;

/** Manifiestos maximos por placa en una misma fecha de expedicion. */
export const MAX_MANIFIESTOS_POR_PLACA_DIA = 10;

// ---------------------------------------------------------------------------
// Utilidades de XML
// ---------------------------------------------------------------------------

function escapeXml(valor: string): string {
  return valor
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Emite una etiqueta. Omite null/undefined/cadena vacia, pero SI emite el
 * cero: hay campos (retenciones, anticipo) donde 0 es un valor valido y
 * distinto de "no informado".
 */
function tag(nombre: string, valor: unknown): string {
  if (valor === null || valor === undefined) return "";
  if (typeof valor === "string" && valor.trim() === "") return "";
  return `<${nombre}>${escapeXml(String(valor))}</${nombre}>`;
}

// ---------------------------------------------------------------------------
// Fechas y horas (siempre en hora de Colombia)
// ---------------------------------------------------------------------------

/**
 * El RNDC razona en hora local colombiana. Si el servidor corre en UTC (lo
 * normal en un VPS o un contenedor), usar getDate()/getHours() del objeto Date
 * mueve las cargas de madrugada al dia siguiente. Por eso todo el formateo
 * pasa explicitamente por America/Bogota.
 */
const FORMATO_BOGOTA = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Bogota",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

interface PartesFecha {
  dia: string;
  mes: string;
  anio: string;
  hora: string;
  minuto: string;
}

function partesBogota(fecha: Date): PartesFecha {
  const p: Record<string, string> = {};
  for (const parte of FORMATO_BOGOTA.formatToParts(fecha)) {
    if (parte.type !== "literal") p[parte.type] = parte.value;
  }
  return { dia: p.day, mes: p.month, anio: p.year, hora: p.hour, minuto: p.minute };
}

/** DD/MM/AAAA, formato exigido por el RNDC. */
export function formatearFecha(fecha: Date): string {
  const p = partesBogota(fecha);
  return `${p.dia}/${p.mes}/${p.anio}`;
}

/** HH:MM en formato militar (00:00 a 23:59) [REM pag. 13]. */
export function formatearHora(fecha: Date): string {
  const p = partesBogota(fecha);
  return `${p.hora}:${p.minuto}`;
}

/** Fecha calendario en Bogota, normalizada a medianoche, para comparar dias. */
function diaBogota(fecha: Date): Date {
  const p = partesBogota(fecha);
  return new Date(`${p.anio}-${p.mes}-${p.dia}T00:00:00Z`);
}

function diferenciaEnDias(a: Date, b: Date): number {
  return Math.round((diaBogota(a).getTime() - diaBogota(b).getTime()) / 86_400_000);
}

/**
 * Cuenta dias habiles (lunes a viernes) entre dos fechas. No contempla
 * festivos colombianos, asi que sirve como alerta temprana y no como verdad
 * final: el RNDC tiene la ultima palabra.
 */
function diasHabilesEntre(desde: Date, hasta: Date): number {
  let habiles = 0;
  const cursor = diaBogota(desde);
  const fin = diaBogota(hasta);
  while (cursor < fin) {
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    const dia = cursor.getUTCDay();
    if (dia !== 0 && dia !== 6) habiles++;
  }
  return habiles;
}

// ---------------------------------------------------------------------------
// Calculos financieros del manifiesto
// ---------------------------------------------------------------------------

/**
 * Base para retenciones: valor a pagar menos los dos trayectos en vacio
 * [MAN pag. 15: "El valor base para aplicar la retencion de ICA es el
 * resultado de la resta del valor a pagar menos valor trayecto vacio 1 y
 * valor trayecto vacio 2"].
 */
export function baseRetenciones(
  valorAPagar: number,
  valorTrayectoVacio1 = 0,
  valorTrayectoVacio2 = 0
): number {
  return Math.max(0, valorAPagar - valorTrayectoVacio1 - valorTrayectoVacio2);
}

/**
 * Retencion en la fuente, en PESOS ENTEROS (sin centavos), obligatorio desde
 * el 31/07/2026 [MAN pag. 15].
 *
 * El RNDC valida que sea > 0 si el titular del manifiesto pertenece al Regimen
 * Ordinario, y solo permite 0 si pertenece al Regimen Simple de Tributacion.
 */
export function calcularRetencionFuente(
  base: number,
  tarifa: number = TARIFA_RETENCION_FUENTE_DEFECTO,
  titularEsRegimenSimple = false
): number {
  if (titularEsRegimenSimple) return 0;
  return Math.round(base * tarifa);
}

/**
 * Aporte FOPAT: 0.1% del valor a pagar, ajustado al peso mas cercano y sin
 * decimales. Aplica solo a vehiculos con peso bruto vehicular mayor a 10.5 t
 * [MAN pag. 15]. El RNDC verifica el monto exacto, asi que enviarlo cuando no
 * aplica es tan problematico como omitirlo cuando si.
 */
export function calcularFopat(valorAPagar: number, aplicaFopat: boolean): number | null {
  if (!aplicaFopat) return null;
  return Math.round(valorAPagar * FACTOR_FOPAT);
}

/**
 * Retencion de ICA en pesos. El manifiesto lleva el FACTOR (por mil), pero el
 * monto hace falta para calcular el neto a pagar.
 */
/**
 * FOPAT que finalmente se envia: el valor explicito si lo hay, o el calculado.
 * Un cero explicito se respeta (caso de vehiculo que no llega a 10.5 t).
 */
export function fopatEfectivo(v: {
  retencionFopat?: number | null;
  vehiculo: { aplicaFopat: boolean };
}, valorAPagar: number): number | null {
  if (v.retencionFopat !== null && v.retencionFopat !== undefined) {
    return v.retencionFopat;
  }
  return calcularFopat(valorAPagar, v.vehiculo.aplicaFopat);
}

export function calcularIca(base: number, factorPorMil: number): number {
  return Math.round((base * factorPorMil) / 1000);
}

/**
 * Neto a pagar: valor a pagar menos las tres retenciones
 * [Manual de Operacion General del RNDC, 5.2.4].
 *
 * Importa porque el tope del anticipo se mide contra este numero, no contra el
 * valor a pagar: "El valor del anticipo no puede ser mayor al valor a pagar
 * menos la sumatoria de las tres retenciones".
 */
export function calcularNetoAPagar(
  valorAPagar: number,
  retencionFuente: number,
  retencionIca: number,
  retencionFopat: number
): number {
  return valorAPagar - retencionFuente - retencionIca - retencionFopat;
}

/**
 * Compara dos identificaciones tolerando el digito de verificacion.
 *
 * Un NIT se escribe indistintamente con o sin DV (901319583 vs 9013195831), y
 * la empresa suele registrarlo de las dos formas en sitios distintos. Sin esto,
 * la deteccion de flota propia falla justo cuando importa.
 */
export function mismaIdentificacion(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  const da = a.replace(/\D/g, "");
  const db = b.replace(/\D/g, "");
  if (!da || !db) return false;
  if (da === db) return true;
  // Diferencia de un digito: puede ser el DV al final.
  if (da.length === db.length + 1) return da.slice(0, -1) === db;
  if (db.length === da.length + 1) return db.slice(0, -1) === da;
  return false;
}

// ---------------------------------------------------------------------------
// Coordenadas de las sedes
// ---------------------------------------------------------------------------

/**
 * Limites geograficos de Colombia segun el RNDC [REMESA V5 pag. 13]:
 * latitud entre -5 y 14, longitud entre -79 y -66. Fuera de ese rectangulo,
 * la ubicacion esta fuera del pais.
 */
export const LIMITES_COLOMBIA = {
  latMin: -5,
  latMax: 14,
  lonMin: -79,
  lonMax: -66,
} as const;

/** Decimales minimos que exige el RNDC. Con menos, el punto se corre. */
export const DECIMALES_MINIMOS_COORDENADA = 6;

/**
 * Cuenta los decimales significativos de una coordenada.
 *
 * Importa porque el RNDC exige minimo 6. Un grado son unos 111 km, asi que
 * cada decimal que falta multiplica por diez el error: con 4 decimales la
 * posicion se corre unos 11 metros, y con 2 mas de un kilometro. Si el cerco
 * con el que el RNDC verifica el GPS del vehiculo es mas estrecho que ese
 * error, el cargue no se va a poder validar nunca.
 */
export function decimalesDe(valor: number): number {
  const texto = String(valor);
  const punto = texto.indexOf(".");
  if (punto === -1) return 0;
  return texto.length - punto - 1;
}

export interface RevisionCoordenada {
  ok: boolean;
  /** Motivo del problema, o null si la coordenada sirve. */
  problema: string | null;
  /** true si el problema impide despachar; false si solo es una advertencia. */
  bloqueante: boolean;
}

/**
 * Revisa la coordenada de una sede contra las reglas del RNDC.
 *
 * Nunca bloquea el despacho: el RNDC usa SU copia de la coordenada, no la
 * nuestra, asi que una coordenada local mala no impide expedir el documento.
 * Lo que hace es avisar, porque casi siempre significa que la sede tambien
 * esta mal registrada en el portal, y eso si rompe la verificacion de GPS.
 */
export function revisarCoordenadaSede(
  latitud: number | null | undefined,
  longitud: number | null | undefined,
  descripcionSede: string
): RevisionCoordenada {
  if (latitud === null || latitud === undefined || longitud === null || longitud === undefined) {
    return {
      ok: false,
      bloqueante: false,
      problema:
        `${descripcionSede}: no tiene coordenadas registradas. El RNDC compara el GPS del ` +
        `vehiculo contra la ubicacion de la sede; verifica que este bien puesta en el portal ` +
        `(Herramientas -> Terceros).`,
    };
  }

  const { latMin, latMax, lonMin, lonMax } = LIMITES_COLOMBIA;
  if (latitud < latMin || latitud > latMax || longitud < lonMin || longitud > lonMax) {
    return {
      ok: false,
      bloqueante: false,
      problema:
        `${descripcionSede}: la coordenada (${latitud}, ${longitud}) queda fuera de Colombia. ` +
        `Revisa que no esten invertidas latitud y longitud, y que la longitud sea negativa.`,
    };
  }

  const decimales = Math.min(decimalesDe(latitud), decimalesDe(longitud));
  if (decimales < DECIMALES_MINIMOS_COORDENADA) {
    const metros = Math.round(111_000 / Math.pow(10, decimales));
    return {
      ok: false,
      bloqueante: false,
      problema:
        `${descripcionSede}: la coordenada tiene ${decimales} decimal(es) y el RNDC exige ` +
        `${DECIMALES_MINIMOS_COORDENADA}. Eso deja la sede a unos ${metros} m de donde ` +
        `realmente esta, y la verificacion de GPS del cargue puede fallar.`,
    };
  }

  return { ok: true, bloqueante: false, problema: null };
}

// ---------------------------------------------------------------------------
// Normalizacion del codigo de mercancia
// ---------------------------------------------------------------------------

/**
 * El codigo de producto lleva "00" a la izquierda del capitulo+partida
 * (ej. partida 2710 -> "002710"). Si el usuario no los escribe, el RNDC los
 * agrega solo, pero se normaliza aqui para que lo guardado y lo enviado
 * coincidan siempre [REM pag. 15].
 */
export function normalizarCodigoMercancia(codigo: string | null): string | null {
  if (!codigo) return null;
  const soloDigitos = codigo.replace(/\D/g, "");
  if (soloDigitos.length === 0) return null;
  if (soloDigitos.length === 4) return `00${soloDigitos}`;
  return soloDigitos;
}

// ---------------------------------------------------------------------------
// Mensaje generico
// ---------------------------------------------------------------------------

export interface CredencialesRndc {
  usuario: string;
  password: string;
  nitEmpresa: string;
}

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

// ---------------------------------------------------------------------------
// Datos de entrada
// ---------------------------------------------------------------------------

export interface TerceroRndc {
  codTipoId: string;
  nit: string;
  codSede: string;
  nombre?: string;
  /** Codigo DIVIPOLA (8 digitos) del municipio de la sede. */
  codMunicipioRndc?: string | null;
  /**
   * Coordenadas de la sede. NO se envian al RNDC: alli las toma de su propio
   * maestro de terceros. Se traen para poder avisar antes de despachar si la
   * sede no tiene coordenada valida, porque el RNDC compara el GPS del vehiculo
   * contra ese punto para verificar que estuvo en el sitio durante el cargue.
   */
  latitud?: number | null;
  longitud?: number | null;
}

export interface TrayectoVacio {
  origen: string;
  destino: string;
  valor: number;
}

/**
 * Una remesa dentro de un manifiesto.
 *
 * Un manifiesto multiparada lleva varias, posiblemente de generadores
 * distintos, cada una con su propio sitio de cargue, sitio de descargue,
 * mercancia y citas.
 */
export interface DatosRemesaParaRndc {
  /** CONSECUTIVOREMESA propio de la empresa. */
  consecutivo: string;

  contratante: TerceroRndc; // propietario de la carga / generador
  remitente: TerceroRndc; // sitio de cargue
  destinatario: TerceroRndc; // sitio de descargue

  tipoOperacionRemesa: TipoOperacionRemesa;
  codTipoEmpaque: string;
  empaquePrimario: string | null;
  codMercancia: string | null;
  subpartidaCode: string | null;
  codigoArancelCode: string | null;
  descripcionCortaProducto: string | null;
  unidadMedidaProducto: UnidadMedidaProducto;

  horasPactoCargue: number;
  minutosPactoCargue: number;
  horasPactoDescargue: number;
  minutosPactoDescargue: number;

  /** Kilos reales cargados -> CANTIDADCARGADA (unidad de transporte). */
  pesoReal: number | null;
  /** Cantidad en la unidad comercial -> CANTIDADPRODUCTO. */
  cantidadReal: number | null;

  fechaHoraCargue: Date;
  fechaHoraDescargue: Date;
  ordenServicioGenerador: string | null;

  /**
   * Factor de retencion de ICA (por mil) del municipio donde carga ESTA remesa.
   * Con varias remesas de municipios distintos, el manifiesto lleva el promedio
   * ponderado de todos [MAN pag. 15].
   */
  factorIcaCargue: number;

  /**
   * Parte del flete que corresponde a esta remesa. Sirve para ponderar el ICA.
   * Si va null, se reparte proporcionalmente al peso.
   */
  valorFleteRemesa: number | null;
}

export interface DatosViajeParaRndc {
  vehiculo: {
    placa: string;
    /**
     * Titular del manifiesto = tenedor/propietario registrado del vehiculo
     * [MAN pag. 11]. NO es el contratante de la carga.
     */
    tenedorCodTipoId: string;
    tenedorNumId: string | null;
    /** true si el PBV supera 10.5 t y por lo tanto aplica FOPAT. */
    aplicaFopat: boolean;
    /** Capacidad de carga en kg, si se conoce. */
    capacidadKg?: number | null;
    /** Peso del vehiculo vacio, en kg. */
    pesoVehiculoVacio?: number | null;
  };
  remolque: {
    placa: string | null;
    capacidadKg?: number | null;
  };
  conductor: {
    codTipoId: string;
    cedula: string;
  };
  conductor2: {
    codTipoId: string;
    cedula: string;
  } | null;

  /**
   * Condiciones del manifiesto. Con varias remesas salen de la plantilla
   * principal del viaje: la ruta y los terminos de pago son del viaje completo,
   * no de cada remesa.
   */
  manifiesto: {
    /**
     * Origen y destino del manifiesto en codigo DIVIPOLA.
     *
     * Salen de la ruta explicita de las plantillas (municipioOrigen de la
     * plantilla de la primera carga, municipioDestino de la de la ultima), que
     * el despachador puede editar. Como ya no se deducen de las remesas, la
     * regla del Manual (5.2.4) -- el origen debe coincidir con el municipio de
     * cargue de alguna remesa y el destino con el de descargue de alguna -- no
     * se cumple por construccion: la verifica validarReglasRndc antes de enviar.
     *
     * Los trayectos en vacio son la excepcion: si el viaje arranca vacio, el
     * origen es donde empieza ese trayecto, no donde se carga (ver
     * municipioOrigenDe / municipioDestinoDe).
     */
    ruta: {
      codigoOrigenRndc: string | null;
      codigoDestinoRndc: string | null;
      /**
       * Codigo de la via a utilizar (CODVIA) [MAN pag. 10]. Si va null, el RNDC
       * asigna la via estandar de SICETAC para esa ruta origen-destino.
       */
      codVia: string | null;
    };
    tipoManifiesto: TipoManifiesto;
    codMunicipioIntermedio: string | null; // obligatorio si tipoManifiesto = I
    tarifaRetencionFuente: number;
    titularEsRegimenSimple: boolean;
    codResponsablePagoCargue: string;
    codResponsablePagoDescargue: string;
    aceptacionElectronica: string;
    codMunicipioPagoSaldo: string | null;
    observaciones: string | null;
  };

  /** Las remesas del viaje. Un manifiesto general lleva una; multiparada, varias. */
  remesas: DatosRemesaParaRndc[];

  valorFleteReal: number | null;
  valorAnticipoManifiesto: number;
  fechaPagoSaldo: Date | null;
  nitMonitoreoFlota: string | null;
  vacio1: TrayectoVacio | null;
  vacio2: TrayectoVacio | null;
  /** Solo para tipoManifiesto = D (varios viajes en el dia). */
  viajesDia: number | null;
  /**
   * NIT de la empresa de transporte. Se usa para detectar flota propia: si el
   * titular del manifiesto es la propia empresa, el valor a pagar debe ser 0.
   */
  nitEmpresaTransporte: string;
  /**
   * Valor del FOPAT que se va a enviar. Si va null, se calcula (0.1% del valor
   * a pagar). Se acepta explicito para que el despachador lo vea y lo pueda
   * ajustar, pero el RNDC verifica el monto exacto: cualquier otro valor que no
   * sea el calculado o cero se rechaza.
   */
  retencionFopat?: number | null;

  /**
   * Manifiestos ya expedidos para esta placa en la misma fecha de expedicion.
   * El RNDC no permite mas de 10, salvo en manifiestos municipales.
   */
  manifiestosMismaPlacaFecha?: number;
}

// ---------------------------------------------------------------------------
// Fechas derivadas del conjunto de remesas
// ---------------------------------------------------------------------------

/**
 * La fecha de expedicion del manifiesto es la del cargue de la PRIMERA
 * mercancia [MAN pag. 9]. Con varias remesas, la mas temprana.
 */
export function fechaExpedicionDe(remesas: DatosRemesaParaRndc[]): Date {
  return remesas.reduce(
    (min, r) => (r.fechaHoraCargue < min ? r.fechaHoraCargue : min),
    remesas[0].fechaHoraCargue
  );
}

/**
 * Fecha de descargue mas tardia de todo el manifiesto. Es contra ella que el
 * RNDC valida el SOAT, la RTM y la licencia [MAN pag. 12-13], asi que con
 * multiparada manda la ultima parada, no la primera.
 */
export function ultimoDescargueDe(remesas: DatosRemesaParaRndc[]): Date {
  return remesas.reduce(
    (max, r) => (r.fechaHoraDescargue > max ? r.fechaHoraDescargue : max),
    remesas[0].fechaHoraDescargue
  );
}

// ---------------------------------------------------------------------------
// Retencion de ICA con varias remesas
// ---------------------------------------------------------------------------

export interface IcaPonderado {
  /** Factor por mil que va en el manifiesto. */
  factor: number;
  /** Como quedo repartido, para poder mostrarlo y auditarlo. */
  detalle: Array<{ consecutivo: string; factor: number; participacion: number }>;
}

/**
 * Calcula el factor de ICA del manifiesto a partir de las remesas.
 *
 * Cuando el manifiesto lleva varias remesas cargadas en municipios distintos y
 * con factores distintos, el RNDC espera el promedio ponderado [MAN pag. 15].
 *
 * La ponderacion se hace por la parte del flete que corresponde a cada remesa.
 * Si no se informa, se reparte proporcionalmente al peso, que es la
 * aproximacion razonable cuando la empresa no desglosa el flete por cliente.
 *
 * OJO: la guia dice "promedio ponderado" sin precisar la base. Este calculo
 * usa la participacion en el flete, que es la lectura natural del texto
 * ("la suma en dinero de los valores de retencion... comparado con el valor a
 * pagar"). Vale la pena confirmarlo con el contador la primera vez que salga
 * un manifiesto multiparada con municipios de factores distintos.
 */
export function calcularIcaPonderado(remesas: DatosRemesaParaRndc[]): IcaPonderado {
  const pesos = remesas.map((r) => {
    const explicito = r.valorFleteRemesa;
    if (explicito !== null && explicito > 0) return explicito;
    return r.pesoReal && r.pesoReal > 0 ? r.pesoReal : 0;
  });

  const total = pesos.reduce((a, b) => a + b, 0);

  // Sin base para ponderar (por ejemplo, remesas sin peso todavia), se cae al
  // promedio simple en vez de devolver cero, que seria peor.
  if (total === 0) {
    const promedio =
      remesas.reduce((a, r) => a + r.factorIcaCargue, 0) / Math.max(1, remesas.length);
    return {
      factor: Math.round(promedio * 100) / 100,
      detalle: remesas.map((r) => ({
        consecutivo: r.consecutivo,
        factor: r.factorIcaCargue,
        participacion: 1 / remesas.length,
      })),
    };
  }

  const detalle = remesas.map((r, i) => ({
    consecutivo: r.consecutivo,
    factor: r.factorIcaCargue,
    participacion: pesos[i] / total,
  }));

  const ponderado = detalle.reduce((a, d) => a + d.factor * d.participacion, 0);

  return { factor: Math.round(ponderado * 100) / 100, detalle };
}

// ---------------------------------------------------------------------------
// Remesa (procesoid = 3)
// ---------------------------------------------------------------------------

/**
 * Diccionario de datos de Remesa Terrestre de Carga [REM pag. 46-50].
 *
 * Hay dos unidades de medida distintas, y es la parte que mas se presta a
 * confusion [REM pag. 44]:
 *   - UNIDADMEDIDACAPACIDAD + CANTIDADCARGADA = unidad de TRANSPORTE, siempre
 *     en kilos. Sirve para el control de peso en carreteras y puentes.
 *   - UNIDADMEDIDAPRODUCTO + CANTIDADPRODUCTO = unidad COMERCIAL, la que el
 *     generador usa para facturar (kilos, unidades, metros cubicos...).
 */
export function construirDatosRemesa(r: DatosRemesaParaRndc): Record<string, unknown> {
  // Si la unidad comercial tambien son kilos, no tiene sentido pedir el dato
  // dos veces en el despacho: se reutiliza el peso.
  const cantidadProducto =
    r.cantidadReal ??
    (r.unidadMedidaProducto === UNIDAD_MEDIDA_PRODUCTO.KILOGRAMO ? r.pesoReal : null);

  return {
    CONSECUTIVOREMESA: r.consecutivo,
    CODOPERACIONTRANSPORTE: r.tipoOperacionRemesa,
    CODNATURALEZACARGA: NATURALEZA_CARGA_GENERAL,

    // Codificacion armonizada. Subpartida y arancel solo los exige el RNDC
    // para ciertas partidas; van opcionales y el propio RNDC reclama si faltan
    // (errores REM112 / REM118 / REM119) [REM pag. 49 y 61].
    MERCANCIAREMESA: normalizarCodigoMercancia(r.codMercancia),
    SUBPARTIDA_CODE: r.subpartidaCode,
    CODIGOARANCEL_CODE: r.codigoArancelCode,
    // Obligatoria para carga general, maximo 60 caracteres [REM pag. 21].
    DESCRIPCIONCORTAPRODUCTO: r.descripcionCortaProducto?.slice(0, 60) ?? null,

    // Peso (unidad de transporte)
    UNIDADMEDIDACAPACIDAD: UNIDAD_MEDIDA_TRANSPORTE_KILOS,
    CANTIDADCARGADA: r.pesoReal,
    // Cantidad comercial (unidad del generador)
    UNIDADMEDIDAPRODUCTO: r.unidadMedidaProducto,
    CANTIDADPRODUCTO: cantidadProducto,

    CODTIPOEMPAQUE: r.codTipoEmpaque,
    EMPAQUEPRIMARIO: r.empaquePrimario,

    CODTIPOIDREMITENTE: r.remitente.codTipoId,
    NUMIDREMITENTE: r.remitente.nit,
    CODSEDEREMITENTE: r.remitente.codSede,
    CODTIPOIDDESTINATARIO: r.destinatario.codTipoId,
    NUMIDDESTINATARIO: r.destinatario.nit,
    CODSEDEDESTINATARIO: r.destinatario.codSede,
    CODTIPOIDPROPIETARIO: r.contratante.codTipoId,
    NUMIDPROPIETARIO: r.contratante.nit,
    CODSEDEPROPIETARIO: r.contratante.codSede,

    ORDENSERVICIOGENERADOR: r.ordenServicioGenerador,

    // Tiempos logisticos pactados (enteros, sin decimales) [REM pag. 13].
    HORASPACTOCARGA: r.horasPactoCargue,
    MINUTOSPACTOCARGA: r.minutosPactoCargue,
    HORASPACTODESCARGUE: r.horasPactoDescargue,
    MINUTOSPACTODESCARGUE: r.minutosPactoDescargue,

    // Citas. De la de descargue dependen las validaciones de vigencia de SOAT,
    // RTM y licencia del conductor [MAN pag. 12-13].
    FECHACITAPACTADACARGUE: formatearFecha(r.fechaHoraCargue),
    HORACITAPACTADACARGUE: formatearHora(r.fechaHoraCargue),
    FECHACITAPACTADADESCARGUE: formatearFecha(r.fechaHoraDescargue),
    HORACITAPACTADADESCARGUEREMESA: formatearHora(r.fechaHoraDescargue),
  };
}

// ---------------------------------------------------------------------------
// Manifiesto (procesoid = 4)
// ---------------------------------------------------------------------------

/**
 * Diccionario de datos del Manifiesto Electronico de Carga [MAN pag. 20].
 *
 * El manifiesto referencia las remesas por CONSECUTIVOREMESA (el consecutivo
 * propio de la empresa, dentro del bloque <REMESASMAN>), no por el radicado
 * que devuelve el RNDC.
 */
export function construirDatosManifiesto(
  v: DatosViajeParaRndc,
  consecutivoManifiesto: string
): Record<string, unknown> {
  const m = v.manifiesto;
  const valorAPagar = v.valorFleteReal ?? 0;
  const base = baseRetenciones(valorAPagar, v.vacio1?.valor ?? 0, v.vacio2?.valor ?? 0);

  return {
    NUMMANIFIESTOCARGA: consecutivoManifiesto,
    // Tipo de manifiesto: G/W/I/M/U/D. Dominio distinto al de la remesa.
    CODOPERACIONTRANSPORTE: m.tipoManifiesto,
    // Fecha del cargue de la primera mercancia.
    FECHAEXPEDICIONMANIFIESTO: formatearFecha(fechaExpedicionDe(v.remesas)),
    // Solo aplica al tipo "varios viajes en el dia" [MAN pag. 9].
    VIAJESDIA: m.tipoManifiesto === TIPO_MANIFIESTO.VARIOS_VIAJES_DIA ? v.viajesDia : null,

    CODMUNICIPIOORIGENMANIFIESTO: m.ruta.codigoOrigenRndc,
    CODMUNICIPIODESTINOMANIFIESTO: m.ruta.codigoDestinoRndc,
    // Municipio de retorno, obligatorio en ida y regreso [MAN pag. 9].
    CODMUNICIPIOINTERMEDIO:
      m.tipoManifiesto === TIPO_MANIFIESTO.IDA_Y_REGRESO ? m.codMunicipioIntermedio : null,

    // Trayectos en vacio [MAN pag. 10]. Si no se pactaron, no se envian.
    CODMUNICIPIOORIGENVACIO1: v.vacio1?.origen ?? null,
    CODMUNICIPIODESTINOVACIO1: v.vacio1?.destino ?? null,
    CODMUNICIPIOORIGENVACIO2: v.vacio2?.origen ?? null,
    CODMUNICIPIODESTINOVACIO2: v.vacio2?.destino ?? null,

    // Via a utilizar. Si va vacia, el RNDC asigna la via estandar de SICETAC.
    CODVIA: m.ruta.codVia,

    CODIDTITULARMANIFIESTO: v.vehiculo.tenedorCodTipoId,
    NUMIDTITULARMANIFIESTO: v.vehiculo.tenedorNumId,
    NUMPLACA: v.vehiculo.placa,
    NUMPLACAREMOLQUE: v.remolque.placa,
    CODIDCONDUCTOR: v.conductor.codTipoId,
    NUMIDCONDUCTOR: v.conductor.cedula,
    CODIDCONDUCTOR2: v.conductor2?.codTipoId ?? null,
    NUMIDCONDUCTOR2: v.conductor2?.cedula ?? null,
    NITMONITOREOFLOTA: v.nitMonitoreoFlota,

    // --- Valores ---
    VALORFLETEPACTADOVIAJE: valorAPagar,
    // En pesos enteros. Obligatorio > 0 salvo titular en Regimen Simple.
    RETENCIONFUENTEMANIFIESTO: calcularRetencionFuente(
      base,
      m.tarifaRetencionFuente,
      m.titularEsRegimenSimple
    ),
    // Factor por mil. Con varias remesas, promedio ponderado [MAN pag. 15].
    RETENCIONICAMANIFIESTOCARGA: calcularIcaPonderado(v.remesas).factor,
    // 0.1% del valor a pagar, solo si el PBV supera 10.5 t.
    RETENCIONFOPAT: fopatEfectivo(v, valorAPagar),
    VALORANTICIPOMANIFIESTO: v.valorAnticipoManifiesto,

    CODMUNICIPIOPAGOSALDO: m.codMunicipioPagoSaldo ?? m.ruta.codigoDestinoRndc,
    FECHAPAGOSALDOMANIFIESTO: v.fechaPagoSaldo
      ? formatearFecha(v.fechaPagoSaldo)
      : formatearFecha(ultimoDescargueDe(v.remesas)),
    CODRESPONSABLEPAGOCARGUE: m.codResponsablePagoCargue,
    CODRESPONSABLEPAGODESCARGUE: m.codResponsablePagoDescargue,

    ACEPTACIONELECTRONICA: m.aceptacionElectronica,
    OBSERVACIONES: m.observaciones?.slice(0, 500) ?? null,
  };
}

/**
 * Bloque <REMESASMAN> que enlaza el manifiesto con sus remesas
 * [MAN pag. 20, ejemplo XML]. El atributo procesoid="43" viene literal del
 * ejemplo oficial.
 */
export function construirBloqueRemesasManifiesto(consecutivosRemesa: string[]): string {
  const remesas = consecutivosRemesa
    .map((c) => `<REMESA><CONSECUTIVOREMESA>${escapeXml(c)}</CONSECUTIVOREMESA></REMESA>`)
    .join("");
  return `<REMESASMAN procesoid="43">${remesas}</REMESASMAN>`;
}

// ---------------------------------------------------------------------------
// Validacion previa (sin red)
// ---------------------------------------------------------------------------

export interface ProblemaValidacion {
  gravedad: "ERROR" | "AVISO";
  mensaje: string;
}

/** Maximo de remesas por manifiesto que soporta el despacho. */
export const MAX_REMESAS_POR_MANIFIESTO = 5;

/**
 * Reglas del RNDC que se pueden verificar localmente. Cada llamada rechazada
 * cuesta tiempo en el despacho nocturno, y algunas cuentan contra cupos de la
 * empresa (manifiestos tardios), asi que conviene atajarlas antes de enviar.
 *
 * Los ERROR detienen el envio. Los AVISO solo se registran: la operacion es
 * valida pero tiene un costo administrativo que el despachador debe conocer.
 */
export function validarReglasRndc(
  v: DatosViajeParaRndc,
  consecutivoManifiesto: string,
  ahora: Date = new Date()
): ProblemaValidacion[] {
  const problemas: ProblemaValidacion[] = [];
  const m = v.manifiesto;
  const error = (mensaje: string) => problemas.push({ gravedad: "ERROR", mensaje });
  const aviso = (mensaje: string) => problemas.push({ gravedad: "AVISO", mensaje });

  // --- Cantidad de remesas ---
  if (v.remesas.length === 0 && m.tipoManifiesto !== TIPO_MANIFIESTO.VACIO) {
    error("El manifiesto no tiene remesas");
    return problemas; // sin remesas no tiene sentido seguir validando
  }
  if (v.remesas.length > MAX_REMESAS_POR_MANIFIESTO) {
    error(
      `El manifiesto lleva ${v.remesas.length} remesas y el maximo configurado es ` +
        `${MAX_REMESAS_POR_MANIFIESTO}`
    );
  }

  // --- Consecutivos: alfanumericos, maximo 15 caracteres [MAN pag. 5, REM pag. 7]
  const consecutivos = [
    ...v.remesas.map((r) => [`remesa ${r.consecutivo}`, r.consecutivo] as const),
    ["manifiesto", consecutivoManifiesto] as const,
  ];
  for (const [nombre, valor] of consecutivos) {
    if (!valor || valor.length > 15 || !/^[A-Za-z0-9]+$/.test(valor)) {
      error(
        `El consecutivo de ${nombre} ("${valor}") debe ser alfanumerico y de maximo 15 caracteres`
      );
    }
  }
  const repetidos = v.remesas
    .map((r) => r.consecutivo)
    .filter((c, i, arr) => arr.indexOf(c) !== i);
  if (repetidos.length > 0) {
    error(`Hay consecutivos de remesa repetidos en el mismo manifiesto: ${repetidos.join(", ")}`);
  }

  // --- Reglas por remesa ---
  for (const r of v.remesas) {
    const etiqueta = `Remesa ${r.consecutivo}`;

    // Fecha de cargue: ventana de +/- 30 dias [MAN pag. 8-9, Manual 5.2.3]
    const diasDesdeHoy = diferenciaEnDias(r.fechaHoraCargue, ahora);
    if (diasDesdeHoy > 30) {
      error(`${etiqueta}: la cita de cargue no puede estar a mas de 30 dias en el futuro`);
    } else if (diasDesdeHoy < -30) {
      error(
        `${etiqueta}: la cita de cargue tiene mas de 30 dias de antiguedad y requiere ` +
          `registrar la excepcion en el RNDC`
      );
    } else if (diasDesdeHoy < 0) {
      aviso(
        `${etiqueta}: manifiesto tardio (${Math.abs(diasDesdeHoy)} dia(s) atras). ` +
          `Cuenta contra el cupo del 10% de la empresa`
      );
    }

    if (r.fechaHoraDescargue.getTime() < r.fechaHoraCargue.getTime()) {
      error(`${etiqueta}: la cita de descargue no puede ser anterior a la de cargue`);
    }

    // Duracion del viaje en carretera: maximo 6 dias [Manual 5.2.3].
    const diasViaje = diferenciaEnDias(r.fechaHoraDescargue, r.fechaHoraCargue);
    if (diasViaje > DIAS_MAXIMOS_VIAJE) {
      error(
        `${etiqueta}: entre la cita de cargue y la de descargue hay ${diasViaje} dias, y el ` +
          `RNDC permite maximo ${DIAS_MAXIMOS_VIAJE}. Si el viaje de verdad se demora mas, ` +
          `registra la excepcion en el RNDC antes de despachar.`
      );
    }
    if (diferenciaEnDias(r.fechaHoraDescargue, ahora) > 30) {
      error(`${etiqueta}: la cita de descargue no puede estar a mas de 30 dias en el futuro`);
    }

    // Carga
    if (!r.pesoReal || r.pesoReal <= 0) {
      error(`${etiqueta}: falta el peso cargado en kilos`);
    }
    const cantidadComercial =
      r.cantidadReal ??
      (r.unidadMedidaProducto === UNIDAD_MEDIDA_PRODUCTO.KILOGRAMO ? r.pesoReal : null);
    if (cantidadComercial === null || cantidadComercial <= 0) {
      error(
        `${etiqueta}: falta la cantidad de mercancia en la unidad comercial ` +
          `(${r.unidadMedidaProducto}), y debe ser mayor a cero`
      );
    }

    // Mercancia
    const codigo = normalizarCodigoMercancia(r.codMercancia);
    if (!codigo) {
      error(`${etiqueta}: falta el codigo de mercancia`);
    } else if (codigo.length !== 6) {
      error(
        `${etiqueta}: el codigo de mercancia "${r.codMercancia}" debe tener 4 digitos ` +
          `(capitulo+partida) o 6 con los ceros a la izquierda`
      );
    }
    for (const [nombre, valor] of [
      ["subpartida", r.subpartidaCode],
      ["codigo de arancel", r.codigoArancelCode],
    ] as const) {
      if (valor && !/^\d{2}$/.test(valor)) {
        error(`${etiqueta}: el ${nombre} debe ser de exactamente 2 digitos (recibido: "${valor}")`);
      }
    }
    if (!r.descripcionCortaProducto?.trim()) {
      error(`${etiqueta}: falta la descripcion del producto`);
    }

    // Coordenadas de las sedes de cargue y descargue. El RNDC verifica que el
    // vehiculo haya estado en la sede durante el cargue comparando el GPS
    // contra estas coordenadas. Como las suyas son las que mandan, se reporta
    // como aviso y no detiene el despacho.
    for (const [rol, tercero] of [
      ["sitio de cargue", r.remitente],
      ["sitio de descargue", r.destinatario],
    ] as const) {
      const desc = `${etiqueta}, ${rol} (${tercero.nombre ?? tercero.nit}, sede ${tercero.codSede})`;
      const revision = revisarCoordenadaSede(tercero.latitud, tercero.longitud, desc);
      if (!revision.ok && revision.problema) {
        if (revision.bloqueante) error(revision.problema);
        else aviso(revision.problema);
      }
    }
  }

  // --- Fecha de pago del saldo: maximo 5 dias habiles despues del ultimo
  //     descargue [MAN pag. 16, Decreto 1079/2015 art. 2.2.1.7.6.6]
  if (v.fechaPagoSaldo) {
    const habiles = diasHabilesEntre(ultimoDescargueDe(v.remesas), v.fechaPagoSaldo);
    if (habiles > 30) {
      error(
        `La fecha de pago del saldo supera los 30 dias habiles despues del ultimo descargue ` +
          `(van ${habiles})`
      );
    }
  }

  // --- Peso total contra la capacidad del vehiculo.
  //
  // El Manual (5.2.4) exige que la suma de los pesos de todas las remesas mas
  // los pesos vacios no supere el tope de la configuracion combinada. Con
  // multiparada es donde mas facil se pasa, porque cada carga se ve razonable
  // por separado.
  const pesoTotal = v.remesas.reduce((t, r) => t + (r.pesoReal ?? 0), 0);
  const capacidad = v.vehiculo.capacidadKg ?? v.remolque.capacidadKg ?? null;
  if (capacidad && pesoTotal > capacidad) {
    error(
      `El peso total de las ${v.remesas.length} remesa(s) es ${pesoTotal} kg y supera la ` +
        `capacidad registrada del vehiculo (${capacidad} kg). Si la capacidad esta mal en el ` +
        `catalogo, corrigela alli; el RNDC valida contra el tope de la configuracion combinada.`
    );
  }

  // --- Empresa de monitoreo de flota.
  //     Obligatoria: "Todo manifiesto debe tener definido cual empresa de
  //     monitoreo hace el monitoreo del viaje" [MANIFIESTO V7, error MAN067].
  if (!v.nitMonitoreoFlota) {
    error(
      "Falta la empresa de monitoreo de flota (proveedor de GPS del vehiculo). Eligela en el " +
        "despacho, o asignale una por defecto al vehiculo en el catalogo."
    );
  }

  // --- Titular del manifiesto
  if (!v.vehiculo.tenedorNumId) {
    error(
      `El vehiculo ${v.vehiculo.placa} no tiene tenedor/propietario registrado, y ese es el ` +
        `titular del manifiesto`
    );
  }

  // --- Valores
  const valorAPagar = v.valorFleteReal ?? 0;
  if (valorAPagar <= 0) {
    error(
      "Falta el valor del flete. Se digita en cada despacho, porque se pacta con el cliente " +
        "y el minimo de SICETAC cambia con frecuencia."
    );
  }

  // Flota propia: si el titular del manifiesto es la propia empresa de
  // transporte, el valor a pagar tiene que ser 0 y no mayor a 0 [Manual 5.2.4].
  // Es el error MAN006 del RNDC.
  const esFlotaPropia = mismaIdentificacion(v.vehiculo.tenedorNumId, v.nitEmpresaTransporte);
  if (esFlotaPropia && valorAPagar > 0) {
    error(
      "El titular del manifiesto es la misma empresa de transporte (flota propia): " +
        "el valor a pagar debe ser 0."
    );
  }

  // El tope del anticipo es el NETO a pagar, no el valor a pagar: hay que
  // descontar primero las tres retenciones [Manual 5.2.4].
  const baseRet = baseRetenciones(valorAPagar, v.vacio1?.valor ?? 0, v.vacio2?.valor ?? 0);
  const retFuente = calcularRetencionFuente(
    baseRet,
    m.tarifaRetencionFuente,
    m.titularEsRegimenSimple
  );
  const retIca = calcularIca(baseRet, calcularIcaPonderado(v.remesas).factor);
  const retFopat = fopatEfectivo(v, valorAPagar) ?? 0;
  const neto = calcularNetoAPagar(valorAPagar, retFuente, retIca, retFopat);

  // El RNDC verifica que el FOPAT sea exactamente el 0.1% del valor a pagar.
  // Se permite ajustarlo en pantalla, pero un valor distinto del calculado (o
  // de cero, cuando el vehiculo no llega a 10.5 t) es rechazo seguro.
  if (v.retencionFopat !== null && v.retencionFopat !== undefined) {
    const esperado = Math.round(valorAPagar * FACTOR_FOPAT);
    if (v.retencionFopat !== esperado && v.retencionFopat !== 0) {
      error(
        `El FOPAT quedo en ${v.retencionFopat}, pero el RNDC exige exactamente el 0.1% del ` +
          `valor a pagar, o sea ${esperado}. Usa 0 solo si el vehiculo no supera 10.5 toneladas.`
      );
    }
    if (v.retencionFopat === 0 && v.vehiculo.aplicaFopat) {
      aviso(
        `El FOPAT quedo en cero pero el vehiculo ${v.vehiculo.placa} esta marcado como mayor ` +
          `a 10.5 toneladas. Revisa que sea correcto antes de enviar.`
      );
    }
  }

  if (v.valorAnticipoManifiesto > neto) {
    error(
      `El anticipo (${v.valorAnticipoManifiesto}) supera el neto a pagar (${neto}). ` +
        `El tope es el valor a pagar menos las tres retenciones: ` +
        `fuente ${retFuente} + ICA ${retIca} + FOPAT ${retFopat}.`
    );
  }

  if (!m.titularEsRegimenSimple && valorAPagar > 0 && retFuente <= 0) {
    error(
      "La retencion en la fuente quedaria en cero, pero el titular no esta marcado como " +
        "Regimen Simple: el RNDC lo rechaza"
    );
  }

  // --- Municipios
  // Origen y destino salen de la ruta explicita de la plantilla (o de los
  // trayectos en vacio). Si faltan, la plantilla quedo sin ruta.
  if (!m.ruta.codigoOrigenRndc) {
    error(
      "No se pudo determinar el municipio de origen del manifiesto. Revisa la ruta " +
        "(municipio origen) de la plantilla de la primera carga."
    );
  }
  if (!m.ruta.codigoDestinoRndc) {
    error(
      "No se pudo determinar el municipio de destino del manifiesto. Revisa la ruta " +
        "(municipio destino) de la plantilla de la ultima carga."
    );
  }
  if (m.tipoManifiesto === TIPO_MANIFIESTO.IDA_Y_REGRESO && !m.codMunicipioIntermedio) {
    error("Un manifiesto de ida y regreso exige el municipio intermedio (de retorno)");
  }

  // Origen distinto de destino, salvo las tres excepciones del Manual 5.2.4:
  // manifiesto municipal, ida y regreso, y viaje redondo por trayecto en vacio.
  if (
    m.ruta.codigoOrigenRndc &&
    m.ruta.codigoOrigenRndc === m.ruta.codigoDestinoRndc &&
    m.tipoManifiesto !== TIPO_MANIFIESTO.URBANO &&
    m.tipoManifiesto !== TIPO_MANIFIESTO.IDA_Y_REGRESO &&
    !v.vacio1 &&
    !v.vacio2
  ) {
    error(
      "El municipio de origen y el de destino son el mismo. Eso solo se permite en " +
        "manifiestos municipales, de ida y regreso, o cuando hay un trayecto en vacio " +
        "que cierra el viaje redondo."
    );
  }

  // El origen del manifiesto debe coincidir con el municipio de cargue de
  // alguna remesa, y el destino con el de descargue de alguna [Manual 5.2.4].
  //
  // Antes esto se cumplia solo, porque la ruta se deducia de las mismas
  // remesas. Ahora la ruta es un dato explicito y editable de la plantilla, asi
  // que hay que verificarlo: mejor detenerlo aqui que dejar que el RNDC
  // rechace el manifiesto. Con trayecto en vacio el extremo es otro municipio
  // a proposito, y no aplica.
  revisarExtremoRuta({
    extremo: "origen",
    municipio: m.ruta.codigoOrigenRndc,
    hayVacio: !!v.vacio1,
    municipiosRemesas: v.remesas.map((r) => r.remitente.codMunicipioRndc),
    sitio: "cargue",
    consejo:
      "Corrige el municipio origen en la ruta de la plantilla de la primera carga, o si el " +
      "vehiculo arranca en vacio desde otro municipio, registra el trayecto en vacio 1.",
    error,
    aviso,
  });
  revisarExtremoRuta({
    extremo: "destino",
    municipio: m.ruta.codigoDestinoRndc,
    hayVacio: !!v.vacio2,
    municipiosRemesas: v.remesas.map((r) => r.destinatario.codMunicipioRndc),
    sitio: "descargue",
    consejo:
      "Corrige el municipio destino en la ruta de la plantilla de la ultima carga, o si el " +
      "vehiculo termina en vacio en otro municipio, registra el trayecto en vacio 2.",
    error,
    aviso,
  });

  // --- Cantidad de remesas segun el tipo de manifiesto [Manual 5.2.4]
  if (m.tipoManifiesto === TIPO_MANIFIESTO.MULTIPARADA && v.remesas.length < 2) {
    error(`Un manifiesto multiparada exige mas de una remesa, y este lleva ${v.remesas.length}`);
  }
  if (m.tipoManifiesto === TIPO_MANIFIESTO.IDA_Y_REGRESO && v.remesas.length < 2) {
    error(
      `Un manifiesto de ida y regreso exige minimo dos remesas (una por trayecto), y este ` +
        `lleva ${v.remesas.length}`
    );
  }
  if (m.tipoManifiesto === TIPO_MANIFIESTO.VARIOS_VIAJES_DIA && v.remesas.length !== 1) {
    error("Un manifiesto de varios viajes en el dia admite exactamente una remesa");
  }
  if (m.tipoManifiesto === TIPO_MANIFIESTO.VACIO && v.remesas.length > 0) {
    error("Un manifiesto de viaje en vacio no lleva remesas");
  }
  if (m.tipoManifiesto === TIPO_MANIFIESTO.GENERAL && v.remesas.length > 1) {
    aviso(
      `Este manifiesto lleva ${v.remesas.length} remesas pero esta marcado como General. ` +
        `Si el viaje hace paradas intermedias de cargue o descargue, el tipo correcto es ` +
        `Multiparada.`
    );
  }
  if (m.tipoManifiesto === TIPO_MANIFIESTO.VARIOS_VIAJES_DIA && !v.viajesDia) {
    error("Un manifiesto de varios viajes en el dia exige la cantidad de viajes");
  }

  // Tope de 10 manifiestos por placa y fecha, salvo municipal [Manual 5.2.4].
  if (
    v.manifiestosMismaPlacaFecha !== undefined &&
    m.tipoManifiesto !== TIPO_MANIFIESTO.URBANO &&
    v.manifiestosMismaPlacaFecha >= MAX_MANIFIESTOS_POR_PLACA_DIA
  ) {
    error(
      `La placa ${v.vehiculo.placa} ya tiene ${v.manifiestosMismaPlacaFecha} manifiestos para ` +
        `esa fecha de expedicion, y el tope son ${MAX_MANIFIESTOS_POR_PLACA_DIA}. ` +
        `Para pasarte hay que registrar la excepcion en el RNDC.`
    );
  }

  // --- Trayectos en vacio: origen y destino van en pareja [MAN pag. 10]
  for (const [nombre, vacio] of [
    ["1", v.vacio1],
    ["2", v.vacio2],
  ] as const) {
    if (vacio && (!vacio.origen || !vacio.destino)) {
      error(`El trayecto en vacio ${nombre} necesita municipio de origen y de destino`);
    }
  }

  return problemas;
}

/**
 * Verifica un extremo de la ruta contra los sitios de las remesas [Manual 5.2.4].
 *
 * Bloquea si ninguna remesa carga (o descarga) en ese municipio. Si a algun
 * tercero le falta el municipio no se puede afirmar que no calce: se avisa en
 * vez de bloquear, porque el RNDC tiene su propio maestro de terceros.
 */
function revisarExtremoRuta(p: {
  extremo: "origen" | "destino";
  municipio: string | null;
  hayVacio: boolean;
  municipiosRemesas: Array<string | null | undefined>;
  sitio: "cargue" | "descargue";
  consejo: string;
  error: (mensaje: string) => void;
  aviso: (mensaje: string) => void;
}): void {
  if (!p.municipio || p.hayVacio) return;

  const conocidos = p.municipiosRemesas.filter((c): c is string => !!c);
  if (conocidos.includes(p.municipio)) return;

  const lista = [...new Set(conocidos)].join(", ") || "ninguno registrado";
  if (conocidos.length === p.municipiosRemesas.length) {
    p.error(
      `La ruta dice ${p.extremo} ${p.municipio}, pero ninguna remesa tiene su ${p.sitio} en ese ` +
        `municipio (${lista}). El RNDC rechazaria el manifiesto. ${p.consejo}`
    );
  } else {
    p.aviso(
      `No se pudo confirmar que el ${p.extremo} de la ruta (${p.municipio}) coincida con el ` +
        `${p.sitio} de alguna remesa: a uno de los terceros le falta el codigo de municipio. ` +
        `Conocidos: ${lista}.`
    );
  }
}

/**
 * Municipio de origen del manifiesto: donde empieza el trayecto en vacio si lo
 * hay, y si no, el origen de la ruta [MANIFIESTO V7 pag. 9].
 *
 * `origenRuta` es el origen explicito de la plantilla principal. Antes salia
 * del remitente de la primera remesa; ahora es un dato propio y editable, y
 * validarReglasRndc verifica que calce con algun sitio de cargue.
 */
export function municipioOrigenDe(
  origenRuta: string | null,
  vacio1?: TrayectoVacio | null
): string | null {
  if (vacio1?.origen) return vacio1.origen;
  return origenRuta;
}

/**
 * Municipio de destino: donde termina el trayecto en vacio final si lo hay, y
 * si no, el destino de la ruta.
 *
 * `destinoRuta` es el destino explicito de la plantilla de la ULTIMA remesa:
 * en multiparada el viaje termina donde descarga el ultimo cliente.
 */
export function municipioDestinoDe(
  destinoRuta: string | null,
  vacio2?: TrayectoVacio | null
): string | null {
  if (vacio2?.destino) return vacio2.destino;
  return destinoRuta;
}

/** Atajo: true si hay al menos un problema que impide enviar. */
export function tieneErroresBloqueantes(problemas: ProblemaValidacion[]): boolean {
  return problemas.some((p) => p.gravedad === "ERROR");
}
