/**
 * Alertas de vencimiento de documentos.
 *
 * Por que importa: el RNDC valida SOAT, tecnomecanica y licencia contra la
 * fecha mas alta de cita de DESCARGUE del manifiesto, no contra hoy. Un
 * documento que vence pasado manana ya bloquea un viaje que descarga el
 * viernes. Por eso las alertas miran hacia adelante y no solo a lo vencido.
 */

import { vehiculos, conductores, remolques, parametros } from "./repo";

/** Umbrales en dias. Se puede pedir otro al consultar. */
export const DIAS_AVISO_POR_DEFECTO = 30;

export type Severidad = "VENCIDO" | "POR_VENCER" | "VIGENTE";

export interface AlertaDocumento {
  tipo: "SOAT" | "TECNOMECANICA" | "LICENCIA" | "POLIZA";
  /** Placa o nombre del conductor. */
  sujeto: string;
  /** Identificacion del sujeto, para poder buscarlo. */
  identificacion: string | null;
  fechaVencimiento: Date | null;
  /** Negativo si ya vencio. */
  diasRestantes: number | null;
  severidad: Severidad;
  mensaje: string;
  /**
   * Registro y campo del que sale la fecha, para poder corregirla desde la
   * alerta misma (PUT /catalogo/<entidad>/:id o PUT /catalogo/parametros).
   */
  origen: OrigenAlerta;
  /**
   * false si el vehiculo, remolque o conductor esta inactivo. Solo aparecen
   * cuando se piden con incluirInactivos (para poder actualizarlos antes de
   * reactivarlos); los contadores normales cuentan solo activos.
   */
  activo: boolean;
}

export interface OrigenAlerta {
  entidad: "vehiculo" | "remolque" | "conductor" | "empresa";
  /** null para la empresa, que es una sola fila. */
  id: number | null;
  campo: "fechaVencSoat" | "fechaVencTecnomecanica" | "fechaVencLicencia" | "fechaVencimientoPolizaCarga";
}

function diasHasta(fecha: Date | null): number | null {
  if (!fecha) return null;
  const hoy = new Date();
  // Se comparan dias calendario, no instantes: un documento que vence hoy
  // sigue siendo valido hoy.
  const a = Date.UTC(fecha.getUTCFullYear(), fecha.getUTCMonth(), fecha.getUTCDate());
  const b = Date.UTC(hoy.getUTCFullYear(), hoy.getUTCMonth(), hoy.getUTCDate());
  return Math.round((a - b) / 86_400_000);
}

function severidadDe(dias: number | null, diasAviso: number): Severidad {
  if (dias === null) return "VIGENTE";
  if (dias < 0) return "VENCIDO";
  if (dias <= diasAviso) return "POR_VENCER";
  return "VIGENTE";
}

function describir(tipo: string, sujeto: string, dias: number | null): string {
  if (dias === null) return `${tipo} de ${sujeto}: sin fecha registrada`;
  if (dias < 0) return `${tipo} de ${sujeto} vencio hace ${Math.abs(dias)} dia(s)`;
  if (dias === 0) return `${tipo} de ${sujeto} vence hoy`;
  return `${tipo} de ${sujeto} vence en ${dias} dia(s)`;
}

function alerta(
  tipo: AlertaDocumento["tipo"],
  sujeto: string,
  identificacion: string | null,
  fecha: Date | null,
  diasAviso: number,
  origen: OrigenAlerta,
  activo = true
): AlertaDocumento {
  const dias = diasHasta(fecha);
  return {
    origen,
    activo,
    tipo,
    sujeto,
    identificacion,
    fechaVencimiento: fecha,
    diasRestantes: dias,
    severidad: severidadDe(dias, diasAviso),
    mensaje: describir(tipo, sujeto, dias),
  };
}

export interface ResumenAlertas {
  vencidos: AlertaDocumento[];
  porVencer: AlertaDocumento[];
  sinFecha: AlertaDocumento[];
  diasAviso: number;
  /** Cuantos elementos se revisaron, para dar contexto al conteo. */
  revisados: { vehiculos: number; remolques: number; conductores: number };
  /** true si la revision incluyo registros inactivos. */
  incluyeInactivos: boolean;
}

/**
 * Revisa toda la flota y los conductores activos.
 *
 * Los registros sin fecha se reportan aparte: no estan vencidos, pero tampoco
 * se puede afirmar que esten vigentes, y esa diferencia importa porque el
 * despacho si los deja pasar.
 */
export async function revisarVencimientos(
  diasAviso = DIAS_AVISO_POR_DEFECTO,
  incluirInactivos = false
): Promise<ResumenAlertas> {
  const [flota, trailers, personal, params] = await Promise.all([
    vehiculos.findMany(),
    remolques.findMany(),
    conductores.findMany(),
    parametros.obtener(),
  ]);

  // Por defecto solo activos: un vehiculo retirado con el SOAT vencido no es
  // una alarma. Con incluirInactivos se revisan todos, marcados con `activo`.
  const activos = flota.filter((v) => incluirInactivos || v.activo);
  const trailersActivos = trailers.filter((r) => incluirInactivos || r.activo);
  const conductoresActivos = personal.filter((c) => incluirInactivos || c.activo);

  const todas: AlertaDocumento[] = [];

  for (const v of activos) {
    todas.push(
      alerta("SOAT", v.placa, v.placa, v.fechaVencSoat, diasAviso, {
        entidad: "vehiculo",
        id: v.id,
        campo: "fechaVencSoat",
      }, v.activo)
    );
    todas.push(
      alerta("TECNOMECANICA", v.placa, v.placa, v.fechaVencTecnomecanica, diasAviso, {
        entidad: "vehiculo",
        id: v.id,
        campo: "fechaVencTecnomecanica",
      }, v.activo)
    );
  }

  // Los remolques tambien llevan tecnomecanica y el RNDC la valida.
  for (const r of trailersActivos) {
    todas.push(
      alerta("TECNOMECANICA", `${r.placa} (remolque)`, r.placa, r.fechaVencTecnomecanica, diasAviso, {
        entidad: "remolque",
        id: r.id,
        campo: "fechaVencTecnomecanica",
      }, r.activo)
    );
  }

  for (const c of conductoresActivos) {
    todas.push(
      alerta("LICENCIA", c.nombre, c.cedula, c.fechaVencLicencia, diasAviso, {
        entidad: "conductor",
        id: c.id,
        campo: "fechaVencLicencia",
      }, c.activo)
    );
  }

  // La poliza de carga de la empresa es una sola, pero su vencimiento para el
  // mismo tipo de problema: se pasa la renovacion anual y nadie se entera.
  todas.push(
    alerta(
      "POLIZA",
      "poliza de carga de la empresa",
      params.numeroPolizaTransporte,
      params.fechaVencimientoPolizaCarga,
      diasAviso,
      { entidad: "empresa", id: null, campo: "fechaVencimientoPolizaCarga" }
    )
  );

  const ordenar = (a: AlertaDocumento, b: AlertaDocumento) =>
    (a.diasRestantes ?? 0) - (b.diasRestantes ?? 0);

  return {
    vencidos: todas.filter((a) => a.severidad === "VENCIDO").sort(ordenar),
    porVencer: todas.filter((a) => a.severidad === "POR_VENCER").sort(ordenar),
    sinFecha: todas.filter((a) => a.fechaVencimiento === null),
    diasAviso,
    revisados: {
      vehiculos: activos.length,
      remolques: trailersActivos.length,
      conductores: conductoresActivos.length,
    },
    incluyeInactivos: incluirInactivos,
  };
}
