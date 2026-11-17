import { Router, type Request } from "express";
import { responder } from "./cuadro";
import { ErrorCuadro } from "../cuadro";
import { gastos } from "../gastos";
import { rolDePeticion } from "../accesos";
import type { EmpresaVehiculo } from "../roles";

/**
 * Libro de gastos, cierres de mes y creditos (ver src/gastos.ts). Montado en
 * /api/gastos con sesion y el area GASTOS (total, administrativo y M&C).
 * Transportes M&C ve todos los gastos y registra y cambia los de su empresa;
 * cerrar meses y cambiar la fecha de corte es solo del rol total.
 */
export const gastosRouter = Router();

/** Empresa a la que esta limitado el usuario (M&C), o null si ve las dos. */
const empresaDe = (req: Request): EmpresaVehiculo | null => (rolDePeticion(req) === "MYC" ? "MYC" : null);

/** M&C solo puede registrar en su empresa. */
function exigirEmpresa(req: Request, empresa: unknown): void {
  const limite = empresaDe(req);
  if (limite && empresa !== limite) throw new ErrorCuadro("Tu usuario solo registra gastos de Transportes M&C.");
}

/** El gasto o credito existe y es de una empresa que el usuario ve. */
async function exigirGasto(req: Request, id: number): Promise<void> {
  const limite = empresaDe(req);
  if (!limite) return;
  const [g] = await gastos.listar({ id });
  if (g && g.empresa !== limite) throw new ErrorCuadro("Ese gasto es de la otra empresa.");
}

/** El credito existe y es de una empresa que el usuario ve. */
async function exigirCredito(req: Request, id: number): Promise<void> {
  const limite = empresaDe(req);
  if (!limite) return;
  const [c] = await gastos.creditos({ id });
  if (c && c.empresa !== limite) throw new ErrorCuadro("Ese credito es de la otra empresa.");
}

/** Solo el rol total. */
function exigirTotal(req: Request): void {
  if (rolDePeticion(req) !== "TOTAL") throw new ErrorCuadro("Solo el rol de acceso total puede hacer esto.");
}

/** GET /api/gastos/opciones: vehiculos propios, socios, categorias, fecha de corte y meses cerrados. */
gastosRouter.get("/opciones", async (_req, res) => {
  res.json(await gastos.opciones());
});

/** GET /api/gastos: el libro de gastos (M&C: solo los de su empresa). */
gastosRouter.get("/", async (req, res) => {
  res.json(await gastos.listar());
});

/** POST /api/gastos: registra un gasto ({ empresa, tipo, categoria, descripcion, monto, fechaPago?, soporteUrl?, causaDesde, causaCuotas?, destinos }). */
gastosRouter.post("/", async (req, res) => {
  await responder(res, async () => {
    exigirEmpresa(req, req.body?.empresa);
    const id = await gastos.crear(req.body ?? {}, req.usuario?.id ?? null);
    return (await gastos.listar({ id }))[0];
  });
});

/** PUT /api/gastos/:id: cambia el gasto y recalcula su reparto (meses abiertos). */
gastosRouter.put("/:id(\\d+)", async (req, res) => {
  await responder(res, async () => {
    const id = Number(req.params.id);
    await exigirGasto(req, id);
    exigirEmpresa(req, req.body?.empresa);
    await gastos.actualizar(id, req.body ?? {});
    return (await gastos.listar({ id }))[0];
  });
});

/** PUT /api/gastos/:id/pago: fecha de pago y link del soporte ({ fechaPago?, soporteUrl? }). */
gastosRouter.put("/:id(\\d+)/pago", async (req, res) => {
  await responder(res, async () => {
    const id = Number(req.params.id);
    await exigirGasto(req, id);
    await gastos.pago(id, req.body ?? {});
    return (await gastos.listar({ id }))[0];
  });
});

/** DELETE /api/gastos/:id: anula el gasto (queda en el libro, deja de contar). */
gastosRouter.delete("/:id(\\d+)", async (req, res) => {
  await responder(res, async () => {
    const id = Number(req.params.id);
    await exigirGasto(req, id);
    await gastos.anular(id);
    return (await gastos.listar({ id }))[0];
  });
});

/** POST /api/gastos/cierres: cierra o abre un mes ({ mes: "AAAA-MM", cerrado }). Solo total. Devuelve los meses cerrados. */
gastosRouter.post("/cierres", async (req, res) => {
  await responder(res, async () => {
    exigirTotal(req);
    return gastos.cerrarMes(req.body ?? {}, req.usuario?.id ?? null);
  });
});

/** PUT /api/gastos/corte: cambia la fecha desde la que se registran gastos ({ corte }). Solo total. */
gastosRouter.put("/corte", async (req, res) => {
  await responder(res, async () => {
    exigirTotal(req);
    return { corte: await gastos.fijarCorte(req.body ?? {}) };
  });
});

/** GET /api/gastos/creditos: creditos con su tabla de amortizacion y saldo. */
gastosRouter.get("/creditos", async (req, res) => {
  res.json(await gastos.creditos());
});

/** POST /api/gastos/creditos: crea un credito y su tabla ({ empresa, nombre, entidad?, obligacion?, monto, tasaMensual, plazo, primeraCuota, cuotaFija?, prorratea, destinos, nota? }). */
gastosRouter.post("/creditos", async (req, res) => {
  await responder(res, async () => {
    exigirEmpresa(req, req.body?.empresa);
    const id = await gastos.guardarCredito(req.body ?? {}, req.usuario?.id ?? null);
    return (await gastos.creditos({ id }))[0];
  });
});

/** PUT /api/gastos/creditos/:id: cambia el credito (rehace la tabla si aun no tiene cuotas pagadas). */
gastosRouter.put("/creditos/:id", async (req, res) => {
  await responder(res, async () => {
    const id = Number(req.params.id);
    await exigirCredito(req, id);
    exigirEmpresa(req, req.body?.empresa);
    await gastos.guardarCredito(req.body ?? {}, req.usuario?.id ?? null, id);
    return (await gastos.creditos({ id }))[0];
  });
});

/** DELETE /api/gastos/creditos/:id: borra un credito sin cuotas pagadas. */
gastosRouter.delete("/creditos/:id", async (req, res) => {
  await responder(res, async () => {
    const id = Number(req.params.id);
    await exigirCredito(req, id);
    await gastos.borrarCredito(id);
    return { ok: true };
  });
});

/** POST /api/gastos/creditos/:id/cuotas/:numero/pago: registra el pago de la cuota y crea su gasto ({ fechaPago, soporteUrl? }). */
gastosRouter.post("/creditos/:id/cuotas/:numero/pago", async (req, res) => {
  await responder(res, async () => {
    const id = Number(req.params.id);
    await exigirCredito(req, id);
    await gastos.pagarCuota(id, Number(req.params.numero), req.body ?? {}, req.usuario?.id ?? null);
    return (await gastos.creditos({ id }))[0];
  });
});

/** DELETE /api/gastos/creditos/:id/cuotas/:numero/pago: quita el pago de la cuota y borra su gasto. */
gastosRouter.delete("/creditos/:id/cuotas/:numero/pago", async (req, res) => {
  await responder(res, async () => {
    const id = Number(req.params.id);
    await exigirCredito(req, id);
    await gastos.quitarPagoCuota(id, Number(req.params.numero));
    return (await gastos.creditos({ id }))[0];
  });
});
