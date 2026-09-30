/**
 * Prueba la configuracion de correo del .env.
 *
 *   npm run probar-correo                     (solo verifica conexion y clave)
 *   npm run probar-correo -- destino@x.com    (ademas envia un correo de prueba)
 */
import { correoConfigurado, enviarCorreo, verificarCorreo } from "../correo";

async function main() {
  const destino = process.argv[2];
  if (!correoConfigurado()) {
    console.log("Falta SMTP_USUARIO o SMTP_CLAVE en el .env.");
    process.exit(1);
  }
  process.stdout.write("Conectando con el servidor de correo... ");
  await verificarCorreo();
  console.log("OK: conexion y credenciales validas.");
  if (destino) {
    await enviarCorreo(
      destino,
      "Prueba de correo del sistema de despacho",
      "Si recibes este correo, el envio esta bien configurado.",
      "<p>Si recibes este correo, el envio esta bien configurado.</p>"
    );
    console.log(`Correo de prueba enviado a ${destino}.`);
  }
}

main().catch((e) => {
  console.error("\nFALLO:", e?.response ?? e?.message ?? e);
  console.error(
    "Si dice 'Username and Password not accepted' (535), SMTP_CLAVE debe ser una CONTRASENA DE APLICACION, " +
      "no la contrasena normal de Gmail: activa la verificacion en dos pasos y creala en " +
      "myaccount.google.com/apppasswords. Si es una cuenta de Google Workspace, el administrador debe " +
      "permitir las contrasenas de aplicacion."
  );
  process.exit(1);
});
