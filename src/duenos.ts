/**
 * Duenos de los vehiculos, para separar la cartera por socio (filtro de
 * Cartera). Cada vehiculo tiene su dueno en vehiculos.dueno; NULL = tercero.
 */

/** Socios que tienen vehiculos propios. Los demas vehiculos son de terceros. */
export const DUENOS = ["MAURICIO", "CELSO", "MILLER", "LUISA"] as const;
export type Dueno = (typeof DUENOS)[number];
/** Grupo de un vehiculo en la cartera: un socio o los terceros. */
export type GrupoDueno = Dueno | "TERCEROS";
export const GRUPOS_DUENO: GrupoDueno[] = [...DUENOS, "TERCEROS"];

/** Grupo del vehiculo a partir de su dueno (vacio o desconocido = terceros). */
export const grupoDe = (dueno: string | null | undefined): GrupoDueno =>
  (DUENOS as readonly string[]).includes(String(dueno ?? "").toUpperCase()) ? (String(dueno).toUpperCase() as Dueno) : "TERCEROS";

/**
 * Placas de cada socio con que arranca el campo dueno (sin guion). Salen de
 * los totales del Excel "Cartera Total": CELSO = TLN-860, TEK-298, SZX-826 y
 * ZAP-745; MILLER = SZP-339 y SKX-202; LUISA = XGJ-197; MAURICIO = las
 * columnas antes de las de Celso. Despues se ajustan en Flota.
 */
export const PLACAS_POR_DUENO: Record<Dueno, string[]> = {
  MAURICIO: ["SWO594", "SRO029", "XJB207", "SPI982", "SZX880", "JTY221", "JTY219"],
  CELSO: ["TLN860", "TEK298", "SZX826", "ZAP745"],
  MILLER: ["SZP339", "SKX202"],
  LUISA: ["XGJ197"],
};
