/**
 * Crea un usuario desde la terminal (sirve para el primero, cuando aun nadie
 * puede entrar a la pantalla de Usuarios).
 *
 *   npm run crear-usuario -- correo@empresa.com "Nombre Apellido"
 *
 * Genera una contrasena temporal, la muestra UNA vez y obliga a cambiarla en
 * el primer ingreso. Si el email ya existe, le restablece la clave.
 */
import { initSchema, pool } from "../db";
import { claveTemporal, emailValido, normalizarEmail, sesiones, usuarios } from "../auth";

/**
 * Punto de entrada: valida correo y nombre, crea el usuario con una clave
 * temporal (o, si ya existe, se la restablece, lo reactiva y cierra sus
 * sesiones) y muestra la clave una sola vez.
 */
async function main() {
  const email = normalizarEmail(process.argv[2]);
  const nombre = (process.argv[3] ?? "").trim();
  if (!emailValido(email) || !nombre) {
    console.log('Uso: npm run crear-usuario -- correo@empresa.com "Nombre Apellido"');
    process.exit(1);
  }
  await initSchema();
  const temporal = claveTemporal();
  const existente = await usuarios.conClavePorEmail(email);
  if (existente) {
    await usuarios.cambiarClave(existente.id, temporal, true);
    await usuarios.actualizar(existente.id, { activo: true });
    await sesiones.cerrarTodasDe(existente.id);
    console.log(`El usuario ${email} ya existia: se le restablecio la contrasena.`);
  } else {
    await usuarios.crear(email, nombre, temporal, true);
    console.log(`Usuario creado: ${nombre} <${email}>`);
  }
  console.log(`Contrasena temporal: ${temporal}`);
  console.log("Se pedira cambiarla en el primer ingreso. Esta es la unica vez que se muestra.");
  await pool.end();
}

main().catch(async (e) => {
  console.error(e);
  await pool.end();
  process.exit(1);
});
