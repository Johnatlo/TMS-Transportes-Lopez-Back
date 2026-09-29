/**
 * Carga el remolque y el conductor habituales de cada vehiculo a partir del
 * historial real de manifiestos de la empresa en el RNDC.
 *
 * Se corre con:  npm run habituales             (solo muestra, no guarda)
 *                npm run habituales -- --aplicar (guarda)
 *                npm run habituales -- --meses 6 (ventana; por defecto 6)
 *
 * Usa una consulta tipo 3 del proceso 4 (manifiestos), que es de SOLO LECTURA
 * [Guia Uso del Web Service V5, seccion 5]. El cliente va con soloConsultas,
 * asi que no puede enviar nada que cree documentos.
 *
 * Solo llena campos VACIOS del catalogo (placaRemolque y
 * cedulaConductorHabitual): no pisa lo que alguien ya configuro a mano. Y solo
 * si el remolque o el conductor existen en el catalogo local.
 */

import { config, describirAmbiente } from "../config";
import { RndcClient } from "../rndc/client";
import { vehiculos, remolques, conductores } from "../repo";
import { pool } from "../db";

const aplicar = process.argv.includes("--aplicar");
const iMeses = process.argv.indexOf("--meses");
const meses = iMeses > 0 ? Number(process.argv[iMeses + 1]) || 6 : 6;

function escapar(v: string): string {
  return v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function xmlConsultaMes(ini: string, fin: string): string {
  // Formato del ejemplo de la guia: NIT sin comillas, fechas 'AAAA/MM/DD'.
  return `<?xml version='1.0' encoding='ISO-8859-1' ?>
<root>
 <acceso>
  <username>${escapar(config.rndc.usuario)}</username>
  <password>${escapar(config.rndc.password)}</password>
 </acceso>
 <solicitud><tipo>3</tipo><procesoid>4</procesoid></solicitud>
 <variables>INGRESOID,FECHAING,NUMMANIFIESTOCARGA,NUMPLACA,NUMPLACAREMOLQUE,NUMIDCONDUCTOR</variables>
 <documento><NUMNITEMPRESATRANSPORTE>${escapar(config.rndc.empresaNit)}</NUMNITEMPRESATRANSPORTE></documento>
 <documentorango><iniFECHAING>'${ini}'</iniFECHAING><finFECHAING>'${fin}'</finFECHAING></documentorango>
</root>`;
}

const fechaRndc = (d: Date) =>
  `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}`;

interface Manifiesto {
  placa: string;
  remolque: string;
  conductor: string;
}

function leer(bloque: string, etiqueta: string): string {
  return (bloque.match(new RegExp(`<${etiqueta}>([^<]*)</${etiqueta}>`, "i"))?.[1] ?? "").trim().toUpperCase();
}

/** El valor mas frecuente y cuantas veces aparece. */
function masFrecuente(valores: string[]): { valor: string; veces: number } | null {
  const cuenta = new Map<string, number>();
  for (const v of valores) if (v) cuenta.set(v, (cuenta.get(v) ?? 0) + 1);
  let mejor: { valor: string; veces: number } | null = null;
  for (const [valor, veces] of cuenta) if (!mejor || veces > mejor.veces) mejor = { valor, veces };
  return mejor;
}

async function main() {
  console.log(describirAmbiente());
  console.log(`Ventana: ultimos ${meses} meses. Modo: ${aplicar ? "APLICAR (guarda)" : "solo mostrar"}\n`);

  const cliente = new RndcClient({
    wsdlUrl: config.rndc.wsdlUrl,
    usuario: config.rndc.usuario,
    password: config.rndc.password,
    simular: config.rndc.simular,
    soloConsultas: true,
  });

  // Mes por mes: una consulta de muchos meses puede ser pesada para el RNDC.
  const manifiestos: Manifiesto[] = [];
  const hoy = new Date();
  for (let m = meses - 1; m >= 0; m--) {
    const ini = new Date(hoy.getFullYear(), hoy.getMonth() - m, 1);
    const fin = m === 0 ? hoy : new Date(hoy.getFullYear(), hoy.getMonth() - m + 1, 0);
    const r = await cliente.enviar(xmlConsultaMes(fechaRndc(ini), fechaRndc(fin)), "4");
    const bloques = r.xmlRespuesta.split(/<documento>/i).slice(1);
    if (bloques.length === 0 && !r.ok) {
      console.log(`  ${fechaRndc(ini)}: sin datos (${(r.errorCrudo ?? "").replace(/\s+/g, " ").slice(0, 120)})`);
      continue;
    }
    for (const b of bloques) {
      manifiestos.push({
        placa: leer(b, "numplaca"),
        remolque: leer(b, "numplacaremolque"),
        conductor: leer(b, "numidconductor").replace(/\D/g, ""),
      });
    }
    console.log(`  ${fechaRndc(ini)} a ${fechaRndc(fin)}: ${bloques.length} manifiestos`);
  }
  console.log(`\nTotal: ${manifiestos.length} manifiestos.\n`);

  const [flota, trailers, personal] = await Promise.all([
    vehiculos.findMany(),
    remolques.findMany(),
    conductores.findMany(),
  ]);
  const placasRemolque = new Set(trailers.map((r) => r.placa.toUpperCase()));
  const cedulas = new Map(personal.map((c) => [c.cedula, c.nombre]));

  let llenarRemolque = 0;
  let llenarConductor = 0;
  let sinHistorial = 0;
  const filas: string[] = [];

  for (const v of flota.filter((x) => x.activo)) {
    const propios = manifiestos.filter((m) => m.placa === v.placa.toUpperCase());
    if (propios.length === 0) {
      sinHistorial++;
      continue;
    }
    const rem = masFrecuente(propios.map((m) => m.remolque));
    const con = masFrecuente(propios.map((m) => m.conductor));
    const cambios: Record<string, string> = {};

    let textoRem = "-";
    if (rem) {
      const existe = placasRemolque.has(rem.valor);
      textoRem = `${rem.valor} (${rem.veces}/${propios.length})${existe ? "" : " [no esta en el catalogo]"}`;
      if (existe && !v.placaRemolque) cambios.placaRemolque = rem.valor;
    }
    let textoCon = "-";
    if (con) {
      const nombre = cedulas.get(con.valor);
      textoCon = `${nombre ?? con.valor} (${con.veces}/${propios.length})${nombre ? "" : " [no esta en el catalogo]"}`;
      if (nombre && !v.cedulaConductorHabitual) cambios.cedulaConductorHabitual = con.valor;
    }

    if (cambios.placaRemolque) llenarRemolque++;
    if (cambios.cedulaConductorHabitual) llenarConductor++;
    filas.push(
      `${v.placa.padEnd(8)} ${String(propios.length).padStart(4)} viajes | remolque ${textoRem.padEnd(34)} | conductor ${textoCon}` +
        (Object.keys(cambios).length === 0 ? "   (sin cambios)" : "")
    );
    if (aplicar && Object.keys(cambios).length > 0) await vehiculos.update(v.id, cambios);
  }

  filas.sort().forEach((f) => console.log(f));
  console.log(
    `\nVehiculos activos sin manifiestos en la ventana: ${sinHistorial}.` +
      `\n${aplicar ? "Se llenaron" : "Se llenarian"}: ${llenarRemolque} remolques habituales y ${llenarConductor} conductores habituales` +
      ` (solo campos vacios).`
  );
  if (!aplicar) console.log("Para guardar:  npm run habituales -- --aplicar");
  await pool.end();
}

main().catch(async (err) => {
  console.error("Error:", err);
  await pool.end();
  process.exit(1);
});
