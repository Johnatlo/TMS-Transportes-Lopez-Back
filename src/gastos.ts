/**
 * Libro de gastos de las dos empresas (Transportes Lopez y Transportes M&C),
 * creditos y cierre de meses. Fase 1 del modulo de gastos, prorrateo y reparto
 * de utilidades.
 *
 * - Un gasto (o ingreso) tiene empresa, categoria, monto, fecha de pago (flujo
 *   de caja) y una o varias causaciones mensuales (rentabilidad): un seguro
 *   anual se paga una vez y se causa en 12 meses.
 * - Destinos: los vehiculos que se marquen (una parte por carro), partes
 *   directas a socios (valor fijo, porcentaje o partes) y/o la empresa (lo
 *   que no se le carga a ningun carro: baja la rentabilidad de la empresa).
 * - El reparto se calcula al guardar y queda escrito (gastos_reparto): no
 *   cambia solo. Editar el gasto lo recalcula, y solo se puede en meses
 *   abiertos (periodos_cierre).
 * - Lo que una empresa le debe a la otra no es una cuenta entre empresas: es
 *   un gasto en una y un ingreso en la otra, cada uno con su reparto.
 * - Montos en DECIMAL; las cuentas se hacen en centavos (ver prorrateo.ts).
 * - Creditos: tabla de amortizacion (capital, interes, saldo); al registrar
 *   el pago de una cuota se crea su gasto con el reparto del credito.
 * - Nomina (fase 2): al aprobarla se crea un gasto por empleado, causado por
 *   dias entre los meses que cubre (causaHasta). Esos gastos se cambian
 *   desde la nomina, no desde el libro.
 */
