/**
 * Rutas de Control interno (/api/control): la bitacora de cambios, el
 * historial de un registro y la papelera (ver src/bitacora.ts). Solo el rol
 * de acceso total (area CONTROL).
 */
import { Router } from "express";
import { responder } from "./cuadro";
import { bitacora } from "../bitacora";

export const controlRouter = Router();

/** GET /api/control/estado: si la bitacora esta activa (o por que no). */
controlRouter.get("/estado", (_req, res) => {
  res.json(bitacora.estado());
});

/** GET /api/control/bitacora?tabla&registroId&usuarioId&accion&desde&hasta&limite: los cambios, los mas recientes primero. */
controlRouter.get("/bitacora", async (req, res) => {
  await responder(res, () => bitacora.listar(req.query));
});

/** GET /api/control/historial/:tabla/:id: los cambios de un registro y de lo que cuelga de el. */
controlRouter.get("/historial/:tabla/:id", async (req, res) => {
  await responder(res, () => bitacora.historial(req.params.tabla, req.params.id));
});

/** GET /api/control/papelera?tabla&usuarioId&desde&hasta: lo borrado, lo mas reciente primero. */
controlRouter.get("/papelera", async (req, res) => {
  await responder(res, () => bitacora.listar(req.query, true));
});

/** POST /api/control/papelera/:id/restaurar: vuelve a crear un registro borrado (solo las tablas simples). */
controlRouter.post("/papelera/:id/restaurar", async (req, res) => {
  await responder(res, async () => {
    await bitacora.restaurar(Number(req.params.id), req.usuario?.id ?? null);
    return { ok: true };
  });
});
