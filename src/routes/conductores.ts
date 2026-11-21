/**
 * Rutas del modulo Cuentas vehiculos (/api/conductores): matriz de fletes conductor,
 * cuentas de viaje, prestamos y liquidacion de los conductores (ver
 * src/conductores.ts). Solo el rol total y M&C; M&C solo su flota.
 */
import { Router, type Request } from "express";
import { responder } from "./cuadro";
import { conductores } from "../conductores";
import { rolDePeticion } from "../accesos";
import type { EmpresaVehiculo } from "../roles";

export const conductoresRouter = Router();

/** M&C solo ve y cambia lo de su flota. */
const empresaDe = (req: Request): EmpresaVehiculo | null => (rolDePeticion(req) === "MYC" ? "MYC" : null);
/** Id del usuario de la sesion. */
const usuario = (req: Request) => req.usuario?.id ?? null;

/** GET /api/conductores/fletes: la matriz de fletes conductor (cada tarifa de la empresa con su valor e historial). */
conductoresRouter.get("/fletes", async (_req, res) => {
  res.json(await conductores.fletes());
});
/** PUT /api/conductores/fletes: guarda el flete conductor de una tarifa desde una fecha ({ tarifaFleteId, valor, tipo, desde }). */
conductoresRouter.put("/fletes", async (req, res) => {
  await responder(res, async () => {
    await conductores.guardarFlete(req.body ?? {}, usuario(req));
    return conductores.fletes();
  });
});
/** DELETE /api/conductores/fletes/:id: borra un valor de la matriz. */
conductoresRouter.delete("/fletes/:id", async (req, res) => {
  await responder(res, async () => {
    await conductores.borrarFlete(Number(req.params.id));
    return conductores.fletes();
  });
});
/** POST /api/conductores/fletes/importar: importa la matriz del Excel ({ filas, aplicar }); sin aplicar solo dice cuales encontro. */
conductoresRouter.post("/fletes/importar", async (req, res) => {
  await responder(res, () => conductores.importarFletes(req.body?.filas, req.body?.aplicar === true, usuario(req)));
});

/** GET /api/conductores/viajes?mes=AAAA-MM: viajes de la flota propia con su producido conductor y su cuenta de viaje. */
conductoresRouter.get("/viajes", async (req, res) => {
  await responder(res, () => conductores.viajes(req.query.mes, empresaDe(req)));
});
/** PUT /api/conductores/viajes/:id/cuenta: guarda la cuenta de viaje (conceptos, ACPM, producido a mano, nota). */
conductoresRouter.put("/viajes/:id/cuenta", async (req, res) => {
  await responder(res, async () => {
    const id = Number(req.params.id);
    await conductores.guardarCuenta(id, req.body ?? {}, usuario(req), empresaDe(req));
    return (await conductores.viajes(String(req.body?.mes ?? ""), empresaDe(req))).find((v) => v.cuadroViajeId === id) ?? null;
  });
});
/** DELETE /api/conductores/viajes/:id/cuenta: borra la cuenta de viaje y su gasto del libro. */
conductoresRouter.delete("/viajes/:id/cuenta", async (req, res) => {
  await responder(res, () => conductores.borrarCuenta(Number(req.params.id), empresaDe(req)).then(() => ({ ok: true })));
});

/** GET /api/conductores/prestamos: prestamos con su saldo y lo descontado por mes. */
conductoresRouter.get("/prestamos", async (req, res) => {
  res.json(await conductores.prestamos(empresaDe(req)));
});
/** POST /api/conductores/prestamos: registra un prestamo ({ empleadoId, fecha, monto, cuota?, nota? }). */
conductoresRouter.post("/prestamos", async (req, res) => {
  await responder(res, async () => {
    await conductores.guardarPrestamo(req.body ?? {}, usuario(req), empresaDe(req));
    return conductores.prestamos(empresaDe(req));
  });
});
/** PUT /api/conductores/prestamos/:id: cambia un prestamo. */
conductoresRouter.put("/prestamos/:id", async (req, res) => {
  await responder(res, async () => {
    await conductores.guardarPrestamo(req.body ?? {}, usuario(req), empresaDe(req), Number(req.params.id));
    return conductores.prestamos(empresaDe(req));
  });
});
/** DELETE /api/conductores/prestamos/:id: borra un prestamo. */
conductoresRouter.delete("/prestamos/:id", async (req, res) => {
  await responder(res, async () => {
    await conductores.borrarPrestamo(Number(req.params.id), empresaDe(req));
    return conductores.prestamos(empresaDe(req));
  });
});
/** PUT /api/conductores/prestamos/:id/descuento: lo que se descuenta en un mes ({ mes, valor }; vacio = no se descuenta). */
conductoresRouter.put("/prestamos/:id/descuento", async (req, res) => {
  await responder(res, async () => {
    await conductores.descontar(Number(req.params.id), req.body ?? {}, usuario(req), empresaDe(req));
    return conductores.prestamos(empresaDe(req));
  });
});

/** GET /api/conductores/liquidacion?mes=AAAA-MM: liquidacion de cada conductor en el mes. */
conductoresRouter.get("/liquidacion", async (req, res) => {
  await responder(res, () => conductores.liquidacion(req.query.mes, empresaDe(req)));
});
/** PUT /api/conductores/liquidacion/:empleadoId/:mes/pago: marca pagada la liquidacion ({ fechaPago }). */
conductoresRouter.put("/liquidacion/:empleadoId/:mes/pago", async (req, res) => {
  await responder(res, async () => {
    await conductores.pagar(Number(req.params.empleadoId), req.params.mes, req.body ?? {}, usuario(req), empresaDe(req));
    return conductores.liquidacion(req.params.mes, empresaDe(req));
  });
});
/** DELETE /api/conductores/liquidacion/:empleadoId/:mes/pago: quita la marca de pagada. */
conductoresRouter.delete("/liquidacion/:empleadoId/:mes/pago", async (req, res) => {
  await responder(res, async () => {
    await conductores.quitarPago(Number(req.params.empleadoId), req.params.mes, empresaDe(req));
    return conductores.liquidacion(req.params.mes, empresaDe(req));
  });
});
