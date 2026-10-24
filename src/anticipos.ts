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
 * Ida y vuelta en el Excel (y en lo que se cargo de el): no hay columna que lo
 * diga; son dos anticipos de la misma placa, el mismo dia y en la misma
 * bomba. juntarIdaYVuelta los deja en un solo tanqueo: la ida es la del viaje
 * despachado mas cerca del dia del tanqueo (el que sale de Bogota / Soacha);
 * la otra es la vuelta (ver elegirIdaYVuelta). Si son 3 o mas el mismo dia,
 * no se juntan solos: la pantalla los muestra como posible vuelta.
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
import { anioPosible, dia, ErrorCuadro } from "./cuadro";

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
  if (!anioPosible(t)) throw new ErrorCuadro(`En ${campo}, el año ${t.slice(0, 4)} no es posible; revisa la fecha.`);
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
  /** Fecha del viaje del cuadro al que se suma. */
  fechaViaje: string | null;
  /** Vale de combustible de la relacion de la bomba con que se cruzo; null = sin cruzar. */
  vale: string | null;
  /** Vale de efectivo de la relacion de la bomba con que se cruzo; null = sin cruzar. */
  valeEfectivo: string | null;
  /** Efectivo que se habia registrado antes de cruzarlo con el vale. */
  efectivoEntregado: number | null;
  /** Factura (relacion) de la bomba con que se cruzo el vale. */
  relacionId: number | null;
}

