/**
 * Cliente para consumir el Web Service SOAP del RNDC.
 *
 * El metodo documentado es 'AtenderMensajeRNDC', que recibe el XML armado en
 * rndc/builders.ts como un unico parametro de texto.
 *
 * Antes de produccion:
 * 1. Descarga y revisa el WSDL vigente.
 * 2. Verifica que el nombre del metodo y sus parametros coincidan con el WSDL real.
 * 3. Prueba primero con RNDC_SIMULAR=true para validar que el XML se arma bien.
 */

export class RndcError extends Error {}

export interface ResultadoRndc {
  ok: boolean;
  radicado: string | null;
  mec: string | null;
  qr: string | null;
  error: string | null;
  xmlRespuesta: string;
}

export interface RndcClientConfig {
  wsdlUrl: string;
  usuario: string;
  password: string;
  simular: boolean;
}

export class RndcClient {
  constructor(private config: RndcClientConfig) {}

  async enviar(xmlMensaje: string): Promise<ResultadoRndc> {
    if (this.config.simular) {
      return {
        ok: true,
        radicado: `SIMULADO-${Math.floor(Math.random() * 100000)}`,
        mec: null,
        qr: null,
        error: null,
        xmlRespuesta: `[SIMULACION] Se habria enviado este XML:\n${xmlMensaje}`,
      };
    }

    try {
      // Import perezoso: la libreria 'soap' solo se necesita en modo real.
      const soap = await import("soap");
      const client = await soap.createClientAsync(this.config.wsdlUrl);
      const [result] = await client.AtenderMensajeRNDCAsync({ variables: xmlMensaje });
      const respuestaXml: string = result?.AtenderMensajeRNDCResult ?? "";
      return this.parsearRespuesta(respuestaXml);
    } catch (exc) {
      throw new RndcError(`Fallo de comunicacion con el RNDC: ${(exc as Error).message}`);
    }
  }

  private parsearRespuesta(xml: string): ResultadoRndc {
    const buscar = (tagName: string): string | null => {
      const match = xml.match(new RegExp(`<${tagName}>(.*?)</${tagName}>`, "i"));
      return match ? match[1] : null;
    };

    const error = buscar("ErrorMSG") ?? buscar("error");
    return {
      ok: error === null,
      radicado: buscar("ingresoid"),
      mec: buscar("MEC") ?? buscar("mec"),
      qr: buscar("seguridadqr"),
      error,
      xmlRespuesta: xml,
    };
  }
}
