/**
 * Cuenta de cada vehiculo en el mes (como el cuadro SWK-973 de Excel): para
 * que cada dueno vea lo que produjo su carro, viaje por viaje, y lo que le
 * queda despues de los gastos.
 *
 * No calcula nada nuevo: junta lo que ya esta en el sistema.
 * - Por viaje (Rentabilidad): flete de la empresa, sus descuentos
 *   (retencion, ICA, anticipo de renta, 4 x 1000, Supertransporte, comision,
 *   T. Lopez, descargue, poliza), el producido (flete - descuentos), el
 *   anticipo y el saldo que se le liquida al dueno con su fecha de pago.
 * - Por viaje (Cuentas vehiculos): el conductor, su flete conductor (integro
 *   o no), lo que gana el conductor por el viaje (el % o el integro), lo que
 *   recibio, lo que gasto y el rojo (gastos - recibido).
 * - El resumen del mes es la cascada de Utilidades del vehiculo: ingresos -
 *   descuentos - anticipos y gastos directos (arreglos, cuentas de viaje...) -
 *   conductor (nomina) - gastos generales = lo que queda. Si el mes esta
 *   aprobado en Utilidades, es la foto aprobada.
 */
import type { RowDataPacket } from "mysql2/promise";
import { pool } from "./db";
import { conductores } from "./conductores";
import { DESCUENTOS } from "./calculoUtilidades";
import type { Cascada, ClaveDescuento } from "./calculoUtilidades";
import { rentabilidad } from "./rentabilidad";
import { utilidades } from "./utilidades";
import type { EmpresaVehiculo } from "./roles";

/** Centavos exactos. */
const c2 = (v: number) => Math.round(v * 100 + Number.EPSILON) / 100;

/** Un viaje en la cuenta del vehiculo (una fila del cuadro SWK-973). */
export interface ViajeCuentaVehiculo {
  id: number;
  fecha: string;
  remision: string | null;
  manifiesto: string | null;
  remisionUrl: string | null;
  facturaUrl: string | null;
  cliente: string;
  pesoKg: number | null;
  /** Lo que paga el cliente. */
  flete: number;
  /** Descuentos del viaje, uno por uno, y su total. */
  detalleDescuentos: Record<ClaveDescuento, number>;
  descuentos: number;
  /** Flete - descuentos. */
  producido: number;
  /** Anticipo del viaje (0 si tiene cuenta de viaje: su costo llega como gasto). */
  anticipo: number;
  conCuenta: boolean;
  /** Lo que se le liquida al dueno por el viaje y cuando se le pago. */
  saldo: number;
  fechaPagoSaldo: string | null;
  /** El conductor del viaje (segun la asignacion de vehiculos de Nomina). */
  conductor: string | null;
  /** Flete conductor del viaje (null = sin valor en la matriz). */
  fleteConductor: number | null;
  /** INTEGRO: el flete conductor se le paga completo (no se le saca el %). */
  integro: boolean;
  /** Lo que gana el conductor por el viaje: el % (salarial + viaticos) o el integro. */
  pagoConductor: number | null;
  /** Lo que recibio el conductor (bomba y transferencia), lo que gasto (cuenta de viaje) y el rojo (gastos - recibido). */
  recibido: number;
  gastosViaje: number | null;
  rojo: number | null;
}

/** Lo de un conductor en la cuenta del vehiculo. */
export interface ConductorCuentaVehiculo {
  nombre: string;
  viajes: number;
  pagoConductor: number;
  rojo: number;
  /** Lo que se le debe por los viajes de este carro: lo que gana + el rojo. */
  alConductor: number;
}

/** La cuenta de un vehiculo en un mes. */
export interface CuentaVehiculo {
  vehiculoId: number;
  placa: string;
  empresa: EmpresaVehiculo;
  dueno: string | null;
  viajes: ViajeCuentaVehiculo[];
  /** La cascada de Utilidades: ingresos, descuentos, anticipos y gastos y lo que queda. */
  cascada: Cascada;
  conductores: ConductorCuentaVehiculo[];
}

