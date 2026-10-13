/**
 * Registro de los maestros en el RNDC desde la aplicacion: terceros (clientes,
 * remitentes, destinatarios, propietarios y conductores) y vehiculos y
 * remolques. Asi no hay que entrar al portal del RNDC para crearlos o
 * actualizarlos.
 *
 * Procesos [Guia Uso del Web Service V5, pag. 9 y 12]:
 * - 11: Crear o actualizar datos de Tercero.
 * - 12: Crear o actualizar datos de Vehiculo (tambien remolques).
 *
 * Etiquetas: las del ejemplo de la guia (pag. 12) y SEGUNDOAPELLIDOIDTERCERO,
 * verificadas en rndcpruebas el 2026-10-13 (el RNDC rechaza con "Error 13"
 * cualquier etiqueta que no este en su diccionario, y estas las acepto).
 *
 * Lo que se vio en rndcpruebas ese dia:
 * - Persona natural: obligatorios tipo y numero de identificacion, nombre,
 *   direccion y municipio. El nombre lo toma el RNDC del registro oficial
 *   (se mando "PRUEBA DE TERCERO" y quedo "JAIRO VESGA MARTINEZ").
 * - NIT: ademas, codigo y nombre de sede (TER090, TER100). En personas
 *   naturales la sede va en 0.
 * - Vehiculo: obligatorio el peso vacio (VEH090: de 200 kg al peso bruto, de 3
 *   a 5 digitos). La configuracion y la carroceria las toma del RUNT (se
 *   mando 3S3/55 y 0 y quedo 54 y 7), por eso no se envian.
 * - Remolque: basta la placa.
 * - Telefono: es opcional, pero si se envia debe tener 10 digitos (fijo con
 *   indicativo 60X o celular). Con el formato viejo de 7 digitos rechaza todo
 *   el registro (TER190); por eso solo se envia si tiene 10 digitos.
 * - Si todo es igual a lo que ya tiene, responde con error
 *   "DUPLICADO:<radicado> ... VEH015 ... ya existe con todos los datos iguales":
 *   se toma como "ya estaba al dia", no como fallo.
 *
 * La guia pide registrar solo cuando algo cambio (cada envio guarda historia
 * en el RNDC): por eso el registro es una accion explicita del usuario.
 */
import type { RowDataPacket } from "mysql2";
import { config } from "../config";
import { pool } from "../db";
import { construirXmlMensaje } from "./builders";
import { RndcClient } from "./client";

export const PROCESO_TERCERO = "11";
export const PROCESO_VEHICULO = "12";

export type Maestro = "terceros" | "conductores" | "vehiculos" | "remolques";
export const MAESTROS: Maestro[] = ["terceros", "conductores", "vehiculos", "remolques"];

/** Texto recortado; vacio, null o undefined -> undefined (la etiqueta no se envia). */
const texto = (v: unknown): string | undefined => {
  if (v === null || v === undefined) return undefined;
  const t = String(v).trim();
  return t === "" ? undefined : t;
};

/** Telefono con solo digitos si tiene 10 (formato que acepta el RNDC); si no, undefined. */
export function telefonoRndc(v: unknown): string | undefined {
  const digitos = String(v ?? "").replace(/\D/g, "");
  return digitos.length === 10 ? digitos : undefined;
}

/** Fila de la tabla terceros (cliente, remitente, destinatario o propietario). */
export interface FilaTercero {
  codTipoId: string | null;
  nit: string;
  nombre: string;
  direccion: string | null;
  telefono: string | null;
  codMunicipioRndc: string | null;
  codSede: string | null;
  nombreSede: string | null;
  ciudad: string | null;
  latitud: number | string | null;
  longitud: number | string | null;
}

/**
 * Variables del proceso 11 para un tercero del catalogo.
 *
 * - Sede: la del catalogo ("0" por defecto). Con NIT el RNDC exige ademas el
 *   nombre de la sede: el escrito, o el municipio, o el nombre del tercero.
 * - Coordenadas: solo si estan (el RNDC verifica el GPS del cargue contra ellas).
 */
export function variablesTercero(t: FilaTercero): Record<string, string | undefined> {
  const tipo = texto(t.codTipoId) ?? "N";
  return {
    CODTIPOIDTERCERO: tipo,
    NUMIDTERCERO: texto(t.nit),
    NOMIDTERCERO: texto(t.nombre),
    NUMTELEFONOCONTACTO: telefonoRndc(t.telefono),
    NOMENCLATURADIRECCION: texto(t.direccion),
    CODMUNICIPIORNDC: texto(t.codMunicipioRndc),
    CODSEDETERCERO: texto(t.codSede) ?? "0",
    NOMSEDETERCERO: texto(t.nombreSede) ?? (tipo === "N" ? texto(t.ciudad) ?? texto(t.nombre) : undefined),
    LATITUD: texto(t.latitud),
    LONGITUD: texto(t.longitud),
  };
}

/** Fila de la tabla conductores. */
export interface FilaConductor {
  codTipoId: string | null;
  cedula: string;
  nombre: string;
  direccion: string | null;
  codMunicipioRndc: string | null;
}

/**
 * Variables del proceso 11 para un conductor: en el RNDC es un tercero mas
 * (persona natural, sede 0). La licencia la toma el RNDC del RUNT.
 */
export function variablesConductor(c: FilaConductor): Record<string, string | undefined> {
  return {
    CODTIPOIDTERCERO: texto(c.codTipoId) ?? "C",
    NUMIDTERCERO: texto(c.cedula),
    NOMIDTERCERO: texto(c.nombre),
    NOMENCLATURADIRECCION: texto(c.direccion),
    CODMUNICIPIORNDC: texto(c.codMunicipioRndc),
    CODSEDETERCERO: "0",
  };
}

