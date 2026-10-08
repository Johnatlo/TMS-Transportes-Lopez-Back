/**
 * Respaldo de la base de datos: un volcado comprimido (.sql.gz) por corrida.
 *
 * Uso:  npm run respaldo
 *
 * Pensado para correr una vez al dia con el Programador de tareas de Windows
 * (ver docs/DESPLIEGUE.md). Guarda en RESPALDO_DIR (por defecto ../respaldos,
 * fuera del repo) y borra los respaldos con mas de RESPALDO_DIAS dias
 * (30 por defecto).
 *
 * La contrasena de la base va por la variable MYSQL_PWD y no en la linea de
 * comandos, donde cualquiera que liste los procesos la veria.
 *
 * Para restaurar:  descomprimir el .gz y luego
 *   mysql -u root -p rndc_tms < rndc_tms-AAAA-MM-DD_HHMM.sql
 */
import "dotenv/config";
import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import zlib from "zlib";
import { pipeline } from "stream/promises";

const DB = process.env.DB_NAME ?? "rndc_tms";
const DIAS = Number(process.env.RESPALDO_DIAS ?? 30);
const DIR = path.resolve(process.env.RESPALDO_DIR || path.join(__dirname, "../../../respaldos"));

/** mysqldump del PATH, o el de XAMPP si no esta en el PATH. */
function rutaMysqldump(): string {
  if (process.env.MYSQLDUMP) return process.env.MYSQLDUMP;
  const xampp = "C:\\xampp\\mysql\\bin\\mysqldump.exe";
  return fs.existsSync(xampp) ? xampp : "mysqldump";
}

/** "AAAA-MM-DD_HHMM" de la fecha, para el nombre del archivo de respaldo. */
function marcaDeTiempo(d = new Date()): string {
  const dos = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${dos(d.getMonth() + 1)}-${dos(d.getDate())}_${dos(d.getHours())}${dos(d.getMinutes())}`;
}

/**
 * Punto de entrada: corre mysqldump (copia consistente sin bloquear tablas),
 * lo comprime en .sql.gz (primero como .parcial y luego lo renombra) y borra
 * los respaldos mas viejos que RESPALDO_DIAS.
 */
async function main() {
  fs.mkdirSync(DIR, { recursive: true });
  const destino = path.join(DIR, `${DB}-${marcaDeTiempo()}.sql.gz`);
  const temporal = `${destino}.parcial`;

  const volcado = spawn(
    rutaMysqldump(),
    [
      `--host=${process.env.DB_HOST ?? "localhost"}`,
      `--port=${process.env.DB_PORT ?? 3306}`,
      `--user=${process.env.DB_USER ?? "root"}`,
      // Copia consistente sin bloquear las tablas: el despacho sigue funcionando.
      "--single-transaction",
      "--routines",
      "--triggers",
      "--default-character-set=utf8mb4",
      DB,
    ],
    { env: { ...process.env, MYSQL_PWD: process.env.DB_PASSWORD ?? "" } }
  );

  let errores = "";
  volcado.stderr.on("data", (d) => (errores += d));
  const termino = new Promise<number>((ok, falla) => {
    volcado.on("error", falla);
    volcado.on("close", (codigo) => ok(codigo ?? 1));
  });

  // Se escribe a un archivo ".parcial" y solo se renombra si todo salio bien:
  // asi nunca queda un respaldo cortado con cara de respaldo bueno.
  await pipeline(volcado.stdout, zlib.createGzip(), fs.createWriteStream(temporal));
  const codigo = await termino;
  if (codigo !== 0) {
    fs.rmSync(temporal, { force: true });
    throw new Error(`mysqldump termino con codigo ${codigo}: ${errores.trim()}`);
  }
  fs.renameSync(temporal, destino);
  const kb = Math.round(fs.statSync(destino).size / 1024);
  console.log(`Respaldo listo: ${destino} (${kb} KB)`);

  // Limpieza de respaldos viejos (solo los de esta base).
  const limite = Date.now() - DIAS * 24 * 60 * 60 * 1000;
  for (const archivo of fs.readdirSync(DIR)) {
    if (!archivo.startsWith(`${DB}-`) || !archivo.endsWith(".sql.gz")) continue;
    const ruta = path.join(DIR, archivo);
    if (fs.statSync(ruta).mtimeMs < limite) {
      fs.rmSync(ruta);
      console.log(`Borrado por antiguo: ${archivo}`);
    }
  }
}

main().catch((err) => {
  console.error("FALLO EL RESPALDO:", err.message ?? err);
  process.exit(1);
});
