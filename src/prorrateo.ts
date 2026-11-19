/**
 * Calculos del libro de gastos, sin base de datos (se prueban en
 * prorrateo.test.ts). Todo en CENTAVOS enteros: asi las sumas dan exactas y
 * no hay errores de punto flotante.
 *
 * - repartir: divide un monto por pesos y reparte los centavos sobrantes.
 * - repartirGasto: aplica los destinos de un gasto: primero las partes fijas
 *   y los porcentajes (a un socio o a una placa) y lo que queda entre los que
 *   van "por partes" (los vehiculos marcados, una parte por carro).
 * - causaciones: reparte un gasto en cuotas mensuales (un seguro anual en 12).
 * - amortizar: tabla de un credito de cuota fija (capital, interes y saldo).
 */

/** Pesos (numero o texto "1234.50") a centavos enteros. */
export const aCentavos = (v: number | string): number => Math.round(Number(v) * 100);
/** Centavos a pesos con dos decimales (para guardar en DECIMAL y mostrar). */
export const aPesos = (centavos: number): number => Math.round(centavos) / 100;

/**
 * Reparte `total` (centavos) en proporcion a `pesos`. Lo que no da exacto se
 * reparte de a un centavo a los de mayor residuo (y, si empatan, a los
 * primeros), para que la suma sea siempre el total.
 */
export function repartir(total: number, pesos: number[]): number[] {
  const suma = pesos.reduce((s, p) => s + p, 0);
  if (suma <= 0 || pesos.some((p) => p < 0)) throw new Error("Los pesos deben ser positivos.");
  const signo = total < 0 ? -1 : 1;
  const abs = Math.abs(total);
  const exactos = pesos.map((p) => (abs * p) / suma);
  const partes = exactos.map((e) => Math.floor(e + 1e-9));
  let faltan = abs - partes.reduce((s, p) => s + p, 0);
  const orden = exactos.map((e, i) => ({ i, residuo: e - partes[i] })).sort((a, b) => b.residuo - a.residuo || a.i - b.i);
  for (let k = 0; faltan > 0; k++, faltan--) partes[orden[k % orden.length].i] += 1;
  return partes.map((p) => signo * p);
}

/** A quien va una parte del gasto. */
export interface Destino {
  /** EMPRESA: lo asume la empresa (no se carga a ningun vehiculo ni socio; id 0). */
  tipo: "VEHICULO" | "SOCIO" | "EMPRESA";
  /** Id del vehiculo o del socio (0 para la empresa). */
  id: number;
  /**
   * FIJO: `valor` pesos; PORCENTAJE: `valor` % del gasto; PARTE: `valor`
   * partes de lo que quede (un carro marcado = 1 parte).
   */
  modo: "FIJO" | "PORCENTAJE" | "PARTE";
  valor: number;
}

/** Lo que le toco a un destino (centavos). */
export interface ParteRepartida {
  tipo: Destino["tipo"];
  id: number;
  monto: number;
}

/** Error de datos del gasto (se muestra al usuario). */
export class ErrorReparto extends Error {}

/**
 * Reparte un gasto (centavos) entre sus destinos: primero lo fijo y los
 * porcentajes, y el resto por partes. Debe quedar repartido todo: si sobra y
 * no hay destinos por partes, o lo fijo pasa del total, es un error. Un mismo
 * destino puede aparecer dos veces (Celso: su parte fija y su carro): se suma.
 */
