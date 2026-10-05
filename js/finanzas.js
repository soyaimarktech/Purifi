// Cálculos puros. Importes en centavos; los pagos nunca cambian la fecha de venta.
export const centavos = (n) => Math.round((Number(n) || 0) * 100);
export const pesos = (n) => n / 100;
export function fechaLocal(valor) {
  if (!valor) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(valor)) return valor;
  const d = new Date(valor);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
export const fechaVenta = (p) => p.fechaEntrega || fechaLocal(p.entregadoEn) || p.fecha;
export const generaCargo = (p) => p.estado === 'Entregado' && (p.libroVersion === 1 || p.pagado === false);
export const vigente = (m) => !m.anuladoEn;

// Los abonos históricos sin pedido se distribuyen por antigüedad. Los nuevos
// guardan su aplicación para no reasignarlos al registrar movimientos posteriores.
export function cartera(pedidos, pagos, hasta = '9999-12-31') {
  const cargos = pedidos.filter(p => generaCargo(p) && fechaVenta(p) <= hasta)
    .map(p => ({ clave: `pedido:${p.id}`, pedidoId: p.id, clienteId: p.clienteId, fecha: fechaVenta(p), total: centavos(p.total), pendiente: centavos(p.total) }));
  pagos.filter(p => vigente(p) && p.tipo === 'adeudo' && p.fecha <= hasta).forEach(p => cargos.push({ clave: `adeudo:${p.id}`, clienteId: p.clienteId, fecha: p.fecha, total: centavos(p.monto), pendiente: centavos(p.monto) }));
  cargos.sort((a, b) => a.fecha.localeCompare(b.fecha) || a.clave.localeCompare(b.clave, undefined, { numeric: true }));
  const saldos = new Map();
  const sumar = (id, n) => saldos.set(id, (saldos.get(id) || 0) + n);
  cargos.forEach(c => sumar(c.clienteId, c.total));
  const abonos = pagos.filter(p => vigente(p) && p.tipo === 'pago' && p.fecha <= hasta).sort((a, b) => a.fecha.localeCompare(b.fecha) || a.id - b.id);
  // Primero reservar aplicaciones explícitas; después distribuir abonos antiguos.
  abonos.filter(p => Array.isArray(p.aplicaciones)).forEach(p => {
    p.aplicaciones.forEach(a => {
      const c = cargos.find(c => c.clave === a.clave && c.clienteId === p.clienteId);
      if (c) c.pendiente = Math.max(0, c.pendiente - centavos(a.monto));
    });
  });
  abonos.forEach(p => {
    sumar(p.clienteId, -centavos(p.monto));
    if (Array.isArray(p.aplicaciones)) return;
    let resto = centavos(p.monto);
    cargos.filter(c => c.clienteId === p.clienteId).forEach(c => {
      const n = Math.min(c.pendiente, resto); c.pendiente -= n; resto -= n;
    });
  });
  const porPedido = new Map();
  pedidos.forEach(p => {
    const c = cargos.find(c => c.pedidoId === p.id);
    if (p.estado === 'Entregado') porPedido.set(p.id, { pendiente: pesos(c?.pendiente || 0), abonado: pesos(centavos(p.total) - (c?.pendiente || 0)) });
  });
  return { cargos, porPedido, saldos: new Map([...saldos].map(([id, n]) => [id, pesos(n)])) };
}

export function resumenCaja(pedidos, pagos, gastos, fecha) {
  const movimientos = pagos.filter(p => vigente(p) && p.tipo === 'pago' && p.fecha === fecha);
  const egresos = gastos.filter(g => g.fecha === fecha);
  const suma = (xs, campo) => pesos(xs.reduce((s, x) => s + centavos(x[campo]), 0));
  const cuentas = cartera(pedidos, pagos, fecha);
  return {
    fecha,
    ventas: suma(pedidos.filter(p => p.estado === 'Entregado' && fechaVenta(p) === fecha), 'total'),
    cobros: suma(movimientos, 'monto'),
    efectivo: suma(movimientos.filter(p => p.metodoPago === 'Efectivo'), 'monto'),
    transferencia: suma(movimientos.filter(p => p.metodoPago === 'Transferencia'), 'monto'),
    sinMetodo: suma(movimientos.filter(p => !['Efectivo', 'Transferencia'].includes(p.metodoPago)), 'monto'),
    gastosEfectivo: suma(egresos.filter(g => g.metodoPago === 'Efectivo'), 'monto'),
    gastosSinMetodo: suma(egresos.filter(g => !['Efectivo', 'Transferencia'].includes(g.metodoPago)), 'monto'),
    porCobrar: pesos([...cuentas.saldos.values()].reduce((s, n) => s + Math.max(0, centavos(n)), 0)),
    historicosSinFecha: pedidos.filter(p => p.estado === 'Entregado' && p.libroVersion !== 1 && p.pagado !== false).length,
    movimientos,
    egresos
  };
}

export function calcularArqueo(resumen, fondo, retiros, contado) {
  const valores = [fondo, retiros, contado].map(Number);
  if (valores.some(n => !Number.isFinite(n) || n < 0)) throw new Error('Los importes deben ser números iguales o mayores a cero.');
  const esperado = centavos(fondo) + centavos(resumen.efectivo) - centavos(resumen.gastosEfectivo) - centavos(retiros);
  return { fondo: pesos(centavos(fondo)), retiros: pesos(centavos(retiros)), contado: pesos(centavos(contado)), esperado: pesos(esperado), diferencia: pesos(centavos(contado) - esperado) };
}
