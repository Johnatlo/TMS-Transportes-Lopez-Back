import { Router, type Response } from "express";
import { bombas, cuadro, ErrorCuadro, hoyColombia } from "../cuadro";
import { facturacion } from "../facturacion";
import { anticipos } from "../anticipos";
import { relacionesBomba } from "../relacionesBomba";
import { reportes } from "../reportes";
import { importarAnticipos, propuestaAnticipos } from "../importaciones";

/**
 * Cuadro pagos de viajes (ver src/cuadro.ts). Montado en /api/cuadro con
 * sesion obligatoria.
 */
export const cuadroRouter = Router();

/**
 * Errores de validacion (ErrorCuadro) como 422 con su mensaje; lo demas sigue
 * al manejador general. Tambien lo usan las rutas de seguimiento.
 */
export async function responder(res: Response, fn: () => Promise<unknown>) {
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

// ---------- Cuadro de anticipos (ver src/anticipos.ts) ----------
/** GET /api/cuadro/anticipos: todos los tramos de anticipo (ida y vuelta), lo mas reciente primero. */
cuadroRouter.get("/anticipos", async (_req, res) => {
  res.json(await anticipos.cuadro());
});
/**
 * POST /api/cuadro/anticipos/importar/previa: propone el viaje de cada fila del
 * Excel de anticipos ({ filas }). No guarda nada.
 */
cuadroRouter.post("/anticipos/importar/previa", async (req, res) => {
  await responder(res, () => propuestaAnticipos(req.body?.filas));
});
/** POST /api/cuadro/anticipos/importar: carga las filas confirmadas ({ filas: [{ ...fila, viajeId }] }). */
cuadroRouter.post("/anticipos/importar", async (req, res) => {
  await responder(res, () => importarAnticipos(req.body?.filas, req.usuario?.id ?? null));
});
/** GET /api/cuadro/anticipos/resumen: deuda, pagado, abonado por el socio, pendiente y cupo con la bomba. */
cuadroRouter.get("/anticipos/resumen", async (_req, res) => {
  res.json(await anticipos.resumen());
});
/**
 * PUT /api/cuadro/anticipos/parametros: cupo de credito con la bomba y precio
 * y descuento por galon sugeridos ({ cupoBomba, precioGalonBomba, descuentoGalonBomba }).
 * Va antes de /anticipos/:anticipoId para que "parametros" no se tome como id.
 */
cuadroRouter.put("/anticipos/parametros", async (req, res) => {
  await responder(res, () => anticipos.guardarParametrosBomba(req.body ?? {}));
});
/**
 * POST /api/cuadro/anticipos/juntar: junta dos tanqueos de la misma placa como
 * ida y vuelta ({ ida, vuelta }: ids de tanqueo). Devuelve el cuadro.
 */
cuadroRouter.post("/anticipos/juntar", async (req, res) => {
  await responder(res, async () => {
    await anticipos.juntarManual(Number(req.body?.ida), Number(req.body?.vuelta));
    return anticipos.cuadro();
  });
});
/** POST /api/cuadro/anticipos/separar/:tanqueoId: separa la vuelta de un tanqueo de ida y vuelta. */
cuadroRouter.post("/anticipos/separar/:tanqueoId", async (req, res) => {
  await responder(res, async () => {
    await anticipos.separarVuelta(Number(req.params.tanqueoId));
    return anticipos.cuadro();
  });
});

// ---------- Cruce con la bomba (ver src/relacionesBomba.ts) ----------
/** GET /api/cuadro/relaciones-bomba: facturas (relaciones de vales) de la bomba ya cruzadas. */
cuadroRouter.get("/relaciones-bomba", async (_req, res) => {
  res.json(await relacionesBomba.listar());
});
/** POST /api/cuadro/relaciones-bomba/previa: propone el tanqueo de cada vale ({ numero, vales }). No guarda. */
cuadroRouter.post("/relaciones-bomba/previa", async (req, res) => {
  await responder(res, () => relacionesBomba.proponer(req.body ?? {}));
});
/** POST /api/cuadro/relaciones-bomba: guarda la relacion y cruza los tanqueos ({ numero, fecha, nota, vales }). */
cuadroRouter.post("/relaciones-bomba", async (req, res) => {
  await responder(res, async () => {
    await relacionesBomba.guardar(req.body ?? {}, req.usuario?.id ?? null);
    return relacionesBomba.listar();
  });
});
/** PUT /api/cuadro/relaciones-bomba/:relacionId/pago: fecha de pago de la factura ({ fechaPago }; vacia la quita). */
cuadroRouter.put("/relaciones-bomba/:relacionId/pago", async (req, res) => {
  await responder(res, async () => {
    await relacionesBomba.pagar(Number(req.params.relacionId), req.body ?? {});
    return relacionesBomba.listar();
  });
});
/** PUT /api/cuadro/relaciones-bomba/:relacionId/vencimiento: fecha de vencimiento de la factura ({ fechaVencimiento }). */
cuadroRouter.put("/relaciones-bomba/:relacionId/vencimiento", async (req, res) => {
  await responder(res, async () => {
    await relacionesBomba.vencimiento(Number(req.params.relacionId), req.body ?? {});
    return relacionesBomba.listar();
  });
});
/**
 * GET /api/cuadro/reportes/bomba?desde=AAAA-MM-DD&hasta=AAAA-MM-DD: estado de
 * cuenta con la bomba (deuda al inicio, prestamos, abonos de los socios,
 * pagos de la empresa, deuda al final) y lo prestado por mes, bomba y empresa.
 */
cuadroRouter.get("/reportes/bomba", async (req, res) => {
  await responder(res, () => reportes.bomba(req.query as Record<string, unknown>, hoyColombia()));
});
/** GET /api/cuadro/pagos-bomba: pagos a la bomba (facturas de la quincena menos abonos de los socios). */
cuadroRouter.get("/pagos-bomba", async (_req, res) => {
  res.json(await relacionesBomba.pagos());
});
/** POST /api/cuadro/pagos-bomba: registra el pago ({ relaciones, abonos, fecha, referencia }). Devuelve los pagos. */
cuadroRouter.post("/pagos-bomba", async (req, res) => {
  await responder(res, async () => {
    await relacionesBomba.registrarPago(req.body ?? {}, req.usuario?.id ?? null);
    return relacionesBomba.pagos();
  });
});
/** DELETE /api/cuadro/pagos-bomba/:pagoId: deshace un pago a la bomba. */
cuadroRouter.delete("/pagos-bomba/:pagoId", async (req, res) => {
  await responder(res, async () => {
    await relacionesBomba.borrarPago(Number(req.params.pagoId));
    return relacionesBomba.pagos();
  });
});
/** DELETE /api/cuadro/relaciones-bomba/:relacionId: borra la relacion y deshace el cruce. */
cuadroRouter.delete("/relaciones-bomba/:relacionId", async (req, res) => {
  await responder(res, async () => {
    await relacionesBomba.borrar(Number(req.params.relacionId));
    return relacionesBomba.listar();
  });
});

/** GET /api/cuadro/abonos-socio: abonos del socio a la bomba, con sus viajes. */
cuadroRouter.get("/abonos-socio", async (_req, res) => {
  res.json(await anticipos.abonos());
});
/** POST /api/cuadro/abonos-socio: registra un abono ({ socio, fecha, nota, viajes: [{ cuadroViajeId, valor }] }). */
cuadroRouter.post("/abonos-socio", async (req, res) => {
  await responder(res, async () => {
    await anticipos.registrarAbono(req.body ?? {}, req.usuario?.id ?? null);
    return anticipos.abonos();
  });
});
/** DELETE /api/cuadro/abonos-socio/:abonoId: borra un abono. */
cuadroRouter.delete("/abonos-socio/:abonoId", async (req, res) => {
  await anticipos.borrarAbono(Number(req.params.abonoId));
  res.json(await anticipos.abonos());
});
/** PUT /api/cuadro/anticipos/:anticipoId: fecha de pago, nota, viaje o datos del cruce (galones, precio y descuento: recalcula el combustible) de un tramo. */
cuadroRouter.put("/anticipos/:anticipoId", async (req, res) => {
  await responder(res, async () => {
    await anticipos.actualizarTramo(Number(req.params.anticipoId), req.body ?? {});
    return anticipos.cuadro();
  });
});
/** PUT /api/cuadro/tanqueos/:tanqueoId: factura de la bomba (numero, fecha) o la bomba del tanqueo. */
cuadroRouter.put("/tanqueos/:tanqueoId", async (req, res) => {
  await responder(res, async () => {
    await anticipos.actualizarTanqueo(Number(req.params.tanqueoId), req.body ?? {});
    return anticipos.cuadro();
  });
});

// ---------- Envio a facturacion y matriz de fletes (ver src/facturacion.ts) ----------
/** GET /api/cuadro/tarifas: la matriz de fletes. */
cuadroRouter.get("/tarifas", async (_req, res) => {
  res.json(await facturacion.tarifas());
});
/**
 * PUT /api/cuadro/tarifas: reemplaza la matriz completa con la importada del
 * Excel ({ tarifas: [{ nombre, razonSocial, valor, tipo, pesoMinimoKg, observaciones }] }).
 */
cuadroRouter.put("/tarifas", async (req, res) => {
  await responder(res, async () => ({ importadas: await facturacion.reemplazarTarifas(req.body?.tarifas) }));
});
/** PUT /api/cuadro/tarifas/:tarifaId: cambia una tarifa y la devuelve (404 si no existe). */
cuadroRouter.put("/tarifas/:tarifaId", async (req, res) => {
  await responder(res, async () => {
    const t = await facturacion.actualizarTarifa(Number(req.params.tarifaId), req.body ?? {});
    if (!t) throw new ErrorCuadro("Tarifa no encontrada.");
    return t;
  });
});
/** GET /api/cuadro/por-facturar: viajes listos para facturar (y los ya enviados sin fecha de factura). */
cuadroRouter.get("/por-facturar", async (_req, res) => {
  res.json(await facturacion.porFacturar());
});
/**
 * POST /api/cuadro/enviar-facturacion: guarda en cada viaje lo que va en el
 * cuadro de la contadora ({ filas: [{ id, tarifaFleteId, tipo, valorTon,
 * pesoFacturadoKg, total, remision, notaFactura, facturaNumero }] }).
 */
cuadroRouter.post("/enviar-facturacion", async (req, res) => {
  await responder(res, async () => ({ guardados: await facturacion.guardarEnvio(req.body?.filas) }));
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