import type { PoolConnection, ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { pool } from "./db";
import { dia, ErrorCuadro, hoyColombia } from "./cuadro";
import { aCentavos, amortizar, aPesos, causaciones, causacionesPorDias, ErrorReparto, repartirGasto } from "./prorrateo";
import type { Destino } from "./prorrateo";
import type { EmpresaVehiculo } from "./roles";

export const EMPRESAS: EmpresaVehiculo[] = ["LOPEZ", "MYC"];
/** Categorias del libro de gastos. */
export const CATEGORIAS = ["NOMINA", "OFICINA", "SERVICIOS", "CREDITO", "VEHICULO", "SEGUROS", "IMPUESTOS", "SOCIO", "OTROS"] as const;
export type Categoria = (typeof CATEGORIAS)[number];

/** Lo que le toco a un vehiculo o socio en una causacion. */
export interface RepartoGasto {
  fecha: string;
  vehiculoId: number | null;
  placa: string | null;
  socioId: number | null;
  socio: string | null;
  monto: number;
}

/** Un gasto del libro con sus causaciones y su reparto. */
export interface Gasto {
  id: number;
  empresa: EmpresaVehiculo;
  tipo: "GASTO" | "INGRESO";
  categoria: Categoria;
  descripcion: string;
  monto: number;
  fechaPago: string | null;
  /** Link al soporte (Drive); el sistema no guarda archivos. */
  soporteUrl: string | null;
  /** Primera causacion y en cuantas cuotas mensuales se causa. */
  causaDesde: string;
  causaCuotas: number;
  /** Si tiene, se causa por dias entre causaDesde y causaHasta (nomina). */
  causaHasta: string | null;
  destinos: Destino[];
  /** MANUAL, CREDITO (la cuota de un credito) o NOMINA (un empleado en una nomina aprobada). */
  origen: string;
  creditoId: number | null;
  nominaId: number | null;
  anulado: boolean;
  creadoPor: string | null;
  creadoEn: string;
  causaciones: Array<{ fecha: string; monto: number }>;
  reparto: RepartoGasto[];
}

/** Un credito con su tabla de amortizacion. */
export interface Credito {
  id: number;
  empresa: EmpresaVehiculo;
  nombre: string;
  entidad: string | null;
  obligacion: string | null;
  monto: number;
  /** Tasa mensual en porcentaje (1.6725). */
  tasaMensual: number;
  plazo: number;
  primeraCuota: string;
  cuotaFija: number | null;
  /** Que se lleva a gasto y se reparte al pagar la cuota. */
  prorratea: "CAPITAL_E_INTERES" | "INTERES";
  destinos: Destino[];
  nota: string | null;
  cuotas: Array<{
    numero: number;
    fecha: string;
    cuota: number;
    capital: number;
    interes: number;
    saldo: number;
    fechaPago: string | null;
    gastoId: number | null;
  }>;
  /** Capital que falta por pagar (saldo despues de la ultima cuota pagada). */
  saldoPendiente: number;
  cuotasPagadas: number;
}

/** Mes de una fecha ("AAAA-MM"). */
const mes = (fecha: string) => fecha.slice(0, 7);
/** Texto recortado y sin espacios de sobra, o null si queda vacio. */
const texto = (v: unknown, max: number) =>
  String(v ?? "")
    .trim()
    .slice(0, max) || null;
/** Centavos como DECIMAL para la base ("1234.50"). */
const decimal = (centavos: number) => (centavos / 100).toFixed(2);

/** Fecha "AAAA-MM-DD" valida o error con el nombre del campo. */
function fechaDe(v: unknown, campo: string): string {
  const f = String(v ?? "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(f) || Number.isNaN(Date.parse(`${f}T12:00:00Z`))) throw new ErrorCuadro(`Escribe ${campo}.`);
  return f;
}

/** Link del soporte: vacio o una direccion http(s). */
function linkDe(v: unknown): string | null {
  const url = texto(v, 500);
  if (url && !/^https?:\/\/\S+$/i.test(url)) throw new ErrorCuadro("El soporte debe ser un link (https://...).");
  return url;
}

/** Destinos que llegan del navegador, validados contra los vehiculos propios y los socios. */
async function leerDestinos(x: unknown): Promise<Destino[]> {
  if (!Array.isArray(x) || !x.length) throw new ErrorCuadro("Elige a que vehiculos, socios o a la empresa va.");
  const [vehiculos] = await pool.query<RowDataPacket[]>("SELECT id FROM vehiculos WHERE eliminado = 0 AND empresa IS NOT NULL");
  const [socios] = await pool.query<RowDataPacket[]>("SELECT id FROM socios");
  const validos = { VEHICULO: new Set(vehiculos.map((v) => v.id)), SOCIO: new Set(socios.map((s) => s.id)), EMPRESA: new Set([0]) };
  return x.map((d) => {
    const tipo = d?.tipo === "SOCIO" ? "SOCIO" : d?.tipo === "EMPRESA" ? "EMPRESA" : "VEHICULO";
    const modo = d?.modo === "FIJO" || d?.modo === "PORCENTAJE" ? d.modo : "PARTE";
    const id = Number(d?.id);
    const valor = Number(d?.valor);
    if (!validos[tipo].has(id))
      throw new ErrorCuadro(tipo === "SOCIO" ? "Hay un socio que no existe." : "Hay un vehiculo que no es de la flota propia (ponle su empresa en Flota).");
    if (!Number.isFinite(valor) || valor <= 0) throw new ErrorCuadro("Cada destino necesita un valor mayor que cero.");
    if (tipo === "VEHICULO" && modo === "PORCENTAJE" && valor > 100) throw new ErrorCuadro("Un porcentaje no pasa de 100.");
    return { tipo, id, modo, valor } as Destino;
  });
}

/** Convierte los errores de reparto en errores de validacion (422). */
function conErrores<T>(fn: () => T): T {
  try {
    return fn();
  } catch (exc) {
    if (exc instanceof ErrorReparto) throw new ErrorCuadro(exc.message);
    throw exc;
  }
}

/** Datos de un gasto ya validados. */
interface DatosGasto {
  empresa: EmpresaVehiculo;
  tipo: "GASTO" | "INGRESO";
  categoria: Categoria;
  descripcion: string;
  monto: number;
  fechaPago: string | null;
  soporteUrl: string | null;
  causaDesde: string;
  causaCuotas: number;
  causaHasta: string | null;
  destinos: Destino[];
}

/** Valida lo que llega del formulario del gasto. */
async function validarGasto(d: Record<string, unknown>): Promise<DatosGasto> {
  const empresa = String(d.empresa ?? "") as EmpresaVehiculo;
  if (!EMPRESAS.includes(empresa)) throw new ErrorCuadro("Elige la empresa: Transportes Lopez o Transportes M&C.");
  const categoria = String(d.categoria ?? "") as Categoria;
  if (!CATEGORIAS.includes(categoria)) throw new ErrorCuadro("Elige la categoria.");
  const descripcion = texto(d.descripcion, 300);
  if (!descripcion) throw new ErrorCuadro("Escribe la descripcion.");
  const monto = Number(d.monto);
  if (!Number.isFinite(monto) || monto <= 0) throw new ErrorCuadro("Escribe el valor (mayor que cero).");
  const causaDesde = fechaDe(d.causaDesde, "la fecha de causacion (a que periodo corresponde)");
  const causaCuotas = d.causaCuotas === undefined || d.causaCuotas === null || d.causaCuotas === "" ? 1 : Number(d.causaCuotas);
  return {
    empresa,
    tipo: d.tipo === "INGRESO" ? "INGRESO" : "GASTO",
    categoria,
    descripcion,
    monto: aCentavos(monto),
    fechaPago: d.fechaPago ? fechaDe(d.fechaPago, "la fecha de pago") : null,
    soporteUrl: linkDe(d.soporteUrl),
    causaDesde,
    causaCuotas,
    causaHasta: d.causaHasta ? fechaDe(d.causaHasta, "el fin del periodo") : null,
    destinos: await leerDestinos(d.destinos),
  };
}

/** Causaciones de un gasto: por dias si tiene causaHasta (nomina); si no, en cuotas mensuales. */
const causacionesDe = (g: Pick<DatosGasto, "monto" | "causaDesde" | "causaCuotas" | "causaHasta">) =>
  conErrores(() => (g.causaHasta ? causacionesPorDias(g.monto, g.causaDesde, g.causaHasta) : causaciones(g.monto, g.causaDesde, g.causaCuotas)));

/** Fecha desde la que se registran gastos y meses cerrados. */
async function limites(): Promise<{ corte: string; cerrados: Set<string> }> {
  const [[p]] = await pool.query<RowDataPacket[]>("SELECT gastosDesde FROM parametros_empresa WHERE id = 1");
  const [filas] = await pool.query<RowDataPacket[]>("SELECT mes FROM periodos_cierre");
  return { corte: dia(p?.gastosDesde) ?? "2026-10-01", cerrados: new Set(filas.map((f) => String(f.mes))) };
}

/** Las causaciones deben ser desde la fecha de corte y en meses abiertos. */
async function exigirAbierto(fechas: string[]): Promise<void> {
  const { corte, cerrados } = await limites();
  const antes = fechas.find((f) => f < corte);
  if (antes)
    throw new ErrorCuadro(
      `Los gastos se registran desde el ${corte.split("-").reverse().join("/")} (la causacion ${antes.split("-").reverse().join("/")} es anterior).`,
    );
  const cerrado = fechas.find((f) => cerrados.has(mes(f)));
  if (cerrado) throw new ErrorCuadro(`El mes ${mes(cerrado)} esta cerrado: abrelo para cambiar sus gastos.`);
}

/** Escribe las causaciones y el reparto de un gasto (borra los que tuviera). */
async function escribirReparto(
  con: PoolConnection,
  gastoId: number,
  g: Pick<DatosGasto, "monto" | "causaDesde" | "causaCuotas" | "causaHasta" | "destinos">,
): Promise<void> {
  const cuotas = causacionesDe(g);
  await con.query("DELETE FROM gastos_reparto WHERE gastoId = ?", [gastoId]);
  await con.query("DELETE FROM gastos_causaciones WHERE gastoId = ?", [gastoId]);
  for (const c of cuotas) {
    const [res] = await con.query<ResultSetHeader>("INSERT INTO gastos_causaciones (gastoId, fecha, monto) VALUES (?, ?, ?)", [
      gastoId,
      c.fecha,
      decimal(c.monto),
    ]);
    // Las partes fijas del gasto se llevan a cada cuota en proporcion.
    const destinos = g.destinos.map((d) => (d.modo === "FIJO" ? { ...d, valor: (d.valor * c.monto) / g.monto } : d));
    const partes = conErrores(() => repartirGasto(c.monto, destinos));
    await con.query("INSERT INTO gastos_reparto (gastoId, causacionId, fecha, vehiculoId, socioId, monto) VALUES ?", [
      partes.map((p) => [gastoId, res.insertId, c.fecha, p.tipo === "VEHICULO" ? p.id : null, p.tipo === "SOCIO" ? p.id : null, decimal(p.monto)]),
    ]);
  }
}

/** Los gastos de un credito o de la nomina se cambian desde alla. */
function exigirManual(g: Gasto): void {
  if (g.origen === "CREDITO") throw new ErrorCuadro("Este gasto sale de un credito: se cambia desde el credito (pago de la cuota).");
  if (g.origen === "NOMINA") throw new ErrorCuadro("Este gasto sale de la nomina: reabre la nomina para cambiarlo.");
}

/** Ejecuta en una transaccion. */
async function enTransaccion<T>(fn: (con: PoolConnection) => Promise<T>): Promise<T> {
  const con = await pool.getConnection();
  try {
    await con.beginTransaction();
    const r = await fn(con);
    await con.commit();
    return r;
  } catch (exc) {
    await con.rollback();
    throw exc;
  } finally {
    con.release();
  }
}

/** Destinos guardados (JSON) a la lista. */
const destinosDe = (v: unknown): Destino[] => {
  try {
    return typeof v === "string" ? JSON.parse(v) : ((v as Destino[]) ?? []);
  } catch {
    return [];
  }
};

/** Libro de gastos, cierres de mes y creditos. */
export const gastos = {
  /** Lo que necesita el formulario: vehiculos propios, socios, categorias, fecha de corte y meses cerrados. */
  async opciones() {
    const [vehiculos] = await pool.query<RowDataPacket[]>(
      "SELECT id, placa, empresa, dueno, activo FROM vehiculos WHERE eliminado = 0 AND empresa IS NOT NULL ORDER BY empresa, placa",
    );
    const [socios] = await pool.query<RowDataPacket[]>("SELECT id, nombre FROM socios WHERE activo = 1 ORDER BY nombre");
    const { corte, cerrados } = await limites();
    return {
      vehiculos: vehiculos.map((v) => ({ id: v.id, placa: v.placa, empresa: v.empresa as EmpresaVehiculo, dueno: v.dueno ?? null, activo: !!v.activo })),
      socios: socios.map((s) => ({ id: s.id, nombre: s.nombre })),
      categorias: [...CATEGORIAS],
      corte,
      cerrados: [...cerrados].sort(),
    };
  },

  /** Gastos (no anulados salvo que se pidan) de una empresa o de las dos, los mas recientes primero. */
  async listar(filtro: { empresa?: EmpresaVehiculo | null; id?: number } = {}): Promise<Gasto[]> {
    const donde: string[] = [];
    const valores: unknown[] = [];
    if (filtro.empresa) {
      donde.push("g.empresa = ?");
      valores.push(filtro.empresa);
    }
    if (filtro.id) {
      donde.push("g.id = ?");
      valores.push(filtro.id);
    }
    const [filas] = await pool.query<RowDataPacket[]>(
      `SELECT g.*, u.nombre AS creadoPor FROM gastos g LEFT JOIN usuarios u ON u.id = g.creadoPorId
        ${donde.length ? `WHERE ${donde.join(" AND ")}` : ""} ORDER BY g.causaDesde DESC, g.id DESC`,
      valores,
    );
    if (!filas.length) return [];
    const ids = filas.map((f) => f.id);
    const [caus] = await pool.query<RowDataPacket[]>("SELECT gastoId, fecha, monto FROM gastos_causaciones WHERE gastoId IN (?) ORDER BY fecha", [ids]);
    const [rep] = await pool.query<RowDataPacket[]>(
      `SELECT r.gastoId, r.fecha, r.vehiculoId, v.placa, r.socioId, s.nombre AS socio, r.monto
         FROM gastos_reparto r LEFT JOIN vehiculos v ON v.id = r.vehiculoId LEFT JOIN socios s ON s.id = r.socioId
        WHERE r.gastoId IN (?) ORDER BY r.fecha, v.placa, s.nombre`,
      [ids],
    );
    return filas.map((f) => ({
      id: f.id,
      empresa: f.empresa,
      tipo: f.tipo,
      categoria: f.categoria,
      descripcion: f.descripcion,
      monto: Number(f.monto),
      fechaPago: dia(f.fechaPago),
      soporteUrl: f.soporteUrl ?? null,
      causaDesde: dia(f.causaDesde)!,
      causaCuotas: f.causaCuotas,
      causaHasta: dia(f.causaHasta),
      destinos: destinosDe(f.destinos),
      origen: f.origen,
      nominaId: f.nominaId ?? null,
      creditoId: f.creditoId ?? null,
      anulado: !!f.anulado,
      creadoPor: f.creadoPor ?? null,
      creadoEn: f.creadoEn instanceof Date ? f.creadoEn.toISOString() : String(f.creadoEn),
      causaciones: caus.filter((c) => c.gastoId === f.id).map((c) => ({ fecha: dia(c.fecha)!, monto: Number(c.monto) })),
      reparto: rep
        .filter((r) => r.gastoId === f.id)
        .map((r) => ({
          fecha: dia(r.fecha)!,
          vehiculoId: r.vehiculoId ?? null,
          placa: r.placa ?? null,
          socioId: r.socioId ?? null,
          socio: r.socio ?? null,
          monto: Number(r.monto),
        })),
    }));
  },

  /** Registra un gasto con sus causaciones y su reparto. Devuelve el id. */
  async crear(
    d: Record<string, unknown>,
    usuarioId: number | null,
    origen: { origen: string; creditoId: number | null; nominaId?: number | null } = { origen: "MANUAL", creditoId: null },
  ): Promise<number> {
    const g = await validarGasto(d);
    await exigirAbierto(causacionesDe(g).map((c) => c.fecha));
    return enTransaccion(async (con) => {
      const [res] = await con.query<ResultSetHeader>(
        `INSERT INTO gastos (empresa, tipo, categoria, descripcion, monto, fechaPago, soporteUrl, causaDesde, causaCuotas, causaHasta, destinos, origen,
                             creditoId, nominaId, creadoPorId)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          g.empresa,
          g.tipo,
          g.categoria,
          g.descripcion,
          decimal(g.monto),
          g.fechaPago,
          g.soporteUrl,
          g.causaDesde,
          g.causaHasta ? causacionesDe(g).length : g.causaCuotas,
          g.causaHasta,
          JSON.stringify(g.destinos),
          origen.origen,
          origen.creditoId,
          origen.nominaId ?? null,
          usuarioId,
        ],
      );
      await escribirReparto(con, res.insertId, g);
      return res.insertId;
    });
  },

  /** Cambia un gasto y recalcula su reparto (solo si sus meses, los de antes y los nuevos, estan abiertos). */
  async actualizar(id: number, d: Record<string, unknown>): Promise<void> {
    const [actual] = await this.listar({ id });
    if (!actual) throw new ErrorCuadro("Ese gasto no existe.");
    if (actual.anulado) throw new ErrorCuadro("Ese gasto esta anulado.");
    exigirManual(actual);
    const g = await validarGasto(d);
    await exigirAbierto([
      ...actual.causaciones.map((c) => c.fecha),
      ...causacionesDe(g).map((c) => c.fecha),
    ]);
    await enTransaccion(async (con) => {
      await con.query(
        `UPDATE gastos SET empresa = ?, tipo = ?, categoria = ?, descripcion = ?, monto = ?, fechaPago = ?, soporteUrl = ?,
                causaDesde = ?, causaCuotas = ?, destinos = ? WHERE id = ?`,
        [
          g.empresa,
          g.tipo,
          g.categoria,
          g.descripcion,
          decimal(g.monto),
          g.fechaPago,
          g.soporteUrl,
          g.causaDesde,
          g.causaCuotas,
          JSON.stringify(g.destinos),
          id,
        ],
      );
      await escribirReparto(con, id, g);
    });
  },

  /** Solo la fecha de pago y el link del soporte (no tocan el reparto, asi que se pueden cambiar con el mes cerrado). */
  async pago(id: number, d: Record<string, unknown>): Promise<void> {
    const sets: string[] = [];
    const valores: unknown[] = [];
    if ("fechaPago" in d) {
      sets.push("fechaPago = ?");
      valores.push(d.fechaPago ? fechaDe(d.fechaPago, "la fecha de pago") : null);
    }
    if ("soporteUrl" in d) {
      sets.push("soporteUrl = ?");
      valores.push(linkDe(d.soporteUrl));
    }
    if (sets.length) await pool.query(`UPDATE gastos SET ${sets.join(", ")} WHERE id = ?`, [...valores, id]);
  },

  /** Anula un gasto: deja de contar (se borra su reparto) pero queda en el libro. */
  async anular(id: number): Promise<void> {
    const [actual] = await this.listar({ id });
    if (!actual || actual.anulado) return;
    exigirManual(actual);
    await exigirAbierto(actual.causaciones.map((c) => c.fecha));
    await enTransaccion(async (con) => {
      await con.query("DELETE FROM gastos_reparto WHERE gastoId = ?", [id]);
      await con.query("UPDATE gastos SET anulado = 1 WHERE id = ?", [id]);
    });
  },

  /** Revisa que se puedan crear gastos con estas causaciones (desde la fecha de inicio y en meses abiertos). */
  async revisarCausaciones(g: { monto: number; causaDesde: string; causaHasta: string }): Promise<void> {
    await exigirAbierto(causacionesDe({ monto: aCentavos(g.monto), causaDesde: g.causaDesde, causaCuotas: 1, causaHasta: g.causaHasta }).map((c) => c.fecha));
  },

  /** Borra los gastos que genero una nomina (al reabrirla). Sus meses deben estar abiertos. */
  async borrarDeNomina(nominaId: number): Promise<void> {
    const [caus] = await pool.query<RowDataPacket[]>(
      "SELECT c.fecha FROM gastos_causaciones c JOIN gastos g ON g.id = c.gastoId WHERE g.nominaId = ?",
      [nominaId],
    );
    await exigirAbierto(caus.map((c) => dia(c.fecha)!));
    await pool.query("DELETE FROM gastos WHERE nominaId = ?", [nominaId]);
  },

  /** Cierra o abre un mes ("AAAA-MM"): con el mes cerrado sus gastos no cambian. */
  async cerrarMes(d: Record<string, unknown>, usuarioId: number | null): Promise<string[]> {
    const m = String(d.mes ?? "");
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(m)) throw new ErrorCuadro("Elige el mes.");
    if (d.cerrado === false) {
      const [[aprobado]] = await pool.query<RowDataPacket[]>("SELECT 1 AS si FROM repartos_utilidades WHERE mes = ?", [m]);
      if (aprobado) throw new ErrorCuadro(`El reparto de utilidades de ${m} esta aprobado: anula la aprobacion en Utilidades para abrir el mes.`);
      await pool.query("DELETE FROM periodos_cierre WHERE mes = ?", [m]);
    }
    else await pool.query("INSERT IGNORE INTO periodos_cierre (mes, cerradoPorId) VALUES (?, ?)", [m, usuarioId]);
    return [...(await limites()).cerrados].sort();
  },

  /** Cambia la fecha desde la que se registran gastos. */
  async fijarCorte(d: Record<string, unknown>): Promise<string> {
    const corte = fechaDe(d.corte, "la fecha de corte");
    await pool.query("UPDATE parametros_empresa SET gastosDesde = ? WHERE id = 1", [corte]);
    return corte;
  },

  // ---------- Creditos ----------

  /** Creditos de una empresa o de las dos, con su tabla y su saldo. */
  async creditos(filtro: { empresa?: EmpresaVehiculo | null; id?: number } = {}): Promise<Credito[]> {
    const donde: string[] = [];
    const valores: unknown[] = [];
    if (filtro.empresa) {
      donde.push("empresa = ?");
      valores.push(filtro.empresa);
    }
    if (filtro.id) {
      donde.push("id = ?");
      valores.push(filtro.id);
    }
    const [filas] = await pool.query<RowDataPacket[]>(
      `SELECT * FROM creditos ${donde.length ? `WHERE ${donde.join(" AND ")}` : ""} ORDER BY primeraCuota DESC, id DESC`,
      valores,
    );
    if (!filas.length) return [];
    const [cuotas] = await pool.query<RowDataPacket[]>("SELECT * FROM creditos_cuotas WHERE creditoId IN (?) ORDER BY numero", [filas.map((f) => f.id)]);
    return filas.map((f) => {
      const propias = cuotas
        .filter((c) => c.creditoId === f.id)
        .map((c) => ({
          numero: c.numero,
          fecha: dia(c.fecha)!,
          cuota: Number(c.cuota),
          capital: Number(c.capital),
          interes: Number(c.interes),
          saldo: Number(c.saldo),
          fechaPago: dia(c.fechaPago),
          gastoId: c.gastoId ?? null,
        }));
      const pagadas = propias.filter((c) => c.fechaPago);
      return {
        id: f.id,
        empresa: f.empresa,
        nombre: f.nombre,
        entidad: f.entidad ?? null,
        obligacion: f.obligacion ?? null,
        monto: Number(f.monto),
        tasaMensual: Number(f.tasaMensual),
        plazo: f.plazo,
        primeraCuota: dia(f.primeraCuota)!,
        cuotaFija: f.cuotaFija === null ? null : Number(f.cuotaFija),
        prorratea: f.prorratea,
        destinos: destinosDe(f.destinos),
        nota: f.nota ?? null,
        cuotas: propias,
        saldoPendiente: aPesos(aCentavos(Number(f.monto)) - pagadas.reduce((s, c) => s + aCentavos(c.capital), 0)),
        cuotasPagadas: pagadas.length,
      };
    });
  },

  /**
   * Crea un credito o lo cambia y arma su tabla de amortizacion. Con cuotas
   * ya pagadas solo se cambian el nombre, la entidad, la nota, el reparto y
   * que se prorratea (la tabla no se rehace).
   */
  async guardarCredito(d: Record<string, unknown>, usuarioId: number | null, id?: number): Promise<number> {
    const empresa = String(d.empresa ?? "") as EmpresaVehiculo;
    if (!EMPRESAS.includes(empresa)) throw new ErrorCuadro("Elige la empresa del credito.");
    const nombre = texto(d.nombre, 150);
    if (!nombre) throw new ErrorCuadro("Escribe el nombre del credito.");
    const monto = Number(d.monto);
    const tasa = Number(d.tasaMensual);
    const plazo = Number(d.plazo);
    if (!Number.isFinite(monto) || monto <= 0) throw new ErrorCuadro("Escribe el monto del credito.");
    if (!Number.isFinite(tasa) || tasa < 0 || tasa >= 100) throw new ErrorCuadro("Escribe la tasa mensual en porcentaje (por ejemplo 1,67).");
    const primeraCuota = fechaDe(d.primeraCuota, "la fecha de la primera cuota");
    const cuotaFija = d.cuotaFija === null || d.cuotaFija === undefined || d.cuotaFija === "" ? null : Number(d.cuotaFija);
    if (cuotaFija !== null && (!Number.isFinite(cuotaFija) || cuotaFija <= 0)) throw new ErrorCuadro("La cuota fija no es valida.");
    const prorratea = d.prorratea === "INTERES" ? "INTERES" : "CAPITAL_E_INTERES";
    const destinos = await leerDestinos(d.destinos);
    const tabla = conErrores(() => amortizar(aCentavos(monto), tasa / 100, plazo, primeraCuota, cuotaFija === null ? null : aCentavos(cuotaFija)));
    const comunes = [empresa, nombre, texto(d.entidad, 100), texto(d.obligacion, 60), prorratea, JSON.stringify(destinos), texto(d.nota, 300)];

    return enTransaccion(async (con) => {
      let creditoId = id;
      let rehacer = true;
      if (id) {
        const [[pagadas]] = await con.query<RowDataPacket[]>("SELECT COUNT(*) AS n FROM creditos_cuotas WHERE creditoId = ? AND fechaPago IS NOT NULL", [id]);
        rehacer = Number(pagadas.n) === 0;
        await con.query("UPDATE creditos SET empresa = ?, nombre = ?, entidad = ?, obligacion = ?, prorratea = ?, destinos = ?, nota = ? WHERE id = ?", [
          ...comunes,
          id,
        ]);
        if (rehacer) {
          await con.query("UPDATE creditos SET monto = ?, tasaMensual = ?, plazo = ?, primeraCuota = ?, cuotaFija = ? WHERE id = ?", [
            decimal(aCentavos(monto)),
            tasa,
            plazo,
            primeraCuota,
            cuotaFija === null ? null : decimal(aCentavos(cuotaFija)),
            id,
          ]);
          await con.query("DELETE FROM creditos_cuotas WHERE creditoId = ?", [id]);
        }
      } else {
        const [res] = await con.query<ResultSetHeader>(
          `INSERT INTO creditos (empresa, nombre, entidad, obligacion, prorratea, destinos, nota, monto, tasaMensual, plazo, primeraCuota, cuotaFija, creadoPorId)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [...comunes, decimal(aCentavos(monto)), tasa, plazo, primeraCuota, cuotaFija === null ? null : decimal(aCentavos(cuotaFija)), usuarioId],
        );
        creditoId = res.insertId;
      }
      if (rehacer) {
        await con.query("INSERT INTO creditos_cuotas (creditoId, numero, fecha, cuota, capital, interes, saldo) VALUES ?", [
          tabla.map((c) => [creditoId, c.numero, c.fecha, decimal(c.cuota), decimal(c.capital), decimal(c.interes), decimal(c.saldo)]),
        ]);
      }
      return creditoId!;
    });
  },

  /** Borra un credito sin cuotas pagadas. */
  async borrarCredito(id: number): Promise<void> {
    const [[pagadas]] = await pool.query<RowDataPacket[]>("SELECT COUNT(*) AS n FROM creditos_cuotas WHERE creditoId = ? AND fechaPago IS NOT NULL", [id]);
    if (Number(pagadas.n) > 0) throw new ErrorCuadro("El credito ya tiene cuotas pagadas: quita esos pagos primero.");
    await pool.query("DELETE FROM creditos WHERE id = ?", [id]);
  },

  /**
   * Registra el pago de una cuota ({ fechaPago, soporteUrl? }). Si la cuota es
   * de la fecha de corte en adelante crea su gasto (capital e interes, o solo
   * interes, segun el credito) con el reparto del credito; las anteriores solo
   * quedan pagadas, para que el saldo cuadre.
   */
  async pagarCuota(creditoId: number, numero: number, d: Record<string, unknown>, usuarioId: number | null): Promise<void> {
    const [credito] = await this.creditos({ id: creditoId });
    const cuota = credito?.cuotas.find((c) => c.numero === numero);
    if (!credito || !cuota) throw new ErrorCuadro("Esa cuota no existe.");
    if (cuota.fechaPago) throw new ErrorCuadro("Esa cuota ya esta pagada.");
    const fechaPago = fechaDe(d.fechaPago ?? hoyColombia(), "la fecha de pago");
    const { corte } = await limites();
    let gastoId: number | null = null;
    if (cuota.fecha >= corte) {
      gastoId = await this.crear(
        {
          empresa: credito.empresa,
          tipo: "GASTO",
          categoria: "CREDITO",
          descripcion: `${credito.nombre}: cuota ${numero} de ${credito.plazo}${credito.prorratea === "INTERES" ? " (interes)" : ""}`,
          monto: credito.prorratea === "INTERES" ? cuota.interes : cuota.cuota,
          fechaPago,
          soporteUrl: d.soporteUrl ?? null,
          causaDesde: cuota.fecha,
          causaCuotas: 1,
          destinos: credito.destinos,
        },
        usuarioId,
        { origen: "CREDITO", creditoId },
      );
    }
    await pool.query("UPDATE creditos_cuotas SET fechaPago = ?, gastoId = ? WHERE creditoId = ? AND numero = ?", [fechaPago, gastoId, creditoId, numero]);
  },

  /** Quita el pago de una cuota y borra su gasto (si el mes esta abierto). */
  async quitarPagoCuota(creditoId: number, numero: number): Promise<void> {
    const [[cuota]] = await pool.query<RowDataPacket[]>("SELECT fecha, gastoId FROM creditos_cuotas WHERE creditoId = ? AND numero = ?", [creditoId, numero]);
    if (!cuota) throw new ErrorCuadro("Esa cuota no existe.");
    if (cuota.gastoId) await exigirAbierto([dia(cuota.fecha)!]);
    await enTransaccion(async (con) => {
      await con.query("UPDATE creditos_cuotas SET fechaPago = NULL, gastoId = NULL WHERE creditoId = ? AND numero = ?", [creditoId, numero]);
      if (cuota.gastoId) await con.query("DELETE FROM gastos WHERE id = ?", [cuota.gastoId]);
    });
  },
};
