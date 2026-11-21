/**
 * Meses congelados: los que ya se cerraron o se pagaron, y que una matriz no
 * puede cambiar hacia atras (las reglas, sin base de datos, en proteccionMeses.ts).
 *
 * - Cerrados en Gastos (periodos_cierre) o con el reparto de utilidades
 *   aprobado (repartos_utilidades): congelan las matrices de Rentabilidad
 *   (comisiones y ReteICA por cliente).
 * - Ademas, para la matriz de fletes conductor: los meses del producido de
 *   una nomina aprobada y los meses con alguna liquidacion de conductor
 *   pagada.
 *
 * Un cambio de una matriz que rija desde una fecha no puede tocar viajes de un
 * mes congelado: el valor nuevo debe empezar despues del ultimo de esos meses.
 */
import type { RowDataPacket } from "mysql2/promise";
import { pool } from "./db";
import { ErrorCuadro } from "./cuadro";
import { primerDiaLibre } from "./proteccionMeses";

/** Meses ("AAAA-MM") cerrados en Gastos o con el reparto de utilidades aprobado. */
export async function mesesCerrados(): Promise<Set<string>> {
  const [cierres] = await pool.query<RowDataPacket[]>("SELECT mes FROM periodos_cierre UNION SELECT mes FROM repartos_utilidades");
  return new Set(cierres.map((c) => String(c.mes)));
}

/** Meses congelados para el producido conductor: cerrados + nomina aprobada (mes de su producido) + liquidacion pagada. */
export async function mesesCongeladosConductores(): Promise<Set<string>> {
  const meses = await mesesCerrados();
  const [nominas] = await pool.query<RowDataPacket[]>(
    "SELECT DISTINCT DATE_FORMAT(COALESCE(producidoDesde, desde), '%Y-%m') AS mes FROM nominas WHERE estado = 'APROBADA'",
  );
  const [pagadas] = await pool.query<RowDataPacket[]>("SELECT DISTINCT mes FROM liquidaciones_conductor");
  for (const f of [...nominas, ...pagadas]) meses.add(String(f.mes));
  return meses;
}

/**
 * Una matriz de Rentabilidad no puede regir desde una fecha que caiga en un
 * mes cerrado o con el reparto aprobado (ni antes de uno): cambiaria cuentas
 * ya cerradas.
 */
export async function exigirVigenciaLibre(desde: string, que: string): Promise<void> {
  const libre = primerDiaLibre(await mesesCerrados(), desde);
  if (libre)
    throw new ErrorCuadro(
      `${que}: desde el ${desde.split("-").reverse().join("/")} cambiaria meses ya cerrados en Gastos o con el reparto aprobado. Usa una fecha desde el ${libre.split("-").reverse().join("/")}.`,
    );
}
