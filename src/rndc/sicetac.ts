/**
 * Consulta de valores de referencia SICETAC.
 *
 * Fuentes:
 *  - "GUIA CONSULTA SICETAC PARA WEB SERVICE" (Ministerio de Transporte,
 *    11/08/2025) -> estructura de la peticion y de la respuesta [SIC25]
 *  - "Consulta de SiceTac desde RNDC" (agosto 2021) -> formula del valor
 *    minimo y regla de los codigos de municipio [SIC21]
 *
 * Va por el mismo WSDL SOAP del resto del RNDC, con tipo 6 y procesoid 26.
 *
 * Para que sirve aqui: la respuesta trae, por cada ruta posible entre dos
 * municipios, su identificador (`rutasid`), su descripcion (`via`), si es la
 * estandar y su valor de movilizacion. Eso es exactamente lo que alimenta el
 * desplegable de "Via a Utilizar" del manifiesto y el piso del flete.
 */

import { RndcClient, RndcError, leerEtiqueta } from "./client";
import { CredencialesRndc } from "./builders";

export const TIPO_SOLICITUD_SICETAC = "6";
export const PROCESO_ID_SICETAC = "26";

/** Condicion de la carga en la consulta [SIC25]. */
export const CONDICION_CARGA = {
  CARGADO: "1",
  VACIO: "2",
} as const;

/**
 * Configuraciones combinadas admitidas por SICETAC [SIC25].
 * Es el mismo codigo que el RNDC llama "configuracion resultante".
 */
export const CONFIGURACIONES_SICETAC = [
  "3S3", "3S2", "2S3", "2S2", "3", "2",
  "2L1", "2L2", "2L3", "V2", "V3", "V4",
] as const;

export interface FilaSicetac {
  periodo: string | null;
  origen: string | null;
  nombreOrigen: string | null;
  destino: string | null;
  nombreDestino: string | null;
  condicionCarga: string | null;
  configuracion: string | null;
  tipoCarga: string | null;
  nombreTipoCarga: string | null;
  unidadTransporte: string | null;
  nombreUnidadTransporte: string | null;
  kilometros: number | null;
  /** Costo de movilizacion de la carga en esa ruta y configuracion. */
  valorMoviliza: number | null;
  valorHora: number | null;
  horasRecorrido: number | null;
  /** SI cuando es la via que el RNDC asigna si no se manda CODVIA. */
  esEstandar: boolean;
  /** Identificador de la ruta. Es el candidato a CODVIA del manifiesto. */
  rutasId: string | null;
  /** Descripcion de la via: la misma que muestra el portal en el desplegable. */
  via: string | null;
}

export interface FiltrosSicetac {
  /** AñoMes, ej. "202509". Obligatorio. */
  periodo: string;
  /** Configuracion combinada, ej. "3S3". Obligatoria. */
  configuracion: string;
  /** Codigo DIVIPOLA de 8 digitos. */
  origen?: string;
  destino?: string;
  condicionCarga?: string;
  /** Filtra por unidad de transporte, ej. "ESTACAS" [SIC21]. */
  nombreUnidadTransporte?: string;
}

