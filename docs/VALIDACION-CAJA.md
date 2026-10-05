# Validación técnica de ventas, cobros y corte de caja

## Cambio de comportamiento

Un pedido entregado ayer por $30 conserva su venta en la fecha de entrega.
Si se cobran $10 ayer y $20 hoy, cada importe aparece en los cobros de su fecha
y el saldo pasa de $20 a $0. Los pagos se aplican al pedido; un pago general
desde Cobranza se distribuye entre los cargos pendientes más antiguos.

Las entregas, pagos iniciales y canjes se guardan en una sola transacción
IndexedDB. Las validaciones dentro de esa transacción impiden cobrar dos veces
el mismo saldo desde dos pestañas. Las entregas ya registradas no se editan ni
se eliminan desde Pedidos: la cobranza posterior usa un movimiento independiente.
Los pagos erróneos se anulan desde el historial y se conservan para consulta.

## Compatibilidad con los datos existentes

- No se borra ni reescribe la base instalada. No se inventan fechas de cobro.
- Un pedido histórico pagado mantiene su saldo liquidado, pero no genera un
  recibo ficticio en caja. El corte informa cuántos pedidos tienen esta limitación.
- Los cargos y abonos antiguos conservan su saldo. Los abonos sin aplicación
  a un pedido se distribuyen por antigüedad para mostrar los saldos por pedido.
- Los pagos o gastos antiguos sin método se muestran pendientes de clasificar.
  No se asumen como efectivo. El corte exige clasificarlos antes de guardarse.
- Se usa fecha local para entregas con timestamp y se conserva la fecha local
  explícita en las nuevas entregas. Los pedidos antiguos sin timestamp usan su
  fecha registrada como alternativa; no puede reconstruirse una entrega desconocida.
- Los cortes son copias guardadas en Configuración y entran en el respaldo JSON.
  Las correcciones posteriores no alteran esas copias. La pantalla señala cambios
  y permite guardar otra revisión. No son un bloqueo contable de toda la jornada.
- Un saldo incorrecto creado anteriormente por marcar como pagado y registrar
  además un abono no se corrige por suposición: requiere conciliar los movimientos.

## Corte

Presenta ventas, cobros, cartera al día seleccionado, efectivo, transferencias y
gastos en efectivo. El arqueo usa:

`esperado = fondo inicial + cobros en efectivo - gastos en efectivo - retiros`

`diferencia = efectivo contado - esperado`

Cada revisión se exporta a Excel con su resumen y detalle de cobros y gastos.
El fondo y los retiros los captura el operador; los retiros no deben repetir
gastos que ya estén registrados. Los cortes históricos solo contienen los cobros
cuya fecha se registró realmente. Las transferencias quedan fuera del efectivo.

## Pruebas reproducibles

Se requiere Node.js 20 o posterior. No hay dependencias de servidor ni proceso
de compilación para usar o publicar la aplicación.

```sh
npm ci
npm test
npx playwright install chromium
npm run test:browser
```

Para usar Chrome ya instalado, configura `BROWSER_CHANNEL=chrome`.
La prueba de navegador inicia y cierra su propio servidor local y utiliza un
perfil desechable con datos de prueba. Las capturas se guardan en `test-results/`.

La suite cubre fechas de venta y cobro, pagos parciales, saldos históricos,
centavos, pagos simultáneos, rollback, canjes, métodos de pago, anulaciones,
cortes y restauración de respaldos. La prueba de navegador recorre Pedidos,
Cobranza, Gastos y Caja, exporta Excel, revisa el ancho móvil y recarga offline.

## Publicación

Publicar los archivos estáticos de la rama revisada. El service worker v27
incluye los módulos nuevos. Conservar el dominio de la instalación existente:
IndexedDB pertenece al origen y al dispositivo, y abrir otro dominio no traslada
los datos. La actualización del manual de Las Peques queda para una etapa posterior.
