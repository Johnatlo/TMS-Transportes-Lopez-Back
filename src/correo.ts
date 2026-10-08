/**
 * Envio de correos por SMTP (cuenta de Gmail / Google Workspace).
 *
 * Se configura en el .env:
 *   SMTP_HOST=smtp.gmail.com
 *   SMTP_PUERTO=465
 *   SMTP_USUARIO=cuenta@gmail.com
 *   SMTP_CLAVE=<contrasena de aplicacion de 16 letras>
 *   SMTP_REMITENTE="Transportes Lopez <cuenta@gmail.com>"   (opcional)
 *
 * Gmail no acepta la contrasena normal de la cuenta por SMTP: hay que activar
 * la verificacion en dos pasos y crear una "contrasena de aplicacion"
 * (myaccount.google.com/apppasswords). El puerto 465 usa TLS directo.
 * Otro proveedor (Office 365, hosting) funciona cambiando host y puerto.
 *
 * Si no esta configurado, correoConfigurado() es false y quien lo usa debe
 * tener un plan B (por ejemplo, mostrar la clave temporal en pantalla).
 */
import nodemailer from "nodemailer";
import type { Transporter } from "nodemailer";
import { config } from "./config";

const host = process.env.SMTP_HOST || "smtp.gmail.com";
const puerto = Number(process.env.SMTP_PUERTO || 465);
// Google la muestra en grupos de 4 ("abcd efgh ijkl mnop"): los espacios sobran.
const esGmail = host.includes("gmail");
const usuario = process.env.SMTP_USUARIO || "";
const clave = esGmail ? (process.env.SMTP_CLAVE || "").replace(/\s+/g, "") : process.env.SMTP_CLAVE || "";
const remitente = process.env.SMTP_REMITENTE || (usuario ? `${config.empresa.nombre} <${usuario}>` : "");

let transporte: Transporter | null = null;

/**
 * true si hay usuario y clave SMTP en el .env. Si es false, quien envia
 * correos debe tener un plan B (mostrar la clave temporal en pantalla).
 */
export function correoConfigurado(): boolean {
  return !!(usuario && clave);
}

/**
 * Conexion SMTP de nodemailer, creada una sola vez y reutilizada. Puerto 465
 * = TLS directo (Gmail); cualquier otro exige STARTTLS.
 */
function obtenerTransporte(): Transporter {
  if (!transporte) {
    transporte = nodemailer.createTransport({
      host,
      port: puerto,
      // 465 = TLS directo (el recomendado para Gmail); 587 = STARTTLS.
      secure: puerto === 465,
      requireTLS: puerto !== 465,
      auth: { user: usuario, pass: clave },
    });
  }
  return transporte;
}

/**
 * Envia un correo en texto y HTML desde el remitente configurado. Lanza error
 * si el correo no esta configurado o el servidor lo rechaza.
 */
export async function enviarCorreo(para: string, asunto: string, texto: string, html: string): Promise<void> {
  if (!correoConfigurado()) throw new Error("El envio de correo no esta configurado (SMTP_USUARIO / SMTP_CLAVE).");
  await obtenerTransporte().sendMail({ from: remitente, to: para, subject: asunto, text: texto, html });
}

/** Verifica conexion y credenciales sin enviar nada. */
export async function verificarCorreo(): Promise<void> {
  if (!correoConfigurado()) throw new Error("Falta SMTP_USUARIO o SMTP_CLAVE en el .env.");
  await obtenerTransporte().verify();
}

// ---------------------------------------------------------------------------
// Plantillas
// ---------------------------------------------------------------------------

/** Escapa &, <, > y comillas para meter texto en el HTML del correo. */
const escapar = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * Plantilla HTML comun de los correos: tarjeta blanca con el nombre de la
 * empresa, el titulo, el cuerpo y el pie de "correo automatico".
 */
function envoltura(titulo: string, cuerpo: string): string {
  return `<!DOCTYPE html><html><body style="margin:0;background:#f4f6fa;font-family:Arial,Helvetica,sans-serif;color:#111827">
<div style="max-width:520px;margin:24px auto;background:#ffffff;border:1px solid #e8ebf1;border-radius:14px;padding:28px">
<div style="font-weight:bold;font-size:15px;margin-bottom:18px">${escapar(config.empresa.nombre)}</div>
<h1 style="font-size:19px;margin:0 0 14px">${escapar(titulo)}</h1>
${cuerpo}
<p style="font-size:12px;color:#6b7280;margin-top:26px">Correo automatico del sistema de despacho. No respondas a este mensaje.</p>
</div></body></html>`;
}

/** Recuadro destacado para un codigo o clave temporal dentro del correo. */
const bloqueCodigo = (codigo: string) =>
  `<div style="font-size:26px;letter-spacing:4px;font-weight:bold;background:#f3f5f9;border:1px dashed #c9d1de;border-radius:10px;padding:12px 16px;display:inline-block;margin:6px 0 14px">${escapar(codigo)}</div>`;

/**
 * Correo con usuario y clave temporal, para una cuenta nueva o una clave
 * restablecida. Devuelve asunto, texto plano y HTML.
 */
export function correoClaveTemporal(nombre: string, email: string, claveTemp: string, motivo: "nueva" | "restablecida") {
  const asunto = motivo === "nueva" ? "Tu cuenta en el sistema de despacho" : "Tu contrasena fue restablecida";
  const intro =
    motivo === "nueva"
      ? `Hola ${nombre}, se creo tu cuenta en el sistema de despacho de ${config.empresa.nombre}.`
      : `Hola ${nombre}, se restablecio tu contrasena del sistema de despacho.`;
  const texto = `${intro}\n\nUsuario: ${email}\nContrasena temporal: ${claveTemp}\n\nAl entrar, el sistema te pedira crear una contrasena propia.`;
  const html = envoltura(
    asunto,
    `<p>${escapar(intro)}</p><p>Usuario: <strong>${escapar(email)}</strong><br>Contrasena temporal:</p>${bloqueCodigo(claveTemp)}<p>Al entrar, el sistema te pedira crear una contrasena propia.</p>`
  );
  return { asunto, texto, html };
}

/**
 * Correo con el codigo de 6 digitos para recuperar la contrasena y los
 * minutos de vigencia. Devuelve asunto, texto plano y HTML.
 */
export function correoCodigoRecuperacion(nombre: string, codigo: string, minutos: number) {
  const asunto = "Codigo para recuperar tu contrasena";
  const texto = `Hola ${nombre}, tu codigo para crear una contrasena nueva es: ${codigo}\n\nVence en ${minutos} minutos. Si no lo pediste, ignora este correo: tu contrasena no cambia.`;
  const html = envoltura(
    asunto,
    `<p>Hola ${escapar(nombre)}, tu codigo para crear una contrasena nueva es:</p>${bloqueCodigo(codigo)}<p>Vence en ${minutos} minutos. Si no lo pediste, ignora este correo: tu contrasena no cambia.</p>`
  );
  return { asunto, texto, html };
}
