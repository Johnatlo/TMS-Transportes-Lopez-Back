/**
 * Borra viajes de PRUEBA: los simulados y los hechos contra el servidor de
 * pruebas del Ministerio. Nunca uno real.
 *
 * Con Docker (servidor):
 *   docker compose --env-file .env.production exec backend node dist/scripts/borrar-viaje.js --listar
 *   docker compose --env-file .env.production exec backend node dist/scripts/borrar-viaje.js 00006735
 *   docker compose --env-file .env.production exec backend node dist/scripts/borrar-viaje.js 00006735 --confirmar
 *
 * Sin Docker:  npm run borrar-viaje -- 00006735 [--confirmar]
 *
 * El viaje se busca por numero de manifiesto (00006735) o por id (#36 o 36).
 * Sin --confirmar solo muestra lo que borraria.
 *
 * Por que hace falta: el numero de un viaje de prueba queda como "usado" y el
 * despacho propone el siguiente; y sus radicados no existen en produccion, asi
 * que el viaje falla al imprimir. Borrarlo libera el numero.
 *
 * Por que se niega con los reales: si el viaje tiene un radicado de produccion,
 * su numero YA existe en el RNDC. Borrarlo aqui lo liberaria, el despacho lo
 * volveria a proponer y el RNDC lo rechazaria por repetido. Un viaje real que
 * sobra se ANULA (boton Anular en Viajes), no se borra.
 *
 * Como se distingue cada radicado:
 *   - "SIMULADO-..."      -> simulacion (nunca salio del servidor).
 *   - numero >= 900000000 -> ambiente de pruebas del Ministerio [Guia Uso del
 *                            Web Service V5, pag. 11: "la respuesta del
 *                            ambiente de pruebas es con un radicado mayor a
 *                            900,000,000"].
 *   - cualquier otro      -> PRODUCCION: no se borra.
 */
import { pool } from "../db";
import { config } from "../config";
import { viajes, viajeRemesas } from "../repo";
import type { Viaje, ViajeRemesa } from "../repo";
import { mayorConsecutivo, siguienteBase } from "../consecutivos";

const RADICADO_MINIMO_PRUEBAS = 900_000_000;

type Tipo = "simulado" | "pruebas" | "produccion";

/**
 * De donde sale un radicado: "SIMULADO-..." = simulado; un numero desde
 * RADICADO_MINIMO_PRUEBAS = ambiente de pruebas; cualquier otro = produccion
 * (real: ese viaje no se puede borrar).
 */
function tipoDeRadicado(radicado: string): Tipo {
  if (/^SIMULADO-/i.test(radicado)) return "simulado";
  const n = Number(radicado);
  if (Number.isFinite(n) && n >= RADICADO_MINIMO_PRUEBAS) return "pruebas";
  return "produccion";
}

/** Todos los radicados del viaje y de sus remesas, con de donde salen. */
function radicadosDe(v: Viaje, remesas: ViajeRemesa[]): Array<{ campo: string; valor: string; tipo: Tipo }> {
  const lista: Array<[string, string | null | undefined]> = [
    ["manifiesto", v.numeroManifiestoRndc],
    ["remesa (columna antigua del viaje)", v.numeroRemesaRndc],
    ["cumplido del manifiesto", v.radicadoCumplido],
    ["anulacion del manifiesto", v.radicadoAnulacion],
  ];
  for (const r of remesas) {
    lista.push([`remesa ${r.consecutivoRemesa}`, r.numeroRemesaRndc]);
    lista.push([`cumplido de la remesa ${r.consecutivoRemesa}`, r.radicadoCumplido]);
    lista.push([`anulacion de la remesa ${r.consecutivoRemesa}`, r.radicadoAnulacion]);
    lista.push([`anulacion del cumplido inicial ${r.consecutivoRemesa}`, r.radicadoAnulacionCumplido]);
  }
  return lista
    .filter(([, valor]) => valor !== null && valor !== undefined && String(valor).trim() !== "")
    .map(([campo, valor]) => ({ campo, valor: String(valor), tipo: tipoDeRadicado(String(valor)) }));
}

/**
 * Siguiente numero de manifiesto que propondria el despacho (para mostrar el
 * efecto de borrar un viaje de prueba).
 */
async function siguienteNumero(): Promise<string> {
  return siguienteBase(
    mayorConsecutivo(await viajes.ultimoConsecutivo(), config.consecutivos.ultimoExterno),
    config.consecutivos.longitud,
    config.consecutivos.prefijo
  );
}

/**
 * Busca el viaje por numero de manifiesto (como lo conoce la gente) o por id
 * ("#36" o "36"). null si no existe.
 */
async function buscar(texto: string): Promise<Viaje | null> {
  const limpio = texto.trim();
  // Primero por numero de manifiesto, que es como lo conoce la gente.
  const [filas] = await pool.query("SELECT id FROM viajes WHERE consecutivoManifiesto = ?", [limpio]);
  const porNumero = (filas as Array<{ id: number }>)[0];
  if (porNumero) return viajes.findById(porNumero.id);
  const id = /^#?\d+$/.test(limpio) ? Number(limpio.replace("#", "")) : NaN;
  return Number.isFinite(id) ? viajes.findById(id) : null;
}