export function repartirGasto(total: number, destinos: Destino[]): ParteRepartida[] {
  if (total <= 0) throw new ErrorReparto("El valor del gasto debe ser mayor que cero.");
  if (!destinos.length) throw new ErrorReparto("Elige a que vehiculos, socios o a la empresa va el gasto.");
  if (destinos.some((d) => !(d.valor > 0))) throw new ErrorReparto("Cada destino necesita un valor mayor que cero.");
  const directos = destinos.filter((d) => d.modo !== "PARTE");
  const porPartes = destinos.filter((d) => d.modo === "PARTE");
  const montos = new Map<Destino, number>();
  for (const d of directos) montos.set(d, d.modo === "FIJO" ? aCentavos(d.valor) : Math.round((total * d.valor) / 100));
  const fijo = [...montos.values()].reduce((s, m) => s + m, 0);
  const resto = total - fijo;
  if (resto < 0) throw new ErrorReparto("Las partes fijas suman mas que el valor del gasto.");
  if (resto > 0 && !porPartes.length) {
    throw new ErrorReparto(`Faltan ${aPesos(resto).toLocaleString("es-CO")} por repartir: marca los vehiculos o completa las partes.`);
  }
  if (porPartes.length) {
    const partes = repartir(
      resto,
      porPartes.map((d) => d.valor),
    );
    porPartes.forEach((d, i) => montos.set(d, partes[i]));
  }
  // Un destino repetido se suma en una sola linea.
  const juntos = new Map<string, ParteRepartida>();
  for (const d of destinos) {
    const clave = `${d.tipo}|${d.id}`;
    const previo = juntos.get(clave);
    if (previo) previo.monto += montos.get(d) ?? 0;
    else juntos.set(clave, { tipo: d.tipo, id: d.id, monto: montos.get(d) ?? 0 });
  }
  return [...juntos.values()].filter((p) => p.monto !== 0);
}

/** Suma `meses` a una fecha "AAAA-MM-DD"; si el dia no existe en ese mes (31 en febrero), el ultimo del mes. */
export function sumarMeses(fecha: string, meses: number): string {
  const [a, m, d] = fecha.split("-").map(Number);
  const total = a * 12 + (m - 1) + meses;
  const anio = Math.floor(total / 12);
  const mes = (total % 12) + 1;
  const ultimo = new Date(Date.UTC(anio, mes, 0)).getUTCDate();
  return `${anio}-${String(mes).padStart(2, "0")}-${String(Math.min(d, ultimo)).padStart(2, "0")}`;
}

/** Cada cuanto se repite un gasto o se reparte en cuotas. */
export type Periodicidad = "MENSUAL" | "QUINCENAL";

/**
 * Fecha del periodo `i` (0 = el primero) desde `desde`: mensual, el mismo dia
 * de cada mes; quincenal, cada 15 dias dentro del mes (el 5 y el 20; el 1 y
 * el 16), siguiendo el mismo dia en los meses siguientes.
 */
export function fechaDePeriodo(desde: string, i: number, periodicidad: Periodicidad = "MENSUAL"): string {
  if (periodicidad === "MENSUAL") return sumarMeses(desde, i);
  const base = sumarMeses(desde, Math.floor(i / 2));
  if (i % 2 === 0) return base;
  return new Date(Date.parse(base) + 15 * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Causaciones de un gasto: `cuotas` periodos seguidos (meses o quincenas)
 * desde `desde`, en partes iguales (los centavos sobrantes van a las
 * primeras). Una cuota = el gasto completo en esa fecha.
 */
export function causaciones(total: number, desde: string, cuotas: number, periodicidad: Periodicidad = "MENSUAL"): Array<{ fecha: string; monto: number }> {
  if (!Number.isInteger(cuotas) || cuotas < 1 || cuotas > 120) throw new ErrorReparto("Las cuotas de causacion van de 1 a 120.");
  return repartir(total, Array(cuotas).fill(1)).map((monto, i) => ({ fecha: fechaDePeriodo(desde, i, periodicidad), monto }));
}

/**
 * Causaciones por dias: reparte `total` entre los meses calendario que cubre
 * el periodo `desde`..`hasta` (los dos incluidos), en proporcion a los dias
 * de cada mes. Es como se lleva una nomina del 21/10 al 20/11 a la
 * rentabilidad: 11 dias a octubre y 20 a noviembre. Cada causacion lleva la
 * fecha en que empieza su tramo.
 */
export function causacionesPorDias(total: number, desde: string, hasta: string): Array<{ fecha: string; monto: number }> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(desde) || !/^\d{4}-\d{2}-\d{2}$/.test(hasta) || hasta < desde) throw new ErrorReparto("El periodo no es valido.");
  const tramos: Array<{ fecha: string; dias: number }> = [];
  const ms = (f: string) => Date.UTC(Number(f.slice(0, 4)), Number(f.slice(5, 7)) - 1, Number(f.slice(8, 10)));
  let inicio = desde;
  while (inicio <= hasta) {
    const [a, m] = inicio.split("-").map(Number);
    const finMes = new Date(Date.UTC(a, m, 0)).toISOString().slice(0, 10);
    const fin = finMes < hasta ? finMes : hasta;
    tramos.push({ fecha: inicio, dias: Math.round((ms(fin) - ms(inicio)) / 86_400_000) + 1 });
    inicio = new Date(ms(fin) + 86_400_000).toISOString().slice(0, 10);
  }
  if (tramos.length > 120) throw new ErrorReparto("El periodo es demasiado largo.");
  return repartir(total, tramos.map((t) => t.dias)).map((monto, i) => ({ fecha: tramos[i].fecha, monto }));
}

