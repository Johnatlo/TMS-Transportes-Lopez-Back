/**
 * Liquidacion a los duenos (docs/Liq duenos ejemplo.xlsx, "CUENTAS MILLER A
 * ..."): los viajes de un grupo de carros con su saldo, los conceptos que se le
 * suman o descuentan (creditos, sueldos, peajes, gastos compartidos) y lo que
 * se le paga. Si no se le paga todo, el saldo pendiente pasa a la siguiente.
 *
 * Se guarda una foto de los viajes y conceptos: el Excel de una liquidacion
 * vieja no cambia aunque despues se corrija un viaje.
 */
import type { ResultSetHeader, RowDataPacket } from "mysql2";
import { pool } from "./db";
import { ErrorCuadro } from "./cuadro";
import { rentabilidad } from "./rentabilidad";
import type { FilaRentabilidad } from "./rentabilidad";

/** Un viaje en la liquidacion, como quedo al registrarla. */
export interface FilaLiquidacionDueno {
  id: number;
  fecha: string;
  placa: string;
  empresa: string;
  remision: string | null;
  manifiesto: string | null;
  facturaNumero: string | null;
  facturaFecha: string | null;
  valorEmpresa: number;
  retencion: number;
  reteIca: number;
  anticipoRenta: number;
  bancaria: number;
  supertransporte: number;
  comision: number;
  tLopez: number;
  descargue: number;
  poliza: number;
  anticipo: number;
  /** Saldo del viaje sin sus otros descuentos (esos van como conceptos). */
  saldo: number;
  fechaPagoEmpresa: string | null;
}

/** Un concepto: valor con signo (negativo = se le descuenta) y la cuenta escrita, si la hay. */
export interface ConceptoLiquidacion {
  descripcion: string;
  expresion: string;
  valor: number;
}

/** Una liquidacion registrada. */
export interface LiquidacionDueno {
  id: number;
  grupo: string;
  nombre: string;
  fecha: string;
  filas: FilaLiquidacionDueno[];
  conceptos: ConceptoLiquidacion[];
  totalViajes: number;
  total: number;
  pagado: number;
  saldoPendiente: number;
}

/** La foto de un viaje de la rentabilidad para la liquidacion. */
export function fotoViaje(f: FilaRentabilidad): FilaLiquidacionDueno {
  return {
    id: f.id,
    fecha: f.fecha,
    placa: f.placa,
    empresa: f.empresa,
    remision: f.remision,
    manifiesto: f.manifiesto,
    facturaNumero: f.facturaNumero,
    facturaFecha: f.facturaFecha,
    valorEmpresa: f.valorEmpresa,
    retencion: f.retencion,
    reteIca: f.reteIca,
    anticipoRenta: f.anticipoRenta,
    bancaria: f.bancaria,
    supertransporte: f.supertransporte,
    comision: f.comision,
    tLopez: f.tLopez,
    descargue: f.descargue,
    poliza: f.poliza,
    anticipo: f.anticipo,
    saldo: f.saldoBeneficiario + f.otrosDescuentos,
    fechaPagoEmpresa: f.fechaPagoEmpresa,
  };
}

/**
 * Totales (exportado para las pruebas). Sin valor pagado se le paga todo; si el
 * total es negativo no se le paga nada y el dueno queda debiendo.
 */
export function totalesLiquidacion(filas: Array<{ saldo: number }>, conceptos: Array<{ valor: number }>, pagado: number | null) {
  const totalViajes = filas.reduce((s, f) => s + f.saldo, 0);
  const total = Math.round(totalViajes + conceptos.reduce((s, c) => s + c.valor, 0));
  const valorPagado = pagado ?? Math.max(total, 0);
  return { totalViajes, total, pagado: valorPagado, saldoPendiente: total - valorPagado };
}

/** Lee los conceptos que llegan en la peticion. */
function leerConceptos(x: unknown): ConceptoLiquidacion[] {
  if (x !== undefined && !Array.isArray(x)) throw new ErrorCuadro("Los conceptos no son validos.");
  return ((x ?? []) as Record<string, unknown>[]).map((c) => {
    const descripcion = String(c.descripcion ?? "").trim().slice(0, 300);
    const valor = Number(c.valor);
    if (!descripcion) throw new ErrorCuadro("Hay un concepto sin descripcion.");
    if (!Number.isFinite(valor)) throw new ErrorCuadro(`"${descripcion}" no tiene un valor valido.`);
    return { descripcion, expresion: String(c.expresion ?? "").trim().slice(0, 120), valor };
  });
}

/** Fila de la tabla a una liquidacion. */
function aLiquidacion(r: RowDataPacket): LiquidacionDueno {
  const fecha = r.fecha instanceof Date ? r.fecha.toISOString().slice(0, 10) : String(r.fecha).slice(0, 10);
  return {
    id: Number(r.id),
    grupo: String(r.grupo),
    nombre: String(r.nombre),
    fecha,
    filas: JSON.parse(String(r.filas)),
    conceptos: JSON.parse(String(r.conceptos)),
    totalViajes: Number(r.totalViajes),
    total: Number(r.total),
    pagado: Number(r.pagado),
    saldoPendiente: Number(r.saldoPendiente),
  };
}

