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
/** Poliza RCE: una por manifiesto (un viaje con varios clientes la paga una vez). */
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
  // De la liquidacion de ejemplo (docs/Liq Viaje Pago ejemplo.xlsx).
  [/ECOAMBIENTAL/i, 4],
  [/CARTON\s+CAJAS/i, 4.14],
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

/**
 * Calcula lo que se le paga al tercero por un viaje (exportado para las
 * pruebas). cobraPoliza: false en las demas filas de un manifiesto con varios
 * clientes (la poliza va solo en una, ver filasConPoliza).
 */
export function liquidar(
  f: Pick<FilaCuadro, "empresa" | "pesoKg" | "valorTerceroTon" | "valorTerceroFijo" | "anticipoTransferencia" | "aplicaDescuentosTercero" | "icaTerceroPorMil">,
  bomba: AnticiposBomba,
  cobraPoliza = true
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
  const poliza = valorTercero === null || !cobraPoliza ? 0 : POLIZA_TERCERO;
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

/** true si la fila ya tiene pactado lo que se le paga al tercero. */
const pactado = (f: Pick<FilaCuadro, "pesoKg" | "valorTerceroTon" | "valorTerceroFijo">) =>
  f.valorTerceroFijo !== null || (f.valorTerceroTon !== null && f.pesoKg !== null);

/**
 * Filas (ids) que llevan la poliza RCE: una por manifiesto, la primera ya
 * pactada (la de menor id); las filas sin manifiesto la llevan cada una.
 */
export function filasConPoliza(
  filas: Array<Pick<FilaCuadro, "id" | "manifiesto" | "pesoKg" | "valorTerceroTon" | "valorTerceroFijo">>
): Set<number> {
  const ids = new Set<number>();
  const vistos = new Set<string>();
  for (const f of [...filas].sort((a, b) => a.id - b.id)) {
    if (!f.manifiesto) {
      ids.add(f.id);
      continue;
    }
    if (vistos.has(f.manifiesto) || !pactado(f)) continue;
    vistos.add(f.manifiesto);
    ids.add(f.id);
  }
  return ids;
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
    /** Titular del vehiculo (Flota, terceros, conductores o propietario); si no se conoce, "CC ..." o la placa. */
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

/** Un tercero leido de la Matriz Terceros: nombre, cedula (si la trae) y placas. */
export interface NombreTercero {
  nombre: string;
  cedula: string | null;
  placas: string[];
}

/** A que vehiculos de Flota se le pondria el nombre de un tercero de la matriz. */
export interface NombreTerceroPropuesto extends NombreTercero {
  vehiculos: Array<{ id: number; placa: string; nombreActual: string | null; por: "PLACA" | "CEDULA" }>;
}

/** Normaliza la lista que llega del navegador (nombres recortados, placas sin guion). */
function leerNombres(lista: unknown): NombreTercero[] {
  if (!Array.isArray(lista)) throw new ErrorCuadro("Falta la lista de terceros.");
  return lista
    .map((t) => ({
      nombre: String(t?.nombre ?? "").replace(/\s+/g, " ").trim().slice(0, 150),
      cedula: String(t?.cedula ?? "").replace(/\D/g, "") || null,
      placas: (Array.isArray(t?.placas) ? t.placas : []).map((p: unknown) => String(p).toUpperCase().replace(/[^A-Z0-9]/g, "")).filter(Boolean),
    }))
    .filter((t) => t.nombre);
}

/** Repositorio del pago a terceros. */
export const terceros = {
  /**
   * Viajes de vehiculos terceros (flota TERCERO y sin socio dueno), sin los
   * reconocidos de Cartones America (no se le pagan al tercero), no
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
        // Primero el nombre del titular de Flota (se llena desde la Matriz
        // Terceros); el tenedor casi nunca esta en terceros, y si maneja su
        // carro esta en conductores.
        `SELECT v.id, COALESCE(
                  NULLIF(TRIM(v.nombreTenedor), ''),
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
    // Sin los reconocidos de Cartones America: al tercero no se le pagan.
    const deTerceros = filas.filter((f) => !f.anulado && f.flota === "TERCERO" && !f.dueno && !f.concepto);
    const conPoliza = filasConPoliza(deTerceros);
    // Manifiestos que ya tienen su poliza en una fila pactada.
    const manifiestosConPoliza = new Set(deTerceros.filter((f) => conPoliza.has(f.id) && f.manifiesto).map((f) => f.manifiesto));
    const viajes = deTerceros
      .map((f) => {
        const l = liquidar(f, porViaje.get(f.id) ?? { efectivo: 0, combustible: 0 }, conPoliza.has(f.id));
        return {
          ...f,
          ...l,
          // Sin pactar: la llevaria si su manifiesto aun no la tiene (para el formulario).
          cobraPoliza: conPoliza.has(f.id) || (!pactado(f) && !manifiestosConPoliza.has(f.manifiesto)),
          tercero: (f.vehiculoId ? nombres.get(f.vehiculoId) : null) ?? f.placa,
          estadoPagoTercero: estadoPagoTercero(f, l, hoy),
          icaSugerido: icaSugerido(f.empresa),
        };
      });
    return { viajes, terceros: resumirTerceros(viajes) };
  },

  /**
   * Propone a que vehiculos terceros (sin socio dueno) se le pone cada nombre
   * de la matriz: por placa y, si ninguna placa coincide, por la cedula del
   * tenedor. Un vehiculo va con un solo nombre (gana la placa). No guarda.
   */
  async proponerNombres(lista: unknown): Promise<NombreTerceroPropuesto[]> {
    const nombres = leerNombres(lista);
    const [vehiculos] = await pool.query<RowDataPacket[]>(
      "SELECT id, placa, numIdTenedor, nombreTenedor FROM vehiculos WHERE dueno IS NULL"
    );
    const usados = new Set<number>();
    const propuestas: NombreTerceroPropuesto[] = nombres.map((t) => ({ ...t, vehiculos: [] }));
    for (const p of propuestas) {
      for (const v of vehiculos.filter((v) => p.placas.includes(v.placa) && !usados.has(v.id))) {
        usados.add(v.id);
        p.vehiculos.push({ id: v.id, placa: v.placa, nombreActual: v.nombreTenedor ?? null, por: "PLACA" });
      }
    }
    for (const p of propuestas.filter((p) => p.cedula)) {
      for (const v of vehiculos.filter((v) => v.numIdTenedor === p.cedula && !usados.has(v.id))) {
        usados.add(v.id);
        p.vehiculos.push({ id: v.id, placa: v.placa, nombreActual: v.nombreTenedor ?? null, por: "CEDULA" });
      }
    }
    return propuestas;
  },

  /** Pone el nombre de la matriz como titular de los vehiculos propuestos. Devuelve cuantos cambio. */
  async importarNombres(lista: unknown): Promise<{ actualizados: number }> {
    let actualizados = 0;
    for (const p of await this.proponerNombres(lista)) {
      if (p.vehiculos.length === 0) continue;
      const [res] = await pool.query<ResultSetHeader>(
        "UPDATE vehiculos SET nombreTenedor = ? WHERE id IN (?) AND NOT (nombreTenedor <=> ?)",
        [p.nombre, p.vehiculos.map((v) => v.id), p.nombre]
      );
      actualizados += res.affectedRows;
    }
    return { actualizados };
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
