/**
 * Perfil de los vehiculos de los socios y la flota propia (no los terceros):
 * lo que hay que consultar de cada uno en un solo lugar. Datos del catalogo,
 * documentos, conductor habitual, el ultimo preoperacional (con sus novedades,
 * equipo, extintor y ultimo mantenimiento) y los ultimos viajes.
 *
 * Es solo lectura: el registro de mantenimientos llega con su modulo.
 */
import type { RowDataPacket } from "mysql2";
import { pool } from "./db";
import { dia } from "./cuadro";
import { sqlFlota } from "./flota";
import { grupoDe } from "./rentabilidad";

/** Un viaje reciente del vehiculo (del Cuadro pagos). */
export interface ViajePerfil {
  id: number;
  fecha: string;
  empresa: string;
  manifiesto: string | null;
  conductor: string | null;
  ruta: string | null;
}

/** El perfil de un vehiculo. */
export interface PerfilVehiculo {
  id: number;
  placa: string;
  placaRemolque: string | null;
  marca: string | null;
  /** Codigo RNDC: 3S3 (tractomula de 3 + 3 ejes), 3 (dobletroque), 2 (sencillo)... */
  configuracion: string | null;
  capacidadKg: number | null;
  pesoVacioKg: number | null;
  grupo: string;
  flota: string;
  conductorHabitual: string | null;
  tieneGps: boolean;
  vencSoat: string | null;
  vencTecno: string | null;
  viajes30Dias: number;
  ultimosViajes: ViajePerfil[];
  /** Respuestas del ultimo preoperacional (ver preguntasPreoperacional del frontend); null si no tiene. */
  ultimoPreoperacional: { fecha: string; conductor: string; aprobo: boolean; respuestas: Record<string, string> } | null;
  preoperacionales: number;
}

/** Placa sin guion ni espacios. */
const sinGuion = (p: string) => p.toUpperCase().replace(/[^A-Z0-9]/g, "");

/** Repositorio de los perfiles. */
export const perfilVehiculos = {
  /**
   * Los vehiculos activos que no son de terceros, con su perfil. Con placa,
   * solo ese (y sus ultimos 10 viajes en vez de 3).
   */
  async listar(placa?: string): Promise<PerfilVehiculo[]> {
    const [vehiculos] = await pool.query<RowDataPacket[]>(
      `SELECT ve.id, ve.placa, ve.placaRemolque, ve.marca, ve.configuracion, ve.capacidadKg, ve.pesoVehiculoVacio,
              ve.fechaVencSoat, ve.fechaVencTecnomecanica, ve.dueno, ve.gpsUrl, ${sqlFlota("ve")} AS flota,
              (SELECT MIN(c.nombre) FROM conductores c WHERE c.cedula = ve.cedulaConductorHabitual) AS conductorHabitual
         FROM vehiculos ve
        WHERE ve.eliminado = 0 AND ve.activo = 1 ${placa ? "AND REPLACE(ve.placa, '-', '') = ?" : ""}
        ORDER BY ve.placa`,
      placa ? [sinGuion(placa)] : []
    );
    const propios = vehiculos
      .map((v) => ({ v, grupo: grupoDe(String(v.placa), String(v.flota), v.dueno ?? null) }))
      .filter((x) => x.grupo !== "TERCEROS");
    if (!propios.length) return [];
    const placas = propios.map((x) => sinGuion(String(x.v.placa)));

    const [[viajes], [conteo], [preops]] = await Promise.all([
      pool.query<RowDataPacket[]>(
        `SELECT id, fecha, placa, empresa, manifiesto, conductor, rutaManual
           FROM cuadro_viajes
          WHERE anulado = 0 AND REPLACE(placa, '-', '') IN (?)
          ORDER BY fecha DESC, id DESC`,
        [placas]
      ),
      pool.query<RowDataPacket[]>(
        `SELECT REPLACE(placa, '-', '') AS placa, COUNT(*) AS n FROM cuadro_viajes
          WHERE anulado = 0 AND fecha >= DATE_SUB(CURDATE(), INTERVAL 30 DAY) AND REPLACE(placa, '-', '') IN (?)
          GROUP BY REPLACE(placa, '-', '')`,
        [placas]
      ),
      pool.query<RowDataPacket[]>(
        `SELECT REPLACE(placa, '-', '') AS placa, fecha, conductor, aprobo, respuestas
           FROM preoperacionales WHERE REPLACE(placa, '-', '') IN (?) ORDER BY fecha DESC, id DESC`,
        [placas]
      ),
    ]);
    const porPlaca = <T>(filas: T[], clave: (f: T) => string) => {
      const m = new Map<string, T[]>();
      for (const f of filas) m.set(clave(f), [...(m.get(clave(f)) ?? []), f]);
      return m;
    };
    const viajesDe = porPlaca(viajes, (f) => sinGuion(String(f.placa)));
    const preopsDe = porPlaca(preops, (f) => String(f.placa));
    const cuantos = new Map(conteo.map((c) => [String(c.placa), Number(c.n)]));

    return propios.map(({ v, grupo }) => {
      const p = sinGuion(String(v.placa));
      const ultimo = preopsDe.get(p)?.[0];
      let respuestas: Record<string, string> = {};
      try {
        respuestas = ultimo ? JSON.parse(String(ultimo.respuestas)) : {};
      } catch {
        respuestas = {};
      }
      return {
        id: Number(v.id),
        placa: String(v.placa),
        placaRemolque: v.placaRemolque ?? null,
        marca: v.marca ?? null,
        configuracion: v.configuracion ?? null,
        capacidadKg: v.capacidadKg === null ? null : Number(v.capacidadKg),
        pesoVacioKg: v.pesoVehiculoVacio === null ? null : Number(v.pesoVehiculoVacio),
        grupo,
        flota: String(v.flota),
        conductorHabitual: v.conductorHabitual ?? null,
        tieneGps: !!v.gpsUrl,
        vencSoat: dia(v.fechaVencSoat) ?? null,
        vencTecno: dia(v.fechaVencTecnomecanica) ?? null,
        viajes30Dias: cuantos.get(p) ?? 0,
        ultimosViajes: (viajesDe.get(p) ?? []).slice(0, placa ? 10 : 3).map((f) => ({
          id: Number(f.id),
          fecha: dia(f.fecha)!,
          empresa: String(f.empresa),
          manifiesto: f.manifiesto ?? null,
          conductor: f.conductor ?? null,
          ruta: f.rutaManual ?? null,
        })),
        ultimoPreoperacional: ultimo
          ? { fecha: dia(ultimo.fecha)!, conductor: String(ultimo.conductor), aprobo: !!ultimo.aprobo, respuestas }
          : null,
        preoperacionales: preopsDe.get(p)?.length ?? 0,
      };
    });
  },
};
