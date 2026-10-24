/**
 * Cruce con la bomba: la relacion quincenal de vales que manda la bomba
 * (COESCO: "RELACION VALES DESPACHO - CONSUMO", una por factura, p. ej.
 * AE5044797) contra los anticipos de combustible del TMS.
 *
 * Cada vale trae EDS, numero de vale, fecha, placa, galones y valor. La
 * bomba da combustible y tambien efectivo: cada vale es de uno de los dos
 * (tipo) y se compara con ese valor del tramo; un tramo puede quedar cruzado
 * con un vale de combustible y otro de efectivo. El
 * navegador lee el PDF o el Excel de la relacion (o se arma a mano eligiendo
 * los tanqueos) y manda los vales; aqui se propone a que tramo corresponde
 * cada uno (emparejarVales) y, al confirmar, se guarda la relacion:
 * - el tramo queda cruzado con su vale: el combustible pasa a ser el valor
 *   del vale (lo que cobra la bomba) y se guarda lo que se habia registrado
 *   antes, para ver la diferencia; los galones son los del vale;
 * - el tanqueo queda con el numero y la fecha de la factura de la bomba.
 * Borrar la relacion devuelve los tramos como estaban.
 */
import type { ResultSetHeader, RowDataPacket } from "mysql2";
import { pool } from "./db";
import { anioPosible, dia, ErrorCuadro } from "./cuadro";
import { placaNormal } from "./anticipos";

/** Que entrego la bomba en el vale: combustible (con galones) o efectivo. */
export type TipoVale = "COMBUSTIBLE" | "EFECTIVO";

/** Un vale de la relacion de la bomba. */
export interface ValeBomba {
  tipo: TipoVale;
  /** Estacion como la escribe la bomba ("EDS CHUSACA", "EDS SAN ESTEBAN"). */
  eds: string;
  /** Numero del vale ("V56300011898"); null si la relacion se armo a mano. */
  vale: string | null;
  fecha: string;
  hora: string | null;
  placa: string;
  galones: number | null;
  valor: number;
}

/** Tramo de anticipo que puede cruzarse con vales (de combustible y de efectivo). */
export interface TramoCruzable {
  id: number;
  placa: string;
  fecha: string;
  bomba: string | null;
  combustible: number;
  efectivo: number;
  /** Ya cruzado con un vale de combustible de otra relacion. */
  cruzadoCombustible: boolean;
  /** Ya cruzado con un vale de efectivo de otra relacion. */
  cruzadoEfectivo: boolean;
}

/** Lo que el tramo tiene registrado del tipo del vale. */
export const montoTramo = (t: Pick<TramoCruzable, "combustible" | "efectivo">, tipo: TipoVale) => (tipo === "EFECTIVO" ? t.efectivo : t.combustible);
/** El tramo ya tiene vale de ese tipo. */
const yaCruzado = (t: TramoCruzable, tipo: TipoVale) => (tipo === "EFECTIVO" ? t.cruzadoEfectivo : t.cruzadoCombustible);

/**
 * Como quedo un vale frente a los tramos:
 * - COINCIDE: misma placa, misma estacion, fecha cercana y el mismo valor
 *   (a lo sumo 1.000 de diferencia, por redondeos).
 * - DIFERENCIA: el tramo es ese (placa, estacion y fecha) pero el valor no
 *   coincide: hay que revisar.
 * - SIN_TANQUEO: no hay ningun tramo de esa placa en esa estacion por esas
 *   fechas (la bomba cobra algo que no esta registrado).
 */
export type EstadoVale = "COINCIDE" | "DIFERENCIA" | "SIN_TANQUEO";

export interface ValePropuesto extends ValeBomba {
  tramoId: number | null;
  estado: EstadoVale;
  /** Lo registrado en el tramo propuesto del tipo del vale (combustible o efectivo). */
  combustibleTramo: number | null;
}

/** Diferencia de valor que se acepta como la misma (redondeos de la bomba). */
export const TOLERANCIA_VALE = 1000;
/** Dias de diferencia entre el vale y el anticipo que se aceptan. */
const DIAS_VALE = 2;

/**
 * Estacion comparable: sin "EDS", "S." como "SAN", sin tildes ni signos.
 * "EDS SAN ESTEBAN" y "S. ESTEBAN" -> "SAN ESTEBAN".
 */