/** Una cuota de la tabla de amortizacion (centavos). */
export interface CuotaCredito {
  numero: number;
  fecha: string;
  cuota: number;
  capital: number;
  interes: number;
  /** Saldo de capital despues de pagar esta cuota. */
  saldo: number;
}

/**
 * Tabla de amortizacion de un credito de cuota fija (sistema frances).
 * `tasaMensual` en fraccion (0.016725 = 1,6725 %). Si se da `cuotaFija` (la
 * que cobra el banco) se usa esa; si no, se calcula. La ultima cuota se
 * ajusta para que el saldo quede en cero.
 */
export function amortizar(monto: number, tasaMensual: number, plazo: number, primeraCuota: string, cuotaFija?: number | null): CuotaCredito[] {
  if (monto <= 0) throw new ErrorReparto("El monto del credito debe ser mayor que cero.");
  if (!Number.isInteger(plazo) || plazo < 1 || plazo > 480) throw new ErrorReparto("El plazo va de 1 a 480 cuotas.");
  if (tasaMensual < 0 || tasaMensual >= 1) throw new ErrorReparto("La tasa mensual no es valida (en porcentaje, por ejemplo 1,67).");
  const calculada = tasaMensual === 0 ? Math.round(monto / plazo) : Math.round((monto * tasaMensual) / (1 - Math.pow(1 + tasaMensual, -plazo)));
  const cuota = cuotaFija && cuotaFija > 0 ? cuotaFija : calculada;
  const tabla: CuotaCredito[] = [];
  let saldo = monto;
  for (let n = 1; n <= plazo; n++) {
    const interes = Math.round(saldo * tasaMensual);
    // La ultima cuota paga lo que quede.
    const capital = n === plazo ? saldo : Math.min(saldo, Math.max(0, cuota - interes));
    saldo -= capital;
    tabla.push({ numero: n, fecha: sumarMeses(primeraCuota, n - 1), cuota: capital + interes, capital, interes, saldo });
  }
  return tabla;
}

/**
 * Tasa mensual (en fraccion) que da una cuota fija: la que hace que `plazo`
 * cuotas de `cuota` paguen `monto` (sistema frances). Se usa para separar
 * capital e interes de un credito con la cuota que cobra el banco, sin tener
 * que escribir la tasa (que cambia mes a mes). Si la cuota no alcanza a pagar
 * el monto, error; si lo paga justo sin interes, 0.
 */
export function tasaImplicita(monto: number, plazo: number, cuota: number): number {
  if (!(monto > 0) || !(cuota > 0) || !Number.isInteger(plazo) || plazo < 1) throw new ErrorReparto("Revisa el monto, el plazo y la cuota del credito.");
  if (cuota * plazo < monto - 1) throw new ErrorReparto("Con esa cuota y ese plazo no se alcanza a pagar el monto.");
  if (cuota * plazo <= monto + 1) return 0;
  const valor = (t: number) => (monto * t) / (1 - Math.pow(1 + t, -plazo));
  let bajo = 0;
  let alto = 1;
  for (let i = 0; i < 200; i++) {
    const medio = (bajo + alto) / 2;
    if (valor(medio) > cuota) alto = medio;
    else bajo = medio;
  }
  // Como la expresan los bancos: 4 decimales del porcentaje (0,016725 = 1,6725 %).
  return Math.round(((bajo + alto) / 2) * 1e6) / 1e6;
}

/** El 4 x 1000 (o lo que se ponga por mil) de un pago, en centavos redondeados al peso. */
export const gmfDe = (centavos: number, porMil: number): number => Math.round((centavos * porMil) / 1000 / 100) * 100;