/** Repositorio de las liquidaciones a los duenos. */
export const liquidacionDuenos = {
  /** Las liquidaciones registradas, las mas recientes primero. */
  async listar(): Promise<LiquidacionDueno[]> {
    const [filas] = await pool.query<RowDataPacket[]>("SELECT * FROM liquidaciones_duenos ORDER BY id DESC");
    return filas.map(aLiquidacion);
  },

  /**
   * Registra la liquidacion ({ grupo, nombre?, fecha, ids, conceptos, pagado? })
   * y marca los viajes como pagados al dueno, todo o nada: si un viaje ya se
   * habia pagado no se registra.
   */
  async registrar(d: Record<string, unknown>): Promise<LiquidacionDueno> {
    const grupo = String(d.grupo ?? "").trim();
    const fecha = String(d.fecha ?? "").slice(0, 10);
    const ids = [...new Set((Array.isArray(d.ids) ? d.ids : []).map(Number).filter((x) => x > 0))];
    if (!grupo || grupo === "TERCEROS") throw new ErrorCuadro("Elige el grupo del dueno (los terceros se liquidan en Pago a terceros).");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) throw new ErrorCuadro("Escribe la fecha de la liquidacion.");
    if (ids.length === 0) throw new ErrorCuadro("Elige al menos un viaje.");
    const conceptos = leerConceptos(d.conceptos);
    const pagado = d.pagado === null || d.pagado === undefined || d.pagado === "" ? null : Number(d.pagado);
    if (pagado !== null && !Number.isFinite(pagado)) throw new ErrorCuadro("El valor pagado no es valido.");

    const viajes = (await rentabilidad.listar()).filter((f) => ids.includes(f.id));
    const ajenos = viajes.filter((f) => f.grupo !== grupo);
    if (viajes.length !== ids.length || ajenos.length) throw new ErrorCuadro(`Hay viajes que no son del grupo ${grupo}.`);
    const filas = viajes.sort((a, b) => a.fecha.localeCompare(b.fecha) || a.id - b.id).map(fotoViaje);
    const t = totalesLiquidacion(filas, conceptos, pagado);

    const con = await pool.getConnection();
    try {
      await con.beginTransaction();
      const [marcados] = await con.query<ResultSetHeader>(
        "UPDATE cuadro_viajes SET fechaPagoSaldo = ? WHERE id IN (?) AND fechaPagoSaldo IS NULL AND anulado = 0",
        [fecha, ids]
      );
      if (marcados.affectedRows !== ids.length) throw new ErrorCuadro("Algun viaje ya estaba pagado al dueno. Vuelve a abrir la liquidacion.");
      const [res] = await con.query<ResultSetHeader>(
        `INSERT INTO liquidaciones_duenos (grupo, nombre, fecha, filas, conceptos, totalViajes, total, pagado, saldoPendiente)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [grupo, String(d.nombre ?? "").trim().slice(0, 80) || grupo, fecha, JSON.stringify(filas), JSON.stringify(conceptos), t.totalViajes, t.total, t.pagado, t.saldoPendiente]
      );
      await con.commit();
      const [nueva] = await pool.query<RowDataPacket[]>("SELECT * FROM liquidaciones_duenos WHERE id = ?", [res.insertId]);
      return aLiquidacion(nueva[0]);
    } catch (exc) {
      await con.rollback();
      throw exc;
    } finally {
      con.release();
    }
  },

  /**
   * Anula la ultima liquidacion de su grupo y devuelve sus viajes a sin pagar
   * (solo los que siguen con esa fecha). Las anteriores no: de ellas sale el
   * saldo pendiente que arrastra la siguiente.
   */
  async anular(id: number): Promise<void> {
    const [filas] = await pool.query<RowDataPacket[]>("SELECT * FROM liquidaciones_duenos WHERE id = ?", [id]);
    if (!filas[0]) throw new ErrorCuadro("Esa liquidacion no existe.");
    const l = aLiquidacion(filas[0]);
    const [[ultima]] = await pool.query<RowDataPacket[]>("SELECT MAX(id) AS id FROM liquidaciones_duenos WHERE grupo = ?", [l.grupo]);
    if (Number(ultima.id) !== id) throw new ErrorCuadro("Solo se puede anular la ultima liquidacion del grupo.");
    const con = await pool.getConnection();
    try {
      await con.beginTransaction();
      await con.query("UPDATE cuadro_viajes SET fechaPagoSaldo = NULL WHERE id IN (?) AND fechaPagoSaldo = ?", [l.filas.map((f) => f.id), l.fecha]);
      await con.query("DELETE FROM liquidaciones_duenos WHERE id = ?", [id]);
      await con.commit();
    } catch (exc) {
      await con.rollback();
      throw exc;
    } finally {
      con.release();
    }
  },
};
