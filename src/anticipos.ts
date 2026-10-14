/**
 * Anticipos de los viajes: efectivo y combustible (bomba / EDS).
 *
 * Se llevan de dos formas a la vez (como el Excel "cuadro de anticipos"):
 * - Por tanqueo (anticipos_tanqueo): lo que se entrego de una vez en una
 *   bomba, que puede cubrir la ida y la vuelta. Es lo que se corrobora con la
 *   factura de la bomba.
 * - Por viaje (cuadro_anticipos): cada tramo (IDA o VUELTA) con su efectivo y
 *   su combustible, sumado al viaje (recorrido / empresa) del cuadro pagos.
 *
 * Si el anticipo es de ida y vuelta, la vuelta se guarda sin viaje y se
 * asigna sola al proximo viaje de esa placa (asignarVueltasPendientes), con
 * su valor, su bomba y su fecha.
 *
 * Cuentas con la bomba (resumirBomba): lo que se le debe (todo lo entregado en
 * la bomba), lo pagado, lo que abono un socio (el Zorro) por algunos viajes y
 * el cupo de credito que queda.
 *
 * Cruce con la relacion quincenal de la bomba: el combustible de cada tramo es
 * la formula de la columna COMBUST. del Excel, que da el valor exacto
 * (redondeado): round(galones x precio por galon - descuento). El precio se
 * sugiere desde los parametros (11.390); el descuento (por la sociedad) se
 * sugiere como galones x descuento por galon (250), en pesos. Los dos se
 * pueden cambiar en cada tramo.
 */
import type { ResultSetHeader, RowDataPacket } from "mysql2";
import { pool } from "./db";
import { dia, ErrorCuadro } from "./cuadro";

export type Tramo = "IDA" | "VUELTA";

