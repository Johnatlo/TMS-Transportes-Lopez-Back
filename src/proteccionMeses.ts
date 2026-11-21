/**
 * Reglas de los meses congelados, sin base de datos (se prueban en
 * proteccionMeses.test.ts). Ver proteccion.ts.
 */

/** "2026-10" -> "2026-11-01". */
const primeroDelSiguiente = (mes: string) => {
  const [a, m] = mes.split("-").map(Number);
  return m === 12 ? `${a + 1}-01-01` : `${a}-${String(m + 1).padStart(2, "0")}-01`;
};

/**
 * Si un valor que rige desde `desde` tocaria un mes congelado (ese mes o uno
 * posterior), el primer dia desde el que si podria regir (el 1 del mes
 * siguiente al ultimo congelado); null si no toca ninguno.
 */
export function primerDiaLibre(congelados: Set<string>, desde: string): string | null {
  const tocados = [...congelados].filter((m) => m >= desde.slice(0, 7)).sort();
  return tocados.length ? primeroDelSiguiente(tocados[tocados.length - 1]) : null;
}

/**
 * Los meses congelados que tocaria cambiar un valor de la matriz de fletes
 * conductor: los de los viajes (fechas) de esa tarifa que caen en el tramo en
 * que rige el valor (desde `desde` hasta antes de `hasta`, o sin fin).
 */
export function mesesTocados(fechasViajes: string[], desde: string, hasta: string | null, congelados: Set<string>): string[] {
  return [...new Set(fechasViajes.filter((f) => f >= desde && (!hasta || f < hasta)).map((f) => f.slice(0, 7)))].filter((m) => congelados.has(m)).sort();
}
