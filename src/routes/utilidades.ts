import { Router, type Request } from "express";
import { responder } from "./cuadro";
import { ErrorCuadro } from "../cuadro";
import { utilidades } from "../utilidades";
import { rolDePeticion } from "../accesos";
import type { EmpresaVehiculo } from "../roles";

/**
 * Cascada de rentabilidad por vehiculo, reparto de utilidades y
 * participaciones (ver src/utilidades.ts). Montado en /api/utilidades con
 * sesion y el area LIQUIDACION (rol total y M&C; M&C solo ve sus vehiculos).
 * Aprobar el reparto, cambiar participaciones y crear socios: rol total.
 */
export const utilidadesRouter = Router();

/** Empresa a la que esta limitado el usuario (M&C), o null si ve las dos. */
const empresaDe = (req: Request): EmpresaVehiculo | null => (rolDePeticion(req) === "MYC" ? "MYC" : null);

/** Solo el rol total. */
function exigirTotal(req: Request): void {
  if (rolDePeticion(req) !== "TOTAL") throw new ErrorCuadro("Solo el rol de acceso total puede hacer esto.");
}

/** GET /api/utilidades/aprobados: meses con reparto aprobado. */
utilidadesRouter.get("/aprobados", async (_req, res) => {
  res.json(await utilidades.aprobados());
});

/** GET /api/utilidades/participaciones: vehiculos con su participacion vigente e historial. */
utilidadesRouter.get("/participaciones", async (req, res) => {
  res.json(await utilidades.participaciones({ empresa: empresaDe(req) }));
});

/** PUT /api/utilidades/participaciones/:vehiculoId: nueva participacion desde una fecha ({ desde, partes }). */
utilidadesRouter.put("/participaciones/:vehiculoId", async (req, res) => {
  await responder(res, async () => {
    exigirTotal(req);
    await utilidades.guardarParticipacion(Number(req.params.vehiculoId), req.body ?? {});
    return utilidades.participaciones();
  });
});

/** GET /api/utilidades/socios: socios. */
utilidadesRouter.get("/socios", async (_req, res) => {
  res.json(await utilidades.socios());
});

/** POST /api/utilidades/socios: crea un socio ({ nombre }). */
utilidadesRouter.post("/socios", async (req, res) => {
  await responder(res, async () => {
    exigirTotal(req);
    await utilidades.crearSocio(req.body ?? {});
    return utilidades.socios();
  });
});

/** PUT /api/utilidades/socios/:id: activa o desactiva ({ activo }). */
utilidadesRouter.put("/socios/:id", async (req, res) => {
  await responder(res, async () => {
    exigirTotal(req);
    await utilidades.activarSocio(Number(req.params.id), req.body?.activo !== false);
    return utilidades.socios();
  });
});

/** GET /api/utilidades/:mes: cascada por vehiculo y reparto por socio del mes ("AAAA-MM"). */
utilidadesRouter.get("/:mes", async (req, res) => {
  await responder(res, () => utilidades.mes(req.params.mes, { empresa: empresaDe(req) }));
});

/** POST /api/utilidades/:mes/aprobar: guarda la foto del reparto (el mes debe estar cerrado). */
utilidadesRouter.post("/:mes/aprobar", async (req, res) => {
  await responder(res, async () => {
    exigirTotal(req);
    await utilidades.aprobar(req.params.mes, req.usuario?.id ?? null);
    return utilidades.mes(req.params.mes);
  });
});

/** DELETE /api/utilidades/:mes/aprobar: anula la aprobacion. */
utilidadesRouter.delete("/:mes/aprobar", async (req, res) => {
  await responder(res, async () => {
    exigirTotal(req);
    await utilidades.anular(req.params.mes);
    return utilidades.mes(req.params.mes);
  });
});
