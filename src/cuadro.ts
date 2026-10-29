/**
 * Cuadro pagos: control operativo y financiero de los viajes.
 *
 * Reemplaza la hoja "CUADRO PAGOS" de Excel. Cada fila es un viaje
 * facturable (empresa + remision), tenga manifiesto o no. El estado no se
 * pinta a mano como en el Excel: se deduce de los datos.
 *
 * Colores del Excel y su equivalente aqui:
 * - blanco: en proceso (EN_RUTA, o sin nada especial)
 * - morado: descargo y los papeles aun no estan radicados (las secretarias
 *   llaman al conductor)
 * - verde (remision): papeles radicados en el cliente
 * - azul (fecha): facturado, pero sin numero ni fecha de factura anotados
 * - naranja: revisado por contabilidad, falta la gerente
 * - amarillo: todo pagado
 */
import type { ResultSetHeader, RowDataPacket } from "mysql2";
import { pool } from "./db";
import { sqlFlota } from "./flota";
import { cargarTarifas, deducirConMatriz, fleteDeTarifa } from "./tarifasFlete";
import type { TarifaPosible } from "./tarifasFlete";
// anticipos.ts tambien importa de aqui; solo se usan dentro de funciones, asi
// que el ciclo no molesta (cuando se llaman, los dos modulos ya cargaron).
import { anticipos } from "./anticipos";
import { viernesDePago } from "./terceros";

/**
 * Donde van los papeles: en ruta, ya descargo, con el conductor, parqueadero,
 * oficina (Don Alexander), listos para facturar (RADICADO) y, solo en CORAME /
 * Cartones America, radicados en el cliente (RADICADOS, el ultimo paso).
 */
export type EstadoPapeles = "EN_RUTA" | "DESCARGADO" | "CONDUCTOR" | "PARQUEADERO" | "OFICINA" | "RADICADO" | "RADICADOS";
export const ESTADOS_PAPELES: EstadoPapeles[] = ["EN_RUTA", "DESCARGADO", "CONDUCTOR", "PARQUEADERO", "OFICINA", "RADICADO", "RADICADOS"];
/** Papeles listos para facturar: "listo para facturar" o, en CORAME, ya radicados. */
export const papelesListos = (e: string) => e === "RADICADO" || e === "RADICADOS";

export type Flota = "LOPEZ" | "MYC" | "TERCERO";


/**
 * Dias dentro de los cuales un manifiesto nuevo de la misma placa y empresa se
 * toma como el reemplazo de uno anulado (el viaje se re-expide casi siempre el
 * mismo dia).
 */
export const DIAS_REEXPEDICION = 3;

/** Fila cruda de cuadro_viajes con lo que puede heredarse de un viaje anulado. */
export type FilaHeredable = Record<string, unknown> & {
  estadoPapeles?: unknown;
  tarifaKilo?: unknown;
  valorFijo?: unknown;
  fleteAdicional?: unknown;
  facturado?: unknown;
};

/** Campos que se copian del anulado si en la fila nueva estan vacios. */
const CAMPOS_HEREDABLES = [
  "remision", "fechaRadicado", "facturaNumero", "facturaFecha", "facturaVence",
  "tarifaFleteId", "pesoFacturadoKg", "notaFactura", "enviadoFacturarEn",
  "facturaFechaPago", "fechaPagoSaldo", "revisadoContabilidadPorId", "revisadoContabilidadEn",
  "revisadoGerenciaPorId", "revisadoGerenciaEn",
] as const;

/**
 * Que hereda la fila del manifiesto nuevo de la del manifiesto anulado al que
 * reemplaza: solo lo que en la nueva esta vacio (nunca pisa lo que ya tiene).
 *
 * - Los campos de CAMPOS_HEREDABLES (remision, flete, factura, pagos,
 *   revisiones) si en la nueva son null o vacios.
 * - El flete completo (tipo, tarifa y valor fijo) como un bloque, solo si la
 *   nueva no tiene ni tarifa ni valor fijo: asi no se mezclan dos fletes.
 * - Los papeles, si la nueva sigue EN_RUTA y la anulada ya habia avanzado.
 * - "Facturado", si la anulada ya estaba facturada.
 * Lo que sale del manifiesto (placa, conductor, peso, fecha) es el de la nueva.
 */
export function datosAHeredar(anulada: FilaHeredable, nueva: FilaHeredable): Record<string, unknown> {
  const vacio = (v: unknown) => v === null || v === undefined || v === "";
  const cambios: Record<string, unknown> = {};
  for (const campo of CAMPOS_HEREDABLES) {
    if (vacio(nueva[campo]) && !vacio(anulada[campo])) cambios[campo] = anulada[campo];
  }
  if (vacio(nueva.tarifaKilo) && vacio(nueva.valorFijo) && (!vacio(anulada.tarifaKilo) || !vacio(anulada.valorFijo))) {
    cambios.tipoFlete = anulada.tipoFlete;
    if (!vacio(anulada.tarifaKilo)) cambios.tarifaKilo = anulada.tarifaKilo;
    if (!vacio(anulada.valorFijo)) cambios.valorFijo = anulada.valorFijo;
    if (!vacio(anulada.fleteAdicional)) cambios.fleteAdicional = anulada.fleteAdicional;
  }
  if (nueva.estadoPapeles === "EN_RUTA" && !vacio(anulada.estadoPapeles) && anulada.estadoPapeles !== "EN_RUTA") {
    cambios.estadoPapeles = anulada.estadoPapeles;
  }
  if (!Number(nueva.facturado) && Number(anulada.facturado)) cambios.facturado = 1;
  return cambios;
}

/** El flujo largo de papeles (parqueadero, Don Alexander) es solo de este cliente. */
export const CLIENTE_FLUJO_LARGO = /CORAME|CARTONES\s+AMERICA/i;

/**
 * Clientes que dan anticipo en sus viajes: los del Zorro (Ecoambiental,
 * Reciclajes Bogota, Bodegas de Reciclaje), que lo abona a la bomba, y Aburra
 * Limpio. Ademas, todo viaje sin manifiesto lo lleva, salvo los urbanos.
 */
export const CLIENTES_CON_ANTICIPO = /ECOAMBIENTAL|RECICLAJES?\s+BOGOTA|BODEGAS?\s+DE\s+RECICLAJE|ABURRA\s+LIMPIO/i;

/**
 * Clientes del Zorro: son los unicos que abonan el anticipo directamente a la
 * bomba (cuenta con la bomba, ver Anticipos). Los demas (Aburra Limpio, viajes
 * sin manifiesto) nos pagan el anticipo a nosotros y no tocan la bomba.
 */
export const CLIENTES_ZORRO = /ECOAMBIENTAL|RECICLAJES?\s+BOGOTA|BODEGAS?\s+DE\s+RECICLAJE/i;

/** NIT de Cartones America (CORAME), sin digito de verificacion: los viajes que cargan alla. */
export const NIT_CARTONES_AMERICA = "860026759";
/** Peso que Cartones America reconoce como minimo por viaje: completa hasta aqui. */
export const PESO_MINIMO_CORAME = 32_000;
/** Con este numero de clientes o mas en el mismo manifiesto, Cartones America reconoce 2 toneladas. */
export const CLIENTES_RECONOCIDO_CORAME = 4;
/** Lo que reconoce por llevar 4 o mas clientes. */
export const KG_RECONOCIDO_CLIENTES = 2_000;

/**
 * Reconocidos de Cartones America (viajes sin manifiesto que se generan solos):
 * - MAS4: el manifiesto lleva 4 o mas clientes: reconoce 2 toneladas.
 * - COMPLETA32: sus remesas suman menos de 32.000 kg: reconoce lo que falta.
 */
export type TipoReconocido = "MAS4" | "COMPLETA32";
export const CONCEPTO_RECONOCIDO: Record<TipoReconocido, string> = {
  // Son 2 toneladas reconocidas por llevar 4 o mas clientes (antes decia "+4 TONELADAS").
  MAS4: "4 CLIENTES CARTONES AMERICA",
  COMPLETA32: "RECONOCIDO CORAME",
};

/**
 * Que reconoce Cartones America por un viaje despachado desde alla (pueden
 * ser los dos): 2.000 kg si lleva 4 o mas clientes, y lo que le falte para
 * 32.000 kg si sus remesas suman menos. Lo de los 32.000 kg es solo para
 * tractomulas (configuracion articulada: 2S, 3S...); un camion de 16
 * toneladas no se completa. Sin configuracion conocida, se completa.
 */
