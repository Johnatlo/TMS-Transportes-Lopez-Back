/**
 * Control interno: bitacora de cambios y papelera.
 *
 * Bitacora: cada vez que se crea, cambia o borra un registro de una tabla
 * sensible (la plata y los permisos: viajes del cuadro, anticipos, bomba,
 * cartera, gastos, nomina, prestamos, socios, repartos, usuarios...), un
 * trigger de MySQL guarda en `bitacora` que tabla y registro, que paso
 * (CREAR, CAMBIAR o BORRAR), los valores de antes y de despues (al cambiar,
 * solo los campos que cambiaron), quien lo hizo y desde que ruta. Quien lo
 * hizo sale de las variables @sofi_usuario y @sofi_origen, que el pool pone
 * antes de cada escritura (ver contexto.ts y db.ts); sin ellas, "Sistema".
 * Asi queda todo: lo que se hace en las pantallas, en las importaciones y en
 * los procesos automaticos, aunque una ruta nueva se olvide de registrarlo.
 *
 * Los triggers se crean (o se rehacen con las columnas de hoy) al arrancar.
 * Las claves y contrasenas no se guardan, ni las columnas muy grandes (fotos
 * de repartos y liquidaciones). Si MySQL no deja crearlos con el usuario de
 * la aplicacion (binlog activo), se intenta con root (MYSQL_ROOT_PASSWORD);
 * si tampoco, la bitacora queda inactiva y la pantalla lo avisa.
 *
 * Papelera: lo borrado es su registro BORRAR, con todos sus datos. Se puede
 * consultar siempre; se puede restaurar (volver a crearlo igual, con el mismo
 * id) solo en las tablas simples, que no tienen otros datos que se borren o
 * cambien con ellas (MySQL no dispara triggers en los borrados en cascada).
 */
import mysql from "mysql2/promise";
import type { ResultSetHeader, RowDataPacket } from "mysql2";
import { pool } from "./db";
import { ErrorCuadro } from "./cuadro";

/** Tablas que se registran, con su nombre en pantalla. restaurable: se puede devolver desde la papelera. */
export const TABLAS_BITACORA: Record<string, { nombre: string; restaurable?: boolean; describe?: string[] }> = {
  cuadro_viajes: { nombre: "Viaje del cuadro pagos", describe: ["placa", "manifiesto", "remision", "empresa"] },
  cuadro_anticipos: { nombre: "Anticipo (tramo)", describe: ["placa", "fecha"] },
  anticipos_tanqueo: { nombre: "Tanqueo", describe: ["placa", "fecha", "facturaBomba"] },
  cuadro_notas: { nombre: "Nota del viaje", restaurable: true, describe: ["texto"] },
  bombas: { nombre: "Bomba", describe: ["nombre"] },
  descuentos_galon_bomba: { nombre: "Descuento por galon", describe: ["descuentoGalon"] },
  bomba_relaciones: { nombre: "Factura de la bomba", describe: ["numero", "fecha"] },
  bomba_relacion_vales: { nombre: "Vale de la bomba", describe: ["vale", "placa", "tipo"] },
  bomba_pagos: { nombre: "Pago a la bomba", describe: ["fecha", "valorPagado"] },
  abonos_socio: { nombre: "Abono a la bomba", describe: ["socio", "fecha", "valor"] },
  abonos_socio_viajes: { nombre: "Viaje de un abono", describe: ["valor"] },
  cartera_anticipos_cliente_registros: { nombre: "Anticipo del cliente (cartera)", restaurable: true, describe: ["facturaNumero", "empresa", "valor"] },
  cartera_clientes: { nombre: "Plazo de cobro del cliente", describe: ["empresa"] },
  cartera_saldos: { nombre: "Saldo de cartera sin viaje", describe: ["facturaNumero", "empresa"] },
  cartera_saldos_placas: { nombre: "Placa de un saldo de cartera", describe: ["placa", "valor"] },
  notas_credito: { nombre: "Nota credito", restaurable: true, describe: ["numero", "facturaAnulada", "empresa"] },
  liquidaciones_duenos: { nombre: "Liquidacion a dueno", describe: ["grupo", "nombre", "fecha"] },
  rentabilidad_comisiones: { nombre: "Matriz de comisiones", describe: ["cliente"] },
  rentabilidad_retenciones: { nombre: "Matriz de retenciones", describe: ["cliente"] },
  tarifas_flete: { nombre: "Tarifa de flete", describe: ["nombre"] },
  gastos: { nombre: "Gasto", describe: ["descripcion", "monto"] },
  gastos_recurrentes: { nombre: "Gasto recurrente", describe: ["descripcion"] },
  gastos_recurrentes_valores: { nombre: "Valor de un recurrente", describe: ["desde", "monto"] },
  creditos: { nombre: "Credito", describe: ["nombre", "entidad"] },
  creditos_cuotas: { nombre: "Cuota de credito", describe: ["numero", "fechaPago"] },
  periodos_cierre: { nombre: "Cierre de mes (gastos)", describe: ["mes"] },
  parametros_empresa: { nombre: "Parametros de la empresa" },
  empleados: { nombre: "Empleado", describe: ["nombre", "cedula"] },
  empleados_vehiculos: { nombre: "Vehiculo de un empleado", describe: ["desde", "hasta"] },
  parametros_nomina: { nombre: "Parametros de nomina", describe: ["anio"] },
  nominas: { nombre: "Nomina", describe: ["desde", "hasta", "estado"] },
  nomina_lineas: { nombre: "Linea de nomina" },
  prestamos_empleado: { nombre: "Prestamo a empleado", describe: ["fecha", "monto"] },
  prestamos_descuentos: { nombre: "Descuento de prestamo", describe: ["mes", "valor"] },
  cuentas_viaje: { nombre: "Cuenta de viaje" },
  fletes_conductor: { nombre: "Flete conductor", restaurable: true, describe: ["valor", "tipo", "desde"] },
  liquidaciones_conductor: { nombre: "Pago de liquidacion de conductor", describe: ["mes", "fechaPago", "total"] },
  socios: { nombre: "Socio", describe: ["nombre"] },
  participaciones: { nombre: "Participacion en un vehiculo", restaurable: true, describe: ["porcentaje", "desde"] },
  fondos_vehiculo: { nombre: "Fondo del vehiculo" },
  pagos_socios: { nombre: "Pago a socio", restaurable: true, describe: ["fecha", "monto"] },
  repartos_utilidades: { nombre: "Reparto aprobado", describe: ["mes"] },
  usuarios: { nombre: "Usuario", describe: ["nombre", "email", "rol"] },
  vehiculos: { nombre: "Vehiculo", describe: ["placa"] },
};

