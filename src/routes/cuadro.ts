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

/** GET /api/cuadro: todos los viajes del cuadro (sincroniza antes los manifiestos). */
cuadroRouter.get("/", async (_req, res) => {
  res.json(await cuadro.listar());
});

/** GET /api/cuadro/bombas: catalogo de bombas aliadas. */
cuadroRouter.get("/bombas", async (_req, res) => {
  res.json(await bombas.listar());
});
/** POST /api/cuadro/bombas: crea una bomba ({ nombre, ciudad }). Devuelve su id. */
cuadroRouter.post("/bombas", async (req, res) => {
  await responder(res, async () => ({ id: await bombas.crear(req.body ?? {}) }));
});
/** PUT /api/cuadro/bombas/:bombaId: cambia nombre, ciudad o activa; devuelve la lista. */
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

/** GET /api/cuadro/:id: un viaje con sus anticipos y notas (404 si no existe). */
cuadroRouter.get("/:id", async (req, res) => {
  const fila = await cuadro.obtener(Number(req.params.id));
  if (!fila) return res.status(404).json({ error: "Viaje no encontrado en el cuadro." });
  res.json(fila);
});

/**
 * POST /api/cuadro: crea un viaje sin manifiesto (urbano o planillado por el
 * cliente). Placa, empresa y fecha obligatorias. Devuelve el viaje creado.
 */
cuadroRouter.post("/", async (req, res) => {
  await responder(res, async () => cuadro.obtener(await cuadro.crear(req.body ?? {}, req.usuario?.id ?? null)));
});

/**
 * PUT /api/cuadro/:id: guarda los campos enviados (papeles, flete, factura,
 * pagos...) y devuelve el viaje actualizado.
 */
cuadroRouter.put("/:id", async (req, res) => {
  const id = Number(req.params.id);
  await responder(res, async () => {
    await cuadro.actualizar(id, req.body ?? {});
    return cuadro.obtener(id);
  });
});

/**
 * DELETE /api/cuadro/:id: borra un viaje creado a mano. Los que tienen
 * manifiesto no se borran aqui (409): se anulan desde Viajes.
 */
cuadroRouter.delete("/:id", async (req, res) => {
  const borrado = await cuadro.borrar(Number(req.params.id));
  if (!borrado) {
    return res.status(409).json({ error: "Solo se borran viajes creados a mano; los que tienen manifiesto se anulan desde Viajes." });
  }
  res.json({ ok: true });
});

/**
 * POST /api/cuadro/:id/revision: marca o quita la revision de CONTABILIDAD o
 * GERENCIA ({ quien, revisado }), con el usuario y la hora.
 */
cuadroRouter.post("/:id/revision", async (req, res) => {
  const id = Number(req.params.id);
  const quien = req.body?.quien === "GERENCIA" ? "GERENCIA" : "CONTABILIDAD";
  await cuadro.revisar(id, quien, req.usuario?.id ?? null, req.body?.revisado !== false);
  res.json(await cuadro.obtener(id));
});

/** POST /api/cuadro/:id/notas: agrega una nota ({ texto }) con su autor. */
cuadroRouter.post("/:id/notas", async (req, res) => {
  const id = Number(req.params.id);
  await responder(res, async () => {
    await cuadro.agregarNota(id, String(req.body?.texto ?? ""), req.usuario?.id ?? null);
    return cuadro.obtener(id);
  });
});
/** DELETE /api/cuadro/:id/notas/:notaId: borra una nota. */
cuadroRouter.delete("/:id/notas/:notaId", async (req, res) => {
  const id = Number(req.params.id);
  await cuadro.borrarNota(id, Number(req.params.notaId));
  res.json(await cuadro.obtener(id));
});

/**
 * POST /api/cuadro/:id/anticipos: registra un anticipo de bomba
 * ({ bombaId, valor, fecha, fechaPago?, nota? }).
 */
cuadroRouter.post("/:id/anticipos", async (req, res) => {
  const id = Number(req.params.id);
  await responder(res, async () => {
    await cuadro.agregarAnticipo(id, req.body ?? {}, req.usuario?.id ?? null);
    return cuadro.obtener(id);
  });
});
/**
 * PUT /api/cuadro/:id/anticipos/:anticipoId: cambia la fecha de pago a la
 * bomba y/o la nota del anticipo.
 */
cuadroRouter.put("/:id/anticipos/:anticipoId", async (req, res) => {
  const id = Number(req.params.id);
  await responder(res, async () => {
    await cuadro.actualizarAnticipo(id, Number(req.params.anticipoId), req.body ?? {});
    return cuadro.obtener(id);
  });
});
/** DELETE /api/cuadro/:id/anticipos/:anticipoId: quita un anticipo. */
cuadroRouter.delete("/:id/anticipos/:anticipoId", async (req, res) => {
  const id = Number(req.params.id);
  await cuadro.borrarAnticipo(id, Number(req.params.anticipoId));
  res.json(await cuadro.obtener(id));
});