export function reconocidosCorame(v: { clientes: number; pesoKg: number; configuracion?: string | null }): Array<{ tipo: TipoReconocido; pesoKg: number }> {
  const r: Array<{ tipo: TipoReconocido; pesoKg: number }> = [];
  const tractomula = !v.configuracion || /S/i.test(v.configuracion);
  if (v.clientes >= CLIENTES_RECONOCIDO_CORAME) r.push({ tipo: "MAS4", pesoKg: KG_RECONOCIDO_CLIENTES });
  if (tractomula && v.pesoKg > 0 && v.pesoKg < PESO_MINIMO_CORAME) r.push({ tipo: "COMPLETA32", pesoKg: Math.round(PESO_MINIMO_CORAME - v.pesoKg) });
  return r;
}

/**
 * Tarifa por kilo mas alta que se acepta. Las de la matriz van de unos 13 a
 * 320 $/kg; una de miles es casi seguro la tarifa por tonelada escrita como
 * por kilo (paso con la factura 7387: un viaje de 1.100 millones).
 */
export const TARIFA_KILO_MAXIMA = 1000;

/**
 * Anticipo que da la empresa en un viaje:
 * - NO_APLICA: el cliente no da anticipo (o se marco que no aplica).
 * - FALTA_REGISTRAR: lo da y aun no se ha escrito cuanto.
 * - POR_COBRAR: escrito y la empresa aun no lo paga.
 * - PAGADO: con fecha de pago.
 */
export type EstadoAnticipoEmpresa = "NO_APLICA" | "FALTA_REGISTRAR" | "POR_COBRAR" | "PAGADO";

/**
 * true si el viaje lleva anticipo de la empresa (ver CLIENTES_CON_ANTICIPO).
 * Los urbanos no llevan: los que se facturan con una tarifa URBANO de la
 * matriz ("ABURRA LIMPIO URBANO", "RECICLAJES URBANO TOCANCIPA") y, sin
 * manifiesto, los que dicen URBANO en la empresa o la ruta.
 */
export function requiereAnticipoEmpresa(
  f: Pick<FilaCuadro, "anulado" | "empresa" | "viajeId" | "ruta" | "rutaManual" | "anticipoEmpresaNoAplica" | "tarifaFlete">
): boolean {
  if (f.anulado || f.anticipoEmpresaNoAplica) return false;
  if (/URBANO/i.test(f.tarifaFlete ?? "")) return false;
  if (CLIENTES_CON_ANTICIPO.test(f.empresa)) return true;
  // Sin manifiesto: lo lleva salvo que sea urbano.
  return !f.viajeId && !/URBANO/i.test(`${f.empresa} ${f.rutaManual ?? ""} ${f.ruta ?? ""}`);
}

/** Estado del anticipo de la empresa de un viaje. */
export function estadoAnticipoEmpresa(
  f: Pick<
    FilaCuadro,
    "anulado" | "empresa" | "viajeId" | "ruta" | "rutaManual" | "anticipoEmpresaNoAplica" | "anticipoEmpresa" | "anticipoEmpresaFechaPago" | "tarifaFlete"
  >
): EstadoAnticipoEmpresa {
  if (f.anulado) return "NO_APLICA";
  // Si ya se escribio un valor, cuenta aunque el cliente no este en la lista.
  if (f.anticipoEmpresa !== null && f.anticipoEmpresa > 0) return f.anticipoEmpresaFechaPago ? "PAGADO" : "POR_COBRAR";
  return requiereAnticipoEmpresa(f) ? "FALTA_REGISTRAR" : "NO_APLICA";
}

/**
 * Viaje urbano: su tarifa de la matriz dice URBANO, o dice URBANO en la
 * empresa o la ruta escrita a mano, o sale y llega al mismo municipio. (La
 * tarifa solo se conoce al facturar; por eso se mira tambien la ruta.)
 */
export function esUrbano(f: {
  tarifaFlete: string | null;
  empresa: string;
  rutaManual: string | null;
  rutaOrigen?: string | null;
  rutaDestino?: string | null;
}): boolean {
  if (/URBANO/i.test(`${f.tarifaFlete ?? ""} ${f.empresa} ${f.rutaManual ?? ""}`)) return true;
  return !!f.rutaOrigen && f.rutaOrigen === f.rutaDestino;
}

/** Estado del viaje por sus papeles; ANULADO y PAGADO (todo pagado) reemplazan a los demas. */
export type EstadoCuadro = "ANULADO" | "PAGADO" | "RADICADOS" | "RADICADO" | "SIN_RADICAR" | "EN_RUTA";
/** Estado de la factura, aparte del de los papeles. */
export type EstadoFactura = "SIN_FACTURAR" | "FACTURADO_SIN_DATOS" | "FACTURADO";

export interface FilaCuadro {
  id: number;
  fecha: string;
  vehiculoId: number | null;
  placa: string;
  flota: Flota;
  /** Configuracion del vehiculo (3S3, 2S = tractomula; 2, 3 = camion rigido). Para sugerir la tarifa. */
  configuracion: string | null;
  /** Socio dueno del vehiculo (MAURICIO, CELSO, MILLER, LUISA); null = tercero. Para la cartera. */
  dueno: string | null;
  conductor: string | null;
  /**
   * Ruta para consultar ("SOACHA CUNDINAMARCA → CALI VALLE DEL CAUCA"). Con
   * manifiesto sale del RNDC y no se edita; sin manifiesto es rutaManual.
   */
  ruta: string | null;
  /** Ruta escrita a mano (solo viajes sin manifiesto). */
  rutaManual: string | null;
  /** Reconocido de Cartones America: "4 CLIENTES CARTONES AMERICA" o "RECONOCIDO CORAME". */
  concepto: string | null;
  /** Manifiesto del viaje que origino el reconocido. */
  reconocidoDe: string | null;
  empresa: string;
  viajeId: number | null;
  viajeRemesaId: number | null;
  manifiesto: string | null;
  remesa: string | null;
  remision: string | null;
  pesoKg: number | null;
  tipoFlete: "KILO" | "FIJO";
  tarifaKilo: number | null;
  valorFijo: number | null;
  /**
   * Solo KILO: se suma a kilos x tarifa. Es el adicional por clientes de las
   * tarifas POR (300.000, 2 clientes) y POR3 (600.000, 3 clientes).
   */
  fleteAdicional: number | null;
  /** Anticipo que da la empresa (cliente) en este viaje; aparte de los de la bomba. */
  anticipoEmpresa: number | null;
  /** Fecha en que la empresa pago ese anticipo; sin fecha, lo debe. */
  anticipoEmpresaFechaPago: string | null;
  /** Se marco que el viaje no lleva anticipo de la empresa (un urbano, por ejemplo). */
  anticipoEmpresaNoAplica: boolean;
  /** Estado del anticipo de la empresa (ver estadoAnticipoEmpresa). */
  estadoAnticipoEmpresa: EstadoAnticipoEmpresa;
  /**
   * Viaje urbano (ver esUrbano): se factura a orden del generador de carga,
   * asi que su alerta de facturacion nunca es urgente.
   */
  urbano: boolean;
  /** El anticipo de la empresa se abona a la bomba (clientes del Zorro); si no, nos lo pagan a nosotros. */
  anticipoEmpresaABomba: boolean;
  /** KILO: kilos (los facturados si los hay) x tarifa + adicional. FIJO: el valor fijo. */
  valorFlete: number | null;
  /** Peso que se factura: el real o el minimo pactado con el cliente (34000, 32000...). */
  pesoFacturadoKg: number | null;
  /** Tarifa de la matriz de fletes con que se facturo. */
  tarifaFleteId: number | null;
  /** Nombre de esa tarifa ("ABURRA LIMPIO URBANO"); con URBANO el viaje no lleva anticipo de la empresa. */
  tarifaFlete: string | null;
  /** Producto de la remesa ("CARTON RECICLADO"), para deducir la tarifa. */
  producto: string | null;
  /** El flete se escribio o se eligio a mano: la deduccion no lo toca. */
  fleteManual: boolean;
  /**
   * Sin flete y sin una tarifa exacta: las tarifas de la matriz que podrian
   * ser, para elegir a mano (ver src/tarifasFlete.ts). Vacio si ya tiene flete.
   */
  tarifasPosibles: TarifaPosible[];
  /** Nota de la factura para la contadora (remision, toneladas, valor, placa). */
  notaFactura: string | null;
  /** Cuando se envio en el cuadro de facturacion. */
  enviadoFacturarEn: string | null;
  fechaDescargue: string | null;
  estadoPapeles: EstadoPapeles;
  flujoCorame: boolean;
  fechaRadicado: string | null;
  facturado: boolean;
  facturaNumero: string | null;
  facturaFecha: string | null;
  /** "Fecha pago cliente": cuando vence la factura. Pasada, hay que cobrar. */
  facturaVence: string | null;
  /** "Fecha pago factura": cuando el cliente pago. Con ella el viaje queda todo pagado. */
  facturaFechaPago: string | null;
  /** Terceros: fecha en que se le pago al tercero. */
  fechaPagoSaldo: string | null;
  /**
   * Terceros: viernes en que se le paga (ver viernesDePago en src/terceros.ts)
   * o la fecha escrita a mano. Flota propia y socios: null.
   */
  venceSaldo: string | null;
  /** Valor por tonelada pactado con el tercero en este viaje. */
  valorTerceroTon: number | null;
  /** Valor fijo pactado con el tercero (manda sobre el de por tonelada). */
  valorTerceroFijo: number | null;
  /** Adicional por transferencia: tercer anticipo al tercero, aparte de efectivo y combustible. */
  anticipoTransferencia: number | null;
  anticipoTransferenciaFecha: string | null;
  /** Enlace al comprobante de la transferencia (no se suben archivos). */
  anticipoTransferenciaLink: string | null;
  /** Cuando el tercero entrego los documentos del viaje. */
  fechaEntregaDocsTercero: string | null;
  /** Numero de la cuenta de cobro del tercero ("AR-138"). */
  cuentaCobroTercero: string | null;
  /** Al pagar se descuentan retefuente, ICA, FOPAT y poliza. */
  aplicaDescuentosTercero: boolean;
  /** ICA por mil del viaje; null = el sugerido por el cliente. */
  icaTerceroPorMil: number | null;
  /** Fecha de pago escrita a mano; null = el viernes que toca. */
  fechaPagoTerceroProgramada: string | null;
  revisadoContabilidadPor: string | null;
  revisadoContabilidadEn: string | null;
  revisadoGerenciaPor: string | null;
  revisadoGerenciaEn: string | null;
  anulado: boolean;
  totalAnticipos: number;
  anticiposSinPagar: number;
  notas: number;
  ultimaNota: string | null;
  /** Seguimiento de papeles: quien los tiene (conductor, parqueadero, Don Alexander...). */
  papelesTiene: string | null;
  /** true = estan todos, false = falta algo, null = no se ha preguntado. */
  papelesCompletos: boolean | null;
  papelesFaltan: string | null;
  /** Ultima vez que alguien pregunto por los papeles (llamada al conductor). */
  papelesRevisadoEn: string | null;
  papelesRevisadoPor: string | null;
  estado: EstadoCuadro;
  estadoFactura: EstadoFactura;
  /** El cliente ya le pago la factura a la empresa (fecha de pago a la empresa). Amarillo. */
  todoPagado: boolean;
}

