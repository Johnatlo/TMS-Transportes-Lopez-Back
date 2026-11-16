/**
 * Empleados, parametros anuales y nomina con costo del empleador (fase 2 del
 * modulo de gastos). El calculo de cada linea esta en calculoNomina.ts.
 *
 * - Empleado: empresa, conductor u oficina, riesgo ARL, salario (el minimo
 *   del ano o uno fijo, mas un adicional), % salarial y % de viaticos del
 *   producido, auxilio de transporte, ingreso y retiro. El conductor tiene su
 *   vehiculo con fechas (empleados_vehiculos); el de oficina, a quien se
 *   reparte su costo (vehiculos y/o socios, como un gasto).
 * - Parametros por ano (parametros_nomina): minimo, auxilio y porcentajes.
 *   La nomina usa los del ano en que termina.
 * - Nomina: un periodo (desde/hasta, variable) con una linea por empleado
 *   (dias, producido, vehiculo, ajuste con nota). Mientras es borrador se
 *   calcula con los datos actuales; al aprobarla el calculo queda guardado y
 *   se crea un gasto por empleado (categoria NOMINA) por su costo total,
 *   causado por dias entre los meses del periodo: el del conductor a su
 *   vehiculo, el de oficina a sus destinos. Reabrirla borra esos gastos.
 */