/** Placa comparable: mayusculas sin guion ni espacios ("SZP-339" -> "SZP339"). */
export const placaNormal = (p: unknown) => String(p ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");

/** Valor en pesos >= 0; vacio -> 0. Lanza ErrorCuadro si no es numero. */
function pesos(v: unknown, campo: string): number {
  if (v === null || v === undefined || String(v).trim() === "") return 0;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new ErrorCuadro(`"${campo}" debe ser un valor positivo.`);
  return Math.round(n);
}

/** Fecha "AAAA-MM-DD" valida o ErrorCuadro. */
function fecha(v: unknown, campo: string): string {
  const t = String(v ?? "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(t)) throw new ErrorCuadro(`Escribe ${campo}.`);
  return t;
}

/** Lo que se pide al registrar un anticipo en un viaje. */
export interface NuevoAnticipo {
  fecha: string;
  bombaId: number | null;
  efectivo: number;
  combustible: number;
  /** true: el anticipo cubre la ida y la vuelta. */
  idaYVuelta: boolean;
  efectivoVuelta: number;
  combustibleVuelta: number;
  facturaBomba: string | null;
  nota: string | null;
}

/**
 * Valida el anticipo del formulario. Reglas:
 * - Fecha obligatoria; al menos un valor (efectivo o combustible) en la ida.
 * - Si hay combustible (ida o vuelta), la bomba es obligatoria.
 * - Ida y vuelta: la vuelta debe tener algun valor.
 * - Compatibilidad: "valor" sin desglose se toma como combustible.
 */
export function validarAnticipo(d: Record<string, unknown>): NuevoAnticipo {
  const idaYVuelta = d.idaYVuelta === true || d.idaYVuelta === "true" || d.idaYVuelta === 1;
  const efectivo = pesos(d.efectivo, "Efectivo");
  const combustible = "combustible" in d || "efectivo" in d ? pesos(d.combustible, "Combustible") : pesos(d.valor, "Valor");
  const efectivoVuelta = idaYVuelta ? pesos(d.efectivoVuelta, "Efectivo de vuelta") : 0;
  const combustibleVuelta = idaYVuelta ? pesos(d.combustibleVuelta, "Combustible de vuelta") : 0;
  const bombaId = d.bombaId ? Number(d.bombaId) : null;
  if (efectivo + combustible === 0) throw new ErrorCuadro("Escribe el valor del anticipo (efectivo o combustible).");
  if (idaYVuelta && efectivoVuelta + combustibleVuelta === 0) {
    throw new ErrorCuadro("Es de ida y vuelta: escribe el valor del anticipo de vuelta.");
  }
  if ((combustible > 0 || combustibleVuelta > 0) && !bombaId) throw new ErrorCuadro("Elige la bomba donde tanqueo.");
  const texto = (v: unknown, max: number) => String(v ?? "").trim().slice(0, max) || null;
  return {
    fecha: fecha(d.fecha, "la fecha del anticipo"),
    bombaId,
    efectivo,
    combustible,
    idaYVuelta,
    efectivoVuelta,
    combustibleVuelta,
    facturaBomba: texto(d.facturaBomba, 40),
    nota: texto(d.nota, 200),
  };
}

/** Un tramo del cuadro de anticipos (una fila por viaje). */
export interface FilaAnticipo {
  id: number;
  tanqueoId: number | null;
  tramo: Tramo;
  fecha: string;
  placa: string | null;
  /** Viaje al que se suma; null = vuelta pendiente del proximo viaje. */
  cuadroViajeId: number | null;
  empresa: string | null;
  manifiesto: string | null;
  efectivo: number;
  combustible: number;
  valor: number;
  bombaId: number | null;
  bomba: string | null;
  facturaBomba: string | null;
  fechaFacturaBomba: string | null;
  idaYVuelta: boolean;
  /** LOPEZ, MYC o TERCERO (del catalogo de vehiculos). */
  flota: string | null;
  fechaPago: string | null;
  nota: string | null;
  /** Galones del tiquete de la bomba (para el cruce). */
  galones: number | null;
  /** Precio por galon con que se calculo el combustible. */
  precioGalon: number | null;
  /** Descuento en pesos que se resta (por la sociedad). */
  descuento: number | null;
  /** Combustible que se habia registrado antes de calcularlo con los galones. */
  combustibleEntregado: number | null;
}

const SELECT_ANTICIPOS = `
  SELECT a.id, a.tanqueoId, a.tramo, a.fecha, COALESCE(a.placa, c.placa) AS placa, a.cuadroViajeId,
         c.empresa, c.manifiesto, a.efectivo, a.combustible, a.valor, a.bombaId, b.nombre AS bomba,
         t.facturaBomba, t.fechaFacturaBomba, COALESCE(t.idaYVuelta, 0) AS idaYVuelta,
         (SELECT ve.flota FROM vehiculos ve
           WHERE REPLACE(ve.placa, '-', '') = REPLACE(COALESCE(a.placa, c.placa), '-', '') LIMIT 1) AS flota,
         a.fechaPago, a.nota, a.galones, a.precioGalon, a.descuento, a.combustibleEntregado
    FROM cuadro_anticipos a
    LEFT JOIN cuadro_viajes c ON c.id = a.cuadroViajeId
    LEFT JOIN anticipos_tanqueo t ON t.id = a.tanqueoId
    LEFT JOIN bombas b ON b.id = a.bombaId`;

/** Fila de SELECT_ANTICIPOS -> FilaAnticipo. */
const mapear = (r: RowDataPacket): FilaAnticipo => ({
  id: r.id,
  tanqueoId: r.tanqueoId ?? null,
  tramo: r.tramo === "VUELTA" ? "VUELTA" : "IDA",
  fecha: dia(r.fecha)!,
  placa: r.placa ?? null,
  cuadroViajeId: r.cuadroViajeId ?? null,
  empresa: r.empresa ?? null,
  manifiesto: r.manifiesto ?? null,
  efectivo: Number(r.efectivo ?? 0),
  combustible: Number(r.combustible ?? 0),
  valor: Number(r.valor ?? 0),
  bombaId: r.bombaId ?? null,
  bomba: r.bomba ?? null,
  facturaBomba: r.facturaBomba ?? null,
  fechaFacturaBomba: dia(r.fechaFacturaBomba),
  idaYVuelta: !!r.idaYVuelta,
  flota: r.flota ?? null,
  fechaPago: dia(r.fechaPago),
  nota: r.nota ?? null,
  galones: r.galones === null || r.galones === undefined ? null : Number(r.galones),
  precioGalon: r.precioGalon === null || r.precioGalon === undefined ? null : Number(r.precioGalon),
  descuento: r.descuento === null || r.descuento === undefined ? null : Number(r.descuento),
  combustibleEntregado: r.combustibleEntregado === null || r.combustibleEntregado === undefined ? null : Number(r.combustibleEntregado),
});

/** Cupo con la bomba y valores sugeridos para el cruce (parametros de la empresa). */
export interface ParametrosBomba {
  cupoBomba: number;
  precioGalonBomba: number;
  descuentoGalonBomba: number;
}

/** Descuento sugerido en pesos: galones x descuento por galon, redondeado. */
export const descuentoSugerido = (galones: number, descuentoPorGalon: number) => Math.round(galones * descuentoPorGalon);

/**
 * Combustible de un tramo segun la relacion de la bomba (la formula de la
 * columna COMBUST. del Excel): round(galones x precio - descuento).
 * Ej.: 100,182 galones x 11.230 - 25.044 = 1.100.000.
 */
export const combustibleSegunFormula = (galones: number, precioGalon: number, descuento: number) =>
  Math.round(galones * precioGalon - descuento);

/** Cuentas con la bomba. */
export interface ResumenBomba extends ParametrosBomba {
  /** Todo lo entregado en la bomba (efectivo y combustible). */
  deuda: number;
  /** Lo que la empresa ya le pago a la bomba. */
  pagado: number;
  /** Lo que abono el socio directamente a la bomba. */
  abonadoSocio: number;
  /** Lo que falta por pagarle: deuda - pagado - abonado (minimo 0). */
  pendiente: number;
  /** Cupo de credito que queda: cupo - pendiente. */
  cupoDisponible: number;
}

/**
 * Cuentas con la bomba a partir de los tramos: solo cuentan los entregados en
 * una bomba (los de solo efectivo sin bomba no son deuda con ella).
 */
export function resumirBomba(tramos: Pick<FilaAnticipo, "bombaId" | "valor" | "fechaPago">[], abonadoSocio: number, p: ParametrosBomba): ResumenBomba {
  const conBomba = tramos.filter((t) => t.bombaId !== null);
  const deuda = conBomba.reduce((s, t) => s + t.valor, 0);
  const pagado = conBomba.filter((t) => !!t.fechaPago).reduce((s, t) => s + t.valor, 0);
  const pendiente = Math.max(0, deuda - pagado - abonadoSocio);
  return { ...p, deuda, pagado, abonadoSocio, pendiente, cupoDisponible: p.cupoBomba - pendiente };
}

/** Un abono del socio, con los viajes a los que corresponde. */
export interface AbonoSocio {
  id: number;
  socio: string;
  fecha: string;
  valor: number;
  nota: string | null;
  viajes: Array<{ cuadroViajeId: number; valor: number; placa: string | null; empresa: string | null; manifiesto: string | null; fecha: string | null }>;
}

/** Anticipos por tanqueo y por tramo: registrar, asignar vueltas, listar y corregir. */
export const anticipos = {
  /**
   * Registra un anticipo en un viaje del cuadro: crea el tanqueo, el tramo de
   * IDA en este viaje y, si es de ida y vuelta, el tramo de VUELTA pendiente
   * (se asigna solo al proximo viaje de la placa). Todo en una transaccion.
   */
  async registrar(cuadroViajeId: number, d: Record<string, unknown>, usuarioId: number | null): Promise<void> {
    const a = validarAnticipo(d);
    const [viajes] = await pool.query<RowDataPacket[]>("SELECT placa FROM cuadro_viajes WHERE id = ?", [cuadroViajeId]);
    if (!viajes[0]) throw new ErrorCuadro("Viaje no encontrado en el cuadro.");
    const placa = placaNormal(viajes[0].placa);
    const conexion = await pool.getConnection();
    try {
      await conexion.beginTransaction();
      const [t] = await conexion.query<ResultSetHeader>(
        `INSERT INTO anticipos_tanqueo (placa, fecha, bombaId, idaYVuelta, facturaBomba, nota, creadoPorId)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [placa, a.fecha, a.bombaId, a.idaYVuelta ? 1 : 0, a.facturaBomba, a.nota, usuarioId]
      );
      const tramo = (viaje: number | null, tipo: Tramo, efectivo: number, combustible: number) =>
        conexion.query(
          `INSERT INTO cuadro_anticipos
             (cuadroViajeId, tanqueoId, tramo, placa, bombaId, efectivo, combustible, valor, fecha, nota, creadoPorId)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [viaje, t.insertId, tipo, placa, a.bombaId, efectivo, combustible, efectivo + combustible, a.fecha, a.nota, usuarioId]
        );
      await tramo(cuadroViajeId, "IDA", a.efectivo, a.combustible);
      if (a.idaYVuelta) await tramo(null, "VUELTA", a.efectivoVuelta, a.combustibleVuelta);
      await conexion.commit();
    } catch (exc) {
      await conexion.rollback();
      throw exc;
    } finally {
      conexion.release();
    }
    await this.asignarVueltasPendientes();
  },

  /**
   * Asigna cada vuelta pendiente al proximo viaje de su placa: el primero del
   * cuadro (no anulado) despues del viaje de ida, por fecha y luego por orden
   * de creacion. Si aun no hay, sigue pendiente. Devuelve cuantas asigno.
   */
  async asignarVueltasPendientes(): Promise<number> {
    const [pendientes] = await pool.query<RowDataPacket[]>(
      `SELECT v.id, v.placa, ida.cuadroViajeId AS viajeIda, c.fecha AS fechaIda
         FROM cuadro_anticipos v
         JOIN cuadro_anticipos ida ON ida.tanqueoId = v.tanqueoId AND ida.tramo = 'IDA'
         JOIN cuadro_viajes c ON c.id = ida.cuadroViajeId
        WHERE v.tramo = 'VUELTA' AND v.cuadroViajeId IS NULL`
    );
    let asignadas = 0;
    for (const p of pendientes) {
      const [siguiente] = await pool.query<RowDataPacket[]>(
        `SELECT id FROM cuadro_viajes
          WHERE anulado = 0 AND REPLACE(placa, '-', '') = ? AND id <> ?
            AND (fecha > ? OR (fecha = ? AND id > ?))
          ORDER BY fecha, id LIMIT 1`,
        [p.placa, p.viajeIda, p.fechaIda, p.fechaIda, p.viajeIda]
      );
      if (!siguiente[0]) continue;
      await pool.query("UPDATE cuadro_anticipos SET cuadroViajeId = ? WHERE id = ? AND cuadroViajeId IS NULL", [
        siguiente[0].id,
        p.id,
      ]);
      asignadas++;
    }
    return asignadas;
  },

  /** Los tramos de un viaje (para su detalle), por fecha. */
  async delViaje(cuadroViajeId: number): Promise<FilaAnticipo[]> {
    const [rows] = await pool.query<RowDataPacket[]>(`${SELECT_ANTICIPOS} WHERE a.cuadroViajeId = ? ORDER BY a.fecha, a.id`, [
      cuadroViajeId,
    ]);
    return rows.map(mapear);
  },

  /** El cuadro de anticipos completo (una fila por tramo), lo mas reciente primero. */
  async cuadro(): Promise<FilaAnticipo[]> {
    await this.asignarVueltasPendientes();
    const [rows] = await pool.query<RowDataPacket[]>(`${SELECT_ANTICIPOS} ORDER BY a.fecha DESC, a.tanqueoId DESC, a.id`);
    return rows.map(mapear);
  },

  /**
   * Datos de la factura de la bomba de un tanqueo (para corroborarlo): numero,
   * fecha y, si hace falta, la bomba (cambia tambien en sus tramos).
   */
  async actualizarTanqueo(id: number, d: Record<string, unknown>): Promise<void> {
    const sets: string[] = [];
    const valores: unknown[] = [];
    if ("facturaBomba" in d) {
      sets.push("facturaBomba = ?");
      valores.push(String(d.facturaBomba ?? "").trim().slice(0, 40) || null);
    }
    if ("fechaFacturaBomba" in d) {
      sets.push("fechaFacturaBomba = ?");
      valores.push(d.fechaFacturaBomba ? fecha(d.fechaFacturaBomba, "la fecha de la factura") : null);
    }
    if ("bombaId" in d) {
      sets.push("bombaId = ?");
      valores.push(d.bombaId ? Number(d.bombaId) : null);
      await pool.query("UPDATE cuadro_anticipos SET bombaId = ? WHERE tanqueoId = ?", [d.bombaId ? Number(d.bombaId) : null, id]);
    }
    if (sets.length) await pool.query(`UPDATE anticipos_tanqueo SET ${sets.join(", ")} WHERE id = ?`, [...valores, id]);
  },

  /**
   * Cambia un tramo desde el cuadro de anticipos: fecha de pago, nota, a que
   * viaje se suma (para corregir una vuelta asignada al viaje equivocado) o
   * los datos del cruce: galones, precio por galon y descuento. Con galones,
   * el combustible del tramo se recalcula con la formula de la bomba (precio
   * y descuento vacios = los sugeridos) y se guarda lo que se habia
   * registrado antes, para ver la diferencia.
   */
  async actualizarTramo(id: number, d: Record<string, unknown>): Promise<void> {
    const sets: string[] = [];
    const valores: unknown[] = [];
    if ("fechaPago" in d) {
      sets.push("fechaPago = ?");
      valores.push(d.fechaPago ? fecha(d.fechaPago, "la fecha de pago") : null);
    }
    if ("nota" in d) {
      sets.push("nota = ?");
      valores.push(String(d.nota ?? "").trim().slice(0, 200) || null);
    }
    if ("cuadroViajeId" in d) {
      sets.push("cuadroViajeId = ?");
      valores.push(d.cuadroViajeId ? Number(d.cuadroViajeId) : null);
    }
    if (sets.length) await pool.query(`UPDATE cuadro_anticipos SET ${sets.join(", ")} WHERE id = ?`, [...valores, id]);
    if ("galones" in d || "precioGalon" in d || "descuento" in d) await this.cruzarTramo(id, d);
  },

  /**
   * Cruce de un tramo con la relacion de la bomba: guarda galones, precio y
   * descuento y recalcula el combustible con la formula. Precio vacio = el
   * sugerido; descuento vacio = galones x descuento por galon sugerido. Sin
   * galones, el tramo vuelve al combustible que se habia registrado.
   */
  async cruzarTramo(id: number, d: Record<string, unknown>): Promise<void> {
    const numero = (campo: string): number | null | undefined => {
      if (!(campo in d)) return undefined;
      const v = d[campo];
      if (v === null || v === undefined || String(v).trim() === "") return null;
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0) throw new ErrorCuadro(`"${campo}" debe ser un numero positivo.`);
      return n;
    };
    const [rows] = await pool.query<RowDataPacket[]>(
      "SELECT efectivo, combustible, galones, precioGalon, descuento, combustibleEntregado FROM cuadro_anticipos WHERE id = ?",
      [id]
    );
    const t = rows[0];
    if (!t) return;
    const p = await this.parametrosBomba();
    const nGalones = numero("galones");
    const galones = nGalones === undefined ? (t.galones === null ? null : Number(t.galones)) : nGalones;
    const entregado = t.combustibleEntregado === null ? Number(t.combustible ?? 0) : Number(t.combustibleEntregado);
    const efectivo = Number(t.efectivo ?? 0);
    if (galones === null) {
      // Sin galones no hay cruce: vuelve lo que se habia registrado.
      await pool.query(
        `UPDATE cuadro_anticipos SET galones = NULL, precioGalon = NULL, descuento = NULL, combustibleEntregado = NULL,
                combustible = ?, valor = ? WHERE id = ?`,
        [entregado, efectivo + entregado, id]
      );
      return;
    }
    const nPrecio = numero("precioGalon");
    const precio = (nPrecio === undefined ? (t.precioGalon === null ? null : Number(t.precioGalon)) : nPrecio) ?? p.precioGalonBomba;
    const nDescuento = numero("descuento");
    // Si cambian los galones y el descuento no se escribio, se vuelve a sugerir.
    const descuentoGuardado = t.descuento === null || nGalones !== undefined ? null : Number(t.descuento);
    const descuento = (nDescuento === undefined ? descuentoGuardado : nDescuento) ?? descuentoSugerido(galones, p.descuentoGalonBomba);
    const combustible = combustibleSegunFormula(galones, precio, descuento);
    await pool.query(
      `UPDATE cuadro_anticipos SET galones = ?, precioGalon = ?, descuento = ?, combustibleEntregado = ?,
              combustible = ?, valor = ? WHERE id = ?`,
      [galones, precio, descuento, entregado, combustible, efectivo + combustible, id]
    );
  },

  /**
   * Quita un tramo. Si era la ida de un anticipo de ida y vuelta, tambien
   * quita la vuelta que aun no se asigno a ningun viaje. Si el tanqueo queda
   * sin tramos, se borra.
   */
  async borrarTramo(id: number): Promise<void> {
    const [rows] = await pool.query<RowDataPacket[]>("SELECT tanqueoId, tramo FROM cuadro_anticipos WHERE id = ?", [id]);
    const t = rows[0];
    if (!t) return;
    await pool.query("DELETE FROM cuadro_anticipos WHERE id = ?", [id]);
    if (t.tanqueoId) {
      if (t.tramo === "IDA") {
        await pool.query("DELETE FROM cuadro_anticipos WHERE tanqueoId = ? AND tramo = 'VUELTA' AND cuadroViajeId IS NULL", [
          t.tanqueoId,
        ]);
      }
      await pool.query(
        "DELETE FROM anticipos_tanqueo WHERE id = ? AND NOT EXISTS (SELECT 1 FROM cuadro_anticipos WHERE tanqueoId = ?)",
        [t.tanqueoId, t.tanqueoId]
      );
    }
  },

  /** Cupo con la bomba, precio por galon y descuento por galon sugeridos. */
  async parametrosBomba(): Promise<ParametrosBomba> {
    const [rows] = await pool.query<RowDataPacket[]>(
      "SELECT cupoBomba, precioGalonBomba, descuentoGalonBomba FROM parametros_empresa WHERE id = 1"
    );
    const r = rows[0] ?? {};
    return {
      cupoBomba: Number(r.cupoBomba ?? 500000000),
      precioGalonBomba: Number(r.precioGalonBomba ?? 11390),
      descuentoGalonBomba: Number(r.descuentoGalonBomba ?? 250),
    };
  },

  /** Cambia el cupo con la bomba y/o los valores sugeridos del cruce. */
  async guardarParametrosBomba(d: Record<string, unknown>): Promise<ParametrosBomba> {
    const sets: string[] = [];
    const valores: unknown[] = [];
    for (const campo of ["cupoBomba", "precioGalonBomba", "descuentoGalonBomba"]) {
      if (!(campo in d)) continue;
      const n = Number(d[campo]);
      if (!Number.isFinite(n) || n < 0) throw new ErrorCuadro(`"${campo}" debe ser un numero positivo.`);
      sets.push(`${campo} = ?`);
      valores.push(n);
    }
    if (sets.length) await pool.query(`UPDATE parametros_empresa SET ${sets.join(", ")} WHERE id = 1`, valores);
    return this.parametrosBomba();
  },

  /** Cuentas con la bomba: deuda, pagado, abonado por el socio, pendiente y cupo disponible. */
  async resumen(): Promise<ResumenBomba> {
    const [tramos] = await pool.query<RowDataPacket[]>("SELECT bombaId, valor, fechaPago FROM cuadro_anticipos");
    const [[abonos]] = await pool.query<RowDataPacket[]>("SELECT COALESCE(SUM(valor), 0) AS total FROM abonos_socio");
    return resumirBomba(
      tramos.map((t) => ({ bombaId: t.bombaId ?? null, valor: Number(t.valor), fechaPago: dia(t.fechaPago) })),
      Number(abonos.total),
      await this.parametrosBomba()
    );
  },

  /** Abonos del socio, el mas reciente primero, con sus viajes. */
  async abonos(): Promise<AbonoSocio[]> {
    const [abonos] = await pool.query<RowDataPacket[]>("SELECT * FROM abonos_socio ORDER BY fecha DESC, id DESC");
    const [viajes] = await pool.query<RowDataPacket[]>(
      `SELECT av.abonoId, av.cuadroViajeId, av.valor, c.placa, c.empresa, c.manifiesto, c.fecha
         FROM abonos_socio_viajes av LEFT JOIN cuadro_viajes c ON c.id = av.cuadroViajeId ORDER BY av.id`
    );
    return abonos.map((a) => ({
      id: a.id,
      socio: a.socio,
      fecha: dia(a.fecha)!,
      valor: Number(a.valor),
      nota: a.nota ?? null,
      viajes: viajes
        .filter((v) => v.abonoId === a.id)
        .map((v) => ({
          cuadroViajeId: v.cuadroViajeId,
          valor: Number(v.valor),
          placa: v.placa ?? null,
          empresa: v.empresa ?? null,
          manifiesto: v.manifiesto ?? null,
          fecha: dia(v.fecha),
        })),
    }));
  },

  /**
   * Registra un abono del socio: socio, fecha, nota y los viajes con el valor
   * de cada uno (al menos uno). El valor del abono es la suma de los viajes.
   */
  async registrarAbono(d: Record<string, unknown>, usuarioId: number | null): Promise<void> {
    const socio = String(d.socio ?? "").trim().toUpperCase().slice(0, 100);
    if (!socio) throw new ErrorCuadro("Escribe quien hizo el abono.");
    const f = fecha(d.fecha, "la fecha del abono");
    const lineas = (Array.isArray(d.viajes) ? d.viajes : []) as Array<Record<string, unknown>>;
    const viajes = lineas.map((v) => ({ id: Number(v.cuadroViajeId), valor: pesos(v.valor, "Valor abonado") })).filter((v) => v.id);
    if (viajes.length === 0) throw new ErrorCuadro("Agrega los viajes a los que corresponde el abono.");
    if (viajes.some((v) => v.valor === 0)) throw new ErrorCuadro("Cada viaje del abono necesita su valor.");
    const total = viajes.reduce((s, v) => s + v.valor, 0);
    const conexion = await pool.getConnection();
    try {
      await conexion.beginTransaction();
      const [a] = await conexion.query<ResultSetHeader>(
        "INSERT INTO abonos_socio (socio, fecha, valor, nota, creadoPorId) VALUES (?, ?, ?, ?, ?)",
        [socio, f, total, String(d.nota ?? "").trim().slice(0, 200) || null, usuarioId]
      );
      await conexion.query("INSERT INTO abonos_socio_viajes (abonoId, cuadroViajeId, valor) VALUES ?", [
        viajes.map((v) => [a.insertId, v.id, v.valor]),
      ]);
      await conexion.commit();
    } catch (exc) {
      await conexion.rollback();
      throw exc;
    } finally {
      conexion.release();
    }
  },

  /** Borra un abono del socio (y su reparto en los viajes). */
  async borrarAbono(id: number): Promise<void> {
    await pool.query("DELETE FROM abonos_socio WHERE id = ?", [id]);
  },
};