/** Numero de MySQL (DECIMAL llega como texto) a number; null se conserva. */
const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
/**
 * DATE de MySQL como "AAAA-MM-DD". El pool trabaja en UTC (timezone "Z"): un
 * DATE llega como medianoche UTC, asi que se lee en UTC para no correrse un dia.
 */
export const dia = (v: unknown): string | null => {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
};
/** Fecha de hoy en Colombia (el servidor corre en UTC: de noche ya seria manana). */
export const hoyColombia = () => new Date(Date.now() - 5 * 3_600_000).toISOString().slice(0, 10);
/**
 * Suma dias a una fecha "AAAA-MM-DD" y devuelve otra "AAAA-MM-DD".
 * Trabaja a mediodia UTC para que ningun cambio de zona la corra de dia.
 * Se usa para el vencimiento del saldo de terceros (descargue + 15 dias).
 */
export const sumarDias = (fecha: string, dias: number) => {
  const d = new Date(`${fecha}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
};

/**
 * Estado de una fila a partir de sus datos (exportado para las pruebas).
 *
 * - Todo pagado: solo cuando el cliente pago la factura (facturaFechaPago,
 *   "fecha pago factura"). La "fecha pago cliente" (facturaVence) es solo el
 *   vencimiento. El saldo del tercero y
 *   los anticipos de bomba se siguen aparte (columnas y "Saldos vencidos").
 * - Papeles y factura son dos estados aparte: un viaje facturado sigue
 *   diciendo si sus papeles estan radicados o no. `estado` es el de los
 *   papeles (en proceso, sin radicar, listo para facturar, radicados) y
 *   `estadoFactura` el de la factura. Solo "todo pagado" (y anulado)
 *   reemplaza a los dos.
 * - Facturado: cuando la factura tiene numero Y fecha, escritos a mano o con
 *   "Facturar varios". Con solo uno de los dos, o solo marcado, queda como
 *   "facturado sin datos".
 */
export function estadoDe(
  f: Omit<FilaCuadro, "estado" | "estadoFactura" | "todoPagado" | "estadoAnticipoEmpresa" | "anticipoEmpresaABomba" | "urbano">
): { estado: EstadoCuadro; estadoFactura: EstadoFactura; todoPagado: boolean } {
  const todoPagado = !f.anulado && !!f.facturaFechaPago;
  const estadoFactura: EstadoFactura =
    f.facturaNumero && f.facturaFecha
      ? "FACTURADO"
      : f.facturado || f.facturaNumero || f.facturaFecha
        ? "FACTURADO_SIN_DATOS"
        : "SIN_FACTURAR";
  if (f.anulado) return { estado: "ANULADO", estadoFactura, todoPagado: false };
  if (f.facturaFechaPago) return { estado: "PAGADO", estadoFactura, todoPagado };
  if (f.estadoPapeles === "RADICADOS") return { estado: "RADICADOS", estadoFactura, todoPagado };
  if (f.estadoPapeles === "RADICADO") return { estado: "RADICADO", estadoFactura, todoPagado };
  if (f.estadoPapeles !== "EN_RUTA") return { estado: "SIN_RADICAR", estadoFactura, todoPagado };
  return { estado: "EN_RUTA", estadoFactura, todoPagado };
}

/**
 * Nombre de un municipio a partir de su codigo DIVIPOLA (expresion SQL):
 * primero el catalogo de municipios; si no se importo, la ciudad de algun
 * tercero de ese municipio. El RNDC devuelve los de Antioquia sin el cero
 * inicial (5308000), por eso se comparan a 8 digitos.
 */
const nombreMunicipio = (codigo: string) => `COALESCE(
    (SELECT nombre FROM municipios WHERE codigo = ${codigo} LIMIT 1),
    (SELECT MAX(ciudad) FROM terceros WHERE LPAD(codMunicipioRndc, 8, '0') = ${codigo}),
    ${codigo})`;

/**
 * Origen y destino de la remesa segun el manifiesto: los del TMS salen de la
 * plantilla de la remesa; los traidos del portal, de lo que reporto el RNDC.
 */
const CODIGO_ORIGEN = "LPAD(COALESCE(pl.municipioOrigen, vj.origenRndc), 8, '0')";
const CODIGO_DESTINO = "LPAD(COALESCE(pl.municipioDestino, vj.destinoRndc), 8, '0')";

export const SELECT_CUADRO = `
  SELECT c.*, ${sqlFlota()} AS flota, ve.dueno, ve.configuracion, tf.nombre AS tarifaFlete,
         ${nombreMunicipio(CODIGO_ORIGEN)} AS rutaOrigen,
         ${nombreMunicipio(CODIGO_DESTINO)} AS rutaDestino,
         uc.nombre AS revisadoContabilidadPor, ug.nombre AS revisadoGerenciaPor, up.nombre AS papelesRevisadoPor,
         COALESCE(a.total, 0) AS totalAnticipos, COALESCE(a.sinPagar, 0) AS anticiposSinPagar,
         COALESCE(n.cuantas, 0) AS notas,
         (SELECT texto FROM cuadro_notas WHERE cuadroViajeId = c.id ORDER BY id DESC LIMIT 1) AS ultimaNota,
         (SELECT consecutivoManifiesto FROM viajes WHERE id = c.reconocidoDeViajeId) AS reconocidoDe,
         COALESCE(pl.tipoMercancia, vrr.producto) AS producto
    FROM cuadro_viajes c
    LEFT JOIN vehiculos ve ON ve.id = c.vehiculoId
    LEFT JOIN tarifas_flete tf ON tf.id = c.tarifaFleteId
    LEFT JOIN viajes vj ON vj.id = c.viajeId
    LEFT JOIN viaje_remesas vrr ON vrr.id = c.viajeRemesaId
    LEFT JOIN plantillas_viaje pl ON pl.id = vrr.plantillaId
    LEFT JOIN usuarios uc ON uc.id = c.revisadoContabilidadPorId
    LEFT JOIN usuarios ug ON ug.id = c.revisadoGerenciaPorId
    LEFT JOIN usuarios up ON up.id = c.papelesRevisadoPorId
    LEFT JOIN (SELECT cuadroViajeId, SUM(valor) AS total, SUM(fechaPago IS NULL) AS sinPagar
                 FROM cuadro_anticipos GROUP BY cuadroViajeId) a ON a.cuadroViajeId = c.id
    LEFT JOIN (SELECT cuadroViajeId, COUNT(*) AS cuantas FROM cuadro_notas GROUP BY cuadroViajeId) n
           ON n.cuadroViajeId = c.id`;

/**
 * Fila de SELECT_CUADRO -> FilaCuadro.
 *
 * Normaliza tipos (fechas a texto, numeros, booleanos), calcula el valor del
 * flete (kilos x tarifa, o el fijo), el vencimiento del saldo si es tercero, y
 * el estado con estadoDe.
 */
export function mapear(r: RowDataPacket): FilaCuadro {
  const base = {
    id: r.id,
    fecha: dia(r.fecha)!,
    vehiculoId: r.vehiculoId,
    placa: r.placa,
    flota: (r.flota ?? "TERCERO") as Flota,
    configuracion: r.configuracion ?? null,
    dueno: r.dueno ?? null,
    conductor: r.conductor,
    ruta: r.viajeId
      ? r.rutaOrigen || r.rutaDestino
        ? `${r.rutaOrigen ?? "?"} → ${r.rutaDestino ?? "?"}`
        : null
      : r.rutaManual ?? null,
    rutaManual: r.rutaManual ?? null,
    concepto: r.concepto ?? null,
    reconocidoDe: r.reconocidoDe ?? null,
    empresa: r.empresa,
    viajeId: r.viajeId,
    viajeRemesaId: r.viajeRemesaId,
    manifiesto: r.manifiesto,
    remesa: r.remesa,
    remision: r.remision,
    pesoKg: num(r.pesoKg),
    tipoFlete: r.tipoFlete === "FIJO" ? ("FIJO" as const) : ("KILO" as const),
    tarifaKilo: num(r.tarifaKilo),
    valorFijo: num(r.valorFijo),
    fleteAdicional: num(r.fleteAdicional),
    anticipoEmpresa: num(r.anticipoEmpresa),
    anticipoEmpresaFechaPago: dia(r.anticipoEmpresaFechaPago),
    anticipoEmpresaNoAplica: !!r.anticipoEmpresaNoAplica,
    valorFlete:
      r.tipoFlete === "FIJO"
        ? num(r.valorFijo)
        : (r.pesoFacturadoKg ?? r.pesoKg) !== null && r.tarifaKilo !== null
          ? Math.round(Number(r.pesoFacturadoKg ?? r.pesoKg) * Number(r.tarifaKilo)) + (num(r.fleteAdicional) ?? 0)
          : null,
    pesoFacturadoKg: num(r.pesoFacturadoKg),
    tarifaFleteId: r.tarifaFleteId ?? null,
    tarifaFlete: r.tarifaFlete ?? null,
    producto: r.producto ?? null,
    fleteManual: !!r.fleteManual,
    tarifasPosibles: [],
    notaFactura: r.notaFactura ?? null,
    enviadoFacturarEn: r.enviadoFacturarEn ? new Date(r.enviadoFacturarEn).toISOString() : null,
    fechaDescargue: dia(r.fechaDescargue),
    estadoPapeles: r.estadoPapeles as EstadoPapeles,
    flujoCorame: !!r.flujoCorame,
    fechaRadicado: dia(r.fechaRadicado),
    facturado: !!r.facturado,
    facturaNumero: r.facturaNumero,
    facturaFecha: dia(r.facturaFecha),
    facturaVence: dia(r.facturaVence),
    facturaFechaPago: dia(r.facturaFechaPago),
    fechaPagoSaldo: dia(r.fechaPagoSaldo),
    venceSaldo: null as string | null,
    valorTerceroTon: num(r.valorTerceroTon),
    valorTerceroFijo: num(r.valorTerceroFijo),
    anticipoTransferencia: num(r.anticipoTransferencia),
    anticipoTransferenciaFecha: dia(r.anticipoTransferenciaFecha),
    anticipoTransferenciaLink: r.anticipoTransferenciaLink ?? null,
    fechaEntregaDocsTercero: dia(r.fechaEntregaDocsTercero),
    cuentaCobroTercero: r.cuentaCobroTercero ?? null,
    aplicaDescuentosTercero: !!r.aplicaDescuentosTercero,
    icaTerceroPorMil: num(r.icaTerceroPorMil),
    fechaPagoTerceroProgramada: dia(r.fechaPagoTerceroProgramada),
    revisadoContabilidadPor: r.revisadoContabilidadPor ?? null,
    revisadoContabilidadEn: r.revisadoContabilidadEn ? new Date(r.revisadoContabilidadEn).toISOString() : null,
    revisadoGerenciaPor: r.revisadoGerenciaPor ?? null,
    revisadoGerenciaEn: r.revisadoGerenciaEn ? new Date(r.revisadoGerenciaEn).toISOString() : null,
    anulado: !!r.anulado,
    totalAnticipos: Number(r.totalAnticipos ?? 0),
    anticiposSinPagar: Number(r.anticiposSinPagar ?? 0),
    notas: Number(r.notas ?? 0),
    ultimaNota: r.ultimaNota ?? null,
    papelesTiene: r.papelesTiene ?? null,
    papelesCompletos: r.papelesCompletos === null || r.papelesCompletos === undefined ? null : !!r.papelesCompletos,
    papelesFaltan: r.papelesFaltan ?? null,
    papelesRevisadoEn: r.papelesRevisadoEn ? new Date(r.papelesRevisadoEn).toISOString() : null,
    papelesRevisadoPor: r.papelesRevisadoPor ?? null,
  };
  // Terceros (sin socio dueno): el viernes que toca o la fecha escrita a mano.
  // Los reconocidos de Cartones America no se le pagan al tercero.
  if (base.flota === "TERCERO" && !base.dueno && !base.concepto) {
    base.venceSaldo = base.fechaPagoTerceroProgramada ?? (base.fechaDescargue ? viernesDePago(base.fechaDescargue) : null);
  }
  return {
    ...base,
    ...estadoDe(base),
    estadoAnticipoEmpresa: estadoAnticipoEmpresa(base),
    anticipoEmpresaABomba: CLIENTES_ZORRO.test(base.empresa),
    urbano: esUrbano({ ...base, rutaOrigen: r.rutaOrigen ?? null, rutaDestino: r.rutaDestino ?? null }),
  };
}

/** Campos que se pueden editar de una fila, con su tipo. */
const CAMPOS_EDITABLES: Record<string, "texto" | "numero" | "fecha" | "booleano"> = {
  fecha: "fecha",
  placa: "texto",
  conductor: "texto",
  // Solo los viajes sin manifiesto (los demas la toman del RNDC).
  rutaManual: "texto",
  empresa: "texto",
  manifiesto: "texto",
  remision: "texto",
  pesoKg: "numero",
  pesoFacturadoKg: "numero",
  notaFactura: "texto",
  tipoFlete: "texto",
  tarifaKilo: "numero",
  valorFijo: "numero",
  fleteAdicional: "numero",
  anticipoEmpresa: "numero",
  anticipoEmpresaFechaPago: "fecha",
  anticipoEmpresaNoAplica: "booleano",
  fechaDescargue: "fecha",
  estadoPapeles: "texto",
  flujoCorame: "booleano",
  fechaRadicado: "fecha",
  facturado: "booleano",
  facturaNumero: "texto",
  facturaFecha: "fecha",
  facturaVence: "fecha",
  facturaFechaPago: "fecha",
  fechaPagoSaldo: "fecha",
  valorTerceroTon: "numero",
  valorTerceroFijo: "numero",
  anticipoTransferencia: "numero",
  anticipoTransferenciaFecha: "fecha",
  anticipoTransferenciaLink: "texto",
  fechaEntregaDocsTercero: "fecha",
  cuentaCobroTercero: "texto",
  aplicaDescuentosTercero: "booleano",
  icaTerceroPorMil: "numero",
  fechaPagoTerceroProgramada: "fecha",
  // Rentabilidad (ver src/rentabilidad.ts): vacio = el valor de siempre.
  rentComision: "numero",
  rentTLopez: "numero",
  rentDescargue: "numero",
  rentPoliza: "numero",
  rentIcaPorMil: "numero",
  fechaPagoRentabilidad: "fecha",
};

/**
 * Años que se aceptan en las fechas del cuadro y de los anticipos. Un año
 * fuera de aqui es un error al escribir (se encontraron pagos a la bomba con
 * fecha de 1906 y 1909, que descuadraban el reporte).
 */
export const ANIO_MINIMO = 2020;
export const ANIO_MAXIMO = 2100;

/** true si la fecha "AAAA-MM-DD" tiene un año posible (ANIO_MINIMO a ANIO_MAXIMO). */
export const anioPosible = (f: string) => Number(f.slice(0, 4)) >= ANIO_MINIMO && Number(f.slice(0, 4)) <= ANIO_MAXIMO;

/** Error de validacion del cuadro: la ruta lo responde como 422 con su mensaje. */
export class ErrorCuadro extends Error {}

/**
 * Convierte un valor del formulario al tipo de su columna.
 *
 * booleano -> 1/0; vacio -> null; numero -> number >= 0 (si no, ErrorCuadro);
 * fecha -> "AAAA-MM-DD" valida; texto -> recortado.
 */
function valorCampo(campo: string, tipo: string, crudo: unknown): unknown {
  const vacio = crudo === null || crudo === undefined || String(crudo).trim() === "";
  if (tipo === "booleano") return crudo ? 1 : 0;
  if (vacio) return null;
  if (tipo === "numero") {
    const n = Number(crudo);
    if (!Number.isFinite(n) || n < 0) throw new ErrorCuadro(`"${campo}" debe ser un numero positivo.`);
    return n;
  }
  if (tipo === "fecha") {
    const t = String(crudo).slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(t)) throw new ErrorCuadro(`"${campo}" no es una fecha valida.`);
    if (!anioPosible(t)) throw new ErrorCuadro(`"${campo}": el año ${t.slice(0, 4)} no es posible; revisa la fecha.`);
    return t;
  }
  return String(crudo).trim();
}

/**
 * Revisa y normaliza los datos antes de guardar: tipo de flete KILO/FIJO,
 * estado de papeles valido, placa en mayuscula sin guiones ni espacios, y
 * empresa en mayuscula. Lanza ErrorCuadro si algo no es valido.
 */
function validar(datos: Record<string, unknown>) {
  if ("tipoFlete" in datos && !["KILO", "FIJO"].includes(String(datos.tipoFlete))) {
    throw new ErrorCuadro("El flete es por kilo (KILO) o fijo (FIJO).");
  }
  if ("estadoPapeles" in datos && !(ESTADOS_PAPELES as string[]).includes(String(datos.estadoPapeles))) {
    throw new ErrorCuadro("Estado de papeles no valido.");
  }
  if ("tarifaKilo" in datos && Number(datos.tarifaKilo) > TARIFA_KILO_MAXIMA) {
    throw new ErrorCuadro(
      `La tarifa es por KILO: ${Number(datos.tarifaKilo).toLocaleString("es-CO")} $/kg es demasiado (el maximo es ${TARIFA_KILO_MAXIMA.toLocaleString("es-CO")}). ` +
        `Si es la tarifa por tonelada, dividela por 1.000 (por ejemplo 168.000 por tonelada = 168 por kilo).`
    );
  }
  // Booleano real: "false" como texto se guardaria como 1.
  for (const campo of ["anticipoEmpresaNoAplica", "aplicaDescuentosTercero"]) {
    if (campo in datos) datos[campo] = datos[campo] === true || datos[campo] === 1 || datos[campo] === "true";
  }
  if ("icaTerceroPorMil" in datos && Number(datos.icaTerceroPorMil) > 20) {
    throw new ErrorCuadro("El ICA va por mil (3,3 / 4 / 8 / 4,14): no puede pasar de 20.");
  }
  if ("anticipoTransferenciaLink" in datos && datos.anticipoTransferenciaLink) {
    const link = String(datos.anticipoTransferenciaLink).trim();
    if (!/^https?:\/\//i.test(link)) throw new ErrorCuadro("El comprobante debe ser un enlace (https://...).");
    datos.anticipoTransferenciaLink = link.slice(0, 500);
  }
  if ("placa" in datos) datos.placa = String(datos.placa ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if ("empresa" in datos) datos.empresa = String(datos.empresa ?? "").trim().toUpperCase();
}

/**
 * Mantenimiento del cuadro (ver cuadro.mantener): corre aparte de las
 * lecturas. Una sola vuelta a la vez; si se pide otra mientras corre, se
 * repite al terminar.
 */
let mantenimientoEnCurso: Promise<void> | null = null;
let otraVuelta = false;
/** Cuando termino la ultima vuelta (ms); 0 = aun no ha corrido desde que arranco el servidor. */
let ultimoMantenimiento = 0;
/** Vuelta pedida con mantenerPronto, esperando su turno. */
let vueltaPedida: NodeJS.Timeout | null = null;
/** Si la ultima vuelta es mas vieja que esto (el reloj se atraso), listar la corre antes de leer. */
const MANTENIMIENTO_VENCE_MS = 5 * 60_000;
/** Cada cuanto corre el mantenimiento solo (ademas de despues de cada cambio). */
export const MANTENIMIENTO_CADA_MS = 60_000;

/** Tarifa posible de la matriz como va en la fila. */
const aPosible = (t: { id: number; nombre: string; valor: number | null; tipo: TarifaPosible["tipo"] }): TarifaPosible => ({
  id: t.id,
  nombre: t.nombre,
  valor: t.valor,
  tipo: t.tipo,
});

/** Repositorio del cuadro pagos: viajes, notas y anticipos de bomba. */
export const cuadro = {
  /**
   * Trae al cuadro los viajes con manifiesto expedido (una fila por remesa) y
   * marca como anulados los que se anularon. Es idempotente: la llave unica
   * de viajeRemesaId impide repetirlos, y no toca lo que ya se diligencio.
   */
  async sincronizarManifiestos(): Promise<number> {
    const [res] = await pool.query<ResultSetHeader>(
      // El conductor del cuadro es el habitual del vehiculo en la flota (el que
      // de verdad maneja); el del manifiesto queda en conductorManifiesto.
      `INSERT IGNORE INTO cuadro_viajes
         (fecha, vehiculoId, placa, conductor, conductorManifiesto, empresa, viajeId, viajeRemesaId,
          manifiesto, remesa, pesoKg, fechaDescargue, flujoCorame, creadoPorId)
       SELECT DATE(DATE_SUB(v.fechaCreacion, INTERVAL 5 HOUR)), v.vehiculoId, COALESCE(ve.placa, v.placaRndc),
              COALESCE(ch.nombre, c.nombre, v.conductorRndc), COALESCE(c.nombre, v.conductorRndc),
              UPPER(COALESCE(con.nombre, prop.nombre, vr.propietarioNit, 'SIN CLIENTE')), v.id, vr.id,
              v.consecutivoManifiesto, vr.consecutivoRemesa, vr.pesoReal,
              DATE(DATE_SUB(vr.fechaHoraDescargue, INTERVAL 5 HOUR)),
              COALESCE(con.nombre, prop.nombre, '') REGEXP 'CORAME|CARTONES[[:space:]]+AMERICA', v.creadoPorId
         FROM viaje_remesas vr
         JOIN viajes v ON v.id = vr.viajeId
         LEFT JOIN vehiculos ve ON ve.id = v.vehiculoId
         LEFT JOIN conductores c ON c.id = v.conductorId
         LEFT JOIN conductores ch ON ch.cedula = ve.cedulaConductorHabitual
         LEFT JOIN plantillas_viaje p ON p.id = vr.plantillaId
         LEFT JOIN terceros con ON con.id = p.contratanteId
         -- Remesas del portal: el cliente sale del propietario de la carga (por NIT).
         LEFT JOIN (SELECT nit, MIN(nombre) AS nombre FROM terceros GROUP BY nit) prop
                ON p.id IS NULL AND prop.nit = vr.propietarioNit
        WHERE v.estado IN ('CONFIRMADO', 'CUMPLIDO') AND vr.estado <> 'ANULADA'
          AND COALESCE(ve.placa, v.placaRndc) IS NOT NULL`
    );
    await pool.query(
      `UPDATE cuadro_viajes cv JOIN viajes v ON v.id = cv.viajeId
          SET cv.anulado = (v.estado = 'ANULADO')
        WHERE cv.anulado <> (v.estado = 'ANULADO')`
    );
    await this.reemplazarAnulados();
    await this.generarReconocidosCorame();
    return res.affectedRows;
  },

  /**
   * Reconocidos de Cartones America: por cada manifiesto despachado desde alla
   * (alguna remesa con remitente Cartones America) se genera solo un viaje sin
   * manifiesto por cada reconocido que le toque (ver reconocidosCorame):
   * empresa CARTONES AMERICA, la fecha, la placa y el descargue del viaje, el
   * peso reconocido y su concepto, sin anticipo de la empresa. Va con su
   * propia factura y sus propias alertas, como cualquier viaje.
   *
   * Es idempotente (uno por manifiesto y tipo). Si el viaje cambia (peso,
   * clientes) y el reconocido aun no se factura, se actualiza su peso; si ya
   * no le toca o el manifiesto se anulo, queda anulado.
   */
  async generarReconocidosCorame(): Promise<void> {
    const [viajes] = await pool.query<RowDataPacket[]>(
      `SELECT v.id, v.estado IN ('CONFIRMADO', 'CUMPLIDO') AS vigente,
              MIN(c.fecha) AS fecha, MIN(c.vehiculoId) AS vehiculoId, MIN(c.placa) AS placa, MIN(c.conductor) AS conductor,
              COUNT(DISTINCT c.empresa) AS clientes, COALESCE(SUM(c.pesoKg), 0) AS pesoKg, MAX(c.fechaDescargue) AS fechaDescargue,
              MIN(ve.configuracion) AS configuracion
         FROM viajes v
         JOIN cuadro_viajes c ON c.viajeId = v.id AND c.viajeRemesaId IS NOT NULL
         LEFT JOIN vehiculos ve ON ve.id = c.vehiculoId
        WHERE v.id IN (
                SELECT vr.viajeId FROM viaje_remesas vr
                  LEFT JOIN plantillas_viaje p ON p.id = vr.plantillaId
                  LEFT JOIN terceros r ON r.id = p.remitenteId
                 WHERE vr.estado <> 'ANULADA' AND COALESCE(r.nit, vr.remitenteNit) LIKE ?)
        GROUP BY v.id`,
      [`${NIT_CARTONES_AMERICA}%`]
    );
    // Si cambio el nombre de un concepto, los reconocidos ya generados toman el
    // nuevo; tambien su nota de factura, si aun no se facturo.
    for (const [tipo, concepto] of Object.entries(CONCEPTO_RECONOCIDO)) {
      await pool.query(
        `UPDATE cuadro_viajes
            SET notaFactura = IF(facturaNumero IS NULL AND concepto IS NOT NULL, REPLACE(notaFactura, concepto, ?), notaFactura),
                concepto = ?
          WHERE reconocidoTipo = ? AND NOT (concepto <=> ?)`,
        [concepto, concepto, tipo, concepto]
      );
    }
    const [existentes] = await pool.query<RowDataPacket[]>(
      `SELECT id, reconocidoDeViajeId, reconocidoTipo, pesoKg, anulado, facturado, facturaNumero
         FROM cuadro_viajes WHERE reconocidoDeViajeId IS NOT NULL`
    );
    const llave = (viajeId: number, tipo: string) => `${viajeId}|${tipo}`;
    const porLlave = new Map(existentes.map((e) => [llave(e.reconocidoDeViajeId, e.reconocidoTipo), e]));
    const deseados = new Set<string>();
    for (const v of viajes) {
      if (!Number(v.vigente)) continue;
      for (const r of reconocidosCorame({ clientes: Number(v.clientes), pesoKg: Number(v.pesoKg), configuracion: v.configuracion })) {
        const k = llave(v.id, r.tipo);
        deseados.add(k);
        const e = porLlave.get(k);
        if (!e) {
          await pool.query(
            `INSERT IGNORE INTO cuadro_viajes
               (fecha, vehiculoId, placa, conductor, empresa, pesoKg, fechaDescargue, flujoCorame,
                anticipoEmpresaNoAplica, concepto, reconocidoDeViajeId, reconocidoTipo)
             VALUES (?, ?, ?, ?, 'CARTONES AMERICA', ?, ?, 1, 1, ?, ?, ?)`,
            [dia(v.fecha), v.vehiculoId, v.placa, v.conductor, r.pesoKg, dia(v.fechaDescargue), CONCEPTO_RECONOCIDO[r.tipo], v.id, r.tipo]
          );
          continue;
        }
        const sinFacturar = !Number(e.facturado) && !e.facturaNumero;
        if (Number(e.anulado) || (sinFacturar && Number(e.pesoKg) !== r.pesoKg)) {
          await pool.query(
            `UPDATE cuadro_viajes SET anulado = 0, pesoKg = IF(?, ?, pesoKg), fechaDescargue = COALESCE(fechaDescargue, ?) WHERE id = ?`,
            [sinFacturar ? 1 : 0, r.pesoKg, dia(v.fechaDescargue), e.id]
          );
        }
      }
    }
    // Los que ya no tocan (manifiesto anulado, mas peso, menos clientes) quedan anulados.
    for (const e of existentes) {
      if (!deseados.has(llave(e.reconocidoDeViajeId, e.reconocidoTipo)) && !Number(e.anulado)) {
        await pool.query("UPDATE cuadro_viajes SET anulado = 1 WHERE id = ?", [e.id]);
      }
    }
  },

  /**
   * Un manifiesto anulado y vuelto a expedir es el MISMO viaje: en el cuadro
   * debe quedar una sola fila, la del manifiesto nuevo.
   *
   * Como funciona: para cada fila anulada busca la de un manifiesto vigente de
   * la misma placa y empresa expedido despues, dentro de DIAS_REEXPEDICION
   * dias (el mas cercano). Si la hay, en una transaccion le pasa lo que se
   * habia diligenciado (datosAHeredar), le mueve los anticipos y las notas,
   * deja una nota de que reemplaza al anulado y borra la fila anulada. Si no
   * la hay (se anulo y no se volvio a expedir), la fila sigue como anulada.
   */
  async reemplazarAnulados(): Promise<number> {
    const [anuladas] = await pool.query<RowDataPacket[]>(
      `SELECT cv.*, v.fechaCreacion AS creadoViaje, vr.orden AS ordenRemesa
         FROM cuadro_viajes cv
         JOIN viajes v ON v.id = cv.viajeId
         LEFT JOIN viaje_remesas vr ON vr.id = cv.viajeRemesaId
        WHERE cv.anulado = 1`
    );
    let reemplazadas = 0;
    for (const anulada of anuladas) {
      const [candidatas] = await pool.query<RowDataPacket[]>(
        // Con varias remesas de la misma empresa se empareja por el orden de la
        // remesa (la 1 con la 1, la 2 con la 2).
        `SELECT cv.* FROM cuadro_viajes cv
           JOIN viajes v ON v.id = cv.viajeId
           LEFT JOIN viaje_remesas vr ON vr.id = cv.viajeRemesaId
          WHERE cv.anulado = 0 AND cv.placa = ? AND cv.empresa = ?
            AND v.fechaCreacion > ? AND v.fechaCreacion <= DATE_ADD(?, INTERVAL ? DAY)
          ORDER BY (vr.orden <=> ?) DESC, v.fechaCreacion, cv.id
          LIMIT 1`,
        [anulada.placa, anulada.empresa, anulada.creadoViaje, anulada.creadoViaje, DIAS_REEXPEDICION, anulada.ordenRemesa]
      );
      const nueva = candidatas[0];
      if (!nueva) continue;

      const conexion = await pool.getConnection();
      try {
        await conexion.beginTransaction();
        const cambios = datosAHeredar(anulada, nueva);
        const campos = Object.keys(cambios);
        if (campos.length) {
          await conexion.query(
            `UPDATE cuadro_viajes SET ${campos.map((c) => `${c} = ?`).join(", ")} WHERE id = ?`,
            [...campos.map((c) => cambios[c]), nueva.id]
          );
        }
        await conexion.query("UPDATE cuadro_anticipos SET cuadroViajeId = ? WHERE cuadroViajeId = ?", [nueva.id, anulada.id]);
        await conexion.query("UPDATE cuadro_notas SET cuadroViajeId = ? WHERE cuadroViajeId = ?", [nueva.id, anulada.id]);
        await conexion.query("INSERT INTO cuadro_notas (cuadroViajeId, texto) VALUES (?, ?)", [
          nueva.id,
          `Reemplaza al manifiesto anulado ${anulada.manifiesto ?? ""}${anulada.remesa && anulada.remesa !== anulada.manifiesto ? ` (remesa ${anulada.remesa})` : ""}: se trajo lo que se habia registrado alla.`,
        ]);
        await conexion.query("DELETE FROM cuadro_viajes WHERE id = ?", [anulada.id]);
        await conexion.commit();
        reemplazadas++;
      } catch (exc) {
        await conexion.rollback();
        console.warn(`Cuadro: no se pudo reemplazar la fila anulada ${anulada.id}:`, (exc as Error).message);
      } finally {
        conexion.release();
      }
    }
    return reemplazadas;
  },

  /**
   * Mantenimiento del cuadro, aparte de las lecturas: pasa al cuadro los
   * manifiestos nuevos (con los reconocidos de Cartones America), asigna las
   * vueltas de anticipos de ida y vuelta y guarda los fletes exactos de la
   * matriz. Corre cada MANTENIMIENTO_CADA_MS (ver index.ts) y despues de cada
   * cambio (mantenerPronto). Una sola vuelta a la vez.
   */
  async mantener(): Promise<void> {
    if (mantenimientoEnCurso) {
      otraVuelta = true;
      return mantenimientoEnCurso;
    }
    mantenimientoEnCurso = (async () => {
      do {
        otraVuelta = false;
        await cuadro.sincronizarManifiestos();
        // Las vueltas de anticipos de ida y vuelta pasan al proximo viaje de la placa.
        await anticipos.asignarVueltasPendientes();
        const [rows] = await pool.query<RowDataPacket[]>(SELECT_CUADRO);
        await cuadro.deducirFletes(rows.map(mapear));
        ultimoMantenimiento = Date.now();
      } while (otraVuelta);
    })().finally(() => {
      mantenimientoEnCurso = null;
    });
    return mantenimientoEnCurso;
  },

  /**
   * Pide una vuelta de mantenimiento sin esperarla (despues de expedir,
   * editar, importar...). Varias seguidas se juntan en una.
   */
  mantenerPronto(): void {
    if (vueltaPedida) return;
    vueltaPedida = setTimeout(() => {
      vueltaPedida = null;
      cuadro.mantener().catch((exc) => console.warn("Mantenimiento del cuadro fallo:", (exc as Error).message));
    }, 300);
  },

  /**
   * Todos los viajes del cuadro, del mas reciente al mas antiguo. Solo lee: el
   * mantenimiento corre aparte (ver mantener). Si esta corriendo, espera a que
   * termine; si nunca ha corrido o se atraso, lo corre antes. A los que no
   * tienen flete les pone las tarifas posibles de la matriz (de memoria).
   */
  async listar(): Promise<FilaCuadro[]> {
    try {
      if (mantenimientoEnCurso) await mantenimientoEnCurso;
      else if (Date.now() - ultimoMantenimiento > MANTENIMIENTO_VENCE_MS) await cuadro.mantener();
    } catch (exc) {
      // Un mantenimiento fallido no deja la pantalla vacia: se lee lo que hay.
      console.warn("Mantenimiento del cuadro fallo:", (exc as Error).message);
    }
    const [rows] = await pool.query<RowDataPacket[]>(`${SELECT_CUADRO} ORDER BY c.fecha DESC, c.id DESC`);
    const filas = rows.map(mapear);
    await this.agregarTarifasPosibles(filas);
    return filas;
  },

  /**
   * Tarifas posibles de la matriz en las filas sin flete (para elegir). Si la
   * deduccion es exacta y aun no se guardo, va como unica posible.
   */
  async agregarTarifasPosibles(filas: FilaCuadro[]): Promise<void> {
    for (const f of filas) {
      if (f.anulado || f.tarifaKilo !== null || f.valorFijo !== null) continue;
      const d = await deducirConMatriz({
        empresa: f.empresa,
        ruta: f.ruta,
        urbano: f.urbano,
        configuracion: f.configuracion,
        producto: f.producto,
      });
      f.tarifasPosibles = d.exacta ? [aPosible(d.exacta)] : d.posibles;
    }
  },

  /**
   * Deduce el flete de la matriz (ver src/tarifasFlete.ts) de los viajes sin
   * flete, sin tarifa, no anulados, no enviados a facturar y no puestos a
   * mano. Solo se guarda el exacto; los demas quedan para elegir (ver
   * agregarTarifasPosibles). Devuelve cuantos se guardaron.
   */
  async deducirFletes(filas: FilaCuadro[]): Promise<number> {
    const pendientes = filas.filter(
      (f) => !f.anulado && f.tarifaKilo === null && f.valorFijo === null && f.tarifaFleteId === null && !f.fleteManual && !f.enviadoFacturarEn
    );
    let guardados = 0;
    for (const f of pendientes) {
      const d = await deducirConMatriz({
        empresa: f.empresa,
        ruta: f.ruta,
        urbano: f.urbano,
        configuracion: f.configuracion,
        producto: f.producto,
      });
      if (!d.exacta) continue;
      const v = fleteDeTarifa(d.exacta, f.pesoKg);
      const [res] = await pool.query<ResultSetHeader>(
        `UPDATE cuadro_viajes SET tarifaFleteId = ?, tipoFlete = ?, tarifaKilo = ?, valorFijo = ?, fleteAdicional = ?, pesoFacturadoKg = ?
          WHERE id = ? AND tarifaFleteId IS NULL AND tarifaKilo IS NULL AND valorFijo IS NULL AND fleteManual = 0 AND anulado = 0`,
        [v.tarifaFleteId, v.tipoFlete, v.tarifaKilo, v.valorFijo, v.fleteAdicional, v.pesoFacturadoKg, f.id]
      );
      guardados += res.affectedRows;
    }
    return guardados;
  },

  /**
   * Pone en un viaje el flete de una tarifa de la matriz elegida a mano (una
   * de las posibles, o cualquiera). Queda como manual: la deduccion ya no lo
   * cambia.
   */
  async aplicarTarifa(id: number, tarifaId: number): Promise<void> {
    const tarifa = (await cargarTarifas()).find((t) => t.id === tarifaId);
    if (!tarifa) throw new ErrorCuadro("Esa tarifa ya no esta en la matriz de fletes.");
    if (tarifa.valor === null) throw new ErrorCuadro(`La tarifa ${tarifa.nombre} no tiene valor en la matriz: escribe el flete a mano.`);
    const [[fila]] = await pool.query<RowDataPacket[]>("SELECT pesoKg FROM cuadro_viajes WHERE id = ? AND anulado = 0", [id]);
    if (!fila) throw new ErrorCuadro("El viaje no existe o esta anulado.");
    const v = fleteDeTarifa(tarifa, fila.pesoKg === null ? null : Number(fila.pesoKg));
    await pool.query(
      `UPDATE cuadro_viajes SET tarifaFleteId = ?, tipoFlete = ?, tarifaKilo = ?, valorFijo = ?, fleteAdicional = ?, pesoFacturadoKg = ?,
              fleteManual = 1 WHERE id = ?`,
      [v.tarifaFleteId, v.tipoFlete, v.tarifaKilo, v.valorFijo, v.fleteAdicional, v.pesoFacturadoKg, id]
    );
  },

  /**
   * Un viaje con sus anticipos (cada tramo con efectivo, combustible y bomba;
   * ver src/anticipos.ts) y sus notas (con autor), la mas reciente primero.
   * null si no existe.
   */
  async obtener(id: number) {
    const [rows] = await pool.query<RowDataPacket[]>(`${SELECT_CUADRO} WHERE c.id = ?`, [id]);
    if (!rows[0]) return null;
    const [notas] = await pool.query<RowDataPacket[]>(
      `SELECT n.id, n.texto, n.creadaEn, u.nombre AS autor
         FROM cuadro_notas n LEFT JOIN usuarios u ON u.id = n.usuarioId
        WHERE n.cuadroViajeId = ? ORDER BY n.id DESC`,
      [id]
    );
    const fila = mapear(rows[0]);
    // Sin flete: las tarifas de la matriz que podrian ser (para elegir en la ventana del viaje).
    await this.agregarTarifasPosibles([fila]);
    return {
      ...fila,
      anticipos: await anticipos.delViaje(id),
      listaNotas: notas.map((n) => ({ ...n, creadaEn: new Date(n.creadaEn).toISOString() })),
    };
  },

  /** Viaje sin manifiesto (urbano o planillado por el generador de carga). */
  async crear(datos: Record<string, unknown>, usuarioId: number | null): Promise<number> {
    validar(datos);
    if (!datos.placa) throw new ErrorCuadro("La placa es obligatoria.");
    if (!datos.empresa) throw new ErrorCuadro("La empresa es obligatoria.");
    if (!datos.fecha) throw new ErrorCuadro("La fecha es obligatoria.");
    const [ve] = await pool.query<RowDataPacket[]>(
      `SELECT ve.id, ch.nombre AS conductorHabitual FROM vehiculos ve
         LEFT JOIN conductores ch ON ch.cedula = ve.cedulaConductorHabitual
        WHERE ve.placa = ?`,
      [datos.placa]
    );
    // Sin conductor escrito: el habitual del vehiculo en la flota.
    if (!String(datos.conductor ?? "").trim() && ve[0]?.conductorHabitual) datos.conductor = ve[0].conductorHabitual;
    const columnas: string[] = ["vehiculoId", "creadoPorId"];
    const valores: unknown[] = [ve[0]?.id ?? null, usuarioId];
    if (!("flujoCorame" in datos)) datos.flujoCorame = CLIENTE_FLUJO_LARGO.test(String(datos.empresa));
    for (const [campo, tipo] of Object.entries(CAMPOS_EDITABLES)) {
      if (!(campo in datos)) continue;
      columnas.push(campo);
      valores.push(valorCampo(campo, tipo, datos[campo]));
    }
    const [res] = await pool.query<ResultSetHeader>(
      `INSERT INTO cuadro_viajes (${columnas.join(", ")}) VALUES (${columnas.map(() => "?").join(", ")})`,
      valores
    );
    return res.insertId;
  },

  /**
   * Guarda solo los campos que vienen en 'datos' (validados).
   *
   * Ademas: al pasar los papeles a RADICADO o RADICADOS sin fecha, se pone la de hoy en
   * Colombia; al devolverlos a otro estado, se borra. Si cambia la placa, se
   * vuelve a enlazar el vehiculo del catalogo.
   */
  async actualizar(id: number, datos: Record<string, unknown>): Promise<boolean> {
    validar(datos);
    const sets: string[] = [];
    const valores: unknown[] = [];
    for (const [campo, tipo] of Object.entries(CAMPOS_EDITABLES)) {
      if (!(campo in datos)) continue;
      sets.push(`${campo} = ?`);
      valores.push(valorCampo(campo, tipo, datos[campo]));
    }
    // Radicado sin fecha: hoy. Volver atras borra la fecha.
    if (papelesListos(String(datos.estadoPapeles)) && !("fechaRadicado" in datos)) {
      sets.push("fechaRadicado = COALESCE(fechaRadicado, ?)");
      valores.push(hoyColombia());
    } else if ("estadoPapeles" in datos && !papelesListos(String(datos.estadoPapeles))) {
      sets.push("fechaRadicado = NULL");
    }
    if ("placa" in datos) {
      sets.push("vehiculoId = (SELECT id FROM vehiculos WHERE placa = ?)");
      valores.push(datos.placa);
    }
    // Flete escrito a mano: queda manual (la deduccion no lo toca) y sin la tarifa de la matriz.
    if (["tipoFlete", "tarifaKilo", "valorFijo", "fleteAdicional"].some((c) => c in datos)) {
      sets.push("fleteManual = 1", "tarifaFleteId = NULL");
    }
    if (sets.length === 0) return false;
    const [res] = await pool.query<ResultSetHeader>(`UPDATE cuadro_viajes SET ${sets.join(", ")} WHERE id = ?`, [
      ...valores,
      id,
    ]);
    return res.affectedRows > 0;
  },

  /** Solo los viajes creados a mano (sin manifiesto) se pueden borrar. */
  async borrar(id: number): Promise<boolean> {
    // Un reconocido de Cartones America se volveria a generar solo: no se borra.
    const [rec] = await pool.query<RowDataPacket[]>("SELECT 1 FROM cuadro_viajes WHERE id = ? AND reconocidoDeViajeId IS NOT NULL", [id]);
    if (rec[0]) throw new ErrorCuadro("Es un reconocido de Cartones America: se genera solo con su manifiesto y no se puede borrar.");
    const [res] = await pool.query<ResultSetHeader>("DELETE FROM cuadro_viajes WHERE id = ? AND viajeId IS NULL", [id]);
    return res.affectedRows > 0;
  },

  /** Revisado por contabilidad o por la gerente (o se quita la marca). */
  async revisar(id: number, quien: "CONTABILIDAD" | "GERENCIA", usuarioId: number | null, revisado: boolean) {
    const col = quien === "CONTABILIDAD" ? "revisadoContabilidad" : "revisadoGerencia";
    await pool.query(`UPDATE cuadro_viajes SET ${col}PorId = ?, ${col}En = ? WHERE id = ?`, [
      revisado ? usuarioId : null,
      revisado ? new Date() : null,
      id,
    ]);
  },

  /** Una factura que cubre varios viajes (los urbanos se facturan juntos). */
  async facturar(
    ids: number[],
    datos: { facturaNumero?: string | null; facturaFecha?: string | null; facturaVence?: string | null }
  ) {
    if (ids.length === 0) throw new ErrorCuadro("Selecciona al menos un viaje.");
    const numero = valorCampo("facturaNumero", "texto", datos.facturaNumero);
    const fecha = valorCampo("facturaFecha", "fecha", datos.facturaFecha);
    const vence = valorCampo("facturaVence", "fecha", datos.facturaVence);
    const [res] = await pool.query<ResultSetHeader>(
      `UPDATE cuadro_viajes SET facturado = 1,
              facturaNumero = COALESCE(?, facturaNumero), facturaFecha = COALESCE(?, facturaFecha),
              facturaVence = COALESCE(?, facturaVence)
        WHERE id IN (?)`,
      [numero, fecha, vence, ids]
    );
    return res.affectedRows;
  },

  /** Agrega una nota (maximo 1000 caracteres) con su autor. Una nota vacia es un error. */
  async agregarNota(id: number, texto: string, usuarioId: number | null) {
    const limpio = texto.trim();
    if (!limpio) throw new ErrorCuadro("La nota esta vacia.");
    await pool.query("INSERT INTO cuadro_notas (cuadroViajeId, texto, usuarioId) VALUES (?, ?, ?)", [
      id,
      limpio.slice(0, 1000),
      usuarioId,
    ]);
  },

  /** Borra una nota de ese viaje. */
  async borrarNota(id: number, notaId: number) {
    await pool.query("DELETE FROM cuadro_notas WHERE id = ? AND cuadroViajeId = ?", [notaId, id]);
  },

  /**
   * Registra un anticipo en el viaje: efectivo y combustible, bomba, fecha y,
   * si es de ida y vuelta, el anticipo de vuelta (queda para el proximo viaje
   * de la placa). Ver anticipos.registrar.
   */
  async agregarAnticipo(id: number, d: Record<string, unknown>, usuarioId: number | null) {
    await anticipos.registrar(id, d, usuarioId);
  },

  /** Solo la fecha de pago a la bomba y la nota se editan; lo demas se borra y se vuelve a crear. */
  async actualizarAnticipo(id: number, anticipoId: number, d: Record<string, unknown>) {
    const sets: string[] = [];
    const valores: unknown[] = [];
    if ("fechaPago" in d) {
      sets.push("fechaPago = ?");
      valores.push(valorCampo("fechaPago", "fecha", d.fechaPago));
    }
    if ("nota" in d) {
      sets.push("nota = ?");
      valores.push(valorCampo("nota", "texto", d.nota));
    }
    if (sets.length === 0) return;
    await pool.query(`UPDATE cuadro_anticipos SET ${sets.join(", ")} WHERE id = ? AND cuadroViajeId = ?`, [
      ...valores,
      anticipoId,
      id,
    ]);
  },

  /** Quita un anticipo de ese viaje (y la vuelta pendiente si era la ida; ver anticipos.borrarTramo). */
  async borrarAnticipo(id: number, anticipoId: number) {
    const [rows] = await pool.query<RowDataPacket[]>("SELECT 1 FROM cuadro_anticipos WHERE id = ? AND cuadroViajeId = ?", [
      anticipoId,
      id,
    ]);
    if (rows[0]) await anticipos.borrarTramo(anticipoId);
  },
};

/** Catalogo de bombas aliadas que entregan anticipos a los conductores. */
export const bombas = {
  /** Todas las bombas, las activas primero. */
  async listar() {
    const [rows] = await pool.query<RowDataPacket[]>("SELECT * FROM bombas ORDER BY activa DESC, nombre, ciudad");
    return rows.map((b) => ({ ...b, activa: !!b.activa }));
  },
  /** Crea una bomba (nombre y ciudad en mayuscula). Nombre + ciudad no se repiten. */
  async crear(d: Record<string, unknown>) {
    const nombre = String(d.nombre ?? "").trim().toUpperCase();
    if (!nombre) throw new ErrorCuadro("Escribe el nombre de la bomba.");
    const ciudad = String(d.ciudad ?? "").trim().toUpperCase() || null;
    try {
      const [res] = await pool.query<ResultSetHeader>("INSERT INTO bombas (nombre, ciudad) VALUES (?, ?)", [nombre, ciudad]);
      return res.insertId;
    } catch (exc: any) {
      if (exc?.code === "ER_DUP_ENTRY") throw new ErrorCuadro("Ya existe una bomba con ese nombre en esa ciudad.");
      throw exc;
    }
  },
  /**
   * Cambia nombre, ciudad y/o si esta activa. Una bomba inactiva ya no se
   * ofrece al registrar anticipos, pero sus anticipos viejos se conservan.
   */
  async actualizar(id: number, d: Record<string, unknown>) {
    const sets: string[] = [];
    const valores: unknown[] = [];
    if ("nombre" in d) {
      sets.push("nombre = ?");
      valores.push(String(d.nombre ?? "").trim().toUpperCase());
    }
    if ("ciudad" in d) {
      sets.push("ciudad = ?");
      valores.push(String(d.ciudad ?? "").trim().toUpperCase() || null);
    }
    if ("activa" in d) {
      sets.push("activa = ?");
      valores.push(d.activa ? 1 : 0);
    }
    if (sets.length) await pool.query(`UPDATE bombas SET ${sets.join(", ")} WHERE id = ?`, [...valores, id]);
  },
};