import type { ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { pool } from "./db";
import { dia, ErrorCuadro, hoyColombia } from "./cuadro";
import { calcularLinea, diasPeriodo } from "./calculoNomina";
import type { CalculoLinea, EntradaLinea, ParametrosNomina } from "./calculoNomina";
import { gastos, EMPRESAS } from "./gastos";
import type { Destino } from "./prorrateo";
import type { EmpresaVehiculo } from "./roles";

export type TipoEmpleado = "CONDUCTOR" | "OFICINA";

/** Un empleado con su vehiculo vigente y el historial de vehiculos. */
export interface Empleado {
  id: number;
  empresa: EmpresaVehiculo;
  tipo: TipoEmpleado;
  nombre: string;
  cedula: string | null;
  cargo: string | null;
  conductorId: number | null;
  riesgoArl: number;
  /** Salario mensual fijo; null = el minimo del ano. */
  salarioBase: number | null;
  salarioAdicional: number;
  pctSalarial: number;
  pctViaticos: number;
  auxilio: boolean;
  /** A quien se reparte el costo (oficina). */
  destinos: Destino[];
  fechaIngreso: string;
  fechaRetiro: string | null;
  nota: string | null;
  vehiculoId: number | null;
  placa: string | null;
  vehiculos: Array<{ id: number; vehiculoId: number; placa: string; desde: string; hasta: string | null }>;
}

/** Una linea de nomina con su calculo. */
export interface LineaNomina {
  id: number;
  empleadoId: number;
  nombre: string;
  empresa: EmpresaVehiculo;
  tipo: TipoEmpleado;
  cargo: string | null;
  vehiculoId: number | null;
  placa: string | null;
  dias: number;
  producido: number;
  ajuste: number;
  notaAjuste: string | null;
  /** Lo que entro al calculo (salario, porcentajes, riesgo...). */
  entrada: EntradaLinea;
  calculo: CalculoLinea;
  gastoId: number | null;
  /** Por que no se puede aprobar (falta vehiculo, destinos o nota). */
  problema: string | null;
}

/** Una nomina con sus lineas y totales. */
export interface Nomina {
  id: number;
  desde: string;
  hasta: string;
  estado: "BORRADOR" | "APROBADA";
  nota: string | null;
  anioParametros: number;
  creadoPor: string | null;
  aprobadaPor: string | null;
  aprobadaEn: string | null;
  lineas: LineaNomina[];
  totales: { devengado: number; neto: number; costoEmpleador: number; costoTotal: number };
}

/** Fecha "AAAA-MM-DD" valida. */
function fechaDe(v: unknown, campo: string): string {
  const f = String(v ?? "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(f) || Number.isNaN(Date.parse(f))) throw new ErrorCuadro(`Escribe ${campo}.`);
  return f;
}
/** Texto recortado, o null si queda vacio. */
const texto = (v: unknown, max: number) =>
  String(v ?? "")
    .trim()
    .slice(0, max) || null;
/** Numero (>= 0) o el valor por defecto si viene vacio. */
function numero(v: unknown, campo: string, defecto = 0): number {
  if (v === undefined || v === null || v === "") return defecto;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new ErrorCuadro(`Revisa ${campo}.`);
  return n;
}
/** JSON guardado a objeto (o el valor por defecto). */
function json<T>(v: unknown, defecto: T): T {
  try {
    return typeof v === "string" && v ? (JSON.parse(v) as T) : defecto;
  } catch {
    return defecto;
  }
}
/** "2026-10-21" -> "21/10/2026". */
const fechaTexto = (f: string) => f.split("-").reverse().join("/");
/** El dia anterior a una fecha. */
const diaAntes = (f: string) => new Date(Date.parse(f) - 86_400_000).toISOString().slice(0, 10);

/** Parametros de un ano desde la fila de la base. */
function parametrosDe(f: RowDataPacket): ParametrosNomina {
  return {
    anio: f.anio,
    smmlv: Number(f.smmlv),
    auxilioTransporte: Number(f.auxilioTransporte),
    pensionEmpleador: Number(f.pensionEmpleador),
    saludEmpleador: Number(f.saludEmpleador),
    arl: [Number(f.arl1), Number(f.arl2), Number(f.arl3), Number(f.arl4), Number(f.arl5)],
    caja: Number(f.caja),
    prima: Number(f.prima),
    cesantias: Number(f.cesantias),
    interesesCesantias: Number(f.interesesCesantias),
    vacaciones: Number(f.vacaciones),
    saludEmpleado: Number(f.saludEmpleado),
    pensionEmpleado: Number(f.pensionEmpleado),
    limiteNoSalarial: Number(f.limiteNoSalarial),
  };
}

/** Parametros del ano, o error si no estan. */
async function parametrosDelAnio(anio: number): Promise<ParametrosNomina> {
  const [[f]] = await pool.query<RowDataPacket[]>("SELECT * FROM parametros_nomina WHERE anio = ?", [anio]);
  if (!f) throw new ErrorCuadro(`Faltan los parametros de nomina de ${anio}: agregalos en Nomina > Parametros.`);
  return parametrosDe(f);
}

/** Lo que entra al calculo de una linea a partir del empleado. */
function entradaDe(e: Empleado, l: { dias: number; producido: number; ajuste: number }): EntradaLinea {
  return {
    salarioBase: e.salarioBase,
    salarioAdicional: e.salarioAdicional,
    pctSalarial: e.pctSalarial,
    pctViaticos: e.pctViaticos,
    auxilio: e.auxilio,
    riesgoArl: e.riesgoArl,
    dias: l.dias,
    producido: l.producido,
    ajuste: l.ajuste,
  };
}

/** Vehiculo del empleado vigente en una fecha (o el ultimo que tuvo antes). */
function vehiculoEn(e: Empleado, fecha: string): { vehiculoId: number; placa: string } | null {
  const v = e.vehiculos.filter((x) => x.desde <= fecha).sort((a, b) => b.desde.localeCompare(a.desde))[0];
  return v ? { vehiculoId: v.vehiculoId, placa: v.placa } : null;
}

/** Destinos validados de un empleado de oficina (los mismos que un gasto). */
async function destinosValidos(x: unknown): Promise<Destino[]> {
  const lista = Array.isArray(x) ? x : [];
  const destinos: Destino[] = [];
  for (const d of lista as Array<Record<string, unknown>>) {
    const tipo = d.tipo === "SOCIO" ? "SOCIO" : "VEHICULO";
    const modo = d.modo === "FIJO" || d.modo === "PORCENTAJE" ? d.modo : "PARTE";
    const id = Number(d.id);
    const valor = Number(d.valor);
    if (!Number.isInteger(id) || !(valor > 0)) throw new ErrorCuadro("Revisa a quien se reparte el costo.");
    destinos.push({ tipo, id, modo, valor });
  }
  return destinos;
}

/** Empleados, parametros y nominas. */
export const nomina = {
  /** Parametros de todos los anos (el mas reciente primero). */
  async parametros(): Promise<ParametrosNomina[]> {
    const [filas] = await pool.query<RowDataPacket[]>("SELECT * FROM parametros_nomina ORDER BY anio DESC");
    return filas.map(parametrosDe);
  },

  /** Crea o cambia los parametros de un ano. */
  async guardarParametros(d: Record<string, unknown>): Promise<void> {
    const anio = Number(d.anio);
    if (!Number.isInteger(anio) || anio < 2020 || anio > 2100) throw new ErrorCuadro("Escribe el ano.");
    const arl = Array.isArray(d.arl) ? d.arl : [];
    const p = {
      smmlv: numero(d.smmlv, "el salario minimo"),
      auxilioTransporte: numero(d.auxilioTransporte, "el auxilio de transporte"),
      pensionEmpleador: numero(d.pensionEmpleador, "la pension del empleador"),
      saludEmpleador: numero(d.saludEmpleador, "la salud del empleador"),
      arl1: numero(arl[0], "la ARL riesgo I"),
      arl2: numero(arl[1], "la ARL riesgo II"),
      arl3: numero(arl[2], "la ARL riesgo III"),
      arl4: numero(arl[3], "la ARL riesgo IV"),
      arl5: numero(arl[4], "la ARL riesgo V"),
      caja: numero(d.caja, "la caja de compensacion"),
      prima: numero(d.prima, "la prima"),
      cesantias: numero(d.cesantias, "las cesantias"),
      interesesCesantias: numero(d.interesesCesantias, "los intereses de cesantias"),
      vacaciones: numero(d.vacaciones, "las vacaciones"),
      saludEmpleado: numero(d.saludEmpleado, "la salud del empleado"),
      pensionEmpleado: numero(d.pensionEmpleado, "la pension del empleado"),
      limiteNoSalarial: numero(d.limiteNoSalarial, "el limite no salarial", 40),
    };
    if (!(p.smmlv > 0)) throw new ErrorCuadro("Escribe el salario minimo.");
    const cols = Object.keys(p);
    await pool.query(
      `INSERT INTO parametros_nomina (anio, ${cols.join(", ")}) VALUES (?, ${cols.map(() => "?").join(", ")})
       ON DUPLICATE KEY UPDATE ${cols.map((c) => `${c} = VALUES(${c})`).join(", ")}`,
      [anio, ...Object.values(p)],
    );
  },

  /** Empleados (de una empresa o de las dos), activos primero. */
  async empleados(filtro: { empresa?: EmpresaVehiculo | null; id?: number } = {}): Promise<Empleado[]> {
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
      `SELECT * FROM empleados ${donde.length ? `WHERE ${donde.join(" AND ")}` : ""} ORDER BY fechaRetiro IS NOT NULL, nombre`,
      valores,
    );
    if (!filas.length) return [];
    const [asig] = await pool.query<RowDataPacket[]>(
      `SELECT a.id, a.empleadoId, a.vehiculoId, v.placa, a.desde, a.hasta FROM empleados_vehiculos a JOIN vehiculos v ON v.id = a.vehiculoId
        WHERE a.empleadoId IN (?) ORDER BY a.desde`,
      [filas.map((f) => f.id)],
    );
    const hoy = hoyColombia();
    return filas.map((f) => {
      const vehiculos = asig
        .filter((a) => a.empleadoId === f.id)
        .map((a) => ({ id: a.id, vehiculoId: a.vehiculoId, placa: a.placa, desde: dia(a.desde)!, hasta: dia(a.hasta) }));
      const vigente = vehiculos.filter((v) => v.desde <= hoy && (!v.hasta || v.hasta >= hoy)).pop() ?? null;
      return {
        id: f.id,
        empresa: f.empresa,
        tipo: f.tipo,
        nombre: f.nombre,
        cedula: f.cedula ?? null,
        cargo: f.cargo ?? null,
        conductorId: f.conductorId ?? null,
        riesgoArl: f.riesgoArl,
        salarioBase: f.salarioBase === null ? null : Number(f.salarioBase),
        salarioAdicional: Number(f.salarioAdicional),
        pctSalarial: Number(f.pctSalarial),
        pctViaticos: Number(f.pctViaticos),
        auxilio: !!f.auxilio,
        destinos: json<Destino[]>(f.destinos, []),
        fechaIngreso: dia(f.fechaIngreso)!,
        fechaRetiro: dia(f.fechaRetiro),
        nota: f.nota ?? null,
        vehiculoId: vigente?.vehiculoId ?? null,
        placa: vigente?.placa ?? null,
        vehiculos,
      };
    });
  },

  /** Crea o cambia un empleado. Devuelve el id. */
  async guardarEmpleado(d: Record<string, unknown>, id?: number): Promise<number> {
    const empresa = String(d.empresa ?? "") as EmpresaVehiculo;
    if (!EMPRESAS.includes(empresa)) throw new ErrorCuadro("Elige la empresa.");
    const tipo: TipoEmpleado = d.tipo === "OFICINA" ? "OFICINA" : "CONDUCTOR";
    const nombre = texto(d.nombre, 150);
    if (!nombre) throw new ErrorCuadro("Escribe el nombre.");
    const riesgoArl = Number(d.riesgoArl ?? (tipo === "CONDUCTOR" ? 4 : 1));
    if (![1, 2, 3, 4, 5].includes(riesgoArl)) throw new ErrorCuadro("El riesgo ARL va de I a V.");
    const fechaIngreso = fechaDe(d.fechaIngreso, "la fecha de ingreso");
    const fechaRetiro = d.fechaRetiro ? fechaDe(d.fechaRetiro, "la fecha de retiro") : null;
    if (fechaRetiro && fechaRetiro < fechaIngreso) throw new ErrorCuadro("El retiro es antes del ingreso.");
    const salarioBase = d.salarioBase === undefined || d.salarioBase === null || d.salarioBase === "" ? null : numero(d.salarioBase, "el salario");
    const valores = [
      empresa,
      tipo,
      nombre,
      texto(d.cedula, 20),
      texto(d.cargo, 80),
      d.conductorId ? Number(d.conductorId) : null,
      riesgoArl,
      salarioBase,
      numero(d.salarioAdicional, "el adicional al salario"),
      numero(d.pctSalarial, "el % salarial", tipo === "CONDUCTOR" ? 4 : 0),
      numero(d.pctViaticos, "el % de viaticos", tipo === "CONDUCTOR" ? 5 : 0),
      d.auxilio ? 1 : 0,
      JSON.stringify(tipo === "OFICINA" ? await destinosValidos(d.destinos) : []),
      fechaIngreso,
      fechaRetiro,
      texto(d.nota, 300),
    ];
    const cols =
      "empresa, tipo, nombre, cedula, cargo, conductorId, riesgoArl, salarioBase, salarioAdicional, pctSalarial, pctViaticos, auxilio, destinos, fechaIngreso, fechaRetiro, nota";
    if (id) {
      await pool.query(
        `UPDATE empleados SET ${cols
          .split(", ")
          .map((c) => `${c} = ?`)
          .join(", ")} WHERE id = ?`,
        [...valores, id],
      );
      return id;
    }
    const [res] = await pool.query<ResultSetHeader>(
      `INSERT INTO empleados (${cols}) VALUES (${cols
        .split(", ")
        .map(() => "?")
        .join(", ")})`,
      valores,
    );
    if (tipo === "CONDUCTOR" && d.vehiculoId) await this.asignarVehiculo(res.insertId, { vehiculoId: d.vehiculoId, desde: fechaIngreso });
    return res.insertId;
  },

  /** El conductor pasa a otro vehiculo desde una fecha (cierra el anterior el dia antes). */
  async asignarVehiculo(empleadoId: number, d: Record<string, unknown>): Promise<void> {
    const vehiculoId = Number(d.vehiculoId);
    if (!Number.isInteger(vehiculoId) || vehiculoId <= 0) throw new ErrorCuadro("Elige el vehiculo.");
    const desde = fechaDe(d.desde, "desde cuando maneja ese vehiculo");
    // Lo que empezaba desde esa fecha o despues se reemplaza; lo vigente se cierra el dia antes.
    await pool.query("DELETE FROM empleados_vehiculos WHERE empleadoId = ? AND desde >= ?", [empleadoId, desde]);
    await pool.query("UPDATE empleados_vehiculos SET hasta = ? WHERE empleadoId = ? AND (hasta IS NULL OR hasta >= ?)", [diaAntes(desde), empleadoId, desde]);
    await pool.query("INSERT INTO empleados_vehiculos (empleadoId, vehiculoId, desde) VALUES (?, ?, ?)", [empleadoId, vehiculoId, desde]);
  },

  /** Quita una asignacion de vehiculo (si fue un error). */
  async quitarAsignacion(empleadoId: number, asignacionId: number): Promise<void> {
    await pool.query("DELETE FROM empleados_vehiculos WHERE id = ? AND empleadoId = ?", [asignacionId, empleadoId]);
  },

  /** Borra un empleado que no esta en ninguna nomina. */
  async borrarEmpleado(id: number): Promise<void> {
    const [[n]] = await pool.query<RowDataPacket[]>("SELECT COUNT(*) AS n FROM nomina_lineas WHERE empleadoId = ?", [id]);
    if (n.n > 0) throw new ErrorCuadro("El empleado ya esta en nominas: ponle fecha de retiro en vez de borrarlo.");
    await pool.query("DELETE FROM empleados WHERE id = ?", [id]);
  },

  /** Nominas (las mas recientes primero). M&C solo ve las lineas de sus empleados. */
  async nominas(filtro: { empresa?: EmpresaVehiculo | null; id?: number } = {}): Promise<Nomina[]> {
    const [filas] = await pool.query<RowDataPacket[]>(
      `SELECT n.*, u.nombre AS creadoPor, a.nombre AS aprobadaPor FROM nominas n
         LEFT JOIN usuarios u ON u.id = n.creadoPorId LEFT JOIN usuarios a ON a.id = n.aprobadaPorId
        ${filtro.id ? "WHERE n.id = ?" : ""} ORDER BY n.desde DESC, n.id DESC`,
      filtro.id ? [filtro.id] : [],
    );
    if (!filas.length) return [];
    const [lineas] = await pool.query<RowDataPacket[]>(
      `SELECT l.*, v.placa FROM nomina_lineas l LEFT JOIN vehiculos v ON v.id = l.vehiculoId WHERE l.nominaId IN (?) ORDER BY l.id`,
      [filas.map((f) => f.id)],
    );
    const empleados = new Map((await this.empleados()).map((e) => [e.id, e]));
    const parametros = new Map((await this.parametros()).map((p) => [p.anio, p]));
    return filas.map((n) => {
      const hasta = dia(n.hasta)!;
      const anio = Number(hasta.slice(0, 4));
      const aprobada = n.estado === "APROBADA";
      const p = aprobada ? json<ParametrosNomina | null>(n.parametros, null) : (parametros.get(anio) ?? null);
      const propias: LineaNomina[] = [];
      for (const l of lineas.filter((x) => x.nominaId === n.id)) {
        const e = empleados.get(l.empleadoId);
        if (!e || (filtro.empresa && e.empresa !== filtro.empresa)) continue;
        const valores = { dias: Number(l.dias), producido: Number(l.producido), ajuste: Number(l.ajuste) };
        const entrada = aprobada ? json<EntradaLinea>(l.entrada, entradaDe(e, valores)) : entradaDe(e, valores);
        const calculo = aprobada ? json<CalculoLinea | null>(l.calculo, null) : p ? calcularLinea(entrada, p) : null;
        let problema: string | null = null;
        if (!p) problema = `Faltan los parametros de ${anio}.`;
        else if (e.tipo === "CONDUCTOR" && !l.vehiculoId) problema = "Elige el vehiculo.";
        else if (e.tipo === "OFICINA" && !e.destinos.length) problema = "El empleado no tiene a quien se reparte su costo.";
        else if (valores.ajuste !== 0 && !l.notaAjuste) problema = "El ajuste necesita una nota.";
        propias.push({
          id: l.id,
          empleadoId: e.id,
          nombre: e.nombre,
          empresa: e.empresa,
          tipo: e.tipo,
          cargo: e.cargo,
          vehiculoId: l.vehiculoId ?? null,
          placa: l.placa ?? null,
          ...valores,
          notaAjuste: l.notaAjuste ?? null,
          entrada,
          calculo: calculo ?? calcularLinea(entrada, { ...VACIOS, anio }),
          gastoId: l.gastoId ?? null,
          problema: aprobada ? null : problema,
        });
      }
      const suma = (k: keyof CalculoLinea) => Math.round(propias.reduce((s, l) => s + l.calculo[k], 0) * 100) / 100;
      return {
        id: n.id,
        desde: dia(n.desde)!,
        hasta,
        estado: n.estado,
        nota: n.nota ?? null,
        anioParametros: anio,
        creadoPor: n.creadoPor ?? null,
        aprobadaPor: n.aprobadaPor ?? null,
        aprobadaEn: n.aprobadaEn instanceof Date ? n.aprobadaEn.toISOString() : n.aprobadaEn ? String(n.aprobadaEn) : null,
        lineas: propias,
        totales: { devengado: suma("devengado"), neto: suma("neto"), costoEmpleador: suma("costoEmpleador"), costoTotal: suma("costoTotal") },
      };
    });
  },

  /** Crea una nomina con una linea por cada empleado activo en el periodo. Devuelve el id. */
  async crearNomina(d: Record<string, unknown>, usuarioId: number | null): Promise<number> {
    const desde = fechaDe(d.desde, "el inicio del periodo");
    const hasta = fechaDe(d.hasta, "el fin del periodo");
    if (hasta < desde) throw new ErrorCuadro("El periodo termina antes de empezar.");
    const [[cruce]] = await pool.query<RowDataPacket[]>("SELECT id FROM nominas WHERE desde <= ? AND hasta >= ? LIMIT 1", [hasta, desde]);
    if (cruce) throw new ErrorCuadro("Ya hay una nomina que cubre parte de ese periodo.");
    const [res] = await pool.query<ResultSetHeader>("INSERT INTO nominas (desde, hasta, nota, creadoPorId) VALUES (?, ?, ?, ?)", [
      desde,
      hasta,
      texto(d.nota, 300),
      usuarioId,
    ]);
    const activos = (await this.empleados()).filter((e) => e.fechaIngreso <= hasta && (!e.fechaRetiro || e.fechaRetiro >= desde));
    if (activos.length)
      await pool.query("INSERT INTO nomina_lineas (nominaId, empleadoId, vehiculoId, dias) VALUES ?", [
        activos.map((e) => [
          res.insertId,
          e.id,
          e.tipo === "CONDUCTOR" ? (vehiculoEn(e, hasta)?.vehiculoId ?? null) : null,
          diasPeriodo(e.fechaIngreso > desde ? e.fechaIngreso : desde, e.fechaRetiro && e.fechaRetiro < hasta ? e.fechaRetiro : hasta),
        ]),
      ]);
    return res.insertId;
  },

  /** La nomina existe y es borrador. */
  async exigirBorrador(nominaId: number): Promise<void> {
    const [[n]] = await pool.query<RowDataPacket[]>("SELECT estado FROM nominas WHERE id = ?", [nominaId]);
    if (!n) throw new ErrorCuadro("Esa nomina no existe.");
    if (n.estado !== "BORRADOR") throw new ErrorCuadro("La nomina esta aprobada: reabrela para cambiarla.");
  },

  /** Empresa del empleado de una linea (para el filtro de M&C). */
  async empresaDeLinea(lineaId: number): Promise<EmpresaVehiculo | null> {
    const [[f]] = await pool.query<RowDataPacket[]>("SELECT e.empresa FROM nomina_lineas l JOIN empleados e ON e.id = l.empleadoId WHERE l.id = ?", [lineaId]);
    return (f?.empresa as EmpresaVehiculo) ?? null;
  },

  /** Cambia dias, producido, vehiculo o ajuste de una linea. */
  async actualizarLinea(nominaId: number, lineaId: number, d: Record<string, unknown>): Promise<void> {
    await this.exigirBorrador(nominaId);
    const sets: string[] = [];
    const valores: unknown[] = [];
    if ("dias" in d) {
      const dias = numero(d.dias, "los dias");
      if (dias > 30) throw new ErrorCuadro("Los dias van de 0 a 30.");
      sets.push("dias = ?");
      valores.push(dias);
    }
    if ("producido" in d) {
      sets.push("producido = ?");
      valores.push(numero(d.producido, "el producido"));
    }
    if ("vehiculoId" in d) {
      sets.push("vehiculoId = ?");
      valores.push(d.vehiculoId ? Number(d.vehiculoId) : null);
    }
    if ("ajuste" in d) {
      const ajuste = Number(d.ajuste || 0);
      if (!Number.isFinite(ajuste)) throw new ErrorCuadro("Revisa el ajuste.");
      sets.push("ajuste = ?");
      valores.push(ajuste);
    }
    if ("notaAjuste" in d) {
      sets.push("notaAjuste = ?");
      valores.push(texto(d.notaAjuste, 300));
    }
    if (sets.length) await pool.query(`UPDATE nomina_lineas SET ${sets.join(", ")} WHERE id = ? AND nominaId = ?`, [...valores, lineaId, nominaId]);
  },

  /** Agrega a la nomina un empleado que no esta. */
  async agregarLinea(nominaId: number, empleadoId: number): Promise<void> {
    await this.exigirBorrador(nominaId);
    const [e] = await this.empleados({ id: empleadoId });
    if (!e) throw new ErrorCuadro("Ese empleado no existe.");
    const [[n]] = await pool.query<RowDataPacket[]>("SELECT desde, hasta FROM nominas WHERE id = ?", [nominaId]);
    const hasta = dia(n.hasta)!;
    await pool.query("INSERT IGNORE INTO nomina_lineas (nominaId, empleadoId, vehiculoId, dias) VALUES (?, ?, ?, ?)", [
      nominaId,
      empleadoId,
      e.tipo === "CONDUCTOR" ? (vehiculoEn(e, hasta)?.vehiculoId ?? null) : null,
      diasPeriodo(dia(n.desde)!, hasta),
    ]);
  },

  /** Quita una linea de la nomina. */
  async quitarLinea(nominaId: number, lineaId: number): Promise<void> {
    await this.exigirBorrador(nominaId);
    await pool.query("DELETE FROM nomina_lineas WHERE id = ? AND nominaId = ?", [lineaId, nominaId]);
  },

  /** Borra una nomina en borrador. */
  async borrarNomina(nominaId: number): Promise<void> {
    await this.exigirBorrador(nominaId);
    await pool.query("DELETE FROM nominas WHERE id = ?", [nominaId]);
  },

  /**
   * Aprueba la nomina: guarda el calculo de cada linea y crea un gasto por
   * empleado (su costo total) causado por dias en los meses del periodo.
   */
  async aprobar(nominaId: number, usuarioId: number | null): Promise<void> {
    await this.exigirBorrador(nominaId);
    const [n] = await this.nominas({ id: nominaId });
    if (!n.lineas.length) throw new ErrorCuadro("La nomina no tiene empleados.");
    const conProblema = n.lineas.find((l) => l.problema);
    if (conProblema) throw new ErrorCuadro(`${conProblema.nombre}: ${conProblema.problema}`);
    const p = await parametrosDelAnio(n.anioParametros);
    const empleados = new Map((await this.empleados()).map((e) => [e.id, e]));
    const conCosto = n.lineas.filter((l) => l.calculo.costoTotal > 0);
    for (const l of conCosto) await gastos.revisarCausaciones({ monto: l.calculo.costoTotal, causaDesde: n.desde, causaHasta: n.hasta });
    try {
      for (const l of conCosto) {
        const e = empleados.get(l.empleadoId)!;
        const gastoId = await gastos.crear(
          {
            empresa: e.empresa,
            tipo: "GASTO",
            categoria: "NOMINA",
            descripcion: `Nomina ${fechaTexto(n.desde)} - ${fechaTexto(n.hasta)}: ${e.nombre}`,
            monto: l.calculo.costoTotal,
            causaDesde: n.desde,
            causaHasta: n.hasta,
            destinos: e.tipo === "CONDUCTOR" ? [{ tipo: "VEHICULO", id: l.vehiculoId, modo: "PARTE", valor: 1 }] : e.destinos,
          },
          usuarioId,
          { origen: "NOMINA", creditoId: null, nominaId },
        );
        await pool.query("UPDATE nomina_lineas SET entrada = ?, calculo = ?, gastoId = ? WHERE id = ?", [
          JSON.stringify(l.entrada),
          JSON.stringify(l.calculo),
          gastoId,
          l.id,
        ]);
      }
      for (const l of n.lineas.filter((x) => x.calculo.costoTotal <= 0))
        await pool.query("UPDATE nomina_lineas SET entrada = ?, calculo = ? WHERE id = ?", [JSON.stringify(l.entrada), JSON.stringify(l.calculo), l.id]);
    } catch (exc) {
      // Si algo falla a mitad de camino, se deshace lo creado.
      await pool.query("DELETE FROM gastos WHERE nominaId = ?", [nominaId]);
      await pool.query("UPDATE nomina_lineas SET entrada = NULL, calculo = NULL, gastoId = NULL WHERE nominaId = ?", [nominaId]);
      throw exc;
    }
    await pool.query("UPDATE nominas SET estado = 'APROBADA', parametros = ?, aprobadaPorId = ?, aprobadaEn = NOW() WHERE id = ?", [
      JSON.stringify(p),
      usuarioId,
      nominaId,
    ]);
  },

  /** Reabre una nomina aprobada: borra sus gastos (sus meses deben estar abiertos). */
  async reabrir(nominaId: number): Promise<void> {
    const [[n]] = await pool.query<RowDataPacket[]>("SELECT estado FROM nominas WHERE id = ?", [nominaId]);
    if (!n || n.estado !== "APROBADA") return;
    await gastos.borrarDeNomina(nominaId);
    await pool.query("UPDATE nomina_lineas SET entrada = NULL, calculo = NULL, gastoId = NULL WHERE nominaId = ?", [nominaId]);
    await pool.query("UPDATE nominas SET estado = 'BORRADOR', parametros = NULL, aprobadaPorId = NULL, aprobadaEn = NULL WHERE id = ?", [nominaId]);
  },
};

/** Parametros en cero: solo para mostrar una linea cuando faltan los del ano. */
const VACIOS: Omit<ParametrosNomina, "anio"> = {
  smmlv: 0,
  auxilioTransporte: 0,
  pensionEmpleador: 0,
  saludEmpleador: 0,
  arl: [0, 0, 0, 0, 0],
  caja: 0,
  prima: 0,
  cesantias: 0,
  interesesCesantias: 0,
  vacaciones: 0,
  saludEmpleado: 0,
  pensionEmpleado: 0,
  limiteNoSalarial: 40,
};
