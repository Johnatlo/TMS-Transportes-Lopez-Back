/**
 * Reglas del libro de gastos sin base de datos (se prueban en
 * reglasGastos.test.ts):
 *
 * - Gastos recurrentes (arriendo, honorarios, servicios): los periodos que ya
 *   tocaron (mensual o quincenal) y el valor vigente en cada uno. Cuando el
 *   valor cambia se registra desde una fecha: los periodos anteriores
 *   conservan el valor de su momento (el historico no se pierde).
 * - Gastos que pueden estar repetidos: la misma factura que llega por correo
 *   y en fisico (en las cuentas de los carros). Se buscan por el numero de
 *   factura, o por el mismo valor y fecha con una descripcion parecida.
 */
import { fechaDePeriodo } from "./prorrateo";
import type { Periodicidad } from "./prorrateo";

/** Fechas de los periodos de un recurrente desde `desde` hasta `hasta` (o hoy), los dos incluidos. */
export function periodosRecurrente(desde: string, hasta: string | null, hoy: string, periodicidad: Periodicidad): string[] {
  const limite = hasta && hasta < hoy ? hasta : hoy;
  const fechas: string[] = [];
  for (let i = 0; i < 2400; i++) {
    const f = fechaDePeriodo(desde, i, periodicidad);
    if (f > limite) break;
    fechas.push(f);
  }
  return fechas;
}

/** Un valor de un recurrente desde una fecha. */
export interface ValorDesde {
  desde: string;
  monto: number;
}

/** El valor vigente en una fecha: el ultimo que empezo antes o ese dia (null si ninguno). */
export function valorEn(valores: ValorDesde[], fecha: string): number | null {
  const vigente = [...valores].filter((v) => v.desde <= fecha).sort((a, b) => b.desde.localeCompare(a.desde))[0];
  return vigente ? vigente.monto : null;
}

/** Texto para comparar: sin tildes ni signos, en mayuscula y sin espacios de mas. */
export const textoComparable = (t: string | null | undefined) =>
  String(t ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .trim();

/** Numero de factura comparable: solo letras y numeros, sin ceros a la izquierda ("FE-00123" = "FE123"). */
export const facturaComparable = (f: string | null | undefined) =>
  textoComparable(f)
    .replace(/ /g, "")
    .replace(/^([A-Z]*)0+(?=\d)/, "$1");

/** Las descripciones se parecen: una contiene a la otra, o comparten la mitad de sus palabras (de 3 letras o mas). */
export function descripcionesParecidas(a: string, b: string): boolean {
  const x = textoComparable(a);
  const y = textoComparable(b);
  if (!x || !y) return false;
  if (x.includes(y) || y.includes(x)) return true;
  const palabras = (t: string) => new Set(t.split(" ").filter((p) => p.length >= 3));
  const px = palabras(x);
  const py = palabras(y);
  const comunes = [...px].filter((p) => py.has(p)).length;
  return comunes > 0 && comunes >= Math.ceil(Math.min(px.size, py.size) / 2);
}

/** Lo que se compara de un gasto para buscar repetidos. */
export interface GastoComparable {
  id?: number;
  empresa: string;
  descripcion: string;
  numeroFactura: string | null;
  /** Fecha de pago o, si no tiene, la del gasto. */
  fecha: string;
  monto: number;
}

/** Un gasto que puede ser el mismo y por que. */
export interface PosibleDuplicado<T extends GastoComparable> {
  gasto: T;
  motivo: string;
}

/**
 * Gastos ya guardados que pueden ser el mismo que el nuevo: la misma factura
 * (mismo numero en la misma empresa), o el mismo valor y la misma fecha con
 * una descripcion parecida.
 */
export function posiblesDuplicados<T extends GastoComparable>(nuevo: GastoComparable, existentes: T[]): PosibleDuplicado<T>[] {
  const factura = facturaComparable(nuevo.numeroFactura);
  const resultado: PosibleDuplicado<T>[] = [];
  for (const g of existentes) {
    if (nuevo.id && g.id === nuevo.id) continue;
    if (factura && g.empresa === nuevo.empresa && facturaComparable(g.numeroFactura) === factura) {
      resultado.push({ gasto: g, motivo: `misma factura ${g.numeroFactura}` });
      continue;
    }
    if (g.fecha === nuevo.fecha && Math.abs(g.monto - nuevo.monto) < 0.01 && descripcionesParecidas(g.descripcion, nuevo.descripcion)) {
      resultado.push({ gasto: g, motivo: "mismo valor y fecha, y descripcion parecida" });
    }
  }
  return resultado;
}