/** Columnas que nunca se guardan (claves, contrasenas, tokens). */
const OCULTA = /clave|password|contrasena|hash|token|secreto/i;
/** Columnas muy grandes que no se guardan (fotos completas de un mes). */
const PESADAS = new Set([
  "repartos_utilidades.datos",
  "liquidaciones_conductor.detalle",
  "nomina_lineas.detalleProducido",
  "liquidaciones_duenos.filas",
  "liquidaciones_duenos.conceptos",
]);
/** Columnas que cambian solas (no son un cambio de nadie). */
const AUTOMATICAS = /^(actualizadoEn|modificadoEn|actualizado_en|ultimoAcceso)$/;

/** Estado de la bitacora: si los triggers quedaron creados, o por que no. */
let estadoBitacora: { activa: boolean; error: string | null; tablas: number } = { activa: false, error: "Aun no se ha instalado.", tablas: 0 };

/** Nombre seguro de tabla o columna (solo letras, numeros y _). */
const id = (x: string) => {
  if (!/^[A-Za-z0-9_]+$/.test(x)) throw new Error(`Nombre no valido: ${x}`);
  return `\`${x}\``;
};

/** Arma los tres triggers (crear, cambiar, borrar) de una tabla con sus columnas de hoy. */
function triggersDe(
  tabla: string,
  columnas: Array<{ nombre: string; tipo: string; extra: string }>,
  pk: string,
  padre: { columna: string; tabla: string } | null,
): string[] {
  const guardadas = columnas.filter(
    (c) => !OCULTA.test(c.nombre) && !PESADAS.has(`${tabla}.${c.nombre}`) && !/^(longtext|mediumtext|longblob|mediumblob|blob)$/i.test(c.tipo),
  );
  const comparadas = guardadas.filter((c) => !AUTOMATICAS.test(c.nombre) && !/on update/i.test(c.extra));
  const objeto = (fila: "NEW" | "OLD") => `JSON_OBJECT(${guardadas.map((c) => `'${c.nombre}', ${fila}.${id(c.nombre)}`).join(", ")})`;
  const cambio = (c: string) => `NOT (OLD.${id(c)} <=> NEW.${id(c)})`;
  const soloCambios = (fila: "NEW" | "OLD") =>
    `JSON_MERGE_PRESERVE(JSON_OBJECT(), ${comparadas.map((c) => `IF(${cambio(c.nombre)}, JSON_OBJECT('${c.nombre}', ${fila}.${id(c.nombre)}), JSON_OBJECT())`).join(", ")})`;
  const relacionado = (fila: "NEW" | "OLD") => (padre ? `CONCAT('${padre.tabla}:', ${fila}.${id(padre.columna)})` : "NULL");
  const insertar = (accion: string, fila: "NEW" | "OLD", antes: string, despues: string) =>
    `INSERT INTO bitacora (en, tabla, registroId, accion, antes, despues, relacionado, usuarioId, origen)
     VALUES (UTC_TIMESTAMP(3), '${tabla}', CAST(${fila}.${id(pk)} AS CHAR), '${accion}', ${antes}, ${despues}, ${relacionado(fila)}, @sofi_usuario, @sofi_origen)`;
  const nombre = (sufijo: string) => id(`sofi_bit_${tabla}`.slice(0, 58) + `_${sufijo}`);
  const t = id(tabla);
  const lista = [
    `CREATE TRIGGER ${nombre("i")} AFTER INSERT ON ${t} FOR EACH ROW ${insertar("CREAR", "NEW", "NULL", objeto("NEW"))}`,
    `CREATE TRIGGER ${nombre("d")} AFTER DELETE ON ${t} FOR EACH ROW ${insertar("BORRAR", "OLD", objeto("OLD"), "NULL")}`,
  ];
  if (comparadas.length)
    lista.push(
      `CREATE TRIGGER ${nombre("u")} AFTER UPDATE ON ${t} FOR EACH ROW BEGIN
         IF ${comparadas.map((c) => cambio(c.nombre)).join(" OR ")} THEN
           ${insertar("CAMBIAR", "NEW", soloCambios("OLD"), soloCambios("NEW"))};
         END IF;
       END`,
    );
  return lista;
}

