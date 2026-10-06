/**
 * cobranza.js — Registro de pagos y adeudos, e historial por cliente.
 */
import { formularioCobro } from './pago.js';
import { anularMovimiento, registrarAdeudo } from '../libro.js';
import { fechaVenta } from '../finanzas.js';
import { STORES, getAll, getByIndex } from '../db.js';
import {
  el, $, toast, abrirModal, cerrarModal, confirmar, esc, debounce,
  dinero, hoyISO, fechaLegible, tamanoPedido, resumenLineas
} from '../utils.js';
import { saldosTodos, esAdeudoPedido } from '../services.js';

let _clientes = [];
let _saldos = new Map();

function tarjetaSaldo(c) {
  const saldo = _saldos.get(c.id) || 0;
  const deudor = saldo > 0.001;
  const main = el('div', { class: 'item__main' }, [
    el('div', { class: 'item__title', text: c.nombre }),
    el('div', { class: 'item__meta', html: deudor
      ? `<span class="badge badge--adeudo">Debe ${dinero(saldo)}</span>`
      : `<span class="badge badge--pago">Al corriente</span>` })
  ]);
  const actions = el('div', { class: 'item__actions' }, [
    el('button', { class: 'icon-btn icon-btn--ok', title: 'Registrar pago', text: '💵', onclick: () => formPago(c, 'pago') }),
    el('button', { class: 'icon-btn', title: 'Registrar adeudo', text: '➕', onclick: () => formPago(c, 'adeudo') }),
    el('button', { class: 'icon-btn', title: 'Historial', text: '📜', onclick: () => verHistorial(c) })
  ]);
  return el('div', { class: 'item' }, [main, actions]);
}

function formPago(cliente, tipo) {
  if (tipo === 'pago') return formularioCobro({ cliente, saldo: _saldos.get(cliente.id) || 0, alGuardar: recargar });
  const esPago = tipo === 'pago';
  const saldo = _saldos.get(cliente.id) || 0;
  const f = el('form', { class: 'form' });
  f.innerHTML = `
    <p class="muted">Cliente: <strong>${esc(cliente.nombre)}</strong> · Saldo actual: <strong>${dinero(saldo)}</strong></p>
    <div class="field--row">
      <div class="field">
        <label for="mMonto">Monto *</label>
        <input id="mMonto" name="monto" type="number" min="0.5" step="0.5" inputmode="decimal" required value="${esPago && saldo > 0 ? saldo : ''}" placeholder="0.00" />
      </div>
      <div class="field">
        <label for="mFecha">Fecha</label>
        <input id="mFecha" name="fecha" type="date" value="${hoyISO()}" />
      </div>
    </div>
    <div class="field">
      <label for="mConcepto">Concepto</label>
      <input id="mConcepto" name="concepto" placeholder="${esPago ? 'Ej. abono semanal' : 'Ej. garrafones a crédito'}" />
    </div>
    <div class="form__actions">
      <button type="button" class="btn btn--ghost btn--lg grow" id="btnCancelar">Cancelar</button>
      <button type="submit" class="btn ${esPago ? 'btn--success' : 'btn--warn'} btn--lg grow">${esPago ? 'Registrar pago' : 'Registrar adeudo'}</button>
    </div>
  `;
  f.querySelector('#btnCancelar').addEventListener('click', cerrarModal);
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(f).entries());
    const monto = Number(fd.monto) || 0;
    if (monto <= 0) { toast('Ingresa un monto válido', 'error'); return; }
    const submit = f.querySelector('[type="submit"]');
    if (submit.disabled) return;
    submit.disabled = true;
    try { await registrarAdeudo({
      clienteId: cliente.id,
      tipo,
      monto: Math.round(monto * 100) / 100,
      fecha: fd.fecha || hoyISO(),
      concepto: (fd.concepto || '').trim(),
      creadoEn: new Date().toISOString()
    }); } catch (error) { toast(error.message, 'error'); submit.disabled = false; return; }
    toast(esPago ? 'Pago registrado' : 'Adeudo registrado', 'success');
    cerrarModal();
    await recargar();
  });
  abrirModal(esPago ? 'Registrar pago' : 'Registrar adeudo', f);
}

