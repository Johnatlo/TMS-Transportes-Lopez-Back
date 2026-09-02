import "dotenv/config";

export const config = {
  port: Number(process.env.PORT ?? 3000),
  corsOrigin: process.env.CORS_ORIGIN ?? "http://localhost:4200",
  rndc: {
    wsdlUrl: process.env.RNDC_WSDL_URL ?? "",
    usuario: process.env.RNDC_USUARIO ?? "",
    password: process.env.RNDC_PASSWORD ?? "",
    empresaNit: process.env.RNDC_EMPRESA_NIT ?? "",
    simular: (process.env.RNDC_SIMULAR ?? "true").toLowerCase() === "true",
  },
};
