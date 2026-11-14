import { Router } from "express";
import { responder } from "./cuadro";
import { preoperacional } from "../preoperacional";
import { filtroVehiculos, rolDePeticion } from "../accesos";

/**
 * Inspeccion preoperacional de vehiculos (ver src/preoperacional.ts).
 * Montado en /api/preoperacional con sesion obligatoria.
 */
export const preoperacionalRouter = Router();

/** GET /api/preoperacional: todas las inspecciones (las mas recientes primero). */
preoperacionalRouter.get("/", async (req, res) => {
  const ve = await filtroVehiculos(rolDePeticion(req));
  res.json((await preoperacional.listar()).filter((p) => ve(p.placa)));
});

/** GET /api/preoperacional/pendientes: viajes con manifiesto de los ultimos 30 dias sin inspeccion. */
preoperacionalRouter.get("/pendientes", async (req, res) => {
  const ve = await filtroVehiculos(rolDePeticion(req));
  res.json((await preoperacional.pendientes()).filter((p) => ve(p.placa)));
});

/** GET /api/preoperacional/sugerido?viajeId= (o ?placa=&conductor=): respuestas sugeridas. */
preoperacionalRouter.get("/sugerido", async (req, res) => {
  await responder(res, () =>
    preoperacional.sugerido({
      viajeId: req.query.viajeId ? Number(req.query.viajeId) : null,
      placa: req.query.placa ? String(req.query.placa) : null,
      conductor: req.query.conductor ? String(req.query.conductor) : null,
    })
  );
});

/** PUT /api/preoperacional/base: reemplaza la base importada de la Matriz Control Integral. */
preoperacionalRouter.put("/base", async (req, res) => {
  await responder(res, () => preoperacional.importarBase(req.body ?? {}));
});

/** POST /api/preoperacional: guarda una inspeccion ({ viajeId?, respuestas }). */
preoperacionalRouter.post("/", async (req, res) => {
  await responder(res, () => preoperacional.guardar(req.body ?? {}, req.usuario?.id ?? null));
});

/** PUT /api/preoperacional/:id: corrige una inspeccion ({ viajeId?, respuestas }). */
preoperacionalRouter.put("/:id", async (req, res) => {
  await responder(res, () => preoperacional.guardar(req.body ?? {}, req.usuario?.id ?? null, Number(req.params.id)));
});

/** DELETE /api/preoperacional/:id: borra una inspeccion. */
preoperacionalRouter.delete("/:id", async (req, res) => {
  await responder(res, async () => {
    await preoperacional.borrar(Number(req.params.id));
    return { ok: true };
  });
});