/** Viajes que se pueden borrar: sin ningun radicado de produccion. */
async function listar() {
  const lista = await viajes.findMany(1000);
  const candidatos: string[] = [];
  for (const v of lista) {
    const rads = radicadosDe(v, await viajeRemesas.findByViaje(v.id));
    if (rads.some((r) => r.tipo === "produccion")) continue;
    const tipos = rads.length === 0 ? "sin radicados" : [...new Set(rads.map((r) => r.tipo))].join(" + ");
    candidatos.push(`  #${v.id}  ${v.consecutivoManifiesto ?? "(sin numero)"}  ${v.estado}  [${tipos}]`);
  }
  if (candidatos.length === 0) {
    console.log("No hay viajes de prueba: todos los viajes tienen radicados de produccion.");
  } else {
    console.log(`Viajes que se pueden borrar (${candidatos.length}):`);
    console.log(candidatos.join("\n"));
    console.log("\nPara ver el detalle de uno:  node dist/scripts/borrar-viaje.js <numero o #id>");
  }
}

/**
 * Punto de entrada: --listar muestra los viajes de prueba borrables; con un
 * numero o id muestra el viaje, sus remesas y radicados, y solo con
 * --confirmar lo borra. Se niega si tiene algun radicado de produccion.
 * Un viaje sin ningun radicado exige ademas --sin-radicado: no se sabe si su
 * numero llego al RNDC por otro lado (el portal).
 */
async function main() {
  const args = process.argv.slice(2);
  const confirmar = args.includes("--confirmar");
  const sinRadicado = args.includes("--sin-radicado");
  const objetivo = args.find((a) => !a.startsWith("--"));

  if (args.includes("--listar")) return listar();
  if (!objetivo) {
    console.log("Uso:");
    console.log("  node dist/scripts/borrar-viaje.js --listar                 viajes de prueba que se pueden borrar");
    console.log("  node dist/scripts/borrar-viaje.js <numero o #id>           muestra lo que se borraria");
    console.log("  node dist/scripts/borrar-viaje.js <numero o #id> --confirmar   lo borra");
    process.exitCode = 1;
    return;
  }

  const viaje = await buscar(objetivo);
  if (!viaje) {
    console.log(`No encontre ningun viaje con numero o id "${objetivo}".`);
    process.exitCode = 1;
    return;
  }
  const remesas = await viajeRemesas.findByViaje(viaje.id);
  const rads = radicadosDe(viaje, remesas);

  console.log(`Viaje #${viaje.id} - manifiesto ${viaje.consecutivoManifiesto ?? "(sin numero)"} - ${viaje.estado}`);
  console.log(`  Creado: ${viaje.fechaCreacion?.toISOString?.() ?? viaje.fechaCreacion}`);
  console.log(`  Remesas: ${remesas.map((r) => `${r.consecutivoRemesa} (${r.estado})`).join(", ") || "ninguna"}`);
  console.log(
    `  Radicados: ${rads.length ? rads.map((r) => `${r.campo} ${r.valor} [${r.tipo}]`).join("; ") : "ninguno"}`
  );

  const reales = rads.filter((r) => r.tipo === "produccion");
  if (reales.length > 0) {
    console.log("\nNO SE BORRA: este viaje tiene radicados de PRODUCCION:");
    for (const r of reales) console.log(`  - ${r.campo}: ${r.valor}`);
    console.log(
      "Su numero ya existe en el RNDC. Si sobra, anulalo desde Viajes (boton Anular); borrarlo\n" +
        "liberaria el numero y el proximo despacho lo repetiria."
    );
    process.exitCode = 2;
    return;
  }

  // Sin ningun radicado no se puede saber si el numero llego al RNDC por otro
  // lado (como la remesa 00006728, que ya existia porque se expidio en el
  // portal). Se permite, pero pidiendolo explicitamente.
  if (rads.length === 0 && !sinRadicado) {
    console.log(
      "\nEste viaje no tiene ningun radicado: no se sabe si su numero llego al RNDC por otro\n" +
        "lado (por ejemplo desde el portal). Si estas seguro de que es de prueba, agrega\n" +
        "--sin-radicado ademas de --confirmar."
    );
    process.exitCode = 2;
    return;
  }

  const antes = await siguienteNumero();
  if (!confirmar) {
    console.log(`\nSe borraria el viaje y sus ${remesas.length} remesa(s). Siguiente numero hoy: ${antes}.`);
    console.log("Para borrarlo de verdad, repite el comando con --confirmar.");
    return;
  }

  const conexion = await pool.getConnection();
  try {
    await conexion.beginTransaction();
    const [r1] = await conexion.query("DELETE FROM viaje_remesas WHERE viajeId = ?", [viaje.id]);
    const [r2] = await conexion.query("DELETE FROM viajes WHERE id = ?", [viaje.id]);
    await conexion.commit();
    const nRemesas = (r1 as { affectedRows: number }).affectedRows;
    const nViajes = (r2 as { affectedRows: number }).affectedRows;
    console.log(`\nBorrado: ${nViajes} viaje y ${nRemesas} remesa(s).`);
  } catch (err) {
    await conexion.rollback();
    throw err;
  } finally {
    conexion.release();
  }
  console.log(`Siguiente numero de despacho: antes ${antes}, ahora ${await siguienteNumero()}.`);
}

main()
  .catch((err) => {
    console.error("ERROR:", err?.sqlMessage ?? err?.message ?? err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
