/**
 * Utilidades (fase 3 del modulo de gastos): cascada de rentabilidad por
 * vehiculo y reparto entre socios de un mes, participaciones (quien es dueno
 * de que vehiculo y en que porcentaje, con vigencia) y aprobacion del reparto.
 * Los calculos estan en calculoUtilidades.ts.
 *
 * - Viajes: los de Rentabilidad (flete, descuentos, anticipos y saldo del
 *   dueno, ya calculados) de los vehiculos de la flota propia, por su fecha.
 * - Libro de gastos: lo que le toco a cada vehiculo o socio (gastos_reparto)
 *   en el mes, por fecha de causacion; los ingresos restan.
 * - Participaciones: por defecto 100 % del dueno del vehiculo; una sociedad
 *   se registra con sus porcentajes desde una fecha (lo anterior no cambia).
 * - Aprobar el reparto de un mes guarda la foto (repartos_utilidades); el mes
 *   debe estar cerrado en Gastos. Mientras este aprobado, el mes no se abre.
 */
import type { RowDataPacket } from "mysql2/promise";
import { pool } from "./db";
import { dia, ErrorCuadro, hoyColombia } from "./cuadro";
import { rentabilidad } from "./rentabilidad";
import { cascadas, finDeMes, participacionesEn, pasoDe, repartirUtilidades } from "./calculoUtilidades";
import type { Cascada, Participacion, PartidaGasto, RepartoSocio, ViajeCascada } from "./calculoUtilidades";
import type { EmpresaVehiculo } from "./roles";

/** La cascada y el reparto de un mes. */
export interface UtilidadesMes {
  mes: string;
  /** Mes cerrado en Gastos. */
  cerrado: boolean;
  /** Si el reparto esta aprobado: quien y cuando (y entonces los datos son la foto guardada). */
  aprobado: { por: string | null; en: string } | null;
  vehiculos: Array<{
    vehiculoId: number;
    placa: string;
    empresa: EmpresaVehiculo;
    dueno: string | null;
    participaciones: Array<{ socioId: number; socio: string; porcentaje: number }>;
    cascada: Cascada;
    detalleViajes: ViajeCascada[];
  }>;
  socios: Array<RepartoSocio & { nombre: string }>;
  /** Vehiculos con utilidad pero sin participacion que sume 100 %: su utilidad no se reparte. */
  sinParticipacion: string[];
}

/** Normaliza una placa ("SZX-880" -> "SZX880"). */
const placaClave = (p: string) => p.replace(/[^A-Z0-9]/gi, "").toUpperCase();
/** El dia anterior a una fecha. */
const diaAntes = (f: string) => new Date(Date.parse(f) - 86_400_000).toISOString().slice(0, 10);
/** JSON guardado a objeto. */
function json<T>(v: unknown, defecto: T): T {
  try {
    return typeof v === "string" && v ? (JSON.parse(v) as T) : defecto;
  } catch {
    return defecto;
  }
}

/** Mes "AAAA-MM" valido. */
function mesDe(v: unknown): string {
  const m = String(v ?? "");
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(m)) throw new ErrorCuadro("Elige el mes.");
  return m;
}