function escapeXml(v: string): string {
  return v
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Los municipios de la consulta deben ser cabecera municipal: los ultimos tres
 * digitos del codigo DIVIPOLA en 000 [SIC21].
 *
 * Importa porque nuestros terceros pueden estar en veredas o centros poblados,
 * y con ese codigo SICETAC no devuelve nada. Para efectos de tarifa, la vereda
 * cotiza como su cabecera.
 */
export function aCabeceraMunicipal(codigo: string | null | undefined): string | null {
  if (!codigo) return null;
  const digitos = codigo.replace(/\D/g, "").padStart(8, "0");
  if (digitos.length !== 8) return null;
  return `${digitos.slice(0, 5)}000`;
}

/** Periodo AñoMes de una fecha, en hora de Colombia. */
export function periodoDe(fecha: Date): string {
  const partes = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Bogota",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(fecha);
  const anio = partes.find((p) => p.type === "year")!.value;
  const mes = partes.find((p) => p.type === "month")!.value;
  return `${anio}${mes}`;
}

/** Retrocede n meses sobre un periodo AñoMes. */
export function periodoAnterior(periodo: string, meses = 1): string {
  let anio = Number(periodo.slice(0, 4));
  let mes = Number(periodo.slice(4, 6)) - meses;
  while (mes <= 0) {
    mes += 12;
    anio -= 1;
  }
  return `${anio}${String(mes).padStart(2, "0")}`;
}

export function construirXmlSicetac(
  credenciales: CredencialesRndc,
  filtros: FiltrosSicetac
): string {
  // Los valores van entre comillas simples DENTRO de la etiqueta. Asi esta en
  // los dos ejemplos oficiales; no es un descuido de la guia.
  const etiqueta = (nombre: string, valor: string | undefined) =>
    valor ? `<${nombre}>'${escapeXml(valor)}'</${nombre}>` : "";

  return `<?xml version='1.0' encoding='ISO-8859-1' ?>
<root>
<acceso>
  <username>${escapeXml(credenciales.usuario)}</username>
  <password>${escapeXml(credenciales.password)}</password>
</acceso>
<solicitud>
  <tipo>${TIPO_SOLICITUD_SICETAC}</tipo>
  <procesoid>${PROCESO_ID_SICETAC}</procesoid>
</solicitud>
<documento>
  ${etiqueta("PERIODO", filtros.periodo)}
  ${etiqueta("CONFIGURACIONESID", filtros.configuracion)}
  ${etiqueta("CONDICIONCARGAID", filtros.condicionCarga)}
  ${etiqueta("ORIGEN", filtros.origen)}
  ${etiqueta("DESTINO", filtros.destino)}
  ${etiqueta("NOMBREUNIDADTRANSPORTE", filtros.nombreUnidadTransporte)}
</documento>
</root>`;
}

function aNumero(valor: string | null): number | null {
  if (valor === null) return null;
  const n = Number(valor);
  return Number.isFinite(n) ? n : null;
}

/**
 * Parte la respuesta en bloques <documento> y lee cada uno.
 *
 * Es necesario leer por bloque y no con un buscador plano de etiquetas: la
 * respuesta trae una fila por cada combinacion de ruta, tipo de carga y unidad
 * de transporte, y mezclarlas daria valores de rutas distintas en una misma
 * fila.
 */
export function parsearRespuestaSicetac(xml: string): FilaSicetac[] {
  const bloques = xml.match(/<documento>[\s\S]*?<\/documento>/gi) ?? [];
  return bloques.map((b) => ({
    periodo: leerEtiqueta(b, "periodo"),
    origen: leerEtiqueta(b, "origen"),
    nombreOrigen: leerEtiqueta(b, "nomorigen"),
    destino: leerEtiqueta(b, "destino"),
    nombreDestino: leerEtiqueta(b, "nomdestino"),
    condicionCarga: leerEtiqueta(b, "condicioncarga"),
    configuracion: leerEtiqueta(b, "configuracion"),
    tipoCarga: leerEtiqueta(b, "tipocarga"),
    nombreTipoCarga: leerEtiqueta(b, "nombretipocarga"),
    unidadTransporte: leerEtiqueta(b, "unidadtransporte"),
    nombreUnidadTransporte: leerEtiqueta(b, "nombreunidadtransporte"),
    kilometros: aNumero(leerEtiqueta(b, "kilometros")),
    valorMoviliza: aNumero(leerEtiqueta(b, "valormoviliza")),
    valorHora: aNumero(leerEtiqueta(b, "valorhora")),
    horasRecorrido: aNumero(leerEtiqueta(b, "horasrecorrido")),
    esEstandar: (leerEtiqueta(b, "viaestandar") ?? "").toUpperCase() === "SI",
    rutasId: leerEtiqueta(b, "rutasid"),
    via: leerEtiqueta(b, "via"),
  }));
}

/**
 * Valor minimo a pagar del viaje [SIC21]:
 *
 *   valor movilizacion + (valor hora * horas pactadas de cargue, descargue y espera)
 *
 * El valor de movilizacion por si solo NO es el piso: si se compara el flete
 * contra el, se subestima el minimo y el RNDC rechaza el manifiesto.
 */
export function calcularPisoSicetac(
  fila: Pick<FilaSicetac, "valorMoviliza" | "valorHora">,
  horasPactadas: number
): number | null {
  if (fila.valorMoviliza === null) return null;
  const porHoras = (fila.valorHora ?? 0) * horasPactadas;
  return Math.round(fila.valorMoviliza + porHoras);
}

/** Horas pactadas totales, con los minutos convertidos a fraccion de hora. */
export function horasPactadasTotales(
  tiempos: Array<{ horas: number; minutos: number }>
): number {
  return tiempos.reduce((total, t) => total + t.horas + t.minutos / 60, 0);
}

export interface ResultadoConsultaSicetac {
  filas: FilaSicetac[];
  /** Periodo que finalmente devolvio datos. */
  periodoUsado: string | null;
  /** Periodos que se intentaron sin resultado, para poder explicarlo. */
  periodosVacios: string[];
}

/**
 * Consulta SICETAC para una ruta, retrocediendo de periodo si hace falta.
 *
 * La guia advierte que un periodo puede no tener registros porque siguen
 * aplicando los del mes anterior, asi que se reintenta hacia atras en vez de
 * devolver una lista vacia.
 */
export async function consultarSicetac(
  cliente: RndcClient,
  credenciales: CredencialesRndc,
  filtros: FiltrosSicetac,
  mesesHaciaAtras = 3
): Promise<ResultadoConsultaSicetac> {
  const periodosVacios: string[] = [];
  let periodo = filtros.periodo;

  for (let intento = 0; intento <= mesesHaciaAtras; intento++) {
    const xml = construirXmlSicetac(credenciales, { ...filtros, periodo });
    const respuesta = await cliente.enviar(xml, PROCESO_ID_SICETAC);

    // Un rechazo no es "periodo sin datos": seguir retrocediendo de mes lo
    // escondia y la pantalla decia "no hay vias" cuando en realidad el RNDC
    // rechazo la consulta (visto en el ambiente de pruebas: RNDC13, proceso 26
    // tipo 6 no habilitado). Solo "Documento no encontrado" (RNDC11) se trata
    // como mes vacio; cualquier otro error se propaga.
    if (!respuesta.ok && !/RNDC11/i.test(respuesta.errorCrudo ?? "")) {
      throw new RndcError(
        `SICETAC rechazo la consulta (periodo ${periodo}): ${respuesta.error ?? respuesta.errorCrudo}`
      );
    }

    const filas = parsearRespuestaSicetac(respuesta.xmlRespuesta);

    if (filas.length > 0) {
      return { filas, periodoUsado: periodo, periodosVacios };
    }
    periodosVacios.push(periodo);
    periodo = periodoAnterior(periodo);
  }

  return { filas: [], periodoUsado: null, periodosVacios };
}

/**
 * Deja una sola fila por ruta, quedandose con la que corresponde a la
 * operacion de la empresa (unidad de transporte y tipo de carga).
 *
 * SICETAC devuelve una fila por cada combinacion de ruta, tipo de carga y
 * unidad de transporte, y cada una tiene un piso distinto. Sin filtrar, el
 * desplegable mostraria la misma via repetida con valores que no aplican.
 */
export function filasDeLaOperacion(
  filas: FilaSicetac[],
  unidadTransporte: string,
  tipoCarga: string
): FilaSicetac[] {
  const coincide = (valor: string | null, esperado: string) =>
    (valor ?? "").toLowerCase().trim() === esperado.toLowerCase().trim();

  const propias = filas.filter(
    (f) =>
      coincide(f.nombreUnidadTransporte, unidadTransporte) &&
      coincide(f.nombreTipoCarga, tipoCarga)
  );

  // Si la combinacion exacta no existe para esa ruta, es preferible mostrar
  // todo a mostrar nada: el despachador decide con la descripcion a la vista.
  const base = propias.length > 0 ? propias : filas;

  // Una sola entrada por ruta: si se repite, se conserva la mas barata, que es
  // el piso real que el RNDC va a exigir.
  const porRuta = new Map<string, FilaSicetac>();
  for (const f of base) {
    const clave = f.rutasId ?? f.via ?? "";
    const previa = porRuta.get(clave);
    if (!previa || (f.valorMoviliza ?? Infinity) < (previa.valorMoviliza ?? Infinity)) {
      porRuta.set(clave, f);
    }
  }
  return [...porRuta.values()].sort(
    (a, b) => Number(b.esEstandar) - Number(a.esEstandar)
  );
}
