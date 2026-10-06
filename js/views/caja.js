import { STORES, getAll } from '../db.js';
import { resumenCaja, calcularArqueo } from '../finanzas.js';
import { guardarCorte, clasificarPago } from '../libro.js';
import { el, dinero, hoyISO, fechaLegible, toast } from '../utils.js';
import { exportarExcel } from '../export.js';

export async function render(root) {
  root.innerHTML = '';
  const fecha = el('input', { type: 'date', value: hoyISO(), max: hoyISO(), 'aria-label': 'Fecha del corte' });
  const body = el('div');
  root.append(el('div', { class: 'page-head' }, [el('h2', { text: 'Corte de caja' }), fecha]), body);
  let secuencia = 0;
  async function cargar() {
    const turno = ++secuencia;
    const dia = fecha.value;
    if (!dia) return;
    const [pedidos, pagos, gastos, clientes, config] = await Promise.all(['pedidos', 'pagos', 'gastos', 'clientes', 'config'].map(n => getAll(STORES[n])));
    if (turno !== secuencia) return;
    const resumen = resumenCaja(pedidos, pagos, gastos, dia);
    const cortes = config.filter(c => c.clave.startsWith(`corte:${dia}:`)).map(c => c.valor).sort((a, b) => b.guardadoEn.localeCompare(a.guardadoEn));
    const nombres = new Map(clientes.map(c => [c.id, c.nombre]));
    body.innerHTML = '';
    const grid = el('div', { class: 'kpi-grid' });
    [['Ventas por entrega', resumen.ventas], ['Cobros recibidos', resumen.cobros], ['Saldo por cobrar al cierre del día', resumen.porCobrar], ['Cobros en efectivo', resumen.efectivo], ['Transferencias recibidas', resumen.transferencia], ['Gastos en efectivo', resumen.gastosEfectivo]].forEach(([nombre, monto]) => grid.append(el('div', { class: 'kpi' }, [el('div', { class: 'kpi__valor', text: dinero(monto) }), el('div', { class: 'kpi__label', text: nombre })])));
    body.append(grid, el('p', { class: 'hint', text: 'Las ventas usan la fecha de entrega; los cobros, la fecha del pago. Las transferencias no forman parte del efectivo de caja.' }));
    if (resumen.historicosSinFecha) body.append(el('p', { class: 'card', text: `Hay ${resumen.historicosSinFecha} pedido(s) antiguo(s) pagado(s) sin fecha de cobro comprobable. Se conserva su saldo liquidado; no se inventan cobros para los cortes históricos.` }));
    if (resumen.sinMetodo || resumen.gastosSinMetodo) body.append(el('p', { class: 'card', text: `Por clasificar: cobros ${dinero(resumen.sinMetodo)} y gastos ${dinero(resumen.gastosSinMetodo)}. No se incluyen en efectivo. Clasifica los cobros abajo y los gastos en Gastos para guardar el corte.` }));
    const form = el('form', { class: 'card form' });
    form.append(el('h3', { text: 'Conteo de efectivo' }));
    const campos = {};
    [['fondo', 'Fondo inicial', String(cortes[0]?.fondo ?? 0)], ['retiros', 'Retiros de efectivo (sin repetir gastos)', String(cortes[0]?.retiros ?? 0)], ['contado', 'Efectivo contado', '']].forEach(([key, label, value]) => {
      campos[key] = el('input', { id: `caja-${key}`, type: 'number', min: '0', step: '0.01', value, required: true });
      form.append(el('div', { class: 'field' }, [el('label', { for: `caja-${key}`, text: label }), campos[key]]));
    });
    const nota = el('textarea', { id: 'caja-nota', placeholder: 'Responsable, motivo de retiros o diferencias', maxlength: 1000 });
    const resultado = el('p', { 'aria-live': 'polite' });
    const actualizar = () => {
      try {
        const a = calcularArqueo(resumen, campos.fondo.value, campos.retiros.value, campos.contado.value);
        resultado.textContent = `Efectivo esperado: ${dinero(a.esperado)}${campos.contado.value === '' ? '' : ` · Diferencia: ${dinero(a.diferencia)} (${a.diferencia < 0 ? 'faltante' : a.diferencia > 0 ? 'sobrante' : 'sin diferencia'})`}`;
      } catch (e) { resultado.textContent = e.message; }
    };
    Object.values(campos).forEach(c => c.addEventListener('input', actualizar));
    const guardar = el('button', { type: 'submit', class: 'btn btn--primary', text: cortes.length ? 'Guardar nueva revisión' : 'Guardar corte' });
    form.append(el('div', { class: 'field' }, [el('label', { for: 'caja-nota', text: 'Notas del corte' }), nota]), el('p', { class: 'hint', text: 'Esperado = fondo inicial + cobros en efectivo − gastos en efectivo − retiros. Cada corte guardado conserva su propia copia; puedes generar una nueva revisión si corriges movimientos.' }), resultado, guardar);
    form.onsubmit = async e => {
      e.preventDefault(); if (guardar.disabled) return; guardar.disabled = true;
      try { await guardarCorte(dia, campos.fondo.value, campos.retiros.value, campos.contado.value, nota.value.trim()); toast('Corte guardado.', 'success'); await cargar(); }
      catch (error) { toast(error.message, 'error'); guardar.disabled = false; }
    };
    actualizar(); body.append(form);
    body.append(el('h3', { text: 'Cobros de la fecha seleccionada' }));
    if (!resumen.movimientos.length) body.append(el('p', { text: 'No hay cobros registrados en esta fecha.' }));
    resumen.movimientos.forEach(p => {
      const item = el('div', { class: 'item' }, [el('div', { class: 'item__main', text: `${nombres.get(p.clienteId) || 'Cliente eliminado'} · ${dinero(p.monto)} · ${p.metodoPago || 'Sin método'}${p.pedidoId ? ` · Pedido #${p.pedidoId}` : ''}` })]);
      if (!['Efectivo', 'Transferencia'].includes(p.metodoPago)) ['Efectivo', 'Transferencia'].forEach(m => item.append(el('button', { class: 'btn btn--ghost', text: m, onclick: async () => {
        try { await clasificarPago(p.id, m); await cargar(); } catch (error) { toast(error.message, 'error'); }
      } })));
      body.append(item);
    });
    body.append(el('a', { href: '#/gastos', class: 'btn btn--ghost', text: 'Revisar gastos y métodos de pago' }));
    body.append(el('h3', { text: 'Cortes guardados' }));
    if (!cortes.length) body.append(el('p', { text: 'Todavía no se ha guardado un corte para esta fecha.' }));
    cortes.forEach(c => {
      const cambio = JSON.stringify([c.ventas, c.movimientos, c.egresos, c.porCobrar]) !== JSON.stringify([resumen.ventas, resumen.movimientos, resumen.egresos, resumen.porCobrar]);
      body.append(el('div', { class: 'card' }, [
        el('h4', { text: `Corte del ${fechaLegible(c.fecha)} · Guardado ${new Date(c.guardadoEn).toLocaleString('es-MX')}` }),
        el('p', { text: `Ventas: ${dinero(c.ventas)} · Cobros: ${dinero(c.cobros)} · Por cobrar: ${dinero(c.porCobrar)}` }),
        el('p', { text: `Esperado: ${dinero(c.esperado)} · Contado: ${dinero(c.contado)} · Diferencia: ${dinero(c.diferencia)}` }),
        el('p', { text: c.nota || 'Sin notas' }),
        cambio ? el('p', { class: 'hint', text: 'Hay cambios desde este corte. Esta copia se conserva; guarda una nueva revisión para incluirlos.' }) : null,
        el('button', { class: 'btn btn--ghost', text: 'Exportar este corte a Excel', onclick: () => exportarExcel(`corte-${c.fecha}`, [
          { nombre: 'Corte', rows: [{ Fecha: c.fecha, Guardado: c.guardadoEn, Ventas: c.ventas, Cobros: c.cobros, PorCobrar: c.porCobrar, Efectivo: c.efectivo, Transferencias: c.transferencia, Fondo: c.fondo, GastosEfectivo: c.gastosEfectivo, Retiros: c.retiros, Esperado: c.esperado, Contado: c.contado, Diferencia: c.diferencia, Notas: c.nota }] },
          { nombre: 'Cobros', rows: c.movimientos.map(p => ({ Fecha: p.fecha, ClienteId: p.clienteId, Pedido: p.pedidoId || '', Monto: p.monto, Metodo: p.metodoPago, Concepto: p.concepto || '' })) },
          { nombre: 'Gastos', rows: c.egresos.map(g => ({ Fecha: g.fecha, Monto: g.monto, Metodo: g.metodoPago || '', Concepto: g.concepto || '' })) }
        ]) })
      ]));
    });
  }
  fecha.onchange = cargar;
  await cargar();
}
