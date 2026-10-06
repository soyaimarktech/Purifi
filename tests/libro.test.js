import 'fake-indexeddb/auto';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetAll, add, getAll, dumpAll, importAll } from '../js/db.js';
import { guardarPedido, registrarPago, anularMovimiento, guardarCorte, eliminarPendiente, clasificarPago } from '../js/libro.js';
import { cartera, fechaLocal } from '../js/finanzas.js';
const hoy = fechaLocal(new Date().toISOString());
const ayer = fechaLocal(new Date(Date.now() - 86400000).toISOString());
const nuevo = (extra = {}) => ({ clienteId: 1, fecha: ayer, total: 30, estado: 'Entregado', metodoPago: 'Efectivo', lineas: [{ tamano: '20L', cantidad: 1, precioUnit: 30, canjeCantidad: 0 }], ...extra });
const abono = (extra = {}) => ({ clienteId: 1, fecha: hoy, monto: 30, metodoPago: 'Efectivo', ...extra });
beforeEach(() => resetAll());

test('entrega y pago se guardan juntos y conservan fecha original', async () => {
  const p = await guardarPedido(nuevo(), 30);
  const pagos = await getAll('pagos');
  assert.equal(p.fecha, ayer); assert.equal(p.fechaEntrega, hoy);
  assert.equal(pagos.length, 1); assert.equal(pagos[0].pedidoId, p.id); assert.equal(pagos[0].fecha, hoy);
  assert.equal(cartera([p], pagos).saldos.get(1), 0);
});
test('método inválido revierte pedido y pago', async () => {
  await assert.rejects(guardarPedido(nuevo({ metodoPago: 'Otro' }), 30), /método/);
  assert.equal((await getAll('pedidos')).length, 0); assert.equal((await getAll('pagos')).length, 0);
});
test('pago parcial, liquidación y bloqueo de doble cobro', async () => {
  const p = await guardarPedido(nuevo(), 10);
  await registrarPago(abono({ pedidoId: p.id, monto: 20 }));
  await assert.rejects(registrarPago(abono({ pedidoId: p.id })), /supera/);
  assert.equal(cartera(await getAll('pedidos'), await getAll('pagos')).porPedido.get(p.id).pendiente, 0);
});
test('dos cobros simultáneos no cobran dos veces la deuda', async () => {
  const p = await guardarPedido(nuevo());
  const resultados = await Promise.allSettled([registrarPago(abono({ pedidoId: p.id })), registrarPago(abono({ pedidoId: p.id }))]);
  assert.equal(resultados.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal((await getAll('pagos')).length, 1);
});
test('un pago retroactivo no ignora pagos posteriores', async () => {
  await add('pedidos', { ...nuevo(), id: 1, fechaEntrega: ayer, libroVersion: 1 });
  await registrarPago(abono({ monto: 20 }));
  await assert.rejects(registrarPago(abono({ monto: 20, fecha: ayer })), /supera/);
});
test('pedido liquidado no admite cambiar entrega ni eliminar', async () => {
  const p = await guardarPedido(nuevo(), 30);
  await assert.rejects(guardarPedido({ ...p, estado: 'Pendiente' }), /entrega/);
  await assert.rejects(eliminarPendiente(p.id), /pendientes/);
});
test('pedido pendiente puede editarse y eliminarse', async () => {
  const p = await guardarPedido(nuevo({ estado: 'Pendiente' }));
  await guardarPedido({ ...p, total: 40 });
  await eliminarPendiente(p.id);
  assert.equal((await getAll('pedidos')).length, 0);
});
test('canje, entrega y pago son atómicos', async () => {
  await guardarPedido(nuevo({ lineas: [{ tamano: '20L', cantidad: 1, canjeCantidad: 1 }] }), 10);
  assert.equal((await getAll('inventario')).length, 1);
  await assert.rejects(guardarPedido(nuevo({ metodoPago: 'Otro', lineas: [{ tamano: '20L', cantidad: 1, canjeCantidad: 1 }] }), 10));
  assert.equal((await getAll('inventario')).length, 1);
});
test('anulación conserva registro y reabre saldo', async () => {
  await guardarPedido(nuevo(), 30);
  const [pago] = await getAll('pagos'); await anularMovimiento(pago.id);
  const pagos = await getAll('pagos');
  assert.equal(pagos.length, 1); assert.ok(pagos[0].anuladoEn);
  assert.equal(cartera(await getAll('pedidos'), pagos).saldos.get(1), 30);
});
test('adeudo manual con abonos no se anula primero', async () => {
  const id = await add('pagos', { clienteId: 1, tipo: 'adeudo', monto: 30, fecha: ayer });
  await registrarPago(abono({ monto: 10 }));
  await assert.rejects(anularMovimiento(id), /Primero/);
});
test('corte conserva snapshot y revisiones independientes', async () => {
  await guardarPedido(nuevo(), 30);
  const c = await guardarCorte(hoy, 100, 10, 120, 'David');
  assert.equal(c.esperado, 120); assert.equal(c.diferencia, 0);
  await anularMovimiento((await getAll('pagos'))[0].id);
  await guardarCorte(hoy, 100, 10, 90, 'Corrección');
  const cortes = (await getAll('config')).filter(c => c.clave.startsWith('corte:'));
  assert.equal(cortes.length, 2); assert.equal(cortes.find(c => c.valor.nota === 'David').valor.cobros, 30);
});
test('corte detecta métodos desconocidos y permite clasificar', async () => {
  await add('pagos', { clienteId: 1, tipo: 'pago', monto: 10, fecha: hoy });
  await assert.rejects(guardarCorte(hoy, 0, 0, 10, ''), /clasif/i);
  await clasificarPago((await getAll('pagos'))[0].id, 'Efectivo');
  const c = await guardarCorte(hoy, 0, 0, 10, ''); assert.equal(c.diferencia, 0);
});
test('respaldo restaura pagos, aplicaciones, anulaciones y cortes', async () => {
  await guardarPedido(nuevo(), 10);
  await guardarCorte(hoy, 0, 0, 10, 'Respaldo');
  const respaldo = await dumpAll();
  await resetAll(); await importAll(respaldo);
  assert.equal((await getAll('pagos'))[0].aplicaciones[0].monto, 10);
  assert.equal((await getAll('config')).filter(c => c.clave.startsWith('corte:')).length, 1);
  assert.equal(cartera(await getAll('pedidos'), await getAll('pagos')).saldos.get(1), 20);
});

test('dos entregas simultáneas del mismo pendiente generan un solo cobro y canje', async () => {
  const pendiente = await guardarPedido(nuevo({ estado: 'Pendiente', lineas: [{ tamano: '20L', cantidad: 1, canjeCantidad: 1 }] }));
  const p = { ...pendiente, estado: 'Entregado' };
  const resultados = await Promise.allSettled([guardarPedido(p, 30), guardarPedido(p, 30)]);
  assert.equal(resultados.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal((await getAll('pagos')).length, 1); assert.equal((await getAll('inventario')).length, 1);
});
test('pago dirigido no se aplica a otro cliente ni a otro pedido', async () => {
  const a = await guardarPedido(nuevo());
  await guardarPedido(nuevo({ clienteId: 2 }));
  await assert.rejects(registrarPago(abono({ clienteId: 2, pedidoId: a.id })), /pedido/);
  assert.equal((await getAll('pagos')).length, 0);
});
test('gastos sin método impiden dar por cuadrado el corte', async () => {
  await add('gastos', { fecha: hoy, monto: 10 });
  await assert.rejects(guardarCorte(hoy, 100, 0, 90, ''), /clasif/i);
});
