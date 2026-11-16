import { Router, type Request } from "express";
import { responder } from "./cuadro";
import { ErrorCuadro } from "../cuadro";
import { nomina } from "../nomina";
import { rolDePeticion } from "../accesos";
import type { EmpresaVehiculo } from "../roles";

/**
 * Empleados, parametros de nomina y nominas (ver src/nomina.ts). Montado en
 * /api/nomina con sesion y el area GASTOS. Transportes M&C solo ve y cambia
 * sus empleados (y sus lineas en las nominas); crear, aprobar, reabrir y
 * borrar nominas es del rol total y el administrativo; los parametros, solo
 * del rol total.
 */
export const nominaRouter = Router();

/** Empresa a la que esta limitado el usuario (M&C), o null si ve las dos. */
const empresaDe = (req: Request): EmpresaVehiculo | null => (rolDePeticion(req) === "MYC" ? "MYC" : null);

/** M&C solo crea o cambia empleados de su empresa. */
async function exigirEmpleado(req: Request, empresaNueva: unknown, id?: number): Promise<void> {
  const limite = empresaDe(req);
  if (!limite) return;
  if (empresaNueva !== undefined && empresaNueva !== limite) throw new ErrorCuadro("Tu usuario solo maneja empleados de Transportes M&C.");
  if (id) {
    const [e] = await nomina.empleados({ id });
    if (e && e.empresa !== limite) throw new ErrorCuadro("Ese empleado es de la otra empresa.");
  }
}

/** M&C solo cambia las lineas de sus empleados. */
async function exigirLinea(req: Request, lineaId: number): Promise<void> {
  const limite = empresaDe(req);
  if (limite && (await nomina.empresaDeLinea(lineaId)) !== limite) throw new ErrorCuadro("Esa linea es de un empleado de la otra empresa.");
}

/** Crear, aprobar, reabrir y borrar nominas: rol total o administrativo. */
function exigirAdministra(req: Request): void {
  if (rolDePeticion(req) === "MYC") throw new ErrorCuadro("La nomina la aprueba el rol total o el administrativo.");
}

/** GET /api/nomina/parametros: parametros por ano. */
nominaRouter.get("/parametros", async (_req, res) => {
  res.json(await nomina.parametros());
});

/** PUT /api/nomina/parametros: crea o cambia los de un ano. Solo total. */
nominaRouter.put("/parametros", async (req, res) => {
  await responder(res, async () => {
    if (rolDePeticion(req) !== "TOTAL") throw new ErrorCuadro("Solo el rol de acceso total cambia los parametros.");
    await nomina.guardarParametros(req.body ?? {});
    return nomina.parametros();
  });
});

/** GET /api/nomina/empleados: empleados (M&C: los suyos). */
nominaRouter.get("/empleados", async (req, res) => {
  res.json(await nomina.empleados({ empresa: empresaDe(req) }));
});

/** POST /api/nomina/empleados: crea un empleado. */
nominaRouter.post("/empleados", async (req, res) => {
  await responder(res, async () => {
    await exigirEmpleado(req, req.body?.empresa);
    const id = await nomina.guardarEmpleado(req.body ?? {});
    return (await nomina.empleados({ id }))[0];
  });
});

/** PUT /api/nomina/empleados/:id: cambia un empleado. */
nominaRouter.put("/empleados/:id", async (req, res) => {
  await responder(res, async () => {
    const id = Number(req.params.id);
    await exigirEmpleado(req, req.body?.empresa, id);
    await nomina.guardarEmpleado(req.body ?? {}, id);
    return (await nomina.empleados({ id }))[0];
  });
});

/** DELETE /api/nomina/empleados/:id: borra un empleado que no esta en nominas. */
nominaRouter.delete("/empleados/:id", async (req, res) => {
  await responder(res, async () => {
    const id = Number(req.params.id);
    await exigirEmpleado(req, undefined, id);
    await nomina.borrarEmpleado(id);
    return { ok: true };
  });
});

