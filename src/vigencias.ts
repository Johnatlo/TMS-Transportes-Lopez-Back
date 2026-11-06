/**
 * Matrices con vigencia (comisiones, ReteICA por cliente, descuento por galon
 * de la bomba): un cambio no borra el valor anterior, sino que agrega una fila
 * que rige desde una fecha. Cada viaje o anticipo usa el valor vigente en su
 * fecha, asi que los viajes viejos conservan el valor que tenian.
 *
 * - vigenteDesde null: rige desde siempre (las filas de antes de las vigencias).
 * - eliminado: desde esa fecha la fila ya no esta en la matriz.
 */

/** Lo que toda fila de una matriz con vigencia trae. */
export interface FilaVigente {
  id: number;
  /** "2026-11-06" o null (desde siempre). */
  vigenteDesde: string | null;
  eliminado: boolean;
}

/**
 * Las filas que rigen en una fecha: por clave, la de vigenteDesde mas reciente
 * que no pase de la fecha (si empatan, la ultima guardada), sin las quitadas.
 * Salen en el orden en que se agrego cada clave por primera vez (importa: si un
 * cliente aparece dos veces, la matriz usa la primera).
 */
export function vigentesEn<T extends FilaVigente>(filas: T[], clave: (f: T) => string, fecha: string): T[] {
  const mejor = new Map<string, T>();
  const primera = new Map<string, number>();
  for (const f of filas) {
    const k = clave(f);
    primera.set(k, Math.min(primera.get(k) ?? f.id, f.id));
    if (f.vigenteDesde && f.vigenteDesde > fecha) continue;
    const a = mejor.get(k);
    const desde = f.vigenteDesde ?? "";
    const desdeA = a?.vigenteDesde ?? "";
    if (!a || desde > desdeA || (desde === desdeA && f.id > a.id)) mejor.set(k, f);
  }
  return [...mejor.entries()]
    .filter(([, f]) => !f.eliminado)
    .sort(([ka], [kb]) => (primera.get(ka) ?? 0) - (primera.get(kb) ?? 0))
    .map(([, f]) => f);
}

/**
 * Lo que hay que guardar para pasar de las filas vigentes a las nuevas: las
 * que son nuevas o cambiaron (por `igual`) y las claves que ya no estan. Si una
 * clave se repite en las nuevas, vale la ultima.
 */
export function cambiosDeMatriz<A, N>(
  actuales: A[],
  nuevas: N[],
  claveActual: (f: A) => string,
  claveNueva: (f: N) => string,
  igual: (a: A, n: N) => boolean
): { guardar: N[]; quitar: string[] } {
  const porClave = new Map(actuales.map((a) => [claveActual(a), a]));
  const ultimas = new Map(nuevas.map((n) => [claveNueva(n), n]));
  const guardar = [...ultimas.entries()].filter(([k, n]) => !porClave.has(k) || !igual(porClave.get(k)!, n)).map(([, n]) => n);
  const quitar = [...porClave.keys()].filter((k) => !ultimas.has(k));
  return { guardar, quitar };
}

/** "2026-11-06" valido o null. */
export function fechaVigencia(x: unknown): string | null {
  const t = String(x ?? "").slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(t) ? t : null;
}
