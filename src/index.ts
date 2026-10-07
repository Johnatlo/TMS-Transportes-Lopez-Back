import express from "express";
// Hace que las excepciones de los handlers async lleguen al manejador de
// errores de Express 4 en vez de quedar como promesa rechazada y tumbar el
// proceso. Debe importarse antes de definir las rutas.
import "express-async-errors";
import cors from "cors";
import fs from "fs";
import path from "path";
import { config, describirAmbiente } from "./config";
import { initSchema } from "./db";
import { catalogoRouter } from "./routes/catalogo";
import { despachoRouter } from "./routes/despacho";
import { authRouter } from "./routes/auth";
import { usuariosRouter } from "./routes/usuarios";
import { cuadroRouter } from "./routes/cuadro";
import { exigirSesion } from "./auth";

async function main() {
  await initSchema();

  const app = express();

  // Detras de un proxy con HTTPS (IIS, nginx, Caddy, un tunel), Express ve la
  // conexion interna como http y la cookie de sesion no se marcaria "Secure".
  // TRUST_PROXY=1 le dice que confie en el encabezado X-Forwarded-Proto.
  if (process.env.TRUST_PROXY) app.set("trust proxy", Number(process.env.TRUST_PROXY) || process.env.TRUST_PROXY);

  // credentials: la sesion viaja en una cookie.
  app.use(cors({ origin: config.corsOrigin, credentials: true }));
  app.use(express.json());

  app.get("/api/health", (_req, res) => {
    res.json({
      ok: true,
      rndcSimulado: config.rndc.simular,
      ambiente: config.rndc.nombreAmbiente,
    });
  });

  // Login, logout y "quien soy": abiertos (cada ruta decide si pide sesion).
  app.use("/api/auth", authRouter);
  // Todo lo demas exige una sesion valida.
  app.use("/api/catalogo", exigirSesion, catalogoRouter);
  app.use("/api/despacho", exigirSesion, despachoRouter);
  app.use("/api/usuarios", exigirSesion, usuariosRouter);
  app.use("/api/cuadro", exigirSesion, cuadroRouter);

  /**
   * Frontend compilado (despliegue).
   *
   * En produccion el mismo backend sirve la pagina: una sola direccion y un
   * solo proceso, sin el servidor de desarrollo de Vite y sin CORS de por
   * medio (la cookie de sesion va al mismo origen). Basta con correr
   * `npm run build` en frontend-react; si la carpeta no existe (desarrollo),
   * esto no hace nada y se sigue usando Vite.
   *
   * Las rutas del frontend (/despacho, /historial...) las resuelve React en
   * el navegador, asi que a cualquier GET que no sea /api se le entrega el
   * index.html.
   */
  const dirFrontend = path.resolve(process.env.FRONTEND_DIST || path.join(__dirname, "../../frontend-react/dist"));
  if (fs.existsSync(path.join(dirFrontend, "index.html"))) {
    app.use(express.static(dirFrontend, { index: false, maxAge: "1h" }));
    app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(path.join(dirFrontend, "index.html")));
    console.log(`Sirviendo el frontend compilado desde ${dirFrontend}`);
  }

  /**
   * Captura de errores.
   *
   * Express 4 no atrapa las excepciones que ocurren dentro de un handler
   * async: quedan como promesa rechazada y, en Node moderno, tumban el
   * proceso. El sintoma desde el navegador es un ECONNRESET del proxy, sin
   * ninguna pista de que fallo.
   *
   * Con esto, un error de SQL o de red devuelve un 500 explicable y el
   * servidor sigue arriba.
   */
  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    // Numero repetido: lo rechazo un indice unico (uk_viaje_consecutivo o
    // uk_consecutivo). Es un caso esperable, no una falla del servidor.
    if (err?.code === "ER_DUP_ENTRY" && /consecutivo/i.test(err?.sqlMessage ?? "")) {
      return res.status(409).json({
        error:
          "Ese numero de manifiesto o remesa ya esta usado por otro viaje. Recarga la pantalla " +
          "para tomar el siguiente numero libre, o escribe otro.",
      });
    }
    console.error("Error no controlado:", err);
    res.status(500).json({
      error: "Error interno del servidor",
      // El detalle se expone porque esto corre en la red de la empresa, no en
      // internet, y sin el diagnosticar a distancia es adivinar.
      detalle: err?.sqlMessage ?? err?.message ?? String(err),
    });
  });

  // Ultima red de seguridad: si algo se escapa igual, queda registrado con su
  // causa en vez de morir en silencio.
  process.on("unhandledRejection", (motivo) => {
    console.error("Promesa rechazada sin capturar:", motivo);
  });

  app.listen(config.port, () => {
    console.log(`Backend RNDC escuchando en http://localhost:${config.port}`);
    console.log(describirAmbiente());
  });
}

main().catch((err) => {
  console.error("Error fatal al arrancar el backend:", err);
  process.exit(1);
});
