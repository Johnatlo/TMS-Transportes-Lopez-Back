/**
 * Pago a terceros: lo que se le paga al dueno de un vehiculo tercero por cada
 * viaje. Reemplaza la "Matriz Terceros" de Excel (una hoja por tercero).
 *
 * Por viaje se pacta el valor con el tercero (por tonelada o fijo). De ahi se
 * descuentan los anticipos: el efectivo y el combustible de la bomba (los de
 * cuadro_anticipos) y el adicional por transferencia. Las retenciones
 * (retefuente 1 %, ICA, FOPAT 0,1 % y la poliza de 3.000) se muestran siempre;
 * solo se descuentan si se marca el viaje (aplicaDescuentosTercero), porque en
 * la matriz casi nunca se restan.
 *
 * Se le paga el viernes: si descargo lunes o martes, el de esa semana; de
 * miercoles en adelante, el de la semana siguiente. La fecha se puede cambiar
 * a mano (fechaPagoTerceroProgramada). Ya pagado, la fecha real es
 * fechaPagoSaldo.
 */
import type { ResultSetHeader, RowDataPacket } from "mysql2";
import { pool } from "./db";
import { cuadro, ErrorCuadro, hoyColombia, sumarDias } from "./cuadro";
import type { FilaCuadro } from "./cuadro";

/** Retencion en la fuente sobre el valor del viaje del tercero. */
export const RETEFUENTE_TERCERO = 0.01;
/** FOPAT (fondo de prevencion de accidentalidad) sobre el valor del viaje. */
export const FOPAT_TERCERO = 0.001;
/** Poliza por viaje. */
export const POLIZA_TERCERO = 3000;

/**
 * ICA por mil sugerido segun el cliente, como en la matriz (que lo muestra
 * con "%": 3,30 % es 3,3 por mil). Se puede cambiar en cada viaje.
 */
const ICA_POR_CLIENTE: Array<[RegExp, number]> = [
  [/CORAME|CARTONES\s+AMERICA/i, 3.3],
  [/BODEGAS?\s+DE\s+RECICLAJE|RECICLAJES?\s+BOGOTA/i, 4],
  [/CENCORE|COOP/i, 8],
  [/EMPAQUES/i, 4.14],
];

/** ICA por mil que se sugiere para un cliente (0 si no esta en la lista: RECOLAM, APROREC...). */
export function icaSugerido(empresa: string): number {
  return ICA_POR_CLIENTE.find(([re]) => re.test(empresa))?.[1] ?? 0;
}

/**
 * Viernes en que se le paga a un tercero ("AAAA-MM-DD"): lunes o martes ->
 * el viernes de esa semana; miercoles a domingo -> el de la semana siguiente.
 */
export function viernesDePago(fechaDescargue: string): string {
  const diaSemana = new Date(`${fechaDescargue}T12:00:00Z`).getUTCDay(); // 0 domingo ... 6 sabado
  const hasta: Record<number, number> = { 1: 4, 2: 3, 3: 9, 4: 8, 5: 7, 6: 6, 0: 5 };
  return sumarDias(fechaDescargue, hasta[diaSemana]);
}

/**
 * Donde va el pago de un viaje:
 * - FALTA_PACTAR: no se ha escrito cuanto se le paga al tercero.
 * - FALTAN_DOCUMENTOS: el tercero no ha entregado los documentos (cumplido).
 * - POR_PAGAR: listo, su viernes aun no llega.
 * - VENCIDO: su viernes ya paso (o es hoy) y no se ha pagado.
 * - PAGADO: con fecha de pago.
 */
export type EstadoPagoTercero = "FALTA_PACTAR" | "FALTAN_DOCUMENTOS" | "POR_PAGAR" | "VENCIDO" | "PAGADO";

/** Anticipos de la bomba de un viaje, separados como en la matriz. */
export interface AnticiposBomba {
  efectivo: number;
  combustible: number;
}

