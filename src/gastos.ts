/**
 * Libro de gastos de las dos empresas (Transportes Lopez y Transportes M&C),
 * creditos y cierre de meses. Fase 1 del modulo de gastos, prorrateo y reparto
 * de utilidades.
 *
 * - Un gasto (o ingreso) tiene empresa, categoria, monto, fecha de pago (flujo
 *   de caja), proveedor y factura (numero y si es credito o debito, para el
 *   reporte de facturas credito de la contadora) y su forma:
 *   . UNICO (lo normal): se causa en la fecha de pago (o la del gasto, si
 *     aun no se paga).
 *   . DIFERIDO: se paga una vez y se causa en cuotas mensuales o quincenales
 *     (un seguro anual en 12 meses).
 *   . RECURRENTE: lo genera un gasto recurrente (arriendo, honorarios,
 *     servicios) cada mes o quincena, con el valor vigente en ese periodo;
 *     cuando el valor cambia se registra desde una fecha y el historico queda.
 * - Antes de guardar se buscan gastos repetidos (la factura que llega por
 *   correo y en fisico): la misma factura, o el mismo valor y fecha con una
 *   descripcion parecida. Si hay, se pregunta antes de guardar (reglasGastos.ts).
 * - Destinos: los vehiculos que se marquen (una parte por carro), partes
 *   directas a socios (valor fijo, porcentaje o partes) y/o la empresa (lo
 *   que no se le carga a ningun carro: baja la rentabilidad de la empresa).
 * - El reparto se calcula al guardar y queda escrito (gastos_reparto): no
 *   cambia solo. Editar el gasto lo recalcula, y solo se puede en meses
 *   abiertos (periodos_cierre).
 * - Lo que una empresa le debe a la otra no es una cuenta entre empresas: es
 *   un gasto en una y un ingreso en la otra, cada uno con su reparto.
 * - Montos en DECIMAL; las cuentas se hacen en centavos (ver prorrateo.ts).
 * - Creditos: se crean con la cuota que cobra el banco y, si se quiere, la
 *   tasa mensual (si no se escribe, se deduce de monto, plazo y cuota) y el 4 x 1000 que se
 *   descuenta a cada cuota. Tabla de amortizacion (capital, interes, saldo);
 *   al registrar el pago de una cuota (con el valor que de verdad se pago) se
 *   crea su gasto con el reparto del credito, sumando su 4 x 1000.
 * - Nomina (fase 2): al aprobarla se crea un gasto por empleado, causado por
 *   dias entre los meses que cubre (causaHasta). Esos gastos se cambian
 *   desde la nomina, no desde el libro.
 */
import type { PoolConnection, ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { pool } from "./db";
import { dia, ErrorCuadro, hoyColombia } from "./cuadro";
import { aCentavos, amortizar, aPesos, causaciones, causacionesPorDias, ErrorReparto, gmfDe, repartirGasto, tasaImplicita } from "./prorrateo";
import type { Destino, Periodicidad } from "./prorrateo";
import { periodosRecurrente, posiblesDuplicados, valorEn } from "./reglasGastos";
import type { GastoComparable } from "./reglasGastos";
import type { EmpresaVehiculo } from "./roles";

export const EMPRESAS: EmpresaVehiculo[] = ["LOPEZ", "MYC"];
/** Categorias del libro de gastos. */
export const CATEGORIAS = ["NOMINA", "OFICINA", "SERVICIOS", "CREDITO", "VEHICULO", "SEGUROS", "IMPUESTOS", "SOCIO", "OTROS"] as const;
export type Categoria = (typeof CATEGORIAS)[number];
/** Forma de un gasto: pago unico, diferido en cuotas o generado por un recurrente. */
export type FormaGasto = "UNICO" | "DIFERIDO" | "RECURRENTE";
/** Tipo de la factura: credito (se paga despues; va al reporte de la contadora) o debito (contado). */
export type TipoFactura = "CREDITO" | "DEBITO";

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
  forma: FormaGasto;
  /** Cada cuanto se causan sus cuotas (diferido) o se repite (recurrente). */
  periodicidad: Periodicidad;
  proveedor: string | null;
  numeroFactura: string | null;
  tipoFactura: TipoFactura | null;
  /** El recurrente que lo genero y su periodo. */
  recurrenteId: number | null;
  periodo: string | null;
}

