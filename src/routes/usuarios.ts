import { Router } from "express";
import { claveTemporal, emailValido, normalizarEmail, sesiones, usuarios } from "../auth";
import { correoClaveTemporal, correoConfigurado, enviarCorreo } from "../correo";

/**
 * Envia la clave temporal al correo del usuario. Si el correo no esta
 * configurado o falla, devuelve la clave para mostrarla en pantalla: nunca se
 * pierde la forma de entregarla.
 */
async function entregarClave(
  nombre: string,
  email: string,
  clave: string,
  motivo: "nueva" | "restablecida"
): Promise<{ enviadoPorCorreo: boolean; claveTemporal?: string; avisoCorreo?: string }> {
  if (!correoConfigurado()) return { enviadoPorCorreo: false, claveTemporal: clave };
  try {
    const c = correoClaveTemporal(nombre, email, clave, motivo);
    await enviarCorreo(email, c.asunto, c.texto, c.html);
    return { enviadoPorCorreo: true };
  } catch (exc) {
    console.error("No se pudo enviar la clave temporal:", (exc as Error).message);
    return {
      enviadoPorCorreo: false,
      claveTemporal: clave,
      avisoCorreo: "No se pudo enviar el correo; entregala manualmente.",
    };
  }
}

/**
 * Administracion de usuarios. Por ahora sin roles: cualquier usuario activo
 * puede crear, desactivar y restablecer cuentas.
 *
 * Las contrasenas temporales se generan aqui y se ENVIAN por correo al
 * usuario. Solo si el correo no esta configurado o falla, se devuelven en la
 * respuesta (una sola vez) para entregarlas a mano. El usuario debe cambiarla
 * en su primer ingreso.
 */
export const usuariosRouter = Router();

usuariosRouter.get("/", async (_req, res) => {
  res.json(await usuarios.listar());
});

usuariosRouter.post("/", async (req, res) => {
  const email = normalizarEmail(req.body?.email);
  const nombre = String(req.body?.nombre ?? "").trim();
  if (!emailValido(email)) return res.status(422).json({ error: "Escribe un email valido." });
  if (!nombre) return res.status(422).json({ error: "Escribe el nombre del usuario." });
  if (await usuarios.conClavePorEmail(email)) {
    return res.status(409).json({ error: "Ya existe un usuario con ese email." });
  }
  const temporal = claveTemporal();
  const creado = await usuarios.crear(email, nombre, temporal, true);
  res.status(201).json({ ...creado, ...(await entregarClave(nombre, email, temporal, "nueva")) });
});

usuariosRouter.put("/:id", async (req, res) => {
  const id = Number(req.params.id);
  const objetivo = await usuarios.porId(id);
  if (!objetivo) return res.status(404).json({ error: "Usuario no encontrado" });

  const datos: { nombre?: string; activo?: boolean } = {};
  if (req.body?.nombre !== undefined) {
    datos.nombre = String(req.body.nombre).trim();
    if (!datos.nombre) return res.status(422).json({ error: "El nombre no puede quedar vacio." });
  }
  if (req.body?.activo !== undefined) {
    datos.activo = !!req.body.activo;
    if (!datos.activo) {
      if (id === req.usuario!.id) {
        return res.status(422).json({ error: "No puedes desactivar tu propia cuenta." });
      }
      if (objetivo.activo && (await usuarios.contarActivos()) <= 1) {
        return res.status(422).json({ error: "Debe quedar al menos un usuario activo." });
      }
    }
  }
  await usuarios.actualizar(id, datos);
  // Un usuario desactivado pierde sus sesiones abiertas de inmediato.
  if (datos.activo === false) await sesiones.cerrarTodasDe(id);
  res.json(await usuarios.porId(id));
});

/** Genera una clave temporal nueva y cierra las sesiones de ese usuario. */
usuariosRouter.post("/:id/restablecer-clave", async (req, res) => {
  const id = Number(req.params.id);
  const objetivo = await usuarios.porId(id);
  if (!objetivo) return res.status(404).json({ error: "Usuario no encontrado" });
  const temporal = claveTemporal();
  await usuarios.cambiarClave(id, temporal, true);
  await sesiones.cerrarTodasDe(id);
  res.json(await entregarClave(objetivo.nombre, objetivo.email, temporal, "restablecida"));
});
