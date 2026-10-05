import { transaccionFinanciera } from './db.js';
import { cartera, centavos, pesos, fechaLocal, resumenCaja, calcularArqueo } from './finanzas.js';

function validarFecha(fecha) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha || '') || fechaLocal(new Date(`${fecha}T12:00:00`).toISOString()) !== fecha || fecha > fechaLocal(new Date().toISOString())) throw new Error('Indica una fecha válida que no sea futura.');
}
function validarMonto(monto, permitirCero = false) {
  if (!Number.isFinite(Number(monto)) || centavos(monto) < (permitirCero ? 0 : 1)) throw new Error('Indica un monto válido.');
}
function prepararPago(datos, entrada) {
  validarFecha(entrada.fecha); validarMonto(entrada.monto);
  if (!['Efectivo', 'Transferencia'].includes(entrada.metodoPago)) throw new Error('Selecciona el método de pago.');
  const cuenta = cartera(datos.pedidos, datos.pagos, entrada.fecha);
  const actual = cartera(datos.pedidos, datos.pagos);
  const saldo = cuenta.saldos.get(entrada.clienteId) || 0;
  let resto = centavos(entrada.monto);
  if (resto > Math.min(centavos(saldo), centavos(actual.saldos.get(entrada.clienteId) || 0))) throw new Error('El pago supera el saldo por cobrar. Revisa también los pagos posteriores a esa fecha.');
  const aplicaciones = [];
  cuenta.cargos.filter(c => c.clienteId === entrada.clienteId && (!entrada.pedidoId || c.pedidoId === entrada.pedidoId)).forEach(c => {
    const hoy = actual.cargos.find(x => x.clave === c.clave)?.pendiente || 0;
    const n = Math.min(resto, c.pendiente, hoy);
    if (n > 0) aplicaciones.push({ clave: c.clave, monto: pesos(n) });
    resto -= n;
  });
  if (resto > 0) throw new Error('El pago supera el saldo pendiente del pedido.');
  return { ...entrada, monto: pesos(centavos(entrada.monto)), tipo: 'pago', aplicaciones, creadoEn: new Date().toISOString() };
}

export function registrarPago(entrada) {
  return transaccionFinanciera((datos, stores, result) => {
    const pago = prepararPago(datos, entrada);
    const req = stores.pagos.add(pago); req.onsuccess = () => result(req.result);
  });
}

export function registrarAdeudo(entrada) {
  return transaccionFinanciera((datos, stores) => {
    validarFecha(entrada.fecha); validarMonto(entrada.monto);
    stores.pagos.add({ clienteId: entrada.clienteId, monto: pesos(centavos(entrada.monto)), fecha: entrada.fecha, concepto: entrada.concepto, tipo: 'adeudo', creadoEn: new Date().toISOString() });
  });
}

export function clasificarPago(id, metodoPago) {
  return transaccionFinanciera((datos, stores) => {
    const p = datos.pagos.find(p => p.id === id);
    if (!p || p.anuladoEn || p.tipo !== 'pago') throw new Error('No se encontró un pago vigente.');
    if (['Efectivo', 'Transferencia'].includes(p.metodoPago)) throw new Error('Este pago ya fue clasificado.');
    if (!['Efectivo', 'Transferencia'].includes(metodoPago)) throw new Error('Método inválido.');
    stores.pagos.put({ ...p, metodoPago });
  });
}

export function eliminarPendiente(id) {
  return transaccionFinanciera((datos, stores) => {
    const p = datos.pedidos.find(p => p.id === id);
    if (!p || p.estado !== 'Pendiente') throw new Error('Solo se pueden eliminar pedidos pendientes de entrega.');
    stores.pedidos.delete(id);
  });
}

export function guardarPedido(entrada, cobro = 0) {
  return transaccionFinanciera((datos, stores, result, fallar) => {
    const previo = datos.pedidos.find(p => p.id === entrada.id);
    if (entrada.id && !previo) throw new Error('El pedido fue eliminado. Recarga la lista.');
    if (previo?.estado === 'Entregado') throw new Error('La entrega ya está registrada. Usa Registrar pago para abonar o liquidar.');
    validarMonto(entrada.total, true); validarMonto(cobro, true);
    if (centavos(cobro) > centavos(entrada.total)) throw new Error('El cobro supera el total del pedido.');
    const p = { ...entrada, libroVersion: 1, pagado: false, creadoEn: previo?.creadoEn || new Date().toISOString() };
    if (!Number.isInteger(p.clienteId) || p.clienteId <= 0) throw new Error('Selecciona un cliente.');
    if (!['Pendiente', 'Entregado'].includes(p.estado)) throw new Error('Estado inválido.');
    if (p.estado === 'Entregado') {
      p.fechaEntrega = fechaLocal(new Date().toISOString());
      p.entregadoEn = new Date().toISOString();
    } else if (centavos(cobro)) throw new Error('Primero registra la entrega.');
    const req = p.id ? stores.pedidos.put(p) : stores.pedidos.add(p);
    req.onsuccess = () => {
      p.id = req.result;
      try {
        if (centavos(cobro)) {
          const pedidos = datos.pedidos.filter(x => x.id !== p.id).concat(p);
          stores.pagos.add(prepararPago({ ...datos, pedidos }, { clienteId: p.clienteId, pedidoId: p.id, monto: cobro, fecha: p.fechaEntrega, metodoPago: p.metodoPago, concepto: `Cobro de pedido #${p.id}` }));
        }
        if (p.estado === 'Entregado') {
          (p.lineas || []).forEach(l => {
            const cantidad = Number(l.canjeCantidad) || 0;
            if (cantidad <= 0) return;
            const tamano = l.tamano;
            stores.inventario.add({ fecha: p.fechaEntrega, tipo: 'Canje', tamano, cantidad, nuevos: -cantidad, usados: cantidad, nuevosPorTamano: { [tamano]: -cantidad }, usadosPorTamano: { [tamano]: cantidad }, concepto: `Canje de garrafón ${tamano} (pedido entregado)`, pedidoId: p.id, clienteId: p.clienteId, creadoEn: p.entregadoEn });
          });
        }
        result(p);
      } catch (error) {
        fallar(error);
      }
    };
  });
}

export function anularMovimiento(id) {
  return transaccionFinanciera((datos, stores) => {
    const p = datos.pagos.find(p => p.id === id);
    if (!p || p.anuladoEn) throw new Error('El movimiento ya fue anulado.');
    if (p.tipo === 'adeudo') {
      const cargo = cartera(datos.pedidos, datos.pagos).cargos.find(c => c.clave === `adeudo:${id}`);
      if (cargo && cargo.pendiente !== cargo.total) throw new Error('Primero anula los pagos aplicados a este adeudo.');
    }
    stores.pagos.put({ ...p, anuladoEn: new Date().toISOString() });
  });
}

export function guardarCorte(fecha, fondo, retiros, contado, nota) {
  return transaccionFinanciera((datos, stores, result) => {
    validarFecha(fecha);
    const resumen = resumenCaja(datos.pedidos, datos.pagos, datos.gastos, fecha);
    if (resumen.sinMetodo || resumen.gastosSinMetodo) throw new Error('Hay movimientos sin método de pago. Clasifícalos antes de guardar el corte.');
    const corte = { ...resumen, ...calcularArqueo(resumen, fondo, retiros, contado), nota, guardadoEn: new Date().toISOString() };
    // Cada revisión es independiente y se incluye en los respaldos existentes.
    stores.config.add({ clave: `corte:${fecha}:${crypto.randomUUID()}`, valor: corte });
    result(corte);
  });
}
