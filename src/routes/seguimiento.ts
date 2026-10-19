import { Router } from "express";
import { ErrorCuadro } from "../cuadro";
import { seguimiento } from "../seguimiento";
import { responder } from "./cuadro";
import { importarCartera, propuestaCartera } from "../importaciones";

/**
 * Seguimiento de papeles, facturacion y cartera (ver src/seguimiento.ts).
 * Montado en /api/seguimiento con sesion obligatoria.
 */
export const seguimientoRouter = Router();

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

/**
 * GET /api/seguimiento/cartera?dueno=: facturas por cobrar, totales por cliente
 * y facturados sin datos. Con dueno (MAURICIO, CELSO, MILLER, LUISA o
 * TERCEROS), solo la parte de los vehiculos de ese dueno.
 */
seguimientoRouter.get("/cartera", async (req, res) => {
  res.json(await seguimiento.cartera(req.query.dueno ? String(req.query.dueno) : undefined));
});

/**
 * GET /api/seguimiento/anticipos-empresas: viajes con anticipo que da la
 * empresa (Zorro, Aburra Limpio, sin manifiesto) y lo que debe cada cliente.
 */
seguimientoRouter.get("/anticipos-empresas", async (_req, res) => {
  res.json(await seguimiento.anticiposEmpresas());
});

/** POST /api/seguimiento/anticipos-empresas/pago: la empresa pago el anticipo de esos viajes ({ ids, fecha }). */
seguimientoRouter.post("/anticipos-empresas/pago", async (req, res) => {
  await responder(res, async () => ({ pagados: await seguimiento.pagarAnticiposEmpresa(req.body ?? {}) }));
});

/** PUT /api/seguimiento/cartera/anticipo: anticipo del cliente de una factura ({ facturaNumero, empresa, valor }). */
seguimientoRouter.put("/cartera/anticipo", async (req, res) => {
  await responder(res, async () => {
    await seguimiento.guardarAnticipoCliente(req.body ?? {});
    return { ok: true };
  });
});

/**
 * POST /api/seguimiento/cartera/importar/previa: propone como cargar cada
 * factura del Excel "Cartera Total" ({ facturas }): saldo sin viaje o ligada a
 * sus viajes. No guarda nada.
 */
seguimientoRouter.post("/cartera/importar/previa", async (req, res) => {
  await responder(res, () => propuestaCartera(req.body?.facturas));
});

/** POST /api/seguimiento/cartera/importar: carga las facturas confirmadas ({ facturas }). */
seguimientoRouter.post("/cartera/importar", async (req, res) => {
  await responder(res, () => importarCartera(req.body?.facturas));
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