/** Utilidades, participaciones y socios. */
export const utilidades = {
  /** Cascada por vehiculo y reparto por socio del mes (M&C: solo sus vehiculos). */
  async mes(mesTexto: unknown, filtro: { empresa?: EmpresaVehiculo | null } = {}): Promise<UtilidadesMes> {
    const mes = mesDe(mesTexto);
    const [[aprob]] = await pool.query<RowDataPacket[]>(
      "SELECT r.datos, r.aprobadoEn, u.nombre AS por FROM repartos_utilidades r LEFT JOIN usuarios u ON u.id = r.aprobadoPorId WHERE r.mes = ?",
      [mes],
    );
    const [[cierre]] = await pool.query<RowDataPacket[]>("SELECT 1 AS si FROM periodos_cierre WHERE mes = ?", [mes]);
    const datos: Omit<UtilidadesMes, "cerrado" | "aprobado"> = aprob ? json(aprob.datos, null)! : await this.calcular(mes);
    const aprobado = aprob
      ? { por: aprob.por ?? null, en: aprob.aprobadoEn instanceof Date ? aprob.aprobadoEn.toISOString() : String(aprob.aprobadoEn) }
      : null;
    const resultado: UtilidadesMes = { ...datos, cerrado: !!cierre, aprobado };
    if (!filtro.empresa) return resultado;
    // M&C: solo sus vehiculos y el reparto que sale de ellos (y los gastos propios de M&C).
    const vehiculos = resultado.vehiculos.filter((v) => v.empresa === filtro.empresa);
    const ids = new Set(vehiculos.map((v) => v.vehiculoId));
    const c2 = (v: number) => Math.round(v * 100) / 100;
    const socios = resultado.socios
      .map((s) => {
        const porVehiculo = s.porVehiculo.filter((v) => ids.has(v.vehiculoId));
        const utilidadVehiculos = c2(porVehiculo.reduce((t, v) => t + v.utilidad, 0));
        const saldoViajes = c2(porVehiculo.reduce((t, v) => t + v.saldoViajes, 0));
        const total = c2(utilidadVehiculos - s.totalGastosPropios);
        return { ...s, porVehiculo, utilidadVehiculos, saldoViajes, total, diferencia: c2(total - saldoViajes) };
      })
      .filter((s) => s.porVehiculo.length);
    return { ...resultado, vehiculos, socios, sinParticipacion: resultado.sinParticipacion.filter((p) => vehiculos.some((v) => v.placa === p)) };
  },

  /** Calcula la cascada y el reparto del mes con los datos actuales. */
  async calcular(mes: string): Promise<Omit<UtilidadesMes, "cerrado" | "aprobado">> {
    const desde = `${mes}-01`;
    const hasta = finDeMes(mes);
    const [flota] = await pool.query<RowDataPacket[]>(
      "SELECT id, placa, empresa, dueno FROM vehiculos WHERE eliminado = 0 AND empresa IS NOT NULL ORDER BY empresa, placa",
    );
    const porPlaca = new Map(flota.map((v) => [placaClave(v.placa), v.id as number]));
    // 1 y 2 (y los anticipos del 3): los viajes de Rentabilidad de la flota propia en el mes.
    const viajes: ViajeCascada[] = (await rentabilidad.listar())
      .filter((f) => f.fecha >= desde && f.fecha <= hasta && porPlaca.has(placaClave(f.placa)))
      .map((f) => ({
        id: f.id,
        vehiculoId: porPlaca.get(placaClave(f.placa))!,
        fecha: f.fecha,
        manifiesto: f.manifiesto,
        cliente: f.empresa,
        flete: f.valorEmpresa,
        retencion: f.retencion,
        reteIca: f.reteIca,
        anticipoRenta: f.anticipoRenta,
        bancaria: f.bancaria,
        supertransporte: f.supertransporte,
        comision: f.comision,
        tLopez: f.tLopez,
        descargue: f.descargue,
        poliza: f.poliza,
        otrosDescuentos: f.otrosDescuentos,
        anticipo: f.anticipo,
        saldoBeneficiario: f.saldoBeneficiario,
      }));
    // 3, 4 y 5: lo que le toco a cada vehiculo o socio del libro de gastos en el mes.
    const [filas] = await pool.query<RowDataPacket[]>(
      `SELECT r.gastoId, r.vehiculoId, r.socioId, SUM(r.monto) AS monto, g.descripcion, g.categoria, g.tipo, g.destinos,
              MAX(e.tipo = 'CONDUCTOR') AS nominaConductor
         FROM gastos_reparto r JOIN gastos g ON g.id = r.gastoId
         LEFT JOIN nomina_lineas nl ON nl.gastoId = g.id LEFT JOIN empleados e ON e.id = nl.empleadoId
        WHERE g.anulado = 0 AND r.fecha BETWEEN ? AND ?
        GROUP BY r.gastoId, r.vehiculoId, r.socioId, g.descripcion, g.categoria, g.tipo, g.destinos`,
      [desde, hasta],
    );
    const partidas: PartidaGasto[] = filas.map((f) => {
      const destinos = json<Array<{ tipo: string }>>(f.destinos, []);
      return {
        gastoId: f.gastoId,
        descripcion: f.descripcion,
        categoria: f.categoria,
        monto: Math.round((f.tipo === "INGRESO" ? -1 : 1) * Number(f.monto) * 100) / 100,
        vehiculoId: f.vehiculoId ?? null,
        socioId: f.socioId ?? null,
        paso: pasoDe({
          esNominaConductor: !!Number(f.nominaConductor),
          destinosVehiculo: destinos.filter((d) => d.tipo === "VEHICULO").length,
          destinosSocio: destinos.filter((d) => d.tipo === "SOCIO").length,
        }),
      };
    });
    const lista = cascadas(
      flota.map((v) => v.id),
      viajes,
      partidas,
    );
    const participaciones = await this.participacionesTodas();
    const [socios] = await pool.query<RowDataPacket[]>("SELECT id, nombre FROM socios");
    const nombre = new Map(socios.map((s) => [s.id as number, s.nombre as string]));
    const reparto = repartirUtilidades(lista, participaciones, partidas, hasta);
    return {
      mes,
      vehiculos: flota.map((v, i) => ({
        vehiculoId: v.id,
        placa: v.placa,
        empresa: v.empresa,
        dueno: v.dueno ?? null,
        participaciones: participacionesEn(participaciones, v.id, hasta).map((p) => ({
          socioId: p.socioId,
          socio: nombre.get(p.socioId) ?? "?",
          porcentaje: p.porcentaje,
        })),
        cascada: lista[i],
        detalleViajes: viajes.filter((x) => x.vehiculoId === v.id),
      })),
      socios: reparto.socios.map((s) => ({ ...s, nombre: nombre.get(s.socioId) ?? "?" })).sort((a, b) => a.nombre.localeCompare(b.nombre)),
      sinParticipacion: reparto.sinParticipacion.map((id) => flota.find((v) => v.id === id)?.placa ?? "?"),
    };
  },

  /** Aprueba el reparto del mes: guarda la foto. El mes debe estar cerrado en Gastos. */
  async aprobar(mesTexto: unknown, usuarioId: number | null): Promise<void> {
    const mes = mesDe(mesTexto);
    const [[cierre]] = await pool.query<RowDataPacket[]>("SELECT 1 AS si FROM periodos_cierre WHERE mes = ?", [mes]);
    if (!cierre) throw new ErrorCuadro(`Primero cierra el mes ${mes} en Gastos (Mas > Cierre de meses): asi sus gastos ya no cambian.`);
    const datos = await this.calcular(mes);
    if (datos.sinParticipacion.length) throw new ErrorCuadro(`Falta la participacion de ${datos.sinParticipacion.join(", ")}: registrala en Participaciones.`);
    await pool.query("REPLACE INTO repartos_utilidades (mes, datos, aprobadoPorId) VALUES (?, ?, ?)", [mes, JSON.stringify(datos), usuarioId]);
  },

  /** Anula la aprobacion del reparto (vuelve a calcularse con los datos actuales). */
  async anular(mesTexto: unknown): Promise<void> {
    await pool.query("DELETE FROM repartos_utilidades WHERE mes = ?", [mesDe(mesTexto)]);
  },

  /** Meses con reparto aprobado. */
  async aprobados(): Promise<string[]> {
    const [filas] = await pool.query<RowDataPacket[]>("SELECT mes FROM repartos_utilidades ORDER BY mes");
    return filas.map((f) => String(f.mes));
  },

  /** Todas las participaciones (para el calculo). */
  async participacionesTodas(): Promise<Participacion[]> {
    const [filas] = await pool.query<RowDataPacket[]>("SELECT vehiculoId, socioId, porcentaje, desde, hasta FROM participaciones ORDER BY vehiculoId, desde");
    return filas.map((f) => ({ vehiculoId: f.vehiculoId, socioId: f.socioId, porcentaje: Number(f.porcentaje), desde: dia(f.desde)!, hasta: dia(f.hasta) }));
  },

  /** Vehiculos de la flota propia con su participacion vigente y su historial. */
  async participaciones(filtro: { empresa?: EmpresaVehiculo | null } = {}) {
    const [flota] = await pool.query<RowDataPacket[]>(
      `SELECT id, placa, empresa, dueno FROM vehiculos WHERE eliminado = 0 AND empresa IS NOT NULL ${filtro.empresa ? "AND empresa = ?" : ""} ORDER BY empresa, placa`,
      filtro.empresa ? [filtro.empresa] : [],
    );
    const [filas] = await pool.query<RowDataPacket[]>(
      "SELECT p.id, p.vehiculoId, p.socioId, s.nombre AS socio, p.porcentaje, p.desde, p.hasta FROM participaciones p JOIN socios s ON s.id = p.socioId ORDER BY p.desde, s.nombre",
    );
    const hoy = hoyColombia();
    return flota.map((v) => {
      const historial = filas
        .filter((f) => f.vehiculoId === v.id)
        .map((f) => ({ id: f.id, socioId: f.socioId, socio: f.socio, porcentaje: Number(f.porcentaje), desde: dia(f.desde)!, hasta: dia(f.hasta) }));
      const vigentes = historial.filter((p) => p.desde <= hoy && (!p.hasta || p.hasta >= hoy));
      return { vehiculoId: v.id, placa: v.placa, empresa: v.empresa as EmpresaVehiculo, dueno: v.dueno ?? null, vigentes, historial };
    });
  },

  /**
   * Registra la participacion de un vehiculo desde una fecha ({ desde, partes: [{ socioId, porcentaje }] }),
   * que debe sumar 100 %. La anterior se cierra el dia antes; lo que empezaba desde esa fecha se reemplaza.
   */
  async guardarParticipacion(vehiculoId: number, d: Record<string, unknown>): Promise<void> {
    const desde = String(d.desde ?? "").slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(desde)) throw new ErrorCuadro("Escribe desde cuando aplica.");
    const partes = (Array.isArray(d.partes) ? d.partes : []) as Array<Record<string, unknown>>;
    const limpias = partes.map((p) => ({ socioId: Number(p.socioId), porcentaje: Number(p.porcentaje) })).filter((p) => p.socioId > 0 && p.porcentaje > 0);
    if (!limpias.length) throw new ErrorCuadro("Agrega al menos un socio.");
    if (new Set(limpias.map((p) => p.socioId)).size !== limpias.length) throw new ErrorCuadro("Un socio esta repetido.");
    const suma = limpias.reduce((s, p) => s + p.porcentaje, 0);
    if (Math.abs(suma - 100) > 0.001) throw new ErrorCuadro(`Los porcentajes suman ${suma} %: deben sumar 100 %.`);
    const [[aprob]] = await pool.query<RowDataPacket[]>("SELECT MAX(mes) AS mes FROM repartos_utilidades");
    if (aprob?.mes && desde <= finDeMes(String(aprob.mes)))
      throw new ErrorCuadro(`El reparto de ${aprob.mes} ya esta aprobado: la nueva participacion debe empezar despues.`);
    await pool.query("DELETE FROM participaciones WHERE vehiculoId = ? AND desde >= ?", [vehiculoId, desde]);
    await pool.query("UPDATE participaciones SET hasta = ? WHERE vehiculoId = ? AND (hasta IS NULL OR hasta >= ?)", [diaAntes(desde), vehiculoId, desde]);
    await pool.query("INSERT INTO participaciones (vehiculoId, socioId, porcentaje, desde) VALUES ?", [
      limpias.map((p) => [vehiculoId, p.socioId, p.porcentaje, desde]),
    ]);
  },

  /** Socios (activos primero). */
  async socios() {
    const [filas] = await pool.query<RowDataPacket[]>("SELECT id, nombre, activo FROM socios ORDER BY activo DESC, nombre");
    return filas.map((f) => ({ id: f.id as number, nombre: f.nombre as string, activo: !!f.activo }));
  },

  /** Crea un socio (por ejemplo el socio de una sociedad). */
  async crearSocio(d: Record<string, unknown>): Promise<void> {
    const nombre = String(d.nombre ?? "")
      .trim()
      .toUpperCase()
      .slice(0, 80);
    if (!nombre) throw new ErrorCuadro("Escribe el nombre del socio.");
    const [[existe]] = await pool.query<RowDataPacket[]>("SELECT id FROM socios WHERE nombre = ?", [nombre]);
    if (existe) throw new ErrorCuadro("Ya hay un socio con ese nombre.");
    await pool.query("INSERT INTO socios (nombre) VALUES (?)", [nombre]);
  },

  /** Activa o desactiva un socio (los inactivos no salen al registrar gastos). */
  async activarSocio(id: number, activo: boolean): Promise<void> {
    await pool.query("UPDATE socios SET activo = ? WHERE id = ?", [activo ? 1 : 0, id]);
  },
};