export function estacionNormal(nombre: string | null | undefined): string {
  return String(nombre ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/\bEDS\b/g, " ")
    .replace(/\bS\.\s*/g, "SAN ")
    .replace(/[^A-Z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Dias entre dos fechas "AAAA-MM-DD" (sin signo). */
const diasEntre = (a: string, b: string) => Math.abs(Math.round((Date.parse(`${a}T12:00:00Z`) - Date.parse(`${b}T12:00:00Z`)) / 86_400_000));

/**
 * Propone el tramo de cada vale. Candidatos: misma placa, misma estacion (si
 * el tramo tiene bomba), a lo sumo 2 dias de diferencia, con valor del tipo
 * del vale (combustible o efectivo) y sin un vale de ese tipo. Se reparten
 * primero los que coinciden en valor (los mas cercanos en fecha), y luego los
 * demas al tramo libre mas cercano. Un tramo va con un solo vale de cada tipo.
 */
export function emparejarVales(vales: ValeBomba[], tramos: TramoCruzable[]): ValePropuesto[] {
  const usados = new Set<string>();
  const clave = (t: TramoCruzable, tipo: TipoVale) => `${t.id}|${tipo}`;
  const elegido = new Map<number, TramoCruzable>();
  const candidatos = vales.map((v) =>
    tramos
      .filter(
        (t) =>
          !yaCruzado(t, v.tipo) &&
          montoTramo(t, v.tipo) > 0 &&
          placaNormal(t.placa) === placaNormal(v.placa) &&
          (!t.bomba || estacionNormal(t.bomba) === estacionNormal(v.eds)) &&
          diasEntre(t.fecha, v.fecha) <= DIAS_VALE
      )
      .sort((a, b) => diasEntre(a.fecha, v.fecha) - diasEntre(b.fecha, v.fecha) || a.id - b.id)
  );
  // 1. Mismo valor.
  vales.forEach((v, i) => {
    const t = candidatos[i].find((c) => !usados.has(clave(c, v.tipo)) && Math.abs(montoTramo(c, v.tipo) - v.valor) <= TOLERANCIA_VALE);
    if (t) {
      elegido.set(i, t);
      usados.add(clave(t, v.tipo));
    }
  });
  // 2. Lo que quede: el tramo libre mas cercano.
  vales.forEach((v, i) => {
    if (elegido.has(i)) return;
    const t = candidatos[i].find((c) => !usados.has(clave(c, v.tipo)));
    if (t) {
      elegido.set(i, t);
      usados.add(clave(t, v.tipo));
    }
  });
  return vales.map((v, i) => {
    const t = elegido.get(i) ?? null;
    return {
      ...v,
      tramoId: t?.id ?? null,
      combustibleTramo: t ? montoTramo(t, v.tipo) : null,
      estado: !t ? "SIN_TANQUEO" : Math.abs(montoTramo(t, v.tipo) - v.valor) <= TOLERANCIA_VALE ? "COINCIDE" : "DIFERENCIA",
    };
  });
}

/** Una relacion (factura) de la bomba ya cruzada. */
export interface RelacionBomba {
  id: number;
  numero: string;
  fecha: string;
  /** Cuando vence la factura de la bomba (hay que pagarla antes). */
  fechaVencimiento: string | null;
  /** Pago a la bomba en que se pago (con otras facturas de la quincena). */
  pagoId: number | null;
  total: number;
  fechaPago: string | null;
  nota: string | null;
  vales: Array<ValeBomba & { id: number; tramoId: number | null }>;
}

/** Valida los vales que manda el navegador. */
function leerVales(lista: unknown): Array<ValeBomba & { tramoId: number | null }> {
  if (!Array.isArray(lista) || lista.length === 0) throw new ErrorCuadro("La relacion no trae vales.");
  return lista.map((v, i) => {
    const fecha = String(v?.fecha ?? "").slice(0, 10);
    const valor = Number(v?.valor);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha) || !anioPosible(fecha)) throw new ErrorCuadro(`Vale ${i + 1}: la fecha no es valida.`);
    if (!Number.isFinite(valor) || valor <= 0) throw new ErrorCuadro(`Vale ${i + 1}: falta el valor.`);
    const placa = placaNormal(v?.placa);
    if (!placa) throw new ErrorCuadro(`Vale ${i + 1}: falta la placa.`);
    const galones = v?.galones === null || v?.galones === undefined || v?.galones === "" ? null : Number(v.galones);
    return {
      tipo: (v?.tipo === "EFECTIVO" ? "EFECTIVO" : "COMBUSTIBLE") as TipoVale,
      eds: String(v?.eds ?? "").trim().slice(0, 80),
      vale: String(v?.vale ?? "").trim().slice(0, 40) || null,
      fecha,
      hora: String(v?.hora ?? "").trim().slice(0, 8) || null,
      placa,
      galones: galones !== null && Number.isFinite(galones) ? galones : null,
      valor: Math.round(valor),
      tramoId: v?.tramoId ? Number(v.tramoId) : null,
    };
  });
}

/** Tramos que aun pueden cruzarse (y los ya cruzados, marcados por tipo). */
async function tramosCruzables(): Promise<TramoCruzable[]> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT a.id, COALESCE(a.placa, c.placa) AS placa, a.fecha, b.nombre AS bomba, a.combustible, a.efectivo,
            EXISTS (SELECT 1 FROM bomba_relacion_vales rv WHERE rv.cuadroAnticipoId = a.id AND rv.tipo = 'COMBUSTIBLE') AS cruzadoCombustible,
            EXISTS (SELECT 1 FROM bomba_relacion_vales rv WHERE rv.cuadroAnticipoId = a.id AND rv.tipo = 'EFECTIVO') AS cruzadoEfectivo
       FROM cuadro_anticipos a
       LEFT JOIN cuadro_viajes c ON c.id = a.cuadroViajeId
       LEFT JOIN bombas b ON b.id = a.bombaId
      WHERE a.combustible > 0 OR a.efectivo > 0`
  );
  return rows.map((r) => ({
    id: r.id,
    placa: r.placa ?? "",
    fecha: dia(r.fecha)!,
    bomba: r.bomba ?? null,
    combustible: Number(r.combustible ?? 0),
    efectivo: Number(r.efectivo ?? 0),
    cruzadoCombustible: !!r.cruzadoCombustible,
    cruzadoEfectivo: !!r.cruzadoEfectivo,
  }));
}

/** Un pago a la bomba: varias facturas de la quincena menos los abonos de los socios. */
export interface PagoBomba {
  id: number;
  fecha: string;
  totalFacturas: number;
  totalAbonos: number;
  valorPagado: number;
  referencia: string | null;
  relaciones: number[];
  abonos: number[];
}

/** Lo que se le paga a la bomba: el total de las facturas menos lo que abonaron los socios. */
export const valorAPagarBomba = (totalFacturas: number, totalAbonos: number) => Math.max(0, Math.round(totalFacturas - totalAbonos));

/** Relaciones de la bomba: proponer, guardar, listar, pagar y borrar. */
export const relacionesBomba = {
  /** Propone el tramo de cada vale (no guarda). Avisa si la factura ya se cargo. */
  async proponer(d: Record<string, unknown>): Promise<{ vales: ValePropuesto[]; yaExiste: boolean }> {
    const vales = leerVales(d.vales);
    const numero = String(d.numero ?? "").trim();
    const [hay] = await pool.query<RowDataPacket[]>("SELECT id FROM bomba_relaciones WHERE numero = ?", [numero]);
    return { vales: emparejarVales(vales, await tramosCruzables()), yaExiste: !!hay[0] };
  },

  /**
   * Guarda la relacion con sus vales y cruza los tramos elegidos ({ numero,
   * fecha, nota, vales: [{ ...vale, tramoId }] }). En una transaccion.
   */
  async guardar(d: Record<string, unknown>, usuarioId: number | null): Promise<number> {
    const numero = String(d.numero ?? "").trim().toUpperCase().slice(0, 40);
    const fecha = String(d.fecha ?? "").slice(0, 10);
    if (!numero) throw new ErrorCuadro("Escribe el numero de la factura de la bomba.");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) throw new ErrorCuadro("Escribe la fecha de la factura de la bomba.");
    const vence = d.fechaVencimiento ? String(d.fechaVencimiento).slice(0, 10) : null;
    if (vence && !/^\d{4}-\d{2}-\d{2}$/.test(vence)) throw new ErrorCuadro("La fecha de vencimiento no es valida.");
    const vales = leerVales(d.vales);
    const ids = vales.map((v) => v.tramoId).filter((x): x is number => !!x);
    const porTipo = vales.filter((v) => v.tramoId).map((v) => `${v.tramoId}|${v.tipo}`);
    if (new Set(porTipo).size !== porTipo.length) throw new ErrorCuadro("Un tanqueo quedo con dos vales del mismo tipo: revisa la relacion.");
    const total = vales.reduce((s, v) => s + v.valor, 0);
    const conexion = await pool.getConnection();
    try {
      await conexion.beginTransaction();
      const [hay] = await conexion.query<RowDataPacket[]>("SELECT id FROM bomba_relaciones WHERE numero = ?", [numero]);
      if (hay[0]) throw new ErrorCuadro(`La factura ${numero} ya se cruzo. Borrala primero si quieres cargarla de nuevo.`);
      if (ids.length) {
        const [ocupados] = await conexion.query<RowDataPacket[]>(
          "SELECT cuadroAnticipoId, tipo FROM bomba_relacion_vales WHERE cuadroAnticipoId IN (?)",
          [ids]
        );
        if (ocupados.some((o) => porTipo.includes(`${o.cuadroAnticipoId}|${o.tipo}`))) {
          throw new ErrorCuadro("Algun tanqueo ya esta cruzado con otra factura de la bomba.");
        }
      }
      const [r] = await conexion.query<ResultSetHeader>(
        "INSERT INTO bomba_relaciones (numero, fecha, fechaVencimiento, total, nota, creadoPorId) VALUES (?, ?, ?, ?, ?, ?)",
        [numero, fecha, vence, total, String(d.nota ?? "").trim().slice(0, 200) || null, usuarioId]
      );
      for (const v of vales) {
        await conexion.query(
          `INSERT INTO bomba_relacion_vales (relacionId, tipo, eds, vale, fecha, hora, placa, galones, valor, cuadroAnticipoId)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [r.insertId, v.tipo, v.eds, v.vale, v.fecha, v.hora, v.placa, v.galones, v.valor, v.tramoId]
        );
        if (!v.tramoId) continue;
        // El valor del tramo pasa a ser lo que cobra la bomba; se guarda lo de antes.
        if (v.tipo === "EFECTIVO") {
          await conexion.query(
            `UPDATE cuadro_anticipos
                SET efectivoEntregado = COALESCE(efectivoEntregado, efectivo),
                    efectivo = ?, valor = ? + COALESCE(combustible, 0)
              WHERE id = ?`,
            [v.valor, v.valor, v.tramoId]
          );
        } else {
          await conexion.query(
            `UPDATE cuadro_anticipos
                SET combustibleEntregado = COALESCE(combustibleEntregado, combustible),
                    combustible = ?, valor = COALESCE(efectivo, 0) + ?, galones = COALESCE(?, galones)
              WHERE id = ?`,
            [v.valor, v.valor, v.galones, v.tramoId]
          );
        }
        await conexion.query(
          `UPDATE anticipos_tanqueo t JOIN cuadro_anticipos a ON a.tanqueoId = t.id
              SET t.facturaBomba = ?, t.fechaFacturaBomba = ?
            WHERE a.id = ?`,
          [numero, fecha, v.tramoId]
        );
      }
      await conexion.commit();
      return r.insertId;
    } catch (exc) {
      await conexion.rollback();
      throw exc;
    } finally {
      conexion.release();
    }
  },

  /** Relaciones cruzadas, la mas reciente primero, con sus vales. */
  async listar(): Promise<RelacionBomba[]> {
    const [relaciones] = await pool.query<RowDataPacket[]>("SELECT * FROM bomba_relaciones ORDER BY fecha DESC, id DESC");
    const [vales] = await pool.query<RowDataPacket[]>("SELECT * FROM bomba_relacion_vales ORDER BY fecha, hora, id");
    return relaciones.map((r) => ({
      id: r.id,
      numero: r.numero,
      fecha: dia(r.fecha)!,
      fechaVencimiento: dia(r.fechaVencimiento),
      pagoId: r.pagoId ?? null,
      total: Number(r.total),
      fechaPago: dia(r.fechaPago),
      nota: r.nota ?? null,
      vales: vales
        .filter((v) => v.relacionId === r.id)
        .map((v) => ({
          id: v.id,
          tipo: (v.tipo === "EFECTIVO" ? "EFECTIVO" : "COMBUSTIBLE") as TipoVale,
          eds: v.eds,
          vale: v.vale ?? null,
          fecha: dia(v.fecha)!,
          hora: v.hora ?? null,
          placa: v.placa,
          galones: v.galones === null ? null : Number(v.galones),
          valor: Number(v.valor),
          tramoId: v.cuadroAnticipoId ?? null,
        })),
    }));
  },

  /** Cambia la fecha de vencimiento de una factura de la bomba (vacia la quita). */
  async vencimiento(id: number, d: Record<string, unknown>): Promise<void> {
    const fecha = d.fechaVencimiento ? String(d.fechaVencimiento).slice(0, 10) : null;
    if (fecha && !/^\d{4}-\d{2}-\d{2}$/.test(fecha)) throw new ErrorCuadro("La fecha de vencimiento no es valida.");
    await pool.query("UPDATE bomba_relaciones SET fechaVencimiento = ? WHERE id = ?", [fecha, id]);
  },

  /** Pagos a la bomba registrados, el mas reciente primero, con sus facturas y abonos. */
  async pagos(): Promise<PagoBomba[]> {
    const [pagos] = await pool.query<RowDataPacket[]>("SELECT * FROM bomba_pagos ORDER BY fecha DESC, id DESC");
    const [rel] = await pool.query<RowDataPacket[]>("SELECT id, pagoId FROM bomba_relaciones WHERE pagoId IS NOT NULL");
    const [abo] = await pool.query<RowDataPacket[]>("SELECT id, pagoId FROM abonos_socio WHERE pagoId IS NOT NULL");
    return pagos.map((p) => ({
      id: p.id,
      fecha: dia(p.fecha)!,
      totalFacturas: Number(p.totalFacturas),
      totalAbonos: Number(p.totalAbonos),
      valorPagado: Number(p.valorPagado),
      referencia: p.referencia ?? null,
      relaciones: rel.filter((r) => r.pagoId === p.id).map((r) => r.id),
      abonos: abo.filter((a) => a.pagoId === p.id).map((a) => a.id),
    }));
  },

  /**
   * Registra el pago de la quincena ({ relaciones, abonos, fecha, referencia }):
   * las facturas elegidas (sin pagar) quedan pagadas en esa fecha, con sus
   * tramos, y los abonos del socio elegidos quedan usados en este pago (no se
   * vuelven a descontar). Valor pagado = facturas - abonos. En una transaccion.
   */
  async registrarPago(d: Record<string, unknown>, usuarioId: number | null): Promise<number> {
    const ids = (Array.isArray(d.relaciones) ? d.relaciones : []).map(Number).filter((x) => x > 0);
    const abonos = (Array.isArray(d.abonos) ? d.abonos : []).map(Number).filter((x) => x > 0);
    const fecha = String(d.fecha ?? "").slice(0, 10);
    if (ids.length === 0) throw new ErrorCuadro("Elige las facturas de la bomba que se pagan.");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha) || !anioPosible(fecha)) throw new ErrorCuadro("Escribe la fecha del pago a la bomba (con un año posible).");
    const conexion = await pool.getConnection();
    try {
      await conexion.beginTransaction();
      const [rels] = await conexion.query<RowDataPacket[]>("SELECT id, total, pagoId FROM bomba_relaciones WHERE id IN (?)", [ids]);
      if (rels.length !== ids.length || rels.some((r) => r.pagoId)) throw new ErrorCuadro("Alguna factura ya se pago o no existe.");
      const [abs] = abonos.length
        ? await conexion.query<RowDataPacket[]>("SELECT id, valor, pagoId FROM abonos_socio WHERE id IN (?)", [abonos])
        : [[] as RowDataPacket[]];
      if (abs.length !== abonos.length || abs.some((a) => a.pagoId)) throw new ErrorCuadro("Algun abono del socio ya se desconto en otro pago.");
      const totalFacturas = rels.reduce((s, r) => s + Number(r.total), 0);
      const totalAbonos = abs.reduce((s, a) => s + Number(a.valor), 0);
      const [p] = await conexion.query<ResultSetHeader>(
        "INSERT INTO bomba_pagos (fecha, totalFacturas, totalAbonos, valorPagado, referencia, creadoPorId) VALUES (?, ?, ?, ?, ?, ?)",
        [fecha, totalFacturas, totalAbonos, valorAPagarBomba(totalFacturas, totalAbonos), String(d.referencia ?? "").trim().slice(0, 80) || null, usuarioId]
      );
      await conexion.query("UPDATE bomba_relaciones SET pagoId = ?, fechaPago = ? WHERE id IN (?)", [p.insertId, fecha, ids]);
      await conexion.query(
        `UPDATE cuadro_anticipos a JOIN bomba_relacion_vales v ON v.cuadroAnticipoId = a.id
            SET a.fechaPago = ? WHERE v.relacionId IN (?)`,
        [fecha, ids]
      );
      if (abonos.length) await conexion.query("UPDATE abonos_socio SET pagoId = ? WHERE id IN (?)", [p.insertId, abonos]);
      await conexion.commit();
      return p.insertId;
    } catch (exc) {
      await conexion.rollback();
      throw exc;
    } finally {
      conexion.release();
    }
  },

  /** Deshace un pago: sus facturas y tramos quedan sin pagar y los abonos libres. */
  async borrarPago(id: number): Promise<void> {
    await pool.query(
      `UPDATE cuadro_anticipos a JOIN bomba_relacion_vales v ON v.cuadroAnticipoId = a.id
         JOIN bomba_relaciones r ON r.id = v.relacionId
          SET a.fechaPago = NULL WHERE r.pagoId = ?`,
      [id]
    );
    await pool.query("UPDATE bomba_relaciones SET pagoId = NULL, fechaPago = NULL WHERE pagoId = ?", [id]);
    await pool.query("UPDATE abonos_socio SET pagoId = NULL WHERE pagoId = ?", [id]);
    await pool.query("DELETE FROM bomba_pagos WHERE id = ?", [id]);
  },

  /** Se le pago a la bomba la factura: fecha de pago en la relacion y en sus tramos. */
  async pagar(id: number, d: Record<string, unknown>): Promise<void> {
    const fecha = d.fechaPago ? String(d.fechaPago).slice(0, 10) : null;
    if (fecha && !/^\d{4}-\d{2}-\d{2}$/.test(fecha)) throw new ErrorCuadro("La fecha de pago no es valida.");
    await pool.query("UPDATE bomba_relaciones SET fechaPago = ? WHERE id = ?", [fecha, id]);
    await pool.query(
      `UPDATE cuadro_anticipos a JOIN bomba_relacion_vales v ON v.cuadroAnticipoId = a.id
          SET a.fechaPago = ? WHERE v.relacionId = ?`,
      [fecha, id]
    );
  },

  /**
   * Borra una relacion: los tramos vuelven al combustible que tenian antes del
   * cruce y los tanqueos quedan sin el numero de esa factura.
   */
  async borrar(id: number): Promise<void> {
    const [r] = await pool.query<RowDataPacket[]>("SELECT numero FROM bomba_relaciones WHERE id = ?", [id]);
    if (!r[0]) return;
    await pool.query(
      `UPDATE cuadro_anticipos a JOIN bomba_relacion_vales v ON v.cuadroAnticipoId = a.id AND v.tipo = 'COMBUSTIBLE'
          SET a.combustible = COALESCE(a.combustibleEntregado, a.combustible),
              a.valor = COALESCE(a.efectivo, 0) + COALESCE(a.combustibleEntregado, a.combustible),
              a.combustibleEntregado = NULL
        WHERE v.relacionId = ?`,
      [id]
    );
    await pool.query(
      `UPDATE cuadro_anticipos a JOIN bomba_relacion_vales v ON v.cuadroAnticipoId = a.id AND v.tipo = 'EFECTIVO'
          SET a.efectivo = COALESCE(a.efectivoEntregado, a.efectivo),
              a.valor = COALESCE(a.efectivoEntregado, a.efectivo) + COALESCE(a.combustible, 0),
              a.efectivoEntregado = NULL
        WHERE v.relacionId = ?`,
      [id]
    );
    await pool.query("UPDATE anticipos_tanqueo SET facturaBomba = NULL, fechaFacturaBomba = NULL WHERE facturaBomba = ?", [r[0].numero]);
    await pool.query("DELETE FROM bomba_relaciones WHERE id = ?", [id]);
  },
};