/** Un gasto recurrente (arriendo, honorarios, servicios) con el historial de su valor. */
export interface GastoRecurrente {
  id: number;
  empresa: EmpresaVehiculo;
  tipo: "GASTO" | "INGRESO";
  categoria: Categoria;
  descripcion: string;
  proveedor: string | null;
  tipoFactura: TipoFactura | null;
  destinos: Destino[];
  periodicidad: Periodicidad;
  desde: string;
  hasta: string | null;
  activo: boolean;
  /** Valor desde cada fecha (el ultimo es el vigente). */
  valores: Array<{ desde: string; monto: number }>;
  valorActual: number | null;
  generados: number;
  porPagar: number;
}

/** Un credito con su tabla de amortizacion. */
export interface Credito {
  id: number;
  empresa: EmpresaVehiculo;
  nombre: string;
  entidad: string | null;
  obligacion: string | null;
  monto: number;
  /** Tasa mensual en porcentaje (1.6725), deducida de la cuota del banco. */
  tasaMensual: number;
  /** 4 x 1000 que se descuenta a cada cuota (por mil). */
  gmfPorMil: number;
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
    /** Lo que de verdad se pago (si fue distinto de la cuota de la tabla). */
    valorPagado: number | null;
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
  forma: FormaGasto;
  periodicidad: Periodicidad;
  proveedor: string | null;
  numeroFactura: string | null;
  tipoFactura: TipoFactura | null;
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
  const fechaPago = d.fechaPago ? fechaDe(d.fechaPago, "la fecha de pago") : null;
  const cuotasDadas = d.causaCuotas === undefined || d.causaCuotas === null || d.causaCuotas === "" ? 1 : Number(d.causaCuotas);
  // Pago unico (lo normal): se causa en la fecha del gasto; si no viene, el dia que se paga.
  const forma: FormaGasto =
    d.forma === "RECURRENTE" ? "RECURRENTE" : d.forma === "DIFERIDO" || (d.forma === undefined && cuotasDadas > 1) ? "DIFERIDO" : "UNICO";
  const causaDesde =
    forma === "UNICO" && !d.causaDesde
      ? (fechaPago ?? fechaDe(d.causaDesde, "la fecha del gasto o la de pago"))
      : fechaDe(d.causaDesde, "la fecha de causacion (a que periodo corresponde)");
  const causaCuotas = forma === "DIFERIDO" ? cuotasDadas : 1;
  const tipoFactura = d.tipoFactura === "CREDITO" || d.tipoFactura === "DEBITO" ? d.tipoFactura : null;
  return {
    empresa,
    tipo: d.tipo === "INGRESO" ? "INGRESO" : "GASTO",
    categoria,
    descripcion,
    monto: aCentavos(monto),
    fechaPago,
    soporteUrl: linkDe(d.soporteUrl),
    causaDesde,
    causaCuotas,
    forma,
    periodicidad: d.periodicidad === "QUINCENAL" ? "QUINCENAL" : "MENSUAL",
    proveedor: texto(d.proveedor, 150),
    numeroFactura: texto(d.numeroFactura, 40),
    tipoFactura,
    causaHasta: d.causaHasta ? fechaDe(d.causaHasta, "el fin del periodo") : null,
    destinos: await leerDestinos(d.destinos),
  };
}

