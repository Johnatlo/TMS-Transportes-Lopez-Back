/**
 * Envio a facturacion: el cuadro que se le manda a la contadora (que factura
 * en World Office) con los viajes listos para facturar, y la matriz de fletes
 * de la que salen los valores sugeridos.
 *
 * - La matriz se importa desde el Excel "MATRIZ FLETES" (el frontend lo lee y
 *   manda las filas); no vive en el repositorio porque son precios reales.
 * - Lo que la matriz sugiere (valor, peso minimo) se puede cambiar en cada
 *   viaje: hay valores negociados aparte. Al enviar, lo editado queda en el
 *   viaje del cuadro pagos (flete, peso facturado, nota, remision, factura).
 */
import type { ResultSetHeader, RowDataPacket } from "mysql2";
import { pool } from "./db";
import { cuadro, ErrorCuadro, TARIFA_KILO_MAXIMA } from "./cuadro";
import type { FilaCuadro } from "./cuadro";

export type TipoTarifa = "TON" | "FIJO" | "POR" | "POR3";
export const TIPOS_TARIFA: TipoTarifa[] = ["TON", "FIJO", "POR", "POR3"];

export interface TarifaFlete {
  id: number;
  /** Como la llaman en la matriz: cliente y ruta ("CORAME", "TOLUA BOGOTA"...). */
  nombre: string;
  /** Cliente que se factura. */
  razonSocial: string | null;
  /** TON: por tonelada. FIJO: por viaje. POR / POR3: por tonelada + 300.000 / 600.000 (2 o 3 clientes). */
  valor: number | null;
  tipo: TipoTarifa;
  /** Si va por menos de este peso, se factura este (34000, 32000 kg). */
  pesoMinimoKg: number | null;
  /** Peso que se factura siempre, sin importar el tiquete (33000 kg). */
  pesoFijoKg: number | null;
  observaciones: string | null;
}