/** Las cuentas de los vehiculos de un mes (con viajes o gastos), con la marca de mes aprobado en Utilidades. */
export async function cuentasVehiculos(
  mes: unknown,
  empresa: EmpresaVehiculo | null,
): Promise<{ mes: string; aprobado: boolean; cerrado: boolean; vehiculos: CuentaVehiculo[] }> {
  const u = await utilidades.mes(mes, { reparto: false, terceros: false, empresa: false });
  const [viajesConductor, filasRent, [empleados]] = await Promise.all([
    conductores.viajes(u.mes, empresa),
    rentabilidad.listar(),
    pool.query<RowDataPacket[]>("SELECT nombre, pctSalarial, pctViaticos FROM empleados"),
  ]);
  const [marcados] = await pool.query<RowDataPacket[]>("SELECT id FROM vehiculos WHERE visibleTodos = 1");
  const visibles = new Set(marcados.map((x) => x.id as number));
  const deConductor = new Map(viajesConductor.map((v) => [v.cuadroViajeId, v]));
  const deRent = new Map(filasRent.map((f) => [f.id, f]));
  const pct = new Map(empleados.map((e) => [e.nombre as string, (Number(e.pctSalarial) + Number(e.pctViaticos)) / 100]));
  const vehiculos: CuentaVehiculo[] = [];
  for (const v of u.vehiculos) {
    // M&C: sus vehiculos y los visibles para todos (XGJ-197).
    if (empresa && v.empresa !== empresa && !visibles.has(v.vehiculoId)) continue;
    const c = v.cascada;
    const conGastos = c.directos.length + c.conductor.length + c.generales.length > 0;
    if (!c.viajes && !conGastos) continue;
    const viajes: ViajeCuentaVehiculo[] = v.detalleViajes.map((d) => {
      const k = deConductor.get(d.id);
      const r = deRent.get(d.id);
      const detalle = Object.fromEntries(DESCUENTOS.map(([clave]) => [clave, d[clave]])) as Record<ClaveDescuento, number>;
      const descuentos = c2(Object.values(detalle).reduce((s, x) => s + x, 0));
      const fleteConductor = k?.producido ?? null;
      const integro = k?.integro ?? false;
      const pctConductor = k?.conductor ? pct.get(k.conductor) : undefined;
      const pagoConductor = fleteConductor === null ? null : integro ? fleteConductor : pctConductor === undefined ? null : c2(fleteConductor * pctConductor);
      return {
        id: d.id,
        fecha: d.fecha,
        remision: k?.remision ?? r?.remision ?? null,
        manifiesto: d.manifiesto,
        remisionUrl: d.remisionUrl ?? null,
        facturaUrl: d.facturaUrl ?? null,
        cliente: d.cliente,
        pesoKg: k?.pesoKg ?? null,
        flete: d.flete,
        detalleDescuentos: detalle,
        descuentos,
        producido: c2(d.flete - descuentos),
        anticipo: d.anticipo,
        conCuenta: !!d.conCuenta,
        saldo: d.saldoBeneficiario,
        fechaPagoSaldo: r?.fechaPagoBeneficiario ?? null,
        conductor: k?.conductor ?? null,
        fleteConductor,
        integro,
        pagoConductor,
        recibido: k?.recibido ?? 0,
        gastosViaje: k?.cuenta?.total ?? null,
        rojo: k?.cuenta?.saldo ?? null,
      };
    });
    const porConductor = new Map<string, ConductorCuentaVehiculo>();
    for (const x of viajes) {
      if (!x.conductor) continue;
      const p = porConductor.get(x.conductor) ?? { nombre: x.conductor, viajes: 0, pagoConductor: 0, rojo: 0, alConductor: 0 };
      p.viajes += 1;
      p.pagoConductor = c2(p.pagoConductor + (x.pagoConductor ?? 0));
      p.rojo = c2(p.rojo + (x.rojo ?? 0));
      p.alConductor = c2(p.pagoConductor + p.rojo);
      porConductor.set(x.conductor, p);
    }
    vehiculos.push({
      vehiculoId: v.vehiculoId,
      placa: v.placa,
      empresa: v.empresa,
      dueno: v.dueno,
      viajes: viajes.sort((a, b) => a.fecha.localeCompare(b.fecha) || a.id - b.id),
      cascada: c,
      conductores: [...porConductor.values()],
    });
  }
  return { mes: u.mes, aprobado: !!u.aprobado, cerrado: u.cerrado, vehiculos };
}
