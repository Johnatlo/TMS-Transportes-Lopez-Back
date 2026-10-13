import { Router, type Response } from "express";
import { ErrorCuadro } from "../cuadro";
import { seguimiento } from "../seguimiento";

/**
 * Seguimiento de papeles, facturacion y cartera (ver src/seguimiento.ts).
 * Montado en /api/seguimiento con sesion obligatoria.
 */
export const seguimientoRouter = Router();

/** Errores de validacion como 422 con su mensaje; lo demas sigue al manejador general. */
async function responder(res: Response, fn: () => Promise<unknown>) {
  try {
    res.json(await fn());
  } catch (exc) {
    if (exc instanceof ErrorCuadro) return res.status(422).json({ error: exc.message });
    throw exc;
  }
}

/** GET /api/seguimiento/alertas: alertas de papeles, facturacion y cartera. */
seguimientoRouter.get("/alertas", async (_req, res) => {
  res.json(await seguimiento.alertas());
});

/** GET /api/seguimiento/papeles: viajes sin factura con su alerta de papeles y de facturacion. */
seguimientoRouter.get("/papeles", async (_req, res) => {
  res.json(await seguimiento.papeles());
});

/**
 * POST /api/seguimiento/papeles/:id: registra lo que se supo de los papeles
 * ({ estadoPapeles?, papelesTiene?, papelesCompletos?, papelesFaltan?, nota? }).
 * Devuelve el viaje del cuadro actualizado (404 si no existe).
 */
seguimientoRouter.post("/papeles/:id", async (req, res) => {
  await responder(res, async () => {
    const fila = await seguimiento.registrarPapeles(Number(req.params.id), req.body ?? {}, req.usuario?.id ?? null);
    if (!fila) throw new ErrorCuadro("Viaje no encontrado en el cuadro.");
    return fila;
  });
});

/** GET /api/seguimiento/cartera: facturas por cobrar, totales por cliente y facturados sin datos. */
seguimientoRouter.get("/cartera", async (_req, res) => {
  res.json(await seguimiento.cartera());
});

/** PUT /api/seguimiento/cartera/plazos: plazo y contacto de cobro de un cliente. */
seguimientoRouter.put("/cartera/plazos", async (req, res) => {
  await responder(res, async () => {
    await seguimiento.guardarPlazo(req.body ?? {});
    return seguimiento.plazos();
  });
});

/** GET /api/seguimiento/cartera/gestiones?factura=&empresa=: gestiones de cobro de una factura. */
seguimientoRouter.get("/cartera/gestiones", async (req, res) => {
  res.json(await seguimiento.gestiones(String(req.query.factura ?? ""), String(req.query.empresa ?? "")));
});

/**
 * POST /api/seguimiento/cartera/gestiones: anota una gestion de cobro
 * ({ facturaNumero, empresa, texto, compromisoPago? }). Devuelve las de esa factura.
 */
seguimientoRouter.post("/cartera/gestiones", async (req, res) => {
  const b = req.body ?? {};
  await responder(res, async () => {
    await seguimiento.agregarGestion(b, req.usuario?.id ?? null);
    return seguimiento.gestiones(String(b.facturaNumero).trim(), String(b.empresa).trim());
  });
});

/** POST /api/seguimiento/cartera/pago: pago de una factura ({ facturaNumero, empresa, fecha }). */
seguimientoRouter.post("/cartera/pago", async (req, res) => {
  await responder(res, async () => ({ viajes: await seguimiento.registrarPago(req.body ?? {}) }));
});