/** POST /api/nomina/empleados/:id/vehiculos: el conductor pasa a otro vehiculo ({ vehiculoId, desde }). */
nominaRouter.post("/empleados/:id/vehiculos", async (req, res) => {
  await responder(res, async () => {
    const id = Number(req.params.id);
    await exigirEmpleado(req, undefined, id);
    await nomina.asignarVehiculo(id, req.body ?? {});
    return (await nomina.empleados({ id }))[0];
  });
});

/** DELETE /api/nomina/empleados/:id/vehiculos/:asignacion: quita una asignacion. */
nominaRouter.delete("/empleados/:id/vehiculos/:asignacion", async (req, res) => {
  await responder(res, async () => {
    const id = Number(req.params.id);
    await exigirEmpleado(req, undefined, id);
    await nomina.quitarAsignacion(id, Number(req.params.asignacion));
    return (await nomina.empleados({ id }))[0];
  });
});

/** GET /api/nomina: nominas con sus lineas (M&C: solo las de sus empleados). */
nominaRouter.get("/", async (req, res) => {
  res.json(await nomina.nominas({ empresa: empresaDe(req) }));
});

/** POST /api/nomina: crea una nomina ({ desde, hasta, nota? }) con los empleados activos. */
nominaRouter.post("/", async (req, res) => {
  await responder(res, async () => {
    exigirAdministra(req);
    const id = await nomina.crearNomina(req.body ?? {}, req.usuario?.id ?? null);
    return (await nomina.nominas({ id }))[0];
  });
});

/** DELETE /api/nomina/:id: borra una nomina en borrador. */
nominaRouter.delete("/:id(\\d+)", async (req, res) => {
  await responder(res, async () => {
    exigirAdministra(req);
    await nomina.borrarNomina(Number(req.params.id));
    return { ok: true };
  });
});

/** POST /api/nomina/:id/aprobar: guarda el calculo y crea los gastos. */
nominaRouter.post("/:id(\\d+)/aprobar", async (req, res) => {
  await responder(res, async () => {
    exigirAdministra(req);
    const id = Number(req.params.id);
    await nomina.aprobar(id, req.usuario?.id ?? null);
    return (await nomina.nominas({ id }))[0];
  });
});

/** POST /api/nomina/:id/reabrir: borra sus gastos y la vuelve borrador. */
nominaRouter.post("/:id(\\d+)/reabrir", async (req, res) => {
  await responder(res, async () => {
    exigirAdministra(req);
    const id = Number(req.params.id);
    await nomina.reabrir(id);
    return (await nomina.nominas({ id }))[0];
  });
});

/** POST /api/nomina/:id/lineas: agrega un empleado ({ empleadoId }). */
nominaRouter.post("/:id(\\d+)/lineas", async (req, res) => {
  await responder(res, async () => {
    const id = Number(req.params.id);
    await exigirEmpleado(req, undefined, Number(req.body?.empleadoId));
    await nomina.agregarLinea(id, Number(req.body?.empleadoId));
    return (await nomina.nominas({ id, empresa: empresaDe(req) }))[0];
  });
});

/** PUT /api/nomina/:id/lineas/:linea: dias, producido, vehiculo, ajuste y nota. */
nominaRouter.put("/:id(\\d+)/lineas/:linea", async (req, res) => {
  await responder(res, async () => {
    const id = Number(req.params.id);
    const linea = Number(req.params.linea);
    await exigirLinea(req, linea);
    await nomina.actualizarLinea(id, linea, req.body ?? {});
    return (await nomina.nominas({ id, empresa: empresaDe(req) }))[0];
  });
});

/** DELETE /api/nomina/:id/lineas/:linea: quita a un empleado de la nomina. */
nominaRouter.delete("/:id(\\d+)/lineas/:linea", async (req, res) => {
  await responder(res, async () => {
    const id = Number(req.params.id);
    const linea = Number(req.params.linea);
    await exigirLinea(req, linea);
    await nomina.quitarLinea(id, linea);
    return (await nomina.nominas({ id, empresa: empresaDe(req) }))[0];
  });
});
