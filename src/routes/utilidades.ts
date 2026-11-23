import { Router, type Request } from "express";
import { responder } from "./cuadro";
import { ErrorCuadro } from "../cuadro";
import { sociosDeVehiculos, utilidades, vehiculosDeMyc } from "../utilidades";
import { cuentasVehiculos } from "../cuentasVehiculo";
import type { VistaUtilidades } from "../utilidades";
import { rolDePeticion } from "../accesos";
import { puede, veRentabilidadEmpresa, veRentabilidadTerceros } from "../roles";

/**
 * Rentabilidad (cascada por vehiculo, cuenta del vehiculo y estado de
 * resultados de la empresa) y Reparto a socios (fondos, reparto,
 * participaciones y socios) (ver src/utilidades.ts). Montado en
 * /api/utilidades con sesion y el area LIQUIDACION (los tres roles).
 * - El reparto de los socios (fondos, reparto, cuentas) es del area REPARTO:
 *   las administrativas no lo ven.
 * - La rentabilidad de los terceros no la ve M&C.
 * - Aprobar el reparto y cambiar fondos, participaciones y socios: rol total.
 */
export const utilidadesRouter = Router();

/** Lo que ve el rol de la peticion. */
const vistaDe = async (req: Request): Promise<VistaUtilidades> => ({
  reparto: puede(rolDePeticion(req), "REPARTO"),
  terceros: veRentabilidadTerceros(rolDePeticion(req)),
  empresa: veRentabilidadEmpresa(rolDePeticion(req)),
  // M&C: solo sus carros (y los visibles para todos) y sus socios.
  vehiculos: await vehiculosVisibles(req),
});

/** M&C: sus vehiculos y los visibles para todos; los demas roles: todos (null). */
const vehiculosVisibles = async (req: Request): Promise<number[] | null> => (rolDePeticion(req) === "MYC" ? vehiculosDeMyc() : null);

/** Rentabilidad (o el reparto, que usa la cascada del mes): no las administrativas. */
function exigirRentabilidad(req: Request): void {
  const rol = rolDePeticion(req);
  if (!puede(rol, "RENTABILIDAD") && !puede(rol, "REPARTO")) throw new ErrorCuadro("Tu usuario no tiene acceso a la rentabilidad.");
}

/**
 * GET /api/utilidades/cuentas-vehiculos/:mes: la cuenta de cada vehiculo en el
 * mes (Rentabilidad > Cuenta del vehiculo). M&C solo sus vehiculos y los
 * visibles para todos (XGJ-197).
 */
utilidadesRouter.get("/cuentas-vehiculos/:mes", async (req, res) => {
  await responder(res, () => {
    if (!puede(rolDePeticion(req), "RENTABILIDAD")) throw new ErrorCuadro("Tu usuario no tiene acceso a la rentabilidad.");
    return cuentasVehiculos(req.params.mes, rolDePeticion(req) === "MYC" ? "MYC" : null);
  });
});

/** Solo el rol total. */
function exigirTotal(req: Request): void {
  if (rolDePeticion(req) !== "TOTAL") throw new ErrorCuadro("Solo el rol de acceso total puede hacer esto.");
}

/** Solo quien ve el reparto de los socios. */
function exigirReparto(req: Request): void {
  if (!puede(rolDePeticion(req), "REPARTO")) throw new ErrorCuadro("Tu usuario no ve el reparto de los socios.");
}

/** GET /api/utilidades/aprobados: meses con reparto aprobado. */
utilidadesRouter.get("/aprobados", async (_req, res) => {
  res.json(await utilidades.aprobados());
});

/** GET /api/utilidades/participaciones: vehiculos con su participacion vigente e historial. */
utilidadesRouter.get("/participaciones", async (req, res) => {
  await responder(res, async () => {
    const lista = await utilidades.participaciones();
    const ids = await vehiculosVisibles(req);
    return ids ? lista.filter((p) => ids.includes(p.vehiculoId)) : lista;
  });
});

/** PUT /api/utilidades/participaciones/:vehiculoId: nueva participacion desde una fecha ({ desde, partes }). Solo total. */
utilidadesRouter.put("/participaciones/:vehiculoId", async (req, res) => {
  await responder(res, async () => {
    exigirTotal(req);
    await utilidades.guardarParticipacion(Number(req.params.vehiculoId), req.body ?? {});
    return utilidades.participaciones();
  });
});

/** GET /api/utilidades/fondos: base y saldo inicial del fondo de cada vehiculo. */
utilidadesRouter.get("/fondos", async (req, res) => {
  await responder(res, async () => {
    exigirReparto(req);
    const fondos = await utilidades.fondos();
    const ids = await vehiculosVisibles(req);
    return ids ? fondos.filter((f) => ids.includes(f.vehiculoId)) : fondos;
  });
});