async function verHistorial(cliente) {
  const [pedidos, pagos] = await Promise.all([
    getByIndex(STORES.pedidos, 'clienteId', cliente.id),
    getByIndex(STORES.pagos, 'clienteId', cliente.id)
  ]);

  const movimientos = [];
  pedidos.forEach((p) => {
    if (esAdeudoPedido(p)) {
      // v2.6: mostrar resumen de líneas (ej: "3×20L + 2×10L")
      movimientos.push({ fecha: fechaVenta(p), tipo: 'cargo', etiqueta: `Cargo por pedido entregado (${resumenLineas(p)})`, monto: Number(p.total) || 0 });
    }
  });
  pagos.forEach((p) => {
    movimientos.push({
      fecha: p.fecha,
      tipo: p.tipo === 'pago' ? 'abono' : 'cargo',
      etiqueta: (p.anuladoEn ? 'ANULADO · ' : '') + (p.tipo === 'pago' ? `Pago · ${p.metodoPago || 'Método sin registrar'}` : 'Adeudo') + (p.concepto ? ` — ${p.concepto}` : ''),
      monto: Number(p.monto) || 0,
      pagoId: p.anuladoEn ? null : p.id
    });
  });
  movimientos.sort((a, b) => (b.fecha || '').localeCompare(a.fecha || ''));

  const cont = el('div', {});
  const saldo = _saldos.get(cliente.id) || 0;
  cont.appendChild(el('div', { class: 'card', style: 'background:var(--azul-claro);margin:0 0 14px' }, [
    el('div', { class: 'flex' }, [
      el('span', { class: 'grow', html: '<strong>Saldo actual</strong>' }),
      el('span', { style: 'font-size:1.4rem;font-weight:800', text: dinero(saldo) })
    ])
  ]));

  cont.appendChild(el('div', { class: 'btn-row mb' }, [
    el('button', { class: 'btn btn--success grow', text: '💵 Pago', onclick: () => { cerrarModal(); formPago(cliente, 'pago'); } }),
    el('button', { class: 'btn btn--warn grow', text: '➕ Adeudo', onclick: () => { cerrarModal(); formPago(cliente, 'adeudo'); } })
  ]));

  if (!movimientos.length) {
    cont.appendChild(el('p', { class: 'muted', text: 'Sin movimientos registrados.' }));
  } else {
    const lista = el('div', { class: 'list' });
    movimientos.forEach((m) => {
      const esAbono = m.tipo === 'abono';
      const item = el('div', { class: 'item' }, [
        el('div', { class: 'item__main' }, [
          el('div', { class: 'item__title', html: `${esAbono ? '🟢' : '🔴'} ${esc(m.etiqueta)}` }),
          el('div', { class: 'item__meta', text: fechaLegible(m.fecha) })
        ]),
        el('div', { class: 'flex' }, [
          el('span', { class: `badge ${esAbono ? 'badge--pago' : 'badge--adeudo'}`, text: `${esAbono ? '-' : '+'}${dinero(m.monto)}` }),
          m.pagoId ? el('button', { class: 'icon-btn icon-btn--danger', title: 'Anular movimiento', text: '🗑️', onclick: async () => {
            const ok = await confirmar('¿Anular este movimiento? Se conservará el registro y se recalculará el saldo.', { ok: 'Anular', peligro: true });
            if (!ok) return;
            try { await anularMovimiento(m.pagoId); } catch (error) { toast(error.message, 'error'); return; }
            toast('Movimiento anulado', 'success');
            cerrarModal();
            await recargar();
          } }) : null
        ])
      ]);
      lista.appendChild(item);
    });
    cont.appendChild(lista);
  }

  abrirModal(`Historial — ${cliente.nombre}`, cont);
}

function aplicarFiltros() {
  const q = ($('#buscarCobranza')?.value || '').toLowerCase().trim();
  const soloDeudores = $('#soloDeudores')?.checked;
  const cont = $('#listaCobranza');
  if (!cont) return;

  let lista = _clientes.slice();
  if (q) lista = lista.filter((c) => (c.nombre || '').toLowerCase().includes(q));
  if (soloDeudores) lista = lista.filter((c) => (_saldos.get(c.id) || 0) > 0.001);
  lista.sort((a, b) => (_saldos.get(b.id) || 0) - (_saldos.get(a.id) || 0) || (a.nombre || '').localeCompare(b.nombre || '', 'es'));

  cont.innerHTML = '';
  if (!lista.length) {
    cont.appendChild(el('div', { class: 'empty-state' }, [
      el('span', { class: 'emoji', text: '💵' }),
      el('p', { text: 'Sin clientes para mostrar.' })
    ]));
    return;
  }
  lista.forEach((c) => cont.appendChild(tarjetaSaldo(c)));
}

async function recargar() {
  [_clientes, _saldos] = await Promise.all([getAll(STORES.clientes), saldosTodos()]);
  pintarResumen();
  aplicarFiltros();
}

function pintarResumen() {
  let total = 0, deudores = 0;
  _clientes.forEach((c) => { const s = _saldos.get(c.id) || 0; if (s > 0.001) { total += s; deudores++; } });
  const box = $('#resumenCobranza');
  if (box) box.innerHTML = `<strong>${deudores}</strong> cliente(s) con adeudo · Total por cobrar: <strong>${esc(dinero(total))}</strong>`;
}

export async function render(root) {
  [_clientes, _saldos] = await Promise.all([getAll(STORES.clientes), saldosTodos()]);

  root.innerHTML = '';
  root.appendChild(el('div', { class: 'page-head' }, [ el('h2', { text: 'Cobranza' }), el('a', { href: '#/caja', class: 'btn btn--primary', text: 'Corte de caja' }) ]));
  root.appendChild(el('div', { class: 'card', id: 'resumenCobranza', style: 'background:var(--naranja-claro)' }));

  const toolbar = el('div', { class: 'toolbar' }, [
    el('input', { id: 'buscarCobranza', class: 'search', type: 'search', placeholder: '🔍 Buscar cliente', oninput: debounce(aplicarFiltros, 200) }),
    el('label', { class: 'flex', style: 'gap:6px' }, [
      el('input', { id: 'soloDeudores', type: 'checkbox', onchange: aplicarFiltros, style: 'width:24px;height:24px' }),
      el('span', { text: 'Solo con adeudo' })
    ])
  ]);
  root.appendChild(toolbar);
  root.appendChild(el('div', { id: 'listaCobranza', class: 'list' }));

  pintarResumen();
  aplicarFiltros();
}