/** Liquidacion del pago de un viaje al tercero (todos los valores en pesos). */
export interface LiquidacionTercero {
  /** Peso x valor por tonelada, o el valor fijo pactado. null si no se ha pactado. */
  valorTercero: number | null;
  efectivo: number;
  combustible: number;
  transferencia: number;
  retefuente: number;
  ica: number;
  /** ICA por mil usado (el del viaje o el sugerido por el cliente). */
  icaPorMil: number;
  fopat: number;
  poliza: number;
  /** Suma de las retenciones; se restan solo si aplicaDescuentosTercero. */
  totalDescuentos: number;
  /** Valor del tercero - anticipos (- retenciones si aplican). */
  valorAPagar: number | null;
}

/** Calcula lo que se le paga al tercero por un viaje (exportado para las pruebas). */
export function liquidar(
  f: Pick<FilaCuadro, "empresa" | "pesoKg" | "valorTerceroTon" | "valorTerceroFijo" | "anticipoTransferencia" | "aplicaDescuentosTercero" | "icaTerceroPorMil">,
  bomba: AnticiposBomba
): LiquidacionTercero {
  const valorTercero =
    f.valorTerceroFijo !== null
      ? Math.round(f.valorTerceroFijo)
      : f.valorTerceroTon !== null && f.pesoKg !== null
        ? Math.round((f.pesoKg / 1000) * f.valorTerceroTon)
        : null;
  const base = valorTercero ?? 0;
  const icaPorMil = f.icaTerceroPorMil ?? icaSugerido(f.empresa);
  const retefuente = Math.round(base * RETEFUENTE_TERCERO);
  const ica = Math.round((base * icaPorMil) / 1000);
  const fopat = Math.round(base * FOPAT_TERCERO);
  const poliza = valorTercero === null ? 0 : POLIZA_TERCERO;
  const totalDescuentos = retefuente + ica + fopat + poliza;
  const transferencia = f.anticipoTransferencia ?? 0;
  return {
    valorTercero,
    efectivo: bomba.efectivo,
    combustible: bomba.combustible,
    transferencia,
    retefuente,
    ica,
    icaPorMil,
    fopat,
    poliza,
    totalDescuentos,
    valorAPagar:
      valorTercero === null
        ? null
        : valorTercero - bomba.efectivo - bomba.combustible - transferencia - (f.aplicaDescuentosTercero ? totalDescuentos : 0),
  };
}

/** Estado del pago de un viaje al tercero (ver EstadoPagoTercero). */
export function estadoPagoTercero(
  f: Pick<FilaCuadro, "fechaPagoSaldo" | "fechaEntregaDocsTercero" | "venceSaldo">,
  l: Pick<LiquidacionTercero, "valorTercero">,
  hoy: string
): EstadoPagoTercero {
  if (f.fechaPagoSaldo) return "PAGADO";
  if (l.valorTercero === null) return "FALTA_PACTAR";
  if (!f.fechaEntregaDocsTercero) return "FALTAN_DOCUMENTOS";
  return f.venceSaldo && f.venceSaldo <= hoy ? "VENCIDO" : "POR_PAGAR";
}

/** Viaje de un tercero con su liquidacion. */
export type ViajeTercero = FilaCuadro &
  LiquidacionTercero & {
    /** Tenedor del vehiculo (terceros, conductores o propietario); si no se conoce, "CC ..." o la placa. */
    tercero: string;
    estadoPagoTercero: EstadoPagoTercero;
    /** ICA por mil que se sugiere por el cliente (para el formulario). */
    icaSugerido: number;
  };

/** Totales de un tercero para pagarle. */
export interface ResumenTercero {
  tercero: string;
  placas: string[];
  viajes: number;
  /** Lo que se le debe de los viajes listos (por pagar y vencidos). */
  porPagar: number;
  vencido: number;
  faltanDocumentos: number;
  faltaPactar: number;
}

/** Agrupa los viajes por tercero (exportado para las pruebas). Los que mas se deben primero. */
export function resumirTerceros(viajes: ViajeTercero[]): ResumenTercero[] {
  const grupos = new Map<string, ResumenTercero>();
  for (const v of viajes) {
    let g = grupos.get(v.tercero);
    if (!g) {
      g = { tercero: v.tercero, placas: [], viajes: 0, porPagar: 0, vencido: 0, faltanDocumentos: 0, faltaPactar: 0 };
      grupos.set(v.tercero, g);
    }
    if (!g.placas.includes(v.placa)) g.placas.push(v.placa);
    g.viajes++;
    if (v.estadoPagoTercero === "POR_PAGAR" || v.estadoPagoTercero === "VENCIDO") g.porPagar += v.valorAPagar ?? 0;
    if (v.estadoPagoTercero === "VENCIDO") g.vencido += v.valorAPagar ?? 0;
    if (v.estadoPagoTercero === "FALTAN_DOCUMENTOS") g.faltanDocumentos++;
    if (v.estadoPagoTercero === "FALTA_PACTAR") g.faltaPactar++;
  }
  return [...grupos.values()].sort((a, b) => b.porPagar - a.porPagar || a.tercero.localeCompare(b.tercero));
}

