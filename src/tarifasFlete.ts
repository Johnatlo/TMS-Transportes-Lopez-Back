/**
 * Deducir el flete de un viaje del cuadro con la matriz de fletes, apenas el
 * viaje entra al cuadro (con o sin manifiesto), para que el valor este para
 * los reportes de fin de mes aunque se demore la facturacion. El envio a
 * facturacion lo puede reemplazar despues.
 *
 * Solo se pone solo cuando es exacto: una tarifa del cliente claramente mejor
 * que las demas (por destino, origen, producto, tipo de carro y urbano), con
 * valor, y sin tarifas de varios clientes o ciudades adicionales (Tolua,
 * Porcelatino: no se sabe cuantos clientes lleva). Si no es exacto, el viaje
 * queda manual y se muestran las tarifas posibles para elegir.
 */
import type { RowDataPacket } from "mysql2";
import { pool } from "./db";

/** Lo que se usa de una tarifa de la matriz (tabla tarifas_flete). */
export interface TarifaMatriz {
  id: number;
  nombre: string;
  razonSocial: string | null;
  valor: number | null;
  tipo: "TON" | "FIJO" | "POR" | "POR3";
  pesoMinimoKg: number | null;
  pesoFijoKg: number | null;
}

/** Lo del viaje que sirve para elegir la tarifa. */
export interface ViajeParaTarifa {
  empresa: string;
  /** "SOACHA CUNDINAMARCA → CALI VALLE DEL CAUCA" o la ruta escrita a mano ("SOACHA - CALI"). */
  ruta: string | null;
  urbano: boolean;
  /** Con S (3S3, 2S) es tractomula (MULA); sin S (2, 3), camion rigido (VOLVO). */
  configuracion: string | null;
  /** Producto de la remesa ("CARTON RECICLADO"): distingue CARTON de ARCHIVO. */
  producto: string | null;
}

/** Una tarifa posible, como se muestra para elegir. */
export interface TarifaPosible {
  id: number;
  nombre: string;
  valor: number | null;
  tipo: TarifaMatriz["tipo"];
}

/** Resultado de la deduccion: la exacta (si la hay) y las posibles. */
export interface Deduccion {
  exacta: TarifaMatriz | null;
  posibles: TarifaPosible[];
}

/** Sufijos legales que no ayudan a reconocer al cliente ("SAS", "LTDA"...). */
const SUFIJOS = /\b(S\s?A\s?S|S\s?A|LTDA|S\s?EN\s?C|E\s?S\s?P|INC|E\s?U)\b/g;

