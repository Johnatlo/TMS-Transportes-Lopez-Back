import express from "express";
// Hace que las excepciones de los handlers async lleguen al manejador de
// errores de Express 4 en vez de quedar como promesa rechazada y tumbar el
// proceso. Debe importarse antes de definir las rutas.
import "express-async-errors";
import cors from "cors";
import { config, describirAmbiente } from "./config";
import { initSchema } from "./db";
import { catalogoRouter } from "./routes/catalogo";
import { despachoRouter } from "./routes/despacho";

async function main() {
  await initSchema();

  const app = express();

  app.use(cors({ origin: config.corsOrigin }));
  app.use(express.json());

  app.get("/api/health", (_req, res) => {
    res.json({
      ok: true,
      rndcSimulado: config.rndc.simular,
      ambiente: config.rndc.nombreAmbiente,
    });
  });

  app.use("/api/catalogo", catalogoRouter);
  app.use("/api/despacho", despachoRouter);

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