/** Causaciones de un gasto: por dias si tiene causaHasta (nomina); si no, en cuotas mensuales o quincenales. */
const causacionesDe = (g: Pick<DatosGasto, "monto" | "causaDesde" | "causaCuotas" | "causaHasta"> & { periodicidad?: Periodicidad }) =>
  conErrores(() =>
    g.causaHasta ? causacionesPorDias(g.monto, g.causaDesde, g.causaHasta) : causaciones(g.monto, g.causaDesde, g.causaCuotas, g.periodicidad ?? "MENSUAL"),
  );

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
  g: Pick<DatosGasto, "monto" | "causaDesde" | "causaCuotas" | "causaHasta" | "destinos"> & { periodicidad?: Periodicidad },
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
function exigirManual(g: Gasto, accion: "cambiar" | "anular" = "cambiar"): void {
  if (g.origen === "CREDITO") throw new ErrorCuadro("Este gasto sale de un credito: se cambia desde el credito (pago de la cuota).");
  if (g.origen === "NOMINA") throw new ErrorCuadro("Este gasto sale de la nomina: reabre la nomina para cambiarlo.");
  if (g.origen === "CUENTA_VIAJE") throw new ErrorCuadro("Este gasto sale de una cuenta de viaje: se cambia en Cuentas vehiculos > Cuentas de viaje.");
  // Un periodo de un recurrente se puede anular (ese mes no se pago), pero su valor se cambia en el recurrente.
  if (g.origen === "RECURRENTE" && accion === "cambiar")
    throw new ErrorCuadro("Este gasto sale de un recurrente: cambia su valor desde una fecha en Recurrentes.");
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
      forma: (f.forma ?? "UNICO") as FormaGasto,
      periodicidad: (f.periodicidad ?? "MENSUAL") as Periodicidad,
      proveedor: f.proveedor ?? null,
      numeroFactura: f.numeroFactura ?? null,
      tipoFactura: f.tipoFactura ?? null,
      recurrenteId: f.recurrenteId ?? null,
      periodo: dia(f.periodo),
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
    origen: {
      origen: string;
      creditoId: number | null;
      nominaId?: number | null;
      recurrenteId?: number | null;
      periodo?: string | null;
      cuentaViajeId?: number | null;
    } = {
      origen: "MANUAL",
      creditoId: null,
    },
  ): Promise<number> {
    const g = await validarGasto(d);
    await exigirAbierto(causacionesDe(g).map((c) => c.fecha));
    // Gastos repetidos (la factura que llega por correo y en fisico): se pregunta antes de guardarlo otra vez.
    if (origen.origen === "MANUAL" && !d.confirmarDuplicado) {
      const repetidos = await this.revisarDuplicados(d);
      if (repetidos.length)
        throw new ErrorCuadro(
          `Este gasto parece ya registrado (${repetidos.map((r) => `${r.descripcion}, ${r.motivo}`).join("; ")}). Si es otro, confirma que lo quieres guardar.`,
        );
    }
    return enTransaccion(async (con) => {
      const [res] = await con.query<ResultSetHeader>(
        `INSERT INTO gastos (empresa, tipo, categoria, descripcion, monto, fechaPago, soporteUrl, causaDesde, causaCuotas, causaHasta, destinos, origen,
                             creditoId, nominaId, creadoPorId, forma, periodicidad, proveedor, numeroFactura, tipoFactura, recurrenteId, periodo, cuentaViajeId)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          origen.origen === "RECURRENTE" ? "RECURRENTE" : g.forma,
          g.periodicidad,
          g.proveedor,
          g.numeroFactura,
          g.tipoFactura,
          origen.recurrenteId ?? null,
          origen.periodo ?? null,
          origen.cuentaViajeId ?? null,
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
    await exigirAbierto([...actual.causaciones.map((c) => c.fecha), ...causacionesDe(g).map((c) => c.fecha)]);
    await enTransaccion(async (con) => {
      await con.query(
        `UPDATE gastos SET empresa = ?, tipo = ?, categoria = ?, descripcion = ?, monto = ?, fechaPago = ?, soporteUrl = ?,
                causaDesde = ?, causaCuotas = ?, destinos = ?, forma = ?, periodicidad = ?, proveedor = ?, numeroFactura = ?, tipoFactura = ? WHERE id = ?`,
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
          g.forma,
          g.periodicidad,
          g.proveedor,
          g.numeroFactura,
          g.tipoFactura,
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
    exigirManual(actual, "anular");
    await exigirAbierto(actual.causaciones.map((c) => c.fecha));
    await enTransaccion(async (con) => {
      await con.query("DELETE FROM gastos_reparto WHERE gastoId = ?", [id]);
      await con.query("UPDATE gastos SET anulado = 1 WHERE id = ?", [id]);
    });
  },

  /**
   * Gastos ya guardados que pueden ser el mismo que este (la misma factura, o
   * el mismo valor y fecha con una descripcion parecida). Se usa antes de
   * guardar para preguntar.
   */
  async revisarDuplicados(
    d: Record<string, unknown>,
  ): Promise<Array<{ id: number; descripcion: string; fecha: string; monto: number; numeroFactura: string | null; motivo: string }>> {
    const empresa = String(d.empresa ?? "");
    const monto = Number(d.monto);
    const fecha = String(d.fechaPago || d.causaDesde || "").slice(0, 10);
    if (!empresa || !fecha) return [];
    const [filas] = await pool.query<RowDataPacket[]>(
      `SELECT id, empresa, descripcion, numeroFactura, fechaPago, causaDesde, monto FROM gastos
        WHERE anulado = 0 AND empresa = ? AND (numeroFactura IS NOT NULL OR COALESCE(fechaPago, causaDesde) = ?)`,
      [empresa, fecha],
    );
    const existentes = filas.map((f) => ({
      id: f.id as number,
      empresa: f.empresa as string,
      descripcion: f.descripcion as string,
      numeroFactura: (f.numeroFactura as string) ?? null,
      fecha: dia(f.fechaPago) ?? dia(f.causaDesde)!,
      monto: Number(f.monto),
    }));
    const nuevo: GastoComparable = {
      id: d.id ? Number(d.id) : undefined,
      empresa,
      descripcion: String(d.descripcion ?? ""),
      numeroFactura: d.numeroFactura ? String(d.numeroFactura) : null,
      fecha,
      monto,
    };
    return posiblesDuplicados(nuevo, existentes).map((r) => ({ ...r.gasto, motivo: r.motivo }));
  },

  /** Gastos recurrentes con el historial de sus valores. */
  async recurrentes(filtro: { id?: number } = {}): Promise<GastoRecurrente[]> {
    const [filas] = await pool.query<RowDataPacket[]>(
      `SELECT * FROM gastos_recurrentes ${filtro.id ? "WHERE id = ?" : ""} ORDER BY activo DESC, descripcion`,
      filtro.id ? [filtro.id] : [],
    );
    if (!filas.length) return [];
    const ids = filas.map((f) => f.id);
    const [valores] = await pool.query<RowDataPacket[]>(
      "SELECT recurrenteId, desde, monto FROM gastos_recurrentes_valores WHERE recurrenteId IN (?) ORDER BY desde",
      [ids],
    );
    const [generados] = await pool.query<RowDataPacket[]>(
      "SELECT recurrenteId, COUNT(*) AS n, SUM(fechaPago IS NULL) AS porPagar FROM gastos WHERE recurrenteId IN (?) AND anulado = 0 GROUP BY recurrenteId",
      [ids],
    );
    const hoy = hoyColombia();
    return filas.map((f) => {
      const suyos = valores.filter((v) => v.recurrenteId === f.id).map((v) => ({ desde: dia(v.desde)!, monto: Number(v.monto) }));
      const g = generados.find((x) => x.recurrenteId === f.id);
      return {
        id: f.id,
        empresa: f.empresa,
        tipo: f.tipo,
        categoria: f.categoria,
        descripcion: f.descripcion,
        proveedor: f.proveedor ?? null,
        tipoFactura: f.tipoFactura ?? null,
        destinos: destinosDe(f.destinos),
        periodicidad: f.periodicidad,
        desde: dia(f.desde)!,
        hasta: dia(f.hasta),
        activo: !!f.activo,
        valores: suyos,
        valorActual: valorEn(suyos, hoy) ?? suyos[0]?.monto ?? null,
        generados: Number(g?.n ?? 0),
        porPagar: Number(g?.porPagar ?? 0),
      };
    });
  },

  /**
   * Crea o cambia un gasto recurrente ({ empresa, tipo, categoria, descripcion,
   * proveedor?, tipoFactura?, destinos, periodicidad, desde, hasta?, monto }).
   * Al crearlo, el monto es su valor desde `desde`; despues el valor se cambia
   * con cambiarValor (para no perder el historico).
   */
  async guardarRecurrente(d: Record<string, unknown>, usuarioId: number | null, id?: number): Promise<number> {
    const empresa = String(d.empresa ?? "") as EmpresaVehiculo;
    if (!EMPRESAS.includes(empresa)) throw new ErrorCuadro("Elige la empresa.");
    const categoria = String(d.categoria ?? "") as Categoria;
    if (!CATEGORIAS.includes(categoria)) throw new ErrorCuadro("Elige la categoria.");
    const descripcion = texto(d.descripcion, 300);
    if (!descripcion) throw new ErrorCuadro("Escribe la descripcion.");
    const desde = fechaDe(d.desde, "la fecha del primer pago");
    const hasta = d.hasta ? fechaDe(d.hasta, "la fecha final") : null;
    if (hasta && hasta < desde) throw new ErrorCuadro("La fecha final es antes del primer pago.");
    const destinos = await leerDestinos(d.destinos);
    conErrores(() => repartirGasto(100_00, destinos));
    const valores = [
      empresa,
      d.tipo === "INGRESO" ? "INGRESO" : "GASTO",
      categoria,
      descripcion,
      texto(d.proveedor, 150),
      d.tipoFactura === "CREDITO" || d.tipoFactura === "DEBITO" ? d.tipoFactura : null,
      JSON.stringify(destinos),
      d.periodicidad === "QUINCENAL" ? "QUINCENAL" : "MENSUAL",
      desde,
      hasta,
    ];
    if (id) {
      await pool.query(
        "UPDATE gastos_recurrentes SET empresa = ?, tipo = ?, categoria = ?, descripcion = ?, proveedor = ?, tipoFactura = ?, destinos = ?, periodicidad = ?, desde = ?, hasta = ? WHERE id = ?",
        [...valores, id],
      );
      return id;
    }
    const monto = Number(d.monto);
    if (!Number.isFinite(monto) || monto <= 0) throw new ErrorCuadro("Escribe el valor (mayor que cero).");
    const [res] = await pool.query<ResultSetHeader>(
      `INSERT INTO gastos_recurrentes (empresa, tipo, categoria, descripcion, proveedor, tipoFactura, destinos, periodicidad, desde, hasta, creadoPorId)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [...valores, usuarioId],
    );
    await pool.query("INSERT INTO gastos_recurrentes_valores (recurrenteId, desde, monto, creadoPorId) VALUES (?, ?, ?, ?)", [
      res.insertId,
      desde,
      decimal(aCentavos(monto)),
      usuarioId,
    ]);
    return res.insertId;
  },

  /**
   * Cambia el valor de un recurrente desde una fecha ({ desde, monto }). Los
   * periodos anteriores conservan el valor de su momento; los ya generados
   * desde esa fecha que no se han pagado (y en meses abiertos) toman el nuevo.
   */
  async cambiarValor(id: number, d: Record<string, unknown>, usuarioId: number | null): Promise<void> {
    const [r] = await this.recurrentes({ id });
    if (!r) throw new ErrorCuadro("Ese recurrente no existe.");
    const desde = fechaDe(d.desde, "desde cuando aplica el nuevo valor");
    const monto = Number(d.monto);
    if (!Number.isFinite(monto) || monto <= 0) throw new ErrorCuadro("Escribe el nuevo valor (mayor que cero).");
    await pool.query("DELETE FROM gastos_recurrentes_valores WHERE recurrenteId = ? AND desde = ?", [id, desde]);
    await pool.query("INSERT INTO gastos_recurrentes_valores (recurrenteId, desde, monto, creadoPorId) VALUES (?, ?, ?, ?)", [
      id,
      desde,
      decimal(aCentavos(monto)),
      usuarioId,
    ]);
    const { cerrados } = await limites();
    const [porActualizar] = await pool.query<RowDataPacket[]>(
      "SELECT id, periodo FROM gastos WHERE recurrenteId = ? AND anulado = 0 AND fechaPago IS NULL AND periodo >= ?",
      [id, desde],
    );
    const valores = [...r.valores.filter((v) => v.desde !== desde), { desde, monto }];
    for (const g of porActualizar) {
      const periodo = dia(g.periodo)!;
      if (cerrados.has(mes(periodo))) continue;
      const nuevo = valorEn(valores, periodo);
      if (nuevo === null) continue;
      await enTransaccion(async (con) => {
        await con.query("UPDATE gastos SET monto = ? WHERE id = ?", [decimal(aCentavos(nuevo)), g.id]);
        await escribirReparto(con, g.id, { monto: aCentavos(nuevo), causaDesde: periodo, causaCuotas: 1, causaHasta: null, destinos: r.destinos });
      });
    }
  },

  /** Termina un recurrente (no genera mas desde el dia siguiente a `hasta`) o lo vuelve a activar ({ activo, hasta? }). */
  async estadoRecurrente(id: number, d: Record<string, unknown>): Promise<void> {
    const activo = d.activo !== false;
    const hasta = d.hasta ? fechaDe(d.hasta, "la fecha final") : null;
    await pool.query("UPDATE gastos_recurrentes SET activo = ?, hasta = ? WHERE id = ?", [activo ? 1 : 0, activo ? hasta : (hasta ?? hoyColombia()), id]);
  },

  /**
   * Genera los gastos de los recurrentes activos para los periodos que ya
   * tocaron (hasta hoy), desde la fecha de inicio de los gastos y en meses
   * abiertos. Cada uno queda por pagar con el valor vigente en su periodo.
   * No repite: un periodo ya generado (o anulado) no se vuelve a crear.
   */
  async generarRecurrentes(usuarioId: number | null): Promise<number> {
    const { corte, cerrados } = await limites();
    const hoy = hoyColombia();
    let creados = 0;
    for (const r of await this.recurrentes()) {
      if (!r.activo || !r.valores.length) continue;
      const [ya] = await pool.query<RowDataPacket[]>("SELECT periodo FROM gastos WHERE recurrenteId = ?", [r.id]);
      const hechos = new Set(ya.map((x) => dia(x.periodo)));
      for (const periodo of periodosRecurrente(r.desde, r.hasta, hoy, r.periodicidad)) {
        if (periodo < corte || cerrados.has(mes(periodo)) || hechos.has(periodo)) continue;
        const monto = valorEn(r.valores, periodo);
        if (monto === null) continue;
        // Un recurrente con un problema (un vehiculo que ya no existe, otro que abrio el libro al tiempo) no tumba el libro.
        try {
          await this.crear(
            {
              empresa: r.empresa,
              tipo: r.tipo,
              categoria: r.categoria,
              descripcion: r.descripcion,
              proveedor: r.proveedor,
              tipoFactura: r.tipoFactura,
              monto,
              forma: "UNICO",
              causaDesde: periodo,
              periodicidad: r.periodicidad,
              destinos: r.destinos,
            },
            usuarioId,
            { origen: "RECURRENTE", creditoId: null, recurrenteId: r.id, periodo },
          );
          creados++;
        } catch (exc) {
          if ((exc as { code?: string }).code !== "ER_DUP_ENTRY") console.error(`Gasto recurrente ${r.id} (${periodo}): ${(exc as Error).message}`);
        }
      }
    }
    return creados;
  },

  /** Revisa que se puedan crear gastos con estas causaciones (desde la fecha de inicio y en meses abiertos). */
  async revisarCausaciones(g: { monto: number; causaDesde: string; causaHasta: string }): Promise<void> {
    await exigirAbierto(causacionesDe({ monto: aCentavos(g.monto), causaDesde: g.causaDesde, causaCuotas: 1, causaHasta: g.causaHasta }).map((c) => c.fecha));
  },

  /** Borra los gastos que genero una nomina (al reabrirla). Sus meses deben estar abiertos. */
  async borrarDeNomina(nominaId: number): Promise<void> {
    const [caus] = await pool.query<RowDataPacket[]>("SELECT c.fecha FROM gastos_causaciones c JOIN gastos g ON g.id = c.gastoId WHERE g.nominaId = ?", [
      nominaId,
    ]);
    await exigirAbierto(caus.map((c) => dia(c.fecha)!));
    await pool.query("DELETE FROM gastos WHERE nominaId = ?", [nominaId]);
  },

  /** Borra el gasto de una cuenta de viaje (sus meses deben estar abiertos). */
  async borrarDeCuenta(cuentaViajeId: number): Promise<void> {
    const [caus] = await pool.query<RowDataPacket[]>("SELECT c.fecha FROM gastos_causaciones c JOIN gastos g ON g.id = c.gastoId WHERE g.cuentaViajeId = ?", [
      cuentaViajeId,
    ]);
    await exigirAbierto(caus.map((c) => dia(c.fecha)!));
    await pool.query("DELETE FROM gastos WHERE cuentaViajeId = ?", [cuentaViajeId]);
  },

  /** Cierra o abre un mes ("AAAA-MM"): con el mes cerrado sus gastos no cambian. */
  async cerrarMes(d: Record<string, unknown>, usuarioId: number | null): Promise<string[]> {
    const m = String(d.mes ?? "");
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(m)) throw new ErrorCuadro("Elige el mes.");
    if (d.cerrado === false) {
      const [[aprobado]] = await pool.query<RowDataPacket[]>("SELECT 1 AS si FROM repartos_utilidades WHERE mes = ?", [m]);
      if (aprobado) throw new ErrorCuadro(`El reparto de utilidades de ${m} esta aprobado: anula la aprobacion en Utilidades para abrir el mes.`);
      await pool.query("DELETE FROM periodos_cierre WHERE mes = ?", [m]);
    } else await pool.query("INSERT IGNORE INTO periodos_cierre (mes, cerradoPorId) VALUES (?, ?)", [m, usuarioId]);
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
          valorPagado: c.valorPagado === null || c.valorPagado === undefined ? null : Number(c.valorPagado),
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
        gmfPorMil: f.gmfPorMil === null || f.gmfPorMil === undefined ? 4 : Number(f.gmfPorMil),
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
    const plazo = Number(d.plazo);
    if (!Number.isFinite(monto) || monto <= 0) throw new ErrorCuadro("Escribe el monto del credito.");
    if (!Number.isInteger(plazo) || plazo < 1) throw new ErrorCuadro("Escribe el plazo (numero de cuotas).");
    const primeraCuota = fechaDe(d.primeraCuota, "la fecha de la primera cuota");
    const cuotaFija = Number(d.cuotaFija);
    if (!Number.isFinite(cuotaFija) || cuotaFija <= 0) throw new ErrorCuadro("Escribe la cuota que cobra el banco.");
    const gmfPorMil = d.gmfPorMil === null || d.gmfPorMil === undefined || d.gmfPorMil === "" ? 4 : Number(d.gmfPorMil);
    if (!Number.isFinite(gmfPorMil) || gmfPorMil < 0 || gmfPorMil > 100) throw new ErrorCuadro("Revisa el 4 x 1000 (por mil).");
    // La tasa mensual es opcional (cambia mes a mes): si se escribe se usa esa; si no, se deduce de la cuota del banco.
    const tasaEscrita = d.tasaMensual === null || d.tasaMensual === undefined || d.tasaMensual === "" ? null : Number(d.tasaMensual);
    if (tasaEscrita !== null && (!Number.isFinite(tasaEscrita) || tasaEscrita < 0 || tasaEscrita >= 100))
      throw new ErrorCuadro("Revisa la tasa mensual (en porcentaje, por ejemplo 1,67).");
    const tasa = tasaEscrita ?? conErrores(() => tasaImplicita(monto, plazo, cuotaFija)) * 100;
    const prorratea = d.prorratea === "INTERES" ? "INTERES" : "CAPITAL_E_INTERES";
    const destinos = await leerDestinos(d.destinos);
    const tabla = conErrores(() => amortizar(aCentavos(monto), tasa / 100, plazo, primeraCuota, aCentavos(cuotaFija)));
    const comunes = [empresa, nombre, texto(d.entidad, 100), texto(d.obligacion, 60), prorratea, JSON.stringify(destinos), texto(d.nota, 300), gmfPorMil];

    return enTransaccion(async (con) => {
      let creditoId = id;
      let rehacer = true;
      if (id) {
        const [[pagadas]] = await con.query<RowDataPacket[]>("SELECT COUNT(*) AS n FROM creditos_cuotas WHERE creditoId = ? AND fechaPago IS NOT NULL", [id]);
        rehacer = Number(pagadas.n) === 0;
        await con.query(
          "UPDATE creditos SET empresa = ?, nombre = ?, entidad = ?, obligacion = ?, prorratea = ?, destinos = ?, nota = ?, gmfPorMil = ? WHERE id = ?",
          [...comunes, id],
        );
        if (rehacer) {
          await con.query("UPDATE creditos SET monto = ?, tasaMensual = ?, plazo = ?, primeraCuota = ?, cuotaFija = ? WHERE id = ?", [
            decimal(aCentavos(monto)),
            tasa,
            plazo,
            primeraCuota,
            decimal(aCentavos(cuotaFija)),
            id,
          ]);
          await con.query("DELETE FROM creditos_cuotas WHERE creditoId = ?", [id]);
        }
      } else {
        const [res] = await con.query<ResultSetHeader>(
          `INSERT INTO creditos (empresa, nombre, entidad, obligacion, prorratea, destinos, nota, gmfPorMil, monto, tasaMensual, plazo, primeraCuota, cuotaFija, creadoPorId)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [...comunes, decimal(aCentavos(monto)), tasa, plazo, primeraCuota, decimal(aCentavos(cuotaFija)), usuarioId],
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
    // Lo que de verdad se pago (la tasa cambia mes a mes); si no se dice, la cuota de la tabla.
    const valor = d.valor === null || d.valor === undefined || d.valor === "" ? cuota.cuota : Number(d.valor);
    if (!Number.isFinite(valor) || valor <= 0) throw new ErrorCuadro("Escribe el valor que se pago.");
    // Al gasto va la cuota (o solo el interes: lo pagado menos el capital de la tabla) mas su 4 x 1000.
    const base = credito.prorratea === "INTERES" ? Math.max(0, aCentavos(valor) - aCentavos(cuota.capital)) : aCentavos(valor);
    const gmf = gmfDe(aCentavos(valor), credito.gmfPorMil);
    const { corte } = await limites();
    let gastoId: number | null = null;
    if (cuota.fecha >= corte) {
      gastoId = await this.crear(
        {
          empresa: credito.empresa,
          tipo: "GASTO",
          categoria: "CREDITO",
          descripcion: `${credito.nombre}: cuota ${numero} de ${credito.plazo}${credito.prorratea === "INTERES" ? " (interes)" : ""}${gmf ? ` + ${credito.gmfPorMil} x 1000 (${aPesos(gmf).toLocaleString("es-CO")})` : ""}`,
          monto: aPesos(base + gmf),
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
    await pool.query("UPDATE creditos_cuotas SET fechaPago = ?, valorPagado = ?, gastoId = ? WHERE creditoId = ? AND numero = ?", [
      fechaPago,
      valor === cuota.cuota ? null : decimal(aCentavos(valor)),
      gastoId,
      creditoId,
      numero,
    ]);
  },

  /** Quita el pago de una cuota y borra su gasto (si el mes esta abierto). */
  async quitarPagoCuota(creditoId: number, numero: number): Promise<void> {
    const [[cuota]] = await pool.query<RowDataPacket[]>("SELECT fecha, gastoId FROM creditos_cuotas WHERE creditoId = ? AND numero = ?", [creditoId, numero]);
    if (!cuota) throw new ErrorCuadro("Esa cuota no existe.");
    if (cuota.gastoId) await exigirAbierto([dia(cuota.fecha)!]);
    await enTransaccion(async (con) => {
      await con.query("UPDATE creditos_cuotas SET fechaPago = NULL, valorPagado = NULL, gastoId = NULL WHERE creditoId = ? AND numero = ?", [
        creditoId,
        numero,
      ]);
      if (cuota.gastoId) await con.query("DELETE FROM gastos WHERE id = ?", [cuota.gastoId]);
    });
  },
};