const SELECT_ANTICIPOS = `
  SELECT a.id, a.tanqueoId, a.tramo, a.fecha, COALESCE(a.placa, c.placa) AS placa, a.cuadroViajeId,
         c.empresa, c.manifiesto, a.efectivo, a.combustible, a.valor, a.bombaId, b.nombre AS bomba,
         t.facturaBomba, t.fechaFacturaBomba, COALESCE(t.idaYVuelta, 0) AS idaYVuelta,
         (SELECT ve.flota FROM vehiculos ve
           WHERE REPLACE(ve.placa, '-', '') = REPLACE(COALESCE(a.placa, c.placa), '-', '') LIMIT 1) AS flota,
         a.fechaPago, a.nota, a.galones, a.precioGalon, a.descuento, a.combustibleEntregado,
         c.fecha AS fechaViaje, rv.vale, COALESCE(rv.relacionId, re.relacionId) AS relacionId,
         re.vale AS valeEfectivo, a.efectivoEntregado
    FROM cuadro_anticipos a
    LEFT JOIN bomba_relacion_vales rv ON rv.cuadroAnticipoId = a.id AND rv.tipo = 'COMBUSTIBLE'
    LEFT JOIN bomba_relacion_vales re ON re.cuadroAnticipoId = a.id AND re.tipo = 'EFECTIVO'
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
  fechaViaje: dia(r.fechaViaje),
  vale: r.vale ?? null,
  valeEfectivo: r.valeEfectivo ?? null,
  efectivoEntregado: r.efectivoEntregado === null || r.efectivoEntregado === undefined ? null : Number(r.efectivoEntregado),
  relacionId: r.relacionId ?? null,
});

/** Tanqueo de un solo tramo (como quedaron los cargados del Excel), para juntar ida y vuelta. */
export interface TanqueoSuelto {
  tanqueoId: number;
  tramoId: number;
  placa: string;
  fecha: string;
  bombaId: number | null;
  cuadroViajeId: number | null;
  /** Fecha de despacho del viaje del tramo. */
  fechaViaje: string | null;
  /** El viaje sale de Bogota o Soacha (la ida casi siempre). */
  saleDeBogota: boolean;
  facturaBomba: string | null;
}

/** Dias entre dos fechas "AAAA-MM-DD" (sin signo); sin fecha, muy lejos. */
const distancia = (a: string, b: string | null) =>
  b ? Math.abs(Math.round((Date.parse(`${a}T12:00:00Z`) - Date.parse(`${b}T12:00:00Z`)) / 86_400_000)) : 9999;

/**
 * Cual de dos tanqueos del mismo dia es la ida y cual la vuelta: la ida es la
 * del viaje despachado mas cerca del dia del tanqueo; si empatan, la que sale
 * de Bogota / Soacha; si no, el viaje mas antiguo.
 */
export function elegirIdaYVuelta(a: TanqueoSuelto, b: TanqueoSuelto): { ida: TanqueoSuelto; vuelta: TanqueoSuelto } {
  const orden = [a, b].sort(
    (x, y) =>
      distancia(x.fecha, x.fechaViaje) - distancia(y.fecha, y.fechaViaje) ||
      Number(y.saleDeBogota) - Number(x.saleDeBogota) ||
      (x.fechaViaje ?? "9999").localeCompare(y.fechaViaje ?? "9999") ||
      x.tramoId - y.tramoId
  );
  return { ida: orden[0], vuelta: orden[1] };
}

/**
 * Parejas de ida y vuelta entre los tanqueos sueltos: exactamente dos de la
 * misma placa, el mismo dia y la misma bomba (con 3 o mas no se sabe cuales
 * van juntos). No junta dos con facturas de la bomba distintas.
 */
export function parejasIdaYVuelta(sueltos: TanqueoSuelto[]): Array<{ ida: TanqueoSuelto; vuelta: TanqueoSuelto }> {
  const grupos = new Map<string, TanqueoSuelto[]>();
  for (const t of sueltos) {
    if (t.bombaId === null) continue;
    const clave = `${placaNormal(t.placa)}|${t.fecha}|${t.bombaId}`;
    grupos.set(clave, [...(grupos.get(clave) ?? []), t]);
  }
  return [...grupos.values()]
    .filter((g) => g.length === 2 && !(g[0].facturaBomba && g[1].facturaBomba && g[0].facturaBomba !== g[1].facturaBomba))
    .map((g) => elegirIdaYVuelta(g[0], g[1]));
}

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
 *
 * Los abonos de los socios que ya se descontaron en un pago a la bomba estan
 * dentro de lo pagado (sus tramos quedaron pagados): a la deuda solo se le
 * restan los que aun no se han usado (`abonosSinUsar`; por defecto, todos).
 */
export function resumirBomba(
  tramos: Pick<FilaAnticipo, "bombaId" | "valor" | "fechaPago">[],
  abonadoSocio: number,
  p: ParametrosBomba,
  abonosSinUsar = abonadoSocio
): ResumenBomba {
  const conBomba = tramos.filter((t) => t.bombaId !== null);
  const deuda = conBomba.reduce((s, t) => s + t.valor, 0);
  const pagado = conBomba.filter((t) => !!t.fechaPago).reduce((s, t) => s + t.valor, 0);
  const pendiente = Math.max(0, deuda - pagado - abonosSinUsar);
  return { ...p, deuda, pagado, abonadoSocio, pendiente, cupoDisponible: p.cupoBomba - pendiente };
}

/** Un abono del socio, con los viajes a los que corresponde. */
export interface AbonoSocio {
  id: number;
  socio: string;
  fecha: string;
  valor: number;
  nota: string | null;
  /** Pago a la bomba en que se desconto; null = aun no se ha usado. */
  pagoId: number | null;
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

  /** Tanqueos de un solo tramo de IDA (sin juntar), con su viaje. */
  async sueltos(): Promise<TanqueoSuelto[]> {
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT t.id AS tanqueoId, a.id AS tramoId, t.placa, t.fecha, t.bombaId, a.cuadroViajeId, c.fecha AS fechaViaje,
              t.facturaBomba,
              COALESCE(pl.municipioOrigen, vj.origenRndc) IN ('11001000', '25754000') AS saleDeBogota
         FROM anticipos_tanqueo t
         JOIN cuadro_anticipos a ON a.tanqueoId = t.id
         LEFT JOIN cuadro_viajes c ON c.id = a.cuadroViajeId
         LEFT JOIN viajes vj ON vj.id = c.viajeId
         LEFT JOIN viaje_remesas vr ON vr.id = c.viajeRemesaId
         LEFT JOIN plantillas_viaje pl ON pl.id = vr.plantillaId
        WHERE t.idaYVuelta = 0 AND a.tramo = 'IDA'
          AND (SELECT COUNT(*) FROM cuadro_anticipos x WHERE x.tanqueoId = t.id) = 1`
    );
    return rows.map((r) => ({
      tanqueoId: r.tanqueoId,
      tramoId: r.tramoId,
      placa: r.placa,
      fecha: dia(r.fecha)!,
      bombaId: r.bombaId ?? null,
      cuadroViajeId: r.cuadroViajeId ?? null,
      fechaViaje: dia(r.fechaViaje),
      saleDeBogota: !!r.saleDeBogota,
      facturaBomba: r.facturaBomba ?? null,
    }));
  },

  /**
   * Junta un tanqueo de ida con otro como su vuelta: el tramo de la vuelta
   * pasa al tanqueo de la ida como VUELTA y el tanqueo de la vuelta se borra.
   * Si los dos estaban en el mismo viaje, la vuelta queda para el proximo
   * viaje de la placa.
   */
  async juntar(ida: TanqueoSuelto, vuelta: TanqueoSuelto): Promise<void> {
    const conexion = await pool.getConnection();
    try {
      await conexion.beginTransaction();
      await conexion.query("UPDATE cuadro_anticipos SET tanqueoId = ?, tramo = 'VUELTA', cuadroViajeId = ? WHERE id = ?", [
        ida.tanqueoId,
        vuelta.cuadroViajeId === ida.cuadroViajeId ? null : vuelta.cuadroViajeId,
        vuelta.tramoId,
      ]);
      await conexion.query("UPDATE anticipos_tanqueo SET idaYVuelta = 1, facturaBomba = COALESCE(facturaBomba, ?) WHERE id = ?", [
        vuelta.facturaBomba,
        ida.tanqueoId,
      ]);
      await conexion.query("DELETE FROM anticipos_tanqueo WHERE id = ?", [vuelta.tanqueoId]);
      await conexion.commit();
    } catch (exc) {
      await conexion.rollback();
      throw exc;
    } finally {
      conexion.release();
    }
  },

  /** Junta solos los pares de ida y vuelta (ver parejasIdaYVuelta). Devuelve cuantos junto. */
  async juntarIdaYVuelta(): Promise<number> {
    const parejas = parejasIdaYVuelta(await this.sueltos());
    for (const p of parejas) await this.juntar(p.ida, p.vuelta);
    if (parejas.length) await this.asignarVueltasPendientes();
    return parejas.length;
  },

  /**
   * Junta a mano dos tanqueos de la misma placa (la posible vuelta que muestra
   * la pantalla): el primero es la ida. Los dos deben ser de un solo tramo.
   */
  async juntarManual(idaTanqueoId: number, vueltaTanqueoId: number): Promise<void> {
    const sueltos = await this.sueltos();
    const ida = sueltos.find((s) => s.tanqueoId === idaTanqueoId);
    const vuelta = sueltos.find((s) => s.tanqueoId === vueltaTanqueoId);
    if (!ida || !vuelta || ida === vuelta) throw new ErrorCuadro("Solo se pueden juntar dos tanqueos de un solo tramo.");
    if (placaNormal(ida.placa) !== placaNormal(vuelta.placa)) throw new ErrorCuadro("Los dos tanqueos deben ser de la misma placa.");
    await this.juntar(ida, vuelta);
    await this.asignarVueltasPendientes();
  },

  /**
   * Separa la vuelta de un tanqueo de ida y vuelta: queda como un tanqueo de
   * ida propio en el mismo viaje (para corregir una pareja mal hecha).
   */
  async separarVuelta(tanqueoId: number): Promise<void> {
    const [rows] = await pool.query<RowDataPacket[]>(
      "SELECT a.id, t.placa, t.fecha, t.bombaId FROM cuadro_anticipos a JOIN anticipos_tanqueo t ON t.id = a.tanqueoId WHERE a.tanqueoId = ? AND a.tramo = 'VUELTA'",
      [tanqueoId]
    );
    const v = rows[0];
    if (!v) throw new ErrorCuadro("Ese tanqueo no tiene vuelta.");
    const [t] = await pool.query<ResultSetHeader>(
      "INSERT INTO anticipos_tanqueo (placa, fecha, bombaId, idaYVuelta, nota) VALUES (?, ?, ?, 0, 'Separado de una ida y vuelta')",
      [v.placa, dia(v.fecha), v.bombaId]
    );
    await pool.query("UPDATE cuadro_anticipos SET tanqueoId = ?, tramo = 'IDA' WHERE id = ?", [t.insertId, v.id]);
    await pool.query("UPDATE anticipos_tanqueo SET idaYVuelta = 0 WHERE id = ?", [tanqueoId]);
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
    await this.juntarIdaYVuelta();
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
   * viaje se suma (para corregir una vuelta asignada al viaje equivocado), el
   * efectivo o el combustible a mano (para corregir lo que no coincide con la
   * bomba; el valor total se recalcula), aceptar lo que cobro la bomba
   * (aceptarBomba: la diferencia queda resuelta) o
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
    for (const campo of ["efectivo", "combustible"] as const) {
      if (!(campo in d)) continue;
      sets.push(`${campo} = ?`);
      valores.push(pesos(d[campo], campo === "efectivo" ? "Efectivo" : "Combustible"));
    }
    if (sets.length) await pool.query(`UPDATE cuadro_anticipos SET ${sets.join(", ")} WHERE id = ?`, [...valores, id]);
    if ("efectivo" in d || "combustible" in d) {
      await pool.query("UPDATE cuadro_anticipos SET valor = COALESCE(efectivo, 0) + COALESCE(combustible, 0) WHERE id = ?", [id]);
    }
    // Se acepta lo que cobro la bomba: la diferencia con lo registrado queda resuelta.
    if (d.aceptarBomba === true) {
      await pool.query("UPDATE cuadro_anticipos SET combustibleEntregado = NULL, efectivoEntregado = NULL WHERE id = ?", [id]);
    }
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
    const [[abonos]] = await pool.query<RowDataPacket[]>(
      "SELECT COALESCE(SUM(valor), 0) AS total, COALESCE(SUM(IF(pagoId IS NULL, valor, 0)), 0) AS sinUsar FROM abonos_socio"
    );
    return resumirBomba(
      tramos.map((t) => ({ bombaId: t.bombaId ?? null, valor: Number(t.valor), fechaPago: dia(t.fechaPago) })),
      Number(abonos.total),
      await this.parametrosBomba(),
      Number(abonos.sinUsar)
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
      pagoId: a.pagoId ?? null,
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