/** Nombre comparable: mayusculas, sin tildes, sin puntuacion y sin sufijos legales. */
export function normalizarNombre(s: string | null | undefined): string {
  return String(s ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(SUFIJOS, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Palabras del nombre, sin la "S" final para que RECICLAJE y RECICLAJES coincidan. */
const palabras = (s: string) =>
  normalizarNombre(s)
    .split(" ")
    .map((p) => p.replace(/S$/, ""))
    .filter(Boolean);

/** Palabras de enlace (ya sin la "S" final) que no ayudan a reconocer al cliente. */
const ENLACE = new Set(["DE", "DEL", "LA", "LO", "EL", "Y", "E", "EN"]);

/**
 * Que tanto se parece una tarifa al cliente (0 = nada): 3 = igual, 2 = uno
 * contiene al otro, 1 = comparten la mayoria de palabras (sin las de enlace
 * ni las letras sueltas). Contra la razon social y contra el nombre.
 */
export function parecido(empresa: string, tarifa: Pick<TarifaMatriz, "nombre" | "razonSocial">): number {
  const e = palabras(empresa).join(" ");
  if (!e) return 0;
  let mejor = 0;
  for (const nombre of [tarifa.razonSocial, tarifa.nombre]) {
    const t = palabras(nombre ?? "").join(" ");
    if (!t) continue;
    if (t === e) mejor = Math.max(mejor, 3);
    else if (t.startsWith(e) || e.startsWith(t)) mejor = Math.max(mejor, 2);
    else {
      const pe = new Set(e.split(" ").filter((p) => p.length > 1 && !ENLACE.has(p)));
      const pt = [...new Set(t.split(" ").filter((p) => p.length > 1 && !ENLACE.has(p)))];
      const comunes = pt.filter((p) => pe.has(p)).length;
      if (comunes > 0 && comunes >= Math.ceil(Math.min(pe.size, pt.length) * 0.6)) mejor = Math.max(mejor, 1);
    }
  }
  return mejor;
}

/** Abreviaturas de ciudades en los nombres de la matriz. */
const ABREVIATURAS: Array<[RegExp, string]> = [
  [/B\s*\/\s*VENTURA/gi, "BUENAVENTURA"],
  [/M\s*\/\s*LLIN|\bMEDELL\b/gi, "MEDELLIN"],
  [/M\s*\/\s*QUERA/gi, "MOSQUERA"],
  [/V\s*\/\s*VICENCIO/gi, "VILLAVICENCIO"],
  [/\bBGTA\b|\bBTA\b/gi, "BOGOTA"],
];

/** Palabras de la tarifa que no son ciudad ni producto: cantidades, adicionales y tipo de carro. */
const NO_CUENTAN = new Set(["C", "Y", "CLI", "ADIC", "MULA", "VOLVO", "URBANO", "TON", "CLIENTES", "RECONOCIDO", "CARTULINA"]);

/** La tarifa es para varios clientes o ciudades adicionales (no se sabe solo con el viaje). */
export const esDeVarios = (t: Pick<TarifaMatriz, "nombre" | "tipo">) =>
  t.tipo === "POR" || t.tipo === "POR3" || /ADIC|CLIENTES|-\s*34\s*TON/i.test(t.nombre);

/**
 * Puntaje de una tarifa para un viaje (mas alto = mejor): cada palabra de su
 * nombre (sin las del cliente) que esta en el destino (+2), el origen (+1) o
 * el producto (+1,5); las que no estan en ninguno restan un poco. Mas el tipo
 * de carro (MULA / VOLVO), urbano, y abajo las de reconocidos de cartulina y
 * las de varios clientes.
 */
export function puntajeTarifa(tarifa: TarifaMatriz, v: ViajeParaTarifa): number {
  const nombre = normalizarNombre(ABREVIATURAS.reduce((n, [re, ciudad]) => n.replace(re, ciudad), tarifa.nombre));
  const delCliente = new Set([...palabras(v.empresa), ...palabras(tarifa.razonSocial ?? "")]);
  const [origen, destino] = (v.ruta ?? "").split(/→| - /).map((p) => ` ${normalizarNombre(p)} `);
  const producto = ` ${normalizarNombre(v.producto)} `;
  let puntos = 0;
  for (const p of nombre.split(" ")) {
    if (!p || /^\d+$/.test(p) || NO_CUENTAN.has(p) || delCliente.has(p.replace(/S$/, ""))) continue;
    if (destino?.includes(` ${p} `)) puntos += 2;
    else if (origen?.includes(` ${p} `)) puntos += 1;
    else if (producto.includes(` ${p} `)) puntos += 1.5;
    else puntos -= 0.25;
  }
  const mula = !v.configuracion || /S/i.test(v.configuracion);
  if (/\bVOLVO\b/.test(nombre)) puntos += mula ? -5 : 2;
  if (/\bMULA\b/.test(nombre)) puntos += mula ? 2 : -5;
  if (/\bURBANO\b/.test(nombre)) puntos += v.urbano ? 3 : -3;
  // Las de reconocidos de cartulina se eligen a mano.
  if (/\bRECONOCIDO\b/.test(nombre)) puntos -= 3;
  if (esDeVarios(tarifa)) puntos -= 2;
  return puntos;
}

/** Primera palabra del origen y del destino del viaje ("YUMBO", "DUITAMA"). */
const ciudadesDe = (v: ViajeParaTarifa) => (v.ruta ?? "").split(/→| - /).map((p) => normalizarNombre(p).split(" ")[0] ?? "");

/** true si el nombre de la tarifa (con las abreviaturas resueltas) trae esa ciudad. */
const nombraCiudad = (tarifa: TarifaMatriz, ciudad: string | undefined) =>
  !!ciudad && ` ${normalizarNombre(ABREVIATURAS.reduce((n, [re, c]) => n.replace(re, c), tarifa.nombre))} `.includes(` ${ciudad} `);

/** true si el nombre de la tarifa trae la ciudad de destino del viaje. */
const nombraDestino = (tarifa: TarifaMatriz, v: ViajeParaTarifa) => nombraCiudad(tarifa, ciudadesDe(v)[1]);

/** true si el nombre de la tarifa trae la ciudad de origen del viaje pero no la de destino. */
function nombraOrigenSinDestino(tarifa: TarifaMatriz, v: ViajeParaTarifa): boolean {
  const [origen, destino] = ciudadesDe(v);
  return !!destino && origen !== destino && nombraCiudad(tarifa, origen) && !nombraCiudad(tarifa, destino);
}

/** Cuantas tarifas posibles se muestran como mucho. */
const MAX_POSIBLES = 8;

/**
 * Deduce la tarifa de un viaje. Exacta solo si: el cliente tiene tarifas, la
 * mejor tiene valor, ninguna otra queda a menos de medio punto, y el cliente no
 * tiene tarifas de varios clientes o ciudades adicionales. Si no, las
 * posibles: la mejor, las que quedan cerca y las de varios clientes.
 */
export function deducirTarifa(v: ViajeParaTarifa, tarifas: TarifaMatriz[]): Deduccion {
  const conParecido = tarifas.map((t) => ({ t, par: parecido(v.empresa, t) })).filter((x) => x.par > 0);
  if (!conParecido.length) return { exacta: null, posibles: [] };
  // Solo las del cliente (mismo nombre o uno contiene al otro), no las que apenas comparten una palabra.
  const minimo = Math.min(Math.max(...conParecido.map((x) => x.par)), 2);
  const delCliente = conParecido
    .filter((x) => x.par >= minimo)
    .map((x) => ({ ...x, p: puntajeTarifa(x.t, v) }))
    .sort((a, b) => b.p - a.p || b.par - a.par || a.t.nombre.length - b.t.nombre.length);
  const mejor = delCliente[0];
  // Empate (o casi): a menos de medio punto de la mejor. Si empata con una que
  // se parece menos al cliente ("EMPAQUES" para Empaques y Papeles WY), gana la de su nombre.
  const cerca = delCliente.slice(1).filter((x) => x.p > mejor.p - 0.5 && x.par >= mejor.par);
  // Si el cliente tiene tarifas de varios clientes o ciudades (Tolua, Porcelatino), nunca es
  // exacto. Se ofrecen las del mismo destino (a Duitama no las de Pereira); si no hay, todas.
  const todasDeVarios = delCliente.slice(1).filter((x) => esDeVarios(x.t));
  const delDestino = nombraDestino(mejor.t, v) ? todasDeVarios.filter((x) => nombraDestino(x.t, v)) : todasDeVarios;
  const deVarios = delDestino.length ? delDestino : todasDeVarios;
  // La tarifa nombra el origen pero no el destino (LAMINADOS B/VENTURA a Medellin): no se sabe si aplica.
  const soloOrigen = nombraOrigenSinDestino(mejor.t, v);
  const exacta =
    !cerca.length && !todasDeVarios.length && !soloOrigen && mejor.t.valor !== null && !esDeVarios(mejor.t) ? mejor.t : null;
  const vistos = new Set<number>();
  const posibles: TarifaPosible[] = [];
  for (const x of [mejor, ...cerca, ...deVarios]) {
    if (vistos.has(x.t.id) || posibles.length >= MAX_POSIBLES) continue;
    vistos.add(x.t.id);
    posibles.push({ id: x.t.id, nombre: x.t.nombre, valor: x.t.valor, tipo: x.t.tipo });
  }
  return { exacta, posibles: exacta ? [] : posibles };
}

/** Lo que va en el viaje con una tarifa: tipo de flete, tarifa por kilo o fijo, adicional y peso a facturar. */
export function fleteDeTarifa(t: TarifaMatriz, pesoKg: number | null) {
  const fijo = t.tipo === "FIJO";
  // Peso a facturar: el fijo de la tarifa, o el real con su minimo (34.000 kg).
  const peso = t.pesoFijoKg ?? (pesoKg === null ? t.pesoMinimoKg : t.pesoMinimoKg && pesoKg < t.pesoMinimoKg ? t.pesoMinimoKg : pesoKg);
  return {
    tarifaFleteId: t.id,
    tipoFlete: fijo ? "FIJO" : "KILO",
    tarifaKilo: fijo || t.valor === null ? null : t.valor / 1000,
    valorFijo: fijo ? t.valor : null,
    // POR (2 clientes) suma 300.000 y POR3 (3 clientes) 600.000.
    fleteAdicional: t.tipo === "POR" ? 300_000 : t.tipo === "POR3" ? 600_000 : null,
    // Solo se guarda si es distinto del real (si no, el cuadro usa el real).
    pesoFacturadoKg: !fijo && peso !== pesoKg ? peso : null,
  };
}

/** La matriz de fletes para deducir (sin las observaciones). */
export async function cargarTarifas(): Promise<TarifaMatriz[]> {
  const [rows] = await pool.query<RowDataPacket[]>(
    "SELECT id, nombre, razonSocial, valor, tipo, pesoMinimoKg, pesoFijoKg FROM tarifas_flete ORDER BY nombre, id"
  );
  const num = (x: unknown) => (x === null || x === undefined ? null : Number(x));
  return rows.map((r) => ({
    id: Number(r.id),
    nombre: String(r.nombre),
    razonSocial: r.razonSocial ?? null,
    valor: num(r.valor),
    tipo: (["TON", "FIJO", "POR", "POR3"].includes(r.tipo) ? r.tipo : "TON") as TarifaMatriz["tipo"],
    pesoMinimoKg: num(r.pesoMinimoKg),
    pesoFijoKg: num(r.pesoFijoKg),
  }));
}
