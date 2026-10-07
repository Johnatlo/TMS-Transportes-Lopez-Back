import { Router, type Response } from "express";
import { bombas, cuadro, ErrorCuadro } from "../cuadro";

/**
 * Cuadro pagos de viajes (ver src/cuadro.ts). Montado en /api/cuadro con
 * sesion obligatoria.
 */
export const cuadroRouter = Router();

/** Errores de validacion como 422 con su mensaje; lo demas sigue al manejador general. */
async function responder(res: Response, fn: () => Promise<unknown>) {
  try {
    res.json(await fn());
  } catch (exc) {
    if (exc instanceof ErrorCuadro) return res.status(422).json({ error: exc.message });
    throw exc;
  }
}

cuadroRouter.get("/", async (_req, res) => {
  res.json(await cuadro.listar());
});

cuadroRouter.get("/bombas", async (_req, res) => {
  res.json(await bombas.listar());
});
cuadroRouter.post("/bombas", async (req, res) => {
  await responder(res, async () => ({ id: await bombas.crear(req.body ?? {}) }));
});
cuadroRouter.put("/bombas/:bombaId", async (req, res) => {
  await responder(res, async () => {
    await bombas.actualizar(Number(req.params.bombaId), req.body ?? {});
    return bombas.listar();
  });
});

/** Asigna una misma factura a varios viajes. */
cuadroRouter.post("/facturar", async (req, res) => {
  const b = req.body ?? {};
  await responder(res, async () => ({
    actualizados: await cuadro.facturar((Array.isArray(b.ids) ? b.ids : []).map(Number), b),
  }));
});

cuadroRouter.get("/:id", async (req, res) => {
  const fila = await cuadro.obtener(Number(req.params.id));
  if (!fila) return res.status(404).json({ error: "Viaje no encontrado en el cuadro." });
  res.json(fila);
});

cuadroRouter.post("/", async (req, res) => {
  await responder(res, async () => cuadro.obtener(await cuadro.crear(req.body ?? {}, req.usuario?.id ?? null)));
});

cuadroRouter.put("/:id", async (req, res) => {
  const id = Number(req.params.id);
  await responder(res, async () => {
    await cuadro.actualizar(id, req.body ?? {});
    return cuadro.obtener(id);
  });
});

cuadroRouter.delete("/:id", async (req, res) => {
  const borrado = await cuadro.borrar(Number(req.params.id));
  if (!borrado) {
    return res.status(409).json({ error: "Solo se borran viajes creados a mano; los que tienen manifiesto se anulan desde Viajes." });
  }
  res.json({ ok: true });
});

cuadroRouter.post("/:id/revision", async (req, res) => {
  const id = Number(req.params.id);
  const quien = req.body?.quien === "GERENCIA" ? "GERENCIA" : "CONTABILIDAD";
  await cuadro.revisar(id, quien, req.usuario?.id ?? null, req.body?.revisado !== false);
  res.json(await cuadro.obtener(id));
});

cuadroRouter.post("/:id/notas", async (req, res) => {
  const id = Number(req.params.id);
  await responder(res, async () => {
    await cuadro.agregarNota(id, String(req.body?.texto ?? ""), req.usuario?.id ?? null);
    return cuadro.obtener(id);
  });
});
cuadroRouter.delete("/:id/notas/:notaId", async (req, res) => {
  const id = Number(req.params.id);
  await cuadro.borrarNota(id, Number(req.params.notaId));
  res.json(await cuadro.obtener(id));
});

cuadroRouter.post("/:id/anticipos", async (req, res) => {
  const id = Number(req.params.id);
  await responder(res, async () => {
    await cuadro.agregarAnticipo(id, req.body ?? {}, req.usuario?.id ?? null);
    return cuadro.obtener(id);
  });
});
cuadroRouter.put("/:id/anticipos/:anticipoId", async (req, res) => {
  const id = Number(req.params.id);
  await responder(res, async () => {
    await cuadro.actualizarAnticipo(id, Number(req.params.anticipoId), req.body ?? {});
    return cuadro.obtener(id);
  });
});
cuadroRouter.delete("/:id/anticipos/:anticipoId", async (req, res) => {
  const id = Number(req.params.id);
  await cuadro.borrarAnticipo(id, Number(req.params.anticipoId));
  res.json(await cuadro.obtener(id));
});