/** Repositorio del pago a terceros. */
export const terceros = {
  /**
   * Viajes de vehiculos terceros (flota TERCERO y sin socio dueno), no
   * anulados, con su liquidacion, y el resumen por tercero.
   */
  async listar(): Promise<{ viajes: ViajeTercero[]; terceros: ResumenTercero[] }> {
    const [filas, [bomba], [duenos]] = await Promise.all([
      cuadro.listar(),
      pool.query<RowDataPacket[]>(
        `SELECT cuadroViajeId,
                SUM(COALESCE(efectivo, 0)) AS efectivo,
                -- Anticipos viejos sin separar: lo que no es efectivo es combustible.
                SUM(COALESCE(combustible, valor - COALESCE(efectivo, 0))) AS combustible
           FROM cuadro_anticipos GROUP BY cuadroViajeId`
      ),
      pool.query<RowDataPacket[]>(
        // El tenedor casi nunca esta en terceros; si maneja su carro, esta en conductores.
        `SELECT v.id, COALESCE(
                  (SELECT MIN(nombre) FROM terceros WHERE nit = v.numIdTenedor),
                  (SELECT MIN(nombre) FROM conductores WHERE cedula = v.numIdTenedor),
                  (SELECT MIN(nombre) FROM terceros WHERE nit = v.propietarioNit),
                  CONCAT('CC ', v.numIdTenedor)) AS nombre
           FROM vehiculos v`
      ),
    ]);
    const porViaje = new Map(bomba.map((b) => [Number(b.cuadroViajeId), { efectivo: Number(b.efectivo), combustible: Number(b.combustible) }]));
    const nombres = new Map(duenos.map((d) => [Number(d.id), d.nombre ? String(d.nombre).trim() : null]));
    const hoy = hoyColombia();
    const viajes = filas
      .filter((f) => !f.anulado && f.flota === "TERCERO" && !f.dueno)
      .map((f) => {
        const l = liquidar(f, porViaje.get(f.id) ?? { efectivo: 0, combustible: 0 });
        return {
          ...f,
          ...l,
          tercero: (f.vehiculoId ? nombres.get(f.vehiculoId) : null) ?? f.placa,
          estadoPagoTercero: estadoPagoTercero(f, l, hoy),
          icaSugerido: icaSugerido(f.empresa),
        };
      });
    return { viajes, terceros: resumirTerceros(viajes) };
  },

  /**
   * Registra el pago al tercero de varios viajes ({ ids, fecha, cuentaCobro? }):
   * pone la fecha de pago (y el numero de la cuenta de cobro, si se escribe y
   * el viaje no lo tiene) en los que aun no estaban pagados.
   */
  async pagar(d: Record<string, unknown>): Promise<number> {
    const ids = (Array.isArray(d.ids) ? d.ids : []).map(Number).filter((x) => x > 0);
    const fecha = String(d.fecha ?? "").slice(0, 10);
    const cuenta = String(d.cuentaCobro ?? "").trim().slice(0, 40) || null;
    if (ids.length === 0) throw new ErrorCuadro("Elige al menos un viaje.");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) throw new ErrorCuadro("Escribe la fecha en que se le pago al tercero.");
    const [res] = await pool.query<ResultSetHeader>(
      `UPDATE cuadro_viajes
          SET fechaPagoSaldo = ?, cuentaCobroTercero = COALESCE(NULLIF(cuentaCobroTercero, ''), ?)
        WHERE id IN (?) AND fechaPagoSaldo IS NULL AND anulado = 0`,
      [fecha, cuenta, ids]
    );
    return res.affectedRows;
  },
};