/** PUT /api/utilidades/fondos/:vehiculoId: cambia la base y el saldo inicial ({ base, saldoInicial, nota? }). Solo total. */
utilidadesRouter.put("/fondos/:vehiculoId", async (req, res) => {
  await responder(res, async () => {
    exigirTotal(req);
    await utilidades.guardarFondo(Number(req.params.vehiculoId), req.body ?? {});
    return utilidades.fondos();
  });
});

/** PUT /api/utilidades/gmf: cambia el 4 x 1000 que se descuenta al repartir ({ gmfPorMil }). Solo total. */
utilidadesRouter.put("/gmf", async (req, res) => {
  await responder(res, async () => {
    exigirTotal(req);
    await utilidades.guardarGmf(req.body ?? {});
    return { ok: true };
  });
});

/** GET /api/utilidades/socios: socios. */
utilidadesRouter.get("/socios", async (_req, res) => {
  res.json(await utilidades.socios());
});

/** POST /api/utilidades/socios: crea un socio ({ nombre, externo, documento?, nota?, saldoInicial? }). Solo total. */
utilidadesRouter.post("/socios", async (req, res) => {
  await responder(res, async () => {
    exigirTotal(req);
    await utilidades.guardarSocio(req.body ?? {});
    return utilidades.socios();
  });
});

/** PUT /api/utilidades/socios/:id/datos: cambia los datos de un socio. Solo total. */
utilidadesRouter.put("/socios/:id/datos", async (req, res) => {
  await responder(res, async () => {
    exigirTotal(req);
    await utilidades.guardarSocio(req.body ?? {}, Number(req.params.id));
    return utilidades.socios();
  });
});

/** PUT /api/utilidades/socios/:id: activa o desactiva ({ activo }). Solo total. */
utilidadesRouter.put("/socios/:id", async (req, res) => {
  await responder(res, async () => {
    exigirTotal(req);
    await utilidades.activarSocio(Number(req.params.id), req.body?.activo !== false);
    return utilidades.socios();
  });
});

/** GET /api/utilidades/cuentas: cuenta de cada socio mes a mes. */
utilidadesRouter.get("/cuentas", async (req, res) => {
  await responder(res, async () => {
    exigirReparto(req);
    const cuentas = await utilidades.cuentas();
    const ids = await vehiculosVisibles(req);
    if (!ids) return cuentas;
    // M&C: solo los socios de sus carros.
    const suyos = await sociosDeVehiculos(ids);
    return cuentas.filter((c) => suyos.has(c.id));
  });
});

/** POST /api/utilidades/socios/:id/pagos: registra un pago al socio ({ fecha, monto, nota?, soporteUrl? }). Solo total. */
utilidadesRouter.post("/socios/:id/pagos", async (req, res) => {
  await responder(res, async () => {
    exigirTotal(req);
    await utilidades.registrarPago(Number(req.params.id), req.body ?? {}, req.usuario?.id ?? null);
    return utilidades.cuentas();
  });
});

/** DELETE /api/utilidades/pagos/:id: borra un pago registrado por error. Solo total. */
utilidadesRouter.delete("/pagos/:id", async (req, res) => {
  await responder(res, async () => {
    exigirTotal(req);
    await utilidades.borrarPago(Number(req.params.id));
    return utilidades.cuentas();
  });
});

/** GET /api/utilidades/:mes: cascada, fondos y reparto del mes ("AAAA-MM"), segun lo que ve el rol. */
utilidadesRouter.get("/:mes", async (req, res) => {
  await responder(res, async () => {
    exigirRentabilidad(req);
    return utilidades.mes(req.params.mes, await vistaDe(req));
  });
});

/** POST /api/utilidades/:mes/simular: el mes con lo que se reparte de cada vehiculo ({ repartimos: { vehiculoId: monto } }). */
utilidadesRouter.post("/:mes/simular", async (req, res) => {
  await responder(res, async () => {
    exigirReparto(req);
    return utilidades.mes(req.params.mes, await vistaDe(req), req.body?.repartimos ?? {});
  });
});

/** POST /api/utilidades/:mes/aprobar: guarda la foto con lo que se reparte ({ repartimos }). Solo total. */
utilidadesRouter.post("/:mes/aprobar", async (req, res) => {
  await responder(res, async () => {
    exigirTotal(req);
    await utilidades.aprobar(req.params.mes, req.body?.repartimos ?? {}, req.usuario?.id ?? null);
    return utilidades.mes(req.params.mes, await vistaDe(req));
  });
});

/** DELETE /api/utilidades/:mes/aprobar: anula la aprobacion (solo el ultimo mes aprobado). Solo total. */
utilidadesRouter.delete("/:mes/aprobar", async (req, res) => {
  await responder(res, async () => {
    exigirTotal(req);
    await utilidades.anular(req.params.mes);
    return utilidades.mes(req.params.mes, await vistaDe(req));
  });
});