/** Texto recortado; vacio -> null. */
const texto = (v: unknown, max: number): string | null => {
  const t = String(v ?? "").trim();
  return t ? t.slice(0, max) : null;
};
/** Numero positivo; vacio o invalido -> null. */
const numero = (v: unknown): number | null => {
  if (v === null || v === undefined || String(v).trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
};

/** Valida y normaliza una tarifa recibida (de la importacion o de una edicion). */
export function normalizarTarifa(t: Record<string, unknown>): Omit<TarifaFlete, "id"> {
  const nombre = texto(t.nombre, 200);
  if (!nombre) throw new ErrorCuadro("Cada tarifa necesita un nombre.");
  const tipo = String(t.tipo ?? "TON").trim().toUpperCase();
  return {
    nombre,
    razonSocial: texto(t.razonSocial, 200),
    valor: numero(t.valor),
    tipo: (TIPOS_TARIFA as string[]).includes(tipo) ? (tipo as TipoTarifa) : "TON",
    pesoMinimoKg: numero(t.pesoMinimoKg) === null ? null : Math.round(numero(t.pesoMinimoKg)!),
    pesoFijoKg: numero(t.pesoFijoKg) === null ? null : Math.round(numero(t.pesoFijoKg)!),
    observaciones: texto(t.observaciones, 500),
  };
}

/** Fila de tarifas_flete -> TarifaFlete. */
const mapearTarifa = (r: RowDataPacket): TarifaFlete => ({
  id: r.id,
  nombre: r.nombre,
  razonSocial: r.razonSocial ?? null,
  valor: r.valor === null ? null : Number(r.valor),
  tipo: r.tipo,
  pesoMinimoKg: r.pesoMinimoKg ?? null,
  pesoFijoKg: r.pesoFijoKg ?? null,
  observaciones: r.observaciones ?? null,
});

/** Un viaje listo para facturar, con lo que hace falta para el cuadro de la contadora. */
export type FilaPorFacturar = FilaCuadro & {
  /** Radicado de la remesa en el RNDC (puede no haber: viajes sin planillar). */
  radicadoRemesa: string | null;
};

/** Matriz de fletes y envio a facturacion: lectura y escritura en la base. */
export const facturacion = {
  /** La matriz de fletes, por nombre. */
  async tarifas(): Promise<TarifaFlete[]> {
    const [rows] = await pool.query<RowDataPacket[]>("SELECT * FROM tarifas_flete ORDER BY nombre, id");
    return rows.map(mapearTarifa);
  },

  /**
   * Reemplaza la matriz completa por la importada (en una transaccion: si algo
   * falla queda la anterior). Los viajes que apuntaban a tarifas viejas
   * conservan su valor; solo pierden el enlace a la tarifa.
   */
  async reemplazarTarifas(lista: Record<string, unknown>[]): Promise<number> {
    if (!Array.isArray(lista) || lista.length === 0) throw new ErrorCuadro("La matriz importada no trae tarifas.");
    const tarifas = lista.map(normalizarTarifa);
    const conexion = await pool.getConnection();
    try {
      await conexion.beginTransaction();
      await conexion.query("UPDATE cuadro_viajes SET tarifaFleteId = NULL WHERE tarifaFleteId IS NOT NULL");
      await conexion.query("DELETE FROM tarifas_flete");
      await conexion.query(
        "INSERT INTO tarifas_flete (nombre, razonSocial, valor, tipo, pesoMinimoKg, pesoFijoKg, observaciones) VALUES ?",
        [tarifas.map((t) => [t.nombre, t.razonSocial, t.valor, t.tipo, t.pesoMinimoKg, t.pesoFijoKg, t.observaciones])]
      );
      await conexion.commit();
    } catch (exc) {
      await conexion.rollback();
      throw exc;
    } finally {
      conexion.release();
    }
    return tarifas.length;
  },

  /** Agrega una tarifa a la matriz sin importar el Excel, y la devuelve. */
  async crearTarifa(datos: Record<string, unknown>): Promise<TarifaFlete> {
    const t = normalizarTarifa(datos);
    const [res] = await pool.query<ResultSetHeader>(
      "INSERT INTO tarifas_flete (nombre, razonSocial, valor, tipo, pesoMinimoKg, pesoFijoKg, observaciones) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [t.nombre, t.razonSocial, t.valor, t.tipo, t.pesoMinimoKg, t.pesoFijoKg, t.observaciones]
    );
    return { id: res.insertId, ...t };
  },

  /** Cambia una tarifa (nombre, razon social, valor, tipo, pesos, observaciones) y la devuelve. */
  async actualizarTarifa(id: number, datos: Record<string, unknown>): Promise<TarifaFlete | null> {
    const [rows] = await pool.query<RowDataPacket[]>("SELECT * FROM tarifas_flete WHERE id = ?", [id]);
    if (!rows[0]) return null;
    const t = normalizarTarifa({ ...mapearTarifa(rows[0]), ...datos });
    await pool.query(
      "UPDATE tarifas_flete SET nombre = ?, razonSocial = ?, valor = ?, tipo = ?, pesoMinimoKg = ?, pesoFijoKg = ?, observaciones = ? WHERE id = ?",
      [t.nombre, t.razonSocial, t.valor, t.tipo, t.pesoMinimoKg, t.pesoFijoKg, t.observaciones, id]
    );
    return { id, ...t };
  },

  /**
   * Viajes listos para facturar (papeles radicados, sin factura con fecha), y
   * los ya enviados a la contadora que aun no tienen fecha de factura (para
   * poder volver a generar el cuadro). Con el radicado de la remesa y la
   * ultima tarifa usada con cada cliente (para sugerirla).
   */
  async porFacturar(): Promise<{ filas: FilaPorFacturar[]; ultimaTarifa: Record<string, number> }> {
    const filas = (await cuadro.listar()).filter(
      (f) => !f.anulado && !f.facturaFecha && !f.facturaFechaPago && (((f.estado === "RADICADO" || f.estado === "RADICADOS") && f.estadoFactura === "SIN_FACTURAR") || !!f.enviadoFacturarEn)
    );
    const remesas = filas.map((f) => f.viajeRemesaId).filter((x): x is number => !!x);
    const radicados = new Map<number, string>();
    if (remesas.length) {
      const [rows] = await pool.query<RowDataPacket[]>(
        "SELECT id, numeroRemesaRndc FROM viaje_remesas WHERE id IN (?)",
        [remesas]
      );
      for (const r of rows) if (r.numeroRemesaRndc) radicados.set(r.id, String(r.numeroRemesaRndc));
    }
    // Ultima tarifa usada con cada cliente: la mas probable para el siguiente viaje.
    const [usadas] = await pool.query<RowDataPacket[]>(
      `SELECT c.empresa, c.tarifaFleteId FROM cuadro_viajes c
         JOIN (SELECT empresa, MAX(id) AS id FROM cuadro_viajes WHERE tarifaFleteId IS NOT NULL GROUP BY empresa) u
           ON u.id = c.id`
    );
    return {
      filas: filas.map((f) => ({ ...f, radicadoRemesa: f.viajeRemesaId ? radicados.get(f.viajeRemesaId) ?? null : null })),
      ultimaTarifa: Object.fromEntries(usadas.map((u) => [u.empresa, u.tarifaFleteId])),
    };
  },

  /**
   * Guarda en cada viaje lo que se envia a facturar y marca la fecha de envio.
   *
   * Por viaje: tarifa de la matriz, tipo (TON: valor por tonelada y peso
   * facturado; FIJO: el total), remision, nota de la factura y consecutivo de
   * factura (manual: hay varias empresas). El flete del cuadro pagos queda con
   * estos valores. Todo en una transaccion.
   */
  async guardarEnvio(filas: Record<string, unknown>[]): Promise<number> {
    if (!Array.isArray(filas) || filas.length === 0) throw new ErrorCuadro("Elige al menos un viaje.");
    const conexion = await pool.getConnection();
    try {
      await conexion.beginTransaction();
      for (const f of filas) {
        const id = Number(f.id);
        if (!id) throw new ErrorCuadro("Falta el viaje.");
        const fijo = String(f.tipo ?? "TON").toUpperCase() === "FIJO";
        const valorTon = numero(f.valorTon);
        // Mismo tope que en el cuadro: mas de 1.000 $/kg es un error de digitacion.
        if (!fijo && valorTon !== null && valorTon / 1000 > TARIFA_KILO_MAXIMA) {
          throw new ErrorCuadro(
            `Viaje ${id}: ${valorTon.toLocaleString("es-CO")} por tonelada es demasiado (mas de ${TARIFA_KILO_MAXIMA.toLocaleString("es-CO")} $/kg). Revisa el valor por tonelada.`
          );
        }
        const total = numero(f.total);
        const [res] = await conexion.query<ResultSetHeader>(
          `UPDATE cuadro_viajes SET
              tarifaFleteId = ?, tipoFlete = ?, tarifaKilo = ?, valorFijo = ?, fleteAdicional = ?, pesoFacturadoKg = ?,
              remision = ?, notaFactura = ?, facturaNumero = COALESCE(?, facturaNumero), enviadoFacturarEn = ?
            WHERE id = ? AND anulado = 0`,
          [
            numero(f.tarifaFleteId),
            fijo ? "FIJO" : "KILO",
            fijo || valorTon === null ? null : valorTon / 1000,
            fijo ? total : null,
            fijo ? null : numero(f.adicional),
            numero(f.pesoFacturadoKg),
            texto(f.remision, 60),
            texto(f.notaFactura, 300),
            texto(f.facturaNumero, 30),
            new Date(),
            id,
          ]
        );
        if (res.affectedRows === 0) throw new ErrorCuadro(`El viaje ${id} no existe o esta anulado.`);
      }
      await conexion.commit();
    } catch (exc) {
      await conexion.rollback();
      throw exc;
    } finally {
      conexion.release();
    }
    return filas.length;
  },
};