/** Ejecuta las sentencias de los triggers con una conexion (la de la aplicacion o la de root). */
async function crearTriggers(ejecutar: (sql: string) => Promise<unknown>, sentencias: Array<{ borrar: string[]; crear: string[] }>) {
  for (const s of sentencias) {
    for (const b of s.borrar) await ejecutar(b);
    for (const c of s.crear) await ejecutar(c);
  }
}

/** Crea la tabla de la bitacora y los triggers de las tablas sensibles (al arrancar). */
export async function instalarBitacora(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bitacora (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      -- En UTC (los triggers ponen UTC_TIMESTAMP), como el resto de fechas de SOFI.
      en DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      tabla VARCHAR(64) NOT NULL,
      registroId VARCHAR(100) NOT NULL,
      accion VARCHAR(10) NOT NULL,
      antes LONGTEXT,
      despues LONGTEXT,
      relacionado VARCHAR(120),
      usuarioId INT,
      origen VARCHAR(200),
      restauradoEn DATETIME,
      restauradoPorId INT,
      INDEX idx_bitacora_registro (tabla, registroId),
      INDEX idx_bitacora_en (en),
      INDEX idx_bitacora_relacionado (relacionado),
      INDEX idx_bitacora_usuario (usuarioId)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  const tablas = Object.keys(TABLAS_BITACORA);
  const [cols] = await pool.query<RowDataPacket[]>(
    `SELECT TABLE_NAME AS tabla, COLUMN_NAME AS nombre, DATA_TYPE AS tipo, EXTRA AS extra FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (?) ORDER BY ORDINAL_POSITION`,
    [tablas],
  );
  const [llaves] = await pool.query<RowDataPacket[]>(
    `SELECT TABLE_NAME AS tabla, COLUMN_NAME AS columna, CONSTRAINT_NAME AS nombre, REFERENCED_TABLE_NAME AS padre
       FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (?)`,
    [tablas],
  );
  const sentencias: Array<{ borrar: string[]; crear: string[] }> = [];
  for (const tabla of tablas) {
    const columnas = cols.filter((c) => c.tabla === tabla).map((c) => ({ nombre: String(c.nombre), tipo: String(c.tipo), extra: String(c.extra ?? "") }));
    const pk = llaves.filter((k) => k.tabla === tabla && k.nombre === "PRIMARY");
    if (!columnas.length || pk.length !== 1) continue;
    const fk = llaves.find((k) => k.tabla === tabla && k.padre && k.nombre !== "PRIMARY");
    const borrar = ["i", "u", "d"].map((x) => `DROP TRIGGER IF EXISTS ${id(`sofi_bit_${tabla}`.slice(0, 58) + `_${x}`)}`);
    sentencias.push({
      borrar,
      crear: triggersDe(tabla, columnas, String(pk[0].columna), fk ? { columna: String(fk.columna), tabla: String(fk.padre) } : null),
    });
  }
  try {
    await crearTriggers((sql) => pool.query(sql), sentencias);
    estadoBitacora = { activa: true, error: null, tablas: sentencias.length };
  } catch (exc) {
    // Con el binlog activo, MySQL no deja crear triggers a un usuario sin SUPER: se intenta con root.
    const raiz = process.env.MYSQL_ROOT_PASSWORD;
    if (!raiz) {
      estadoBitacora = { activa: false, error: (exc as Error).message, tablas: 0 };
      console.warn("AVISO: la bitacora de cambios no quedo activa:", (exc as Error).message);
      return;
    }
    let conexion: mysql.Connection | null = null;
    try {
      conexion = await mysql.createConnection({
        host: process.env.DB_HOST ?? "localhost",
        port: Number(process.env.DB_PORT ?? 3306),
        user: "root",
        password: raiz,
        database: process.env.DB_NAME ?? "rndc_tms",
      });
      const c = conexion;
      await crearTriggers((sql) => c.query(sql), sentencias);
      estadoBitacora = { activa: true, error: null, tablas: sentencias.length };
    } catch (exc2) {
      estadoBitacora = { activa: false, error: (exc2 as Error).message, tablas: 0 };
      console.warn("AVISO: la bitacora de cambios no quedo activa:", (exc2 as Error).message);
    } finally {
      await conexion?.end();
    }
  }
}

/** Un cambio de un campo: antes y despues (al crear no hay antes; al borrar no hay despues). */
export interface CampoCambiado {
  campo: string;
  antes: unknown;
  despues: unknown;
}

/** Un registro de la bitacora. */
export interface RegistroBitacora {
  id: number;
  en: string;
  tabla: string;
  /** Nombre de la tabla en pantalla. */
  que: string;
  registroId: string;
  /** Algo que identifica el registro (placa, numero, nombre...). */
  descripcion: string | null;
  accion: "CREAR" | "CAMBIAR" | "BORRAR";
  cambios: CampoCambiado[];
  usuarioId: number | null;
  /** Nombre de quien lo hizo; null = el sistema (procesos automaticos). */
  usuario: string | null;
  origen: string | null;
  relacionado: string | null;
  /** Papelera: se puede restaurar y si ya se restauro. */
  restaurable: boolean;
  restauradoEn: string | null;
  restauradoPor: string | null;
}

/** Texto JSON a objeto (vacio si no es valido). */
const leerJson = (v: unknown): Record<string, unknown> => {
  if (!v) return {};
  try {
    const x = typeof v === "string" ? JSON.parse(v) : v;
    return x && typeof x === "object" ? (x as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

/** Los campos de un registro de la bitacora como lista de cambios. */
export function cambiosDe(accion: string, antes: Record<string, unknown>, despues: Record<string, unknown>): CampoCambiado[] {
  const campos = [...new Set([...Object.keys(antes), ...Object.keys(despues)])];
  return campos
    .filter((c) => accion !== "CREAR" || (despues[c] !== null && despues[c] !== "" && despues[c] !== undefined))
    .filter((c) => accion !== "BORRAR" || (antes[c] !== null && antes[c] !== "" && antes[c] !== undefined))
    .map((campo) => ({ campo, antes: accion === "CREAR" ? null : (antes[campo] ?? null), despues: accion === "BORRAR" ? null : (despues[campo] ?? null) }));
}

/** Fecha de la base a ISO. */
const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : v ? new Date(String(v)).toISOString() : null);

/** Filtros de la bitacora. */
export interface FiltroBitacora {
  tabla?: unknown;
  registroId?: unknown;
  usuarioId?: unknown;
  accion?: unknown;
  desde?: unknown;
  hasta?: unknown;
  limite?: unknown;
}

/** Bitacora, papelera e historial de cada registro. */
export const bitacora = {
  /** Si los triggers quedaron creados (o por que no). */
  estado() {
    return estadoBitacora;
  },

  /** Los registros de la bitacora con los filtros (los mas recientes primero; hasta 2.000). */
  async listar(f: FiltroBitacora = {}, soloBorrados = false): Promise<RegistroBitacora[]> {
    const donde: string[] = [];
    const valores: unknown[] = [];
    const fecha = (v: unknown) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v ?? "")) ? String(v) : null);
    if (soloBorrados) donde.push("b.accion = 'BORRAR'");
    if (f.tabla && TABLAS_BITACORA[String(f.tabla)]) {
      donde.push("b.tabla = ?");
      valores.push(String(f.tabla));
    }
    if (f.registroId) {
      donde.push("b.registroId = ?");
      valores.push(String(f.registroId));
    }
    if (f.usuarioId === "SISTEMA") donde.push("b.usuarioId IS NULL");
    else if (f.usuarioId) {
      donde.push("b.usuarioId = ?");
      valores.push(Number(f.usuarioId));
    }
    if (f.accion && ["CREAR", "CAMBIAR", "BORRAR"].includes(String(f.accion))) {
      donde.push("b.accion = ?");
      valores.push(String(f.accion));
    }
    // Los dias son de Colombia (UTC-5): el dia empieza a las 05:00 UTC.
    if (fecha(f.desde)) {
      donde.push("b.en >= ?");
      valores.push(`${fecha(f.desde)} 05:00:00`);
    }
    if (fecha(f.hasta)) {
      const siguiente = new Date(`${fecha(f.hasta)}T12:00:00Z`);
      siguiente.setUTCDate(siguiente.getUTCDate() + 1);
      donde.push("b.en < ?");
      valores.push(`${siguiente.toISOString().slice(0, 10)} 05:00:00`);
    }
    const limite = Math.max(1, Math.min(2000, Number(f.limite) || 1000));
    const [filas] = await pool.query<RowDataPacket[]>(
      `SELECT b.*, u.nombre AS usuario, r.nombre AS restauradoPor FROM bitacora b
         LEFT JOIN usuarios u ON u.id = b.usuarioId LEFT JOIN usuarios r ON r.id = b.restauradoPorId
        ${donde.length ? `WHERE ${donde.join(" AND ")}` : ""}
        ORDER BY b.en DESC, b.id DESC LIMIT ${limite}`,
      valores,
    );
    return this.armar(filas);
  },

  /** Historial de un registro: sus cambios y los de lo que cuelga de el (anticipos y notas de un viaje...). */
  async historial(tabla: unknown, registroId: unknown): Promise<RegistroBitacora[]> {
    const t = String(tabla ?? "");
    if (!TABLAS_BITACORA[t]) throw new ErrorCuadro("Esa tabla no tiene bitacora.");
    const idTexto = String(registroId ?? "");
    const [filas] = await pool.query<RowDataPacket[]>(
      `SELECT b.*, u.nombre AS usuario, r.nombre AS restauradoPor FROM bitacora b
         LEFT JOIN usuarios u ON u.id = b.usuarioId LEFT JOIN usuarios r ON r.id = b.restauradoPorId
        WHERE (b.tabla = ? AND b.registroId = ?) OR b.relacionado = ?
        ORDER BY b.en DESC, b.id DESC LIMIT 1000`,
      [t, idTexto, `${t}:${idTexto}`],
    );
    return this.armar(filas);
  },

  /** Arma los registros: nombre de la tabla, cambios, quien y una descripcion del registro. */
  async armar(filas: RowDataPacket[]): Promise<RegistroBitacora[]> {
    // Descripcion: de los datos guardados (crear o borrar) o del registro como esta hoy.
    const porTabla = new Map<string, Set<string>>();
    for (const f of filas) {
      const cols = TABLAS_BITACORA[f.tabla]?.describe;
      if (cols && f.accion === "CAMBIAR") porTabla.set(f.tabla, (porTabla.get(f.tabla) ?? new Set()).add(String(f.registroId)));
    }
    const actuales = new Map<string, Record<string, unknown>>();
    for (const [tabla, ids] of porTabla) {
      const cols = TABLAS_BITACORA[tabla].describe!;
      const [pk] = await pool.query<RowDataPacket[]>(
        "SELECT COLUMN_NAME AS c FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND CONSTRAINT_NAME = 'PRIMARY'",
        [tabla],
      );
      if (pk.length !== 1) continue;
      const [existen] = await pool.query<RowDataPacket[]>(
        "SELECT COLUMN_NAME AS c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME IN (?)",
        [tabla, cols],
      );
      if (!existen.length) continue;
      const [rows] = await pool.query<RowDataPacket[]>(
        `SELECT ${id(String(pk[0].c))} AS _id, ${existen.map((e) => id(String(e.c))).join(", ")} FROM ${id(tabla)} WHERE ${id(String(pk[0].c))} IN (?)`,
        [[...ids]],
      );
      for (const r of rows) actuales.set(`${tabla}:${r._id}`, r);
    }
    const describir = (tabla: string, datos: Record<string, unknown> | undefined) => {
      const cols = TABLAS_BITACORA[tabla]?.describe ?? [];
      const partes = cols.map((c) => datos?.[c]).filter((x) => x !== null && x !== undefined && x !== "");
      return partes.length ? partes.map((x) => (x instanceof Date ? x.toISOString().slice(0, 10) : String(x))).join(" · ") : null;
    };
    return filas.map((f) => {
      const antes = leerJson(f.antes);
      const despues = leerJson(f.despues);
      const datos = f.accion === "BORRAR" ? antes : f.accion === "CREAR" ? despues : actuales.get(`${f.tabla}:${f.registroId}`);
      return {
        id: Number(f.id),
        en: iso(f.en)!,
        tabla: f.tabla,
        que: TABLAS_BITACORA[f.tabla]?.nombre ?? f.tabla,
        registroId: String(f.registroId),
        descripcion: describir(f.tabla, datos),
        accion: f.accion,
        cambios: cambiosDe(f.accion, antes, despues),
        usuarioId: f.usuarioId ?? null,
        usuario: f.usuario ?? null,
        origen: f.origen ?? null,
        relacionado: f.relacionado ?? null,
        restaurable: f.accion === "BORRAR" && !!TABLAS_BITACORA[f.tabla]?.restaurable && !f.restauradoEn,
        restauradoEn: iso(f.restauradoEn),
        restauradoPor: f.restauradoPor ?? null,
      };
    });
  },

  /**
   * Restaura un registro borrado (solo de las tablas simples): lo vuelve a
   * crear con sus mismos datos e id. Si ya existe uno con ese id, no.
   */
  async restaurar(bitacoraId: number, usuarioId: number | null): Promise<void> {
    const [[b]] = await pool.query<RowDataPacket[]>("SELECT * FROM bitacora WHERE id = ?", [bitacoraId]);
    if (!b || b.accion !== "BORRAR") throw new ErrorCuadro("Ese registro no esta en la papelera.");
    if (b.restauradoEn) throw new ErrorCuadro("Ese registro ya se restauro.");
    if (!TABLAS_BITACORA[b.tabla]?.restaurable)
      throw new ErrorCuadro("Ese registro se borro con otros datos relacionados: no se puede restaurar desde aqui. Sus datos quedan para consultarlos.");
    const datos = leerJson(b.antes);
    const [cols] = await pool.query<RowDataPacket[]>(
      "SELECT COLUMN_NAME AS c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?",
      [b.tabla],
    );
    const existen = new Set(cols.map((c) => String(c.c)));
    const campos = Object.keys(datos).filter((c) => existen.has(c));
    if (!campos.length) throw new ErrorCuadro("No hay datos para restaurar.");
    try {
      await pool.query<ResultSetHeader>(`INSERT INTO ${id(b.tabla)} (${campos.map(id).join(", ")}) VALUES (?)`, [campos.map((c) => datos[c])]);
    } catch (exc) {
      const e = exc as { code?: string; message?: string };
      if (e.code === "ER_DUP_ENTRY") throw new ErrorCuadro("Ya existe un registro igual (con el mismo id o los mismos datos unicos): no se restauro.");
      if (e.code === "ER_NO_REFERENCED_ROW_2" || e.code === "ER_NO_REFERENCED_ROW")
        throw new ErrorCuadro("Lo que tenia relacionado ya no existe (por ejemplo, el viaje o el empleado): no se puede restaurar.");
      throw exc;
    }
    await pool.query("UPDATE bitacora SET restauradoEn = UTC_TIMESTAMP(), restauradoPorId = ? WHERE id = ?", [usuarioId, bitacoraId]);
  },
};
