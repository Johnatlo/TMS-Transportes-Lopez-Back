import { Router } from "express";
import {
  borrarCookie,
  exigirSesion,
  leerToken,
  limpiarFallos,
  minutosBloqueado,
  normalizarEmail,
  ponerCookie,
  problemaConClave,
  registrarFallo,
  sesiones,
  usuarios,
  verificarClave,
  recuperaciones,
  MINUTOS_CODIGO,
} from "../auth";
import { correoCodigoRecuperacion, correoConfigurado, enviarCorreo } from "../correo";

export const authRouter = Router();

/**
 * Inicio de sesion con email y contrasena. El mensaje de error es el mismo
 * para email inexistente y clave errada: no revela que correos tienen cuenta.
 */
authRouter.post("/login", async (req, res) => {
  const email = normalizarEmail(req.body?.email);
  const clave = String(req.body?.clave ?? "");
  const claveIntentos = `${email}|${req.ip}`;

  const bloqueo = minutosBloqueado(claveIntentos);
  if (bloqueo > 0) {
    return res.status(429).json({
      error: `Demasiados intentos fallidos. Espera ${bloqueo} minuto(s) e intenta de nuevo.`,
    });
  }

  const usuario = email ? await usuarios.conClavePorEmail(email) : null;
  const valido = !!usuario && usuario.activo && (await verificarClave(clave, usuario.claveHash));
  if (!valido || !usuario) {
    registrarFallo(claveIntentos);
    return res.status(401).json({ error: "Email o contrasena incorrectos." });
  }

  limpiarFallos(claveIntentos);
  await sesiones.limpiarVencidas();
  const token = await sesiones.crear(usuario.id);
  ponerCookie(res, token, req);
  const { claveHash: _omitida, ...publico } = usuario;
  res.json(publico);
});

authRouter.post("/logout", async (req, res) => {
  const token = leerToken(req);
  if (token) await sesiones.cerrar(token);
  borrarCookie(res);
  res.status(204).send();
});

/** Quien soy: lo usa el frontend al abrir para saber si hay sesion. */
authRouter.get("/sesion", exigirSesion, (req, res) => {
  res.json(req.usuario);
});

/** Cambiar la propia contrasena (obligatorio tras una clave temporal). */
authRouter.post("/cambiar-clave", exigirSesion, async (req, res) => {
  const actual = String(req.body?.actual ?? "");
  const nueva = String(req.body?.nueva ?? "");
  const usuario = await usuarios.conClavePorEmail(req.usuario!.email);
  if (!usuario || !(await verificarClave(actual, usuario.claveHash))) {
    return res.status(422).json({ error: "La contrasena actual no es correcta." });
  }
  const problema = problemaConClave(nueva);
  if (problema) return res.status(422).json({ error: problema });
  if (nueva === actual) return res.status(422).json({ error: "La nueva contrasena debe ser distinta a la actual." });

  await usuarios.cambiarClave(usuario.id, nueva, false);
  // Las demas sesiones de este usuario se cierran; esta sigue abierta.
  await sesiones.cerrarTodasDe(usuario.id, leerToken(req) ?? undefined);
  res.json(await usuarios.porId(usuario.id));
});

// ---------------------------------------------------------------------------
// Recuperar contrasena ("olvide mi contrasena")
// ---------------------------------------------------------------------------

/**
 * Paso 1: pedir un codigo. La respuesta es la MISMA exista o no el correo: no
 * revela que cuentas existen. Tras 5 pedidos seguidos para el mismo correo,
 * se bloquea un rato.
 */
authRouter.post("/recuperar", async (req, res) => {
  if (!correoConfigurado()) {
    return res.status(503).json({
      error: "La recuperacion por correo no esta disponible. Pide a otro usuario que restablezca tu contrasena.",
    });
  }
  const email = normalizarEmail(req.body?.email);
  const clave = `recuperar|${email}`;
  const bloqueo = minutosBloqueado(clave);
  if (bloqueo > 0) {
    return res.status(429).json({ error: `Ya pediste varios codigos. Espera ${bloqueo} minuto(s).` });
  }
  // Cuenta como "intento" cada pedido: 5 seguidos bloquean un rato.
  registrarFallo(clave);

  const usuario = email ? await usuarios.conClavePorEmail(email) : null;
  if (usuario?.activo) {
    const codigo = await recuperaciones.crear(usuario.id);
    const c = correoCodigoRecuperacion(usuario.nombre, codigo, MINUTOS_CODIGO);
    try {
      await enviarCorreo(usuario.email, c.asunto, c.texto, c.html);
    } catch (exc) {
      console.error("No se pudo enviar el codigo de recuperacion:", (exc as Error).message);
      return res.status(502).json({ error: "No se pudo enviar el correo. Intenta mas tarde o pide ayuda a otro usuario." });
    }
  }
  res.json({ ok: true, minutos: MINUTOS_CODIGO });
});

/** Paso 2: con el codigo recibido, crear la contrasena nueva. */
authRouter.post("/recuperar/confirmar", async (req, res) => {
  const email = normalizarEmail(req.body?.email);
  const codigo = String(req.body?.codigo ?? "");
  const nueva = String(req.body?.nueva ?? "");
  const invalido = () => res.status(422).json({ error: "El codigo no es valido o ya vencio. Pide uno nuevo." });

  const usuario = email ? await usuarios.conClavePorEmail(email) : null;
  if (!usuario || !usuario.activo) return invalido();
  if (!(await recuperaciones.verificar(usuario.id, codigo))) return invalido();

  const problema = problemaConClave(nueva);
  if (problema) return res.status(422).json({ error: problema });

  await usuarios.cambiarClave(usuario.id, nueva, false);
  await recuperaciones.borrarDe(usuario.id);
  await sesiones.cerrarTodasDe(usuario.id);
  limpiarFallos(`recuperar|${email}`);
  res.json({ ok: true });
});
