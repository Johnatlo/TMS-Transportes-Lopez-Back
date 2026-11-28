import { Router } from "express";
import { rolDePeticion } from "../accesos";
import { PARTES_RESUMEN, resumenInicio } from "../inicioResumen";
import type { ParteResumen } from "../inicioResumen";

/**
 * Resumen del Inicio (ver src/inicioResumen.ts). Montado en /api/inicio con
 * sesion obligatoria; cada parte se filtra por el rol.
 */
export const inicioRouter = Router();

/**
 * GET /api/inicio/resumen?partes=sofi,cifras,cobros,rentabilidad,reparto: las
 * partes pedidas que el rol puede ver (sin partes, todas las suyas).
 */
inicioRouter.get("/resumen", async (req, res) => {
  const pedidas = String(req.query.partes ?? "")
    .split(",")
    .map((p) => p.trim())
    .filter((p): p is ParteResumen => (PARTES_RESUMEN as string[]).includes(p));
  res.json(await resumenInicio(rolDePeticion(req), pedidas.length ? pedidas : PARTES_RESUMEN));
});