/** Fila de la tabla vehiculos. */
export interface FilaVehiculo {
  placa: string;
  pesoVehiculoVacio: number | string | null;
  codTipoIdTenedor: string | null;
  numIdTenedor: string | null;
}

/**
 * Variables del proceso 12 para un vehiculo: placa, peso vacio (en kg, sin
 * decimales) y tenedor si lo hay. Configuracion y carroceria no: el RNDC las
 * toma del RUNT.
 */
export function variablesVehiculo(v: FilaVehiculo): Record<string, string | undefined> {
  const peso = v.pesoVehiculoVacio === null || v.pesoVehiculoVacio === undefined || v.pesoVehiculoVacio === ""
    ? undefined
    : String(Math.round(Number(v.pesoVehiculoVacio)));
  const tenedor = texto(v.numIdTenedor);
  return {
    NUMPLACA: texto(v.placa)?.toUpperCase(),
    PESOVEHICULOVACIO: peso,
    CODTIPOIDTENEDOR: tenedor ? texto(v.codTipoIdTenedor) ?? "C" : undefined,
    NUMIDTENEDOR: tenedor,
  };
}

/** Variables del proceso 12 para un remolque: solo la placa. */
export function variablesRemolque(r: { placa: string }): Record<string, string | undefined> {
  return { NUMPLACA: texto(r.placa)?.toUpperCase() };
}

/** Resultado de registrar un maestro, ya interpretado. */
export interface ResultadoMaestro {
  ok: boolean;
  /** Radicado del RNDC (el nuevo, o el del registro igual que ya existia). */
  radicado: string | null;
  /** true si el RNDC ya lo tenia con los mismos datos (VEH015 / DUPLICADO). */
  yaEstabaIgual: boolean;
  /** Mensaje del RNDC si lo rechazo. */
  error: string | null;
  /** Lo que no se envio y por que (ej. un telefono de 7 digitos). */
  avisos?: string[];
}

/**
 * Interpreta la respuesta del RNDC. "DUPLICADO:<radicado>" significa que ya
 * tiene exactamente esos datos: es exito (nada que actualizar).
 */
export function interpretarRegistro(r: { ok: boolean; radicado: string | null; error: string | null; errorCrudo: string | null }): ResultadoMaestro {
  if (r.ok) return { ok: true, radicado: r.radicado, yaEstabaIgual: false, error: null };
  const crudo = r.errorCrudo ?? r.error ?? "";
  const duplicado = /DUPLICADO:\s*(\d+)/i.exec(crudo);
  if (duplicado) return { ok: true, radicado: duplicado[1], yaEstabaIgual: true, error: null };
  return { ok: false, radicado: null, yaEstabaIgual: false, error: r.error ?? r.errorCrudo ?? "El RNDC rechazo el registro." };
}

/** Error de uso (registro inexistente): la ruta lo responde como 404. */
export class MaestroNoEncontrado extends Error {}

/**
 * Registra (crea o actualiza) en el RNDC el tercero, conductor, vehiculo o
 * remolque con ese id, con los datos que tiene hoy el catalogo. Guarda en la
 * fila el radicado y la fecha, o el error del RNDC.
 */
export async function registrarMaestro(maestro: Maestro, id: number): Promise<ResultadoMaestro> {
  const [filas] = await pool.query<RowDataPacket[]>(`SELECT * FROM \`${maestro}\` WHERE id = ?`, [id]);
  const fila = filas[0];
  if (!fila) throw new MaestroNoEncontrado("No existe en el catalogo.");

  const [proceso, variables] =
    maestro === "terceros"
      ? [PROCESO_TERCERO, variablesTercero(fila as unknown as FilaTercero)]
      : maestro === "conductores"
        ? [PROCESO_TERCERO, variablesConductor(fila as unknown as FilaConductor)]
        : maestro === "vehiculos"
          ? [PROCESO_VEHICULO, variablesVehiculo(fila as unknown as FilaVehiculo)]
          : [PROCESO_VEHICULO, variablesRemolque(fila as unknown as { placa: string })];

  const credenciales = { usuario: config.rndc.usuario, password: config.rndc.password, nitEmpresa: config.rndc.empresaNit };
  const cliente = new RndcClient({
    wsdlUrl: config.rndc.wsdlUrl,
    usuario: config.rndc.usuario,
    password: config.rndc.password,
    simular: config.rndc.simular,
    reintentos: config.rndc.reintentos,
  });
  const avisos: string[] = [];
  if (maestro === "terceros" && texto(fila.telefono) && !variables.NUMTELEFONOCONTACTO) {
    avisos.push(
      `El telefono "${fila.telefono}" no se envio: el RNDC lo exige de 10 digitos (fijo con indicativo, ej. 601..., o celular). Actualizalo en el catalogo.`
    );
  }
  let resultado: ResultadoMaestro;
  try {
    resultado = interpretarRegistro(await cliente.enviar(construirXmlMensaje(credenciales, proceso, variables), proceso));
  } catch (exc) {
    resultado = { ok: false, radicado: null, yaEstabaIgual: false, error: (exc as Error).message };
  }

  if (resultado.ok) {
    await pool.query(`UPDATE \`${maestro}\` SET rndcRadicado = ?, rndcEn = ?, rndcError = NULL WHERE id = ?`, [
      resultado.radicado,
      new Date(),
      id,
    ]);
  } else {
    await pool.query(`UPDATE \`${maestro}\` SET rndcError = ? WHERE id = ?`, [resultado.error, id]);
  }
  return avisos.length ? { ...resultado, avisos } : resultado;
}
