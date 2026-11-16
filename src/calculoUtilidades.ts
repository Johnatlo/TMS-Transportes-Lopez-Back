/**
 * Cascada de rentabilidad por vehiculo y reparto de utilidades por socio
 * (fase 3 del modulo de gastos), sin base de datos: se prueba en
 * calculoUtilidades.test.ts.
 *
 * Cascada de un vehiculo en un mes:
 *   1. Ingresos por fletes (lo que paga el cliente, de Rentabilidad).
 *   2. - Descuentos del viaje (retencion, ReteICA, anticipo de renta, 4x1000,
 *        Supertransporte, comision, T. Lopez, descargue, poliza, otros).
 *   3. - Costos directos: anticipos del viaje (combustible, efectivo,
 *        transferencia) y los gastos del libro que van completos a ese carro.
 *   4. - Costo total de la nomina del conductor (salario + carga del empleador).
 *   5. - Gastos generales prorrateados (lo que le toco de los gastos repartidos
 *        entre varios carros: oficina, creditos, nomina de oficina...).
 *   6. = Utilidad neta del vehiculo.
 * Los viajes van por su fecha; los gastos, por su fecha de causacion.
 *
 * Reparto: la utilidad de cada vehiculo se reparte entre sus socios segun la
 * participacion vigente al cierre del mes (100 % del dueno, o la sociedad).
 * Lo que va directo a un socio en el libro (sus gastos adicionales, su parte
 * fija de un credito) se le descuenta solo a el. Como referencia se muestra lo
 * que ya se le liquido al dueno por los viajes (saldo de los viajes).
 *
 * Todo en pesos con dos decimales; las partes se reparten en centavos para que
 * sumen exacto (ver prorrateo.ts).
 */
import { aCentavos, aPesos, repartir } from "./prorrateo";

/** Los valores de un viaje que usa la cascada (salen de Rentabilidad). */
export interface ViajeCascada {
  id: number;
  vehiculoId: number;
  fecha: string;
  manifiesto: string | null;
  cliente: string;
  flete: number;
  retencion: number;
  reteIca: number;
  anticipoRenta: number;
  bancaria: number;
  supertransporte: number;
  comision: number;
  tLopez: number;
  descargue: number;
  poliza: number;
  otrosDescuentos: number;
  /** Anticipos del viaje: combustible + efectivo + transferencia. */
  anticipo: number;
  /** Lo que se le liquida al dueno por el viaje. */
  saldoBeneficiario: number;
}

/** De que paso de la cascada es un gasto del libro. */
export type PasoGasto = "DIRECTO" | "CONDUCTOR" | "GENERAL";

/** Lo que le toco a un vehiculo o a un socio de un gasto del libro en el mes. */
export interface PartidaGasto {
  gastoId: number;
  descripcion: string;
  categoria: string;
  /** Positivo: gasto; negativo: ingreso. */
  monto: number;
  vehiculoId: number | null;
  socioId: number | null;
  paso: PasoGasto;
}

/** Los descuentos del viaje, uno por uno. */
export const DESCUENTOS = [
  ["retencion", "Retencion en la fuente + FOPAT"],
  ["reteIca", "ReteICA"],
  ["anticipoRenta", "Anticipo de renta"],
  ["bancaria", "4 x 1000 y comision bancaria"],
  ["supertransporte", "Supertransporte"],
  ["comision", "Comision"],
  ["tLopez", "T. Lopez"],
  ["descargue", "Descargue"],
  ["poliza", "Poliza RCE"],
  ["otrosDescuentos", "Otros descuentos"],
] as const;
export type ClaveDescuento = (typeof DESCUENTOS)[number][0];

/** La cascada de un vehiculo en el periodo. */
export interface Cascada {
  vehiculoId: number;
  viajes: number;
  /** 1. */
  ingresos: number;
  /** 2. Por concepto y total. */
  descuentos: Record<ClaveDescuento, number>;
  totalDescuentos: number;
  /** 3. Anticipos de los viajes + gastos directos del libro. */
  anticipos: number;
  directos: PartidaGasto[];
  totalDirectos: number;
  /** 4. */
  conductor: PartidaGasto[];
  totalConductor: number;
  /** 5. */
  generales: PartidaGasto[];
  totalGenerales: number;
  /** 6. */
  utilidad: number;
  /** Lo que se le liquido al dueno por los viajes (referencia). */
  saldoViajes: number;
}

/** Redondea a centavos. */
const c2 = (v: number) => Math.round(v * 100 + Number.EPSILON) / 100;
/** Suma a centavos. */
const sumar = (xs: number[]) => c2(xs.reduce((s, x) => s + x, 0));

