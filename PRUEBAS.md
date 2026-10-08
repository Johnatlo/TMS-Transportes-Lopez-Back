# Pruebas unitarias — Backend

Pruebas automáticas de la lógica de negocio del TMS: cálculos del RNDC, pisos de
SICETAC, fechas en hora de Colombia y estados del Cuadro pagos.

Se hacen con **[Vitest](https://vitest.dev)**. No necesitan base de datos, ni
conexión al RNDC, ni el servidor encendido: prueban funciones puras, así que
corren en menos de un segundo.

---

## 1. Cómo correrlas

```bash
cd backend
npm test             # corre todas las pruebas una vez
npm run test:watch   # las vuelve a correr cada vez que guardas un archivo
npm run test:tipos   # revisa los tipos de TypeScript, incluidas las pruebas
```

Resultado esperado:

```
 ✓ src/fechas.test.ts          (5 tests)
 ✓ src/cuadro.test.ts          (13 tests)
 ✓ src/rndc/builders.test.ts   (32 tests)
 ✓ src/rndc/sicetac.test.ts    (16 tests)
 Test Files  4 passed (4)
      Tests  66 passed (66)
```

Si una prueba falla, Vitest muestra el nombre de la prueba, el valor esperado y
el que obtuvo. **Una prueba que falla significa que se rompió una regla de
negocio**; no se "arregla" cambiando el valor esperado sin entender por qué.

**Cuándo correrlas:** antes de cada commit que toque `src/rndc/`, `src/fechas.ts`
o `src/cuadro.ts`, y antes de desplegar.

---

## 2. Dónde están

Cada archivo de pruebas va junto al código que prueba, con el mismo nombre y
terminación `.test.ts`:

| Archivo de pruebas | Prueba | Pruebas |
|---|---|---|
| `src/fechas.test.ts` | `src/fechas.ts` | 5 |
| `src/rndc/builders.test.ts` | `src/rndc/builders.ts` | 32 |
| `src/rndc/sicetac.test.ts` | `src/rndc/sicetac.ts` | 16 |
| `src/cuadro.test.ts` | `src/cuadro.ts` | 13 |

Los `.test.ts` están excluidos del build de producción (`tsconfig.json`), así
que no llegan a `dist` ni a la imagen de Docker. `tsconfig.test.json` existe solo
para revisar sus tipos con `npm run test:tipos`.

---

## 3. Qué cubre cada archivo

### 3.1 `fechas.test.ts` — Horas escritas en el formulario

| Regla | Por qué importa |
|---|---|
| Una hora sin zona (`2026-10-01T11:30`) es hora de Colombia (UTC-5). | Bug real en producción: el servidor corre en UTC y una cita de las **11:30 llegaba al RNDC como 06:30**. |
| Acepta segundos y milisegundos. | El navegador a veces los envía. |
| Si la fecha ya trae zona (`Z` o `-05:00`), se respeta. | Fechas que vienen del propio backend. |
| Un texto inválido da una fecha inválida. | La valida quien la usa (por ejemplo, el cumplido). |

### 3.2 `rndc/builders.test.ts` — Documentos y valores del RNDC

**Fechas para el RNDC**

| Regla | Fuente |
|---|---|
| `formatearFecha` y `formatearHora` usan la hora de Colombia (22:00 del 30/09, no 03:00 del 01/10). | El RNDC exige DD/MM/AAAA y HH:MM [REM pág. 13]. |
| Una columna DATE no se corre un día al formatearla. | Bug real: el 30 salía como 29. |
| Días hábiles: no cuenta sábados ni domingos. | Plazo de 5 días hábiles para cumplir [Guía de Manifiesto V7, pág. 6]. |
| Plazo del cumplido: cuánto queda y cuándo vence; una entrega futura no consume plazo. | Ídem. |

**Retenciones y valores**

| Regla | Caso de prueba |
|---|---|
| Base de retenciones = valor a pagar − trayectos en vacío (nunca negativa). | [MAN pág. 15] |
| Retención en la fuente: 1 % en pesos enteros; 0 si el titular es régimen simple. | Manifiesto 00006765: 4.560.283 → 45.603. |
| FOPAT: 0,1 % redondeado al peso; no se envía si el vehículo no lo causa. | Manifiesto 00006775: 4.019.761 → 4.020. |
| Neto a pagar = valor − las tres retenciones. | [Manual RNDC 5.2.4] |
| Valor final del cumplido = flete + adicionales − descuento. | 00006775: 4.019.761 + 578.000 = 4.597.761 (aceptado por el RNDC). |

**XML del cumplido del manifiesto (proceso 6)**

| Regla | Por qué importa |
|---|---|
| Lleva tipo `C`, fecha de entrega de documentos, retenciones y la vía (`CODVIA`). | Sin fecha de entrega el RNDC responde CMA140. |
| Los ceros y textos vacíos no se envían. | Así se verificó en el ambiente de pruebas del RNDC (radicado 900000917). |
| El motivo solo va si hay valor adicional o descuento. | El motivo explica ese valor; sin valor no tiene sentido enviarlo. |
| Sin FOPAT, la etiqueta no se envía. | Enviarlo cuando no aplica es un error. |

**Validación del cumplido de remesa (proceso 5)**

| Regla | Fuente |
|---|---|
| Kilos entregados > 0, al menos el 10 % y como máximo el doble de lo cargado. | [Manual RNDC 2026, 5.3.4 f] |
| Las fechas de entrada no pueden ser futuras. | [Guía Cumplido 2.5] |
| La entrada al descargue va después de la del cargue. | Ídem. |

**Otras utilidades**

| Regla | Por qué importa |
|---|---|
| `radicadoDeDuplicado` saca el radicado de "DUPLICADO:168864148". | Permite adoptar documentos que ya existían en el RNDC (hechos en el portal). |
| Coordenadas: cuenta decimales, avisa si faltan (el RNDC exige 6) o si están fuera de Colombia, y **nunca bloquea**. | Regla del proyecto: el RNDC decide; lo local solo avisa. |
| El NIT se compara con o sin dígito de verificación. | Detección de flota propia. |
| Código de mercancía con "00" a la izquierda (4805 → 004805). | [REM pág. 15] |
| Tope de anulaciones: 30 %, 20 % o 10 % según los manifiestos del mes. | Resolución vigente. |

### 3.3 `rndc/sicetac.test.ts` — Piso de SICETAC

Esta es la regla que más problemas dio en producción. Las pruebas usan el
**caso real del manifiesto 00006775** (Palmira → Bogotá, 3S3, vía 11693,
movilización $3.647.929, valor hora $92.958):

| Prueba | Resultado esperado | Lo que pasó en el RNDC |
|---|---|---|
| Piso de despacho (4 h pactadas) | **$4.019.761** | El flete fue exactamente ese valor y se aceptó. |
| Piso del cumplido, horas desde la **llegada** (8 h 13 min + 2 h) | **$4.597.650** | $4.551.761 → rechazado (CMA045); $4.597.761 → aceptado. |
| Piso del cumplido, horas desde la **entrada** (9,72 h) | $4.551.171 | Es menor que el que exige el RNDC: por eso se cuenta desde la llegada. |
| Redondeo hacia arriba | 1000,2 → 1001 | Un peso de menos basta para el rechazo (MAN045). |

Además:

| Regla | Por qué importa |
|---|---|
| Horas pactadas = horas + minutos de cargue y descargue. | Entran en el piso. |
| Código DIVIPOLA → cabecera municipal (76520001 → 76520000; 5001000 → 05001000). | SICETAC solo tiene cabeceras. |
| Periodo AAAAMM en hora de Colombia. | El 1 de octubre a las 03:00 UTC todavía es septiembre. |
| Tipo de carga sin tildes ("Granel Sólido" = "Granel Solido"). | Bug real: no coincidía y se tomaba la fila más barata (MAN045). |
| Se descartan las filas de vehículo vacío. | Tienen un piso mucho menor. |
| Una fila por vía, la de piso más alto, la estándar primero. | Con un piso de más el flete pasa; con uno de menos, el RNDC rechaza. |

### 3.4 `cuadro.test.ts` — Estados del Cuadro pagos

Cada estado corresponde a un color del Excel "CUADRO CENTRAL":

| Situación del viaje | Estado | Color en el Excel |
|---|---|---|
| Recién cargado | En proceso | Blanco |
| Papeles con el conductor, en el parqueadero o donde Don Alexander | Sin radicar | Morado |
| Papeles radicados en el cliente | Radicado | Verde |
| Facturado sin número ni fecha | Facturado sin datos | Azul |
| Con número de factura | Facturado | — |
| El cliente pagó la factura | Factura pagada | — |
| Anulado (gana sobre todo lo demás) | Anulado | — |

**Todo pagado (amarillo)** exige las tres cosas:

| Prueba | Resultado |
|---|---|
| Tercero con factura cobrada pero sin pagarle el saldo | No |
| Tercero con factura cobrada y saldo pagado | Sí |
| Flota propia (López o MYC) con factura cobrada | Sí: no hay saldo de tercero |
| Con un anticipo sin pagar a la bomba | No |
| Sin pago de la factura | Nunca |

Además:

| Regla | Caso |
|---|---|
| El saldo del tercero vence 15 días después del descargue. | 06/10 → 21/10; 20/10 → 04/11 (cambio de mes). |
| Solo CORAME / Cartones América pasan por parqueadero y oficina. | "CORAME URBANO" sí; "TP FORMULADOS" no. |

`cuadro.test.ts` reemplaza la conexión a MySQL por un objeto vacío
(`vi.mock("./db")`): las pruebas nunca tocan la base.

---

## 4. Qué NO cubren (y cómo se verifica eso)

Las pruebas unitarias cubren las **reglas**. No cubren:

| Qué | Cómo se verifica hoy |
|---|---|
| Las rutas de Express y las consultas SQL | Pruebas manuales contra la base local (`npm run dev`). |
| La comunicación con el RNDC | Ambiente de pruebas `rndcpruebas`, o consultas de solo lectura (tipo 3) en producción. Nunca registros de prueba en producción. |
| El piso en vivo de SICETAC | Tiene límite de consultas (RNDC13): no se consulta desde pruebas automáticas. |

---

## 5. Cómo agregar una prueba

1. Crea `algo.test.ts` junto a `algo.ts` (o agrégala al archivo existente).
2. Estructura:

   ```ts
   import { describe, expect, test } from "vitest";
   import { calcularFopat } from "./builders";

   describe("FOPAT", () => {
     test("0,1 % del valor a pagar, redondeado al peso", () => {
       expect(calcularFopat(4_019_761, true)).toBe(4_020);
     });
   });
   ```

3. Escribe el nombre de la prueba como la **regla de negocio** que protege, en
   español ("el saldo del tercero vence 15 días después del descargue").
4. Usa **casos reales** cuando existan (número de manifiesto y valores), y anota
   en un comentario qué respondió el RNDC.
5. Corre `npm test` y `npm run test:tipos`.
6. **Comprueba que la prueba puede fallar:** cambia la regla un momento en el
   código y verifica que la prueba se pone en rojo; luego deja el código como
   estaba.

Cuando se descubra una regla nueva del RNDC (como la del piso del cumplido con
horas desde la llegada), la prueba con el caso real es la forma de que no se
vuelva a perder.
