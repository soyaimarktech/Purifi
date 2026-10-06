import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cartera, resumenCaja, calcularArqueo, fechaVenta, fechaLocal } from '../js/finanzas.js';

const ayer = '2026-10-04', hoy = '2026-10-05';
const pedido = (extra = {}) => ({ id: 1, clienteId: 1, fecha: ayer, fechaEntrega: ayer, total: 30, estado: 'Entregado', libroVersion: 1, pagado: false, ...extra });
const pago = (extra = {}) => ({ id: 1, clienteId: 1, tipo: 'pago', monto: 30, fecha: hoy, metodoPago: 'Efectivo', aplicaciones: [{ clave: 'pedido:1', monto: 30 }], ...extra });

test('venta de ayer y cobro de hoy permanecen separados', () => {
  const pedidos = [pedido()], pagos = [pago()];
  const a = resumenCaja(pedidos, pagos, [], ayer), b = resumenCaja(pedidos, pagos, [], hoy);
  assert.deepEqual([a.ventas, a.cobros, a.porCobrar], [30, 0, 30]);
  assert.deepEqual([b.ventas, b.cobros, b.porCobrar], [0, 30, 0]);
});
test('abono parcial y liquidación en dos días', () => {
  const pagos = [pago({ fecha: ayer, monto: 10, aplicaciones: [{ clave: 'pedido:1', monto: 10 }] }), pago({ id: 2, monto: 20, aplicaciones: [{ clave: 'pedido:1', monto: 20 }] })];
  assert.equal(cartera([pedido()], pagos, ayer).porPedido.get(1).pendiente, 20);
  assert.equal(resumenCaja([pedido()], pagos, [], ayer).cobros, 10);
  assert.equal(resumenCaja([pedido()], pagos, [], hoy).cobros, 20);
  assert.equal(cartera([pedido()], pagos).saldos.get(1), 0);
});
test('pendiente no cuenta como venta ni cargo', () => {
  const r = resumenCaja([pedido({ estado: 'Pendiente' })], [], [], ayer);
  assert.equal(r.ventas, 0); assert.equal(r.porCobrar, 0);
});
test('la venta usa entrega, no creación del pedido', () => {
  const p = pedido({ fechaEntrega: hoy });
  assert.equal(fechaVenta(p), hoy);
  assert.equal(resumenCaja([p], [], [], ayer).ventas, 0);
  assert.equal(resumenCaja([p], [], [], hoy).ventas, 30);
});
test('histórico pagado conserva saldo sin inventar cobro', () => {
  const p = pedido({ libroVersion: undefined, pagado: true });
  const r = resumenCaja([p], [], [], ayer);
  assert.equal(r.ventas, 30); assert.equal(r.cobros, 0); assert.equal(r.porCobrar, 0); assert.equal(r.historicosSinFecha, 1);
});
test('abonos antiguos y nuevos conservan saldo y liquidan el pedido', () => {
  const p = pedido({ libroVersion: undefined });
  const pagos = [pago({ monto: 10, fecha: ayer, aplicaciones: undefined }), pago({ id: 2, monto: 20, aplicaciones: [{ clave: 'pedido:1', monto: 20 }] })];
  const c = cartera([p], pagos);
  assert.equal(c.saldos.get(1), 0); assert.equal(c.porPedido.get(1).pendiente, 0);
});
test('pagos generales históricos se distribuyen por antigüedad sin mezclar clientes', () => {
  const c = cartera([pedido(), pedido({ id: 2, fechaEntrega: hoy }), pedido({ id: 3, clienteId: 2 })], [pago({ monto: 40, aplicaciones: undefined })]);
  assert.equal(c.porPedido.get(1).pendiente, 0); assert.equal(c.porPedido.get(2).pendiente, 20); assert.equal(c.porPedido.get(3).pendiente, 30);
});
test('anular pago reabre saldo sin borrar cargo', () => {
  const c = cartera([pedido()], [pago({ anuladoEn: '2026-10-06T12:00:00Z' })]);
  assert.equal(c.saldos.get(1), 30); assert.equal(c.porPedido.get(1).pendiente, 30);
});
test('transferencias y métodos desconocidos no inflan efectivo', () => {
  const r = resumenCaja([], [pago(), pago({ id: 2, metodoPago: 'Transferencia' }), pago({ id: 3, metodoPago: undefined })], [{ fecha: hoy, monto: 5, metodoPago: 'Efectivo' }, { fecha: hoy, monto: 7, metodoPago: 'Transferencia' }, { fecha: hoy, monto: 3 }], hoy);
  assert.deepEqual([r.cobros, r.efectivo, r.transferencia, r.sinMetodo, r.gastosEfectivo, r.gastosSinMetodo], [90, 30, 30, 30, 5, 3]);
  assert.deepEqual(calcularArqueo(r, 100, 20, 103), { fondo: 100, retiros: 20, contado: 103, esperado: 105, diferencia: -2 });
});
test('centavos no acumulan residuos de coma flotante', () => {
  const c = cartera([pedido({ total: 0.3 })], [pago({ monto: 0.1, aplicaciones: undefined }), pago({ id: 2, monto: 0.2, aplicaciones: undefined })]);
  assert.equal(c.saldos.get(1), 0);
});
test('fechas ISO con hora se convierten al día local', () => {
  const d = new Date('2026-10-05T02:00:00Z');
  const expected = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  assert.equal(fechaLocal(d.toISOString()), expected);
  assert.equal(fechaVenta({ entregadoEn: d.toISOString(), fecha: hoy }), expected);
});
test('saldo a favor histórico se conserva separado de deudores', () => {
  const c = cartera([pedido({ libroVersion: undefined })], [pago({ monto: 40, aplicaciones: undefined })]);
  assert.equal(c.saldos.get(1), -10);
  assert.equal(resumenCaja([pedido({ libroVersion: undefined })], [pago({ monto: 40, aplicaciones: undefined })], [], hoy).porCobrar, 0);
});