/** Cascada de cada vehiculo con los viajes y las partidas del libro del periodo. */
export function cascadas(vehiculos: number[], viajes: ViajeCascada[], partidas: PartidaGasto[]): Cascada[] {
  return vehiculos.map((vehiculoId) => {
    const suyos = viajes.filter((v) => v.vehiculoId === vehiculoId);
    const descuentos = Object.fromEntries(DESCUENTOS.map(([k]) => [k, sumar(suyos.map((v) => v[k]))])) as Record<ClaveDescuento, number>;
    const deLibro = (paso: PasoGasto) => partidas.filter((p) => p.vehiculoId === vehiculoId && p.paso === paso);
    const ingresos = sumar(suyos.map((v) => v.flete));
    const totalDescuentos = sumar(Object.values(descuentos));
    const anticipos = sumar(suyos.map((v) => v.anticipo));
    const directos = deLibro("DIRECTO");
    const totalDirectos = sumar([anticipos, ...directos.map((p) => p.monto)]);
    const conductor = deLibro("CONDUCTOR");
    const totalConductor = sumar(conductor.map((p) => p.monto));
    const generales = deLibro("GENERAL");
    const totalGenerales = sumar(generales.map((p) => p.monto));
    return {
      vehiculoId,
      viajes: suyos.length,
      ingresos,
      descuentos,
      totalDescuentos,
      anticipos,
      directos,
      totalDirectos,
      conductor,
      totalConductor,
      generales,
      totalGenerales,
      utilidad: c2(ingresos - totalDescuentos - totalDirectos - totalConductor - totalGenerales),
      saldoViajes: sumar(suyos.map((v) => v.saldoBeneficiario)),
    };
  });
}

/** Participacion de un socio en un vehiculo, con vigencia. */
export interface Participacion {
  vehiculoId: number;
  socioId: number;
  /** En % (50 = 50 %). */
  porcentaje: number;
  desde: string;
  hasta: string | null;
}

/** Participaciones de un vehiculo vigentes en una fecha. */
export function participacionesEn(todas: Participacion[], vehiculoId: number, fecha: string): Participacion[] {
  return todas.filter((p) => p.vehiculoId === vehiculoId && p.desde <= fecha && (!p.hasta || p.hasta >= fecha));
}

/** Lo que le toca a un socio en el reparto. */
export interface RepartoSocio {
  socioId: number;
  porVehiculo: Array<{ vehiculoId: number; porcentaje: number; utilidad: number; saldoViajes: number }>;
  /** Suma de su parte de la utilidad de los vehiculos. */
  utilidadVehiculos: number;
  /** Lo que va directo a el en el libro (positivo = gasto, negativo = ingreso). */
  gastosPropios: PartidaGasto[];
  totalGastosPropios: number;
  /** Utilidad de sus vehiculos - sus gastos propios. */
  total: number;
  /** Su parte de lo que ya se liquido por los viajes (referencia). */
  saldoViajes: number;
  /** total - saldoViajes: lo que falta por darle (positivo) o lo que debe devolver (negativo). */
  diferencia: number;
}

/** El reparto del periodo por socio, y los vehiculos sin participacion (su utilidad no se reparte). */
export function repartirUtilidades(
  lista: Cascada[],
  participaciones: Participacion[],
  partidas: PartidaGasto[],
  fecha: string,
): { socios: RepartoSocio[]; sinParticipacion: number[] } {
  const socios = new Map<number, RepartoSocio>();
  const de = (socioId: number) => {
    let s = socios.get(socioId);
    if (!s) {
      s = { socioId, porVehiculo: [], utilidadVehiculos: 0, gastosPropios: [], totalGastosPropios: 0, total: 0, saldoViajes: 0, diferencia: 0 };
      socios.set(socioId, s);
    }
    return s;
  };
  const sinParticipacion: number[] = [];
  for (const c of lista) {
    const ps = participacionesEn(participaciones, c.vehiculoId, fecha);
    if (!ps.length || Math.abs(ps.reduce((s, p) => s + p.porcentaje, 0) - 100) > 0.001) {
      if (c.utilidad !== 0 || c.saldoViajes !== 0) sinParticipacion.push(c.vehiculoId);
      continue;
    }
    const pesos = ps.map((p) => p.porcentaje);
    const utilidades = repartir(aCentavos(c.utilidad), pesos);
    const saldos = repartir(aCentavos(c.saldoViajes), pesos);
    ps.forEach((p, i) =>
      de(p.socioId).porVehiculo.push({ vehiculoId: c.vehiculoId, porcentaje: p.porcentaje, utilidad: aPesos(utilidades[i]), saldoViajes: aPesos(saldos[i]) }),
    );
  }
  for (const p of partidas.filter((x) => x.socioId !== null)) de(p.socioId!).gastosPropios.push(p);
  for (const s of socios.values()) {
    s.utilidadVehiculos = sumar(s.porVehiculo.map((v) => v.utilidad));
    s.saldoViajes = sumar(s.porVehiculo.map((v) => v.saldoViajes));
    s.totalGastosPropios = sumar(s.gastosPropios.map((g) => g.monto));
    s.total = c2(s.utilidadVehiculos - s.totalGastosPropios);
    s.diferencia = c2(s.total - s.saldoViajes);
  }
  return { socios: [...socios.values()], sinParticipacion };
}

/**
 * Paso de la cascada de un gasto del libro: la nomina de un conductor va al
 * paso 4; un gasto que va completo a un solo vehiculo (sin socios) es costo
 * directo (paso 3); lo repartido entre varios es gasto general (paso 5).
 */
export function pasoDe(g: { esNominaConductor: boolean; destinosVehiculo: number; destinosSocio: number }): PasoGasto {
  if (g.esNominaConductor) return "CONDUCTOR";
  if (g.destinosVehiculo === 1 && g.destinosSocio === 0) return "DIRECTO";
  return "GENERAL";
}

/** Ultimo dia de un mes "AAAA-MM". */
export function finDeMes(mes: string): string {
  const [a, m] = mes.split("-").map(Number);
  return `${mes}-${String(new Date(Date.UTC(a, m, 0)).getUTCDate()).padStart(2, "0")}`;
}
