/**
 * pedidos.js — Registro y seguimiento de pedidos de garrafones.
 *
 * v2.6: un pedido puede tener MÚLTIPLES líneas (una por tamaño). Cada línea
 * tiene su propio tamaño, cantidad, precio y canje. Esto permite registrar
 * en un solo pedido "3×20L + 2×10L" en vez de tener que hacer dos pedidos.
 *
 * Modelo de datos:
 *  - Pedidos nuevos (v2.6+): { lineas: [{ tamano, cantidad, precioUnit, canjeCantidad }] }
 *  - Pedidos legacy (anteriores a v2.6): campos escalares tamano/cantidad/precioUnit/canjeCantidad
 *    Se normalizan a una línea implícita vía lineasDePedido().
 *
 * Al guardar, siempre se usa el formato nuevo (array lineas). Los pedidos
 * legacy no se modifican en disco a menos que se editen.
 */
import { STORES, getAll, getConfig } from '../db.js';
import {
  el, $, toast, abrirModal, cerrarModal, confirmar, esc, debounce,
  dinero, numero, hoyISO, fechaLegible, METODOS_PAGO, ESTADOS_PEDIDO, folioCliente,
  TAMANOS_GARRAFON, TAMANO_DEFAULT, tamanoPedido, lineasDePedido, cantidadTotalPedido, canjeTotalPedido, resumenLineas
} from '../utils.js';
import { cartera } from '../finanzas.js';
import { guardarPedido, eliminarPendiente } from '../libro.js';
import { formularioCobro } from './pago.js';
import { mapaClientes } from '../services.js';

let _pedidos = [];
let _clientes = [];
let _mapa = new Map();
let _cfg = {};
let _cuentas = new Map();

function estadoCobroVal(p) {
  if (!p || p.estado !== 'Entregado') return 'pendiente';
  return p.pagado === false ? 'credito' : 'pagado';
}

/** Insignia que refleja los 3 estados: pendiente / entregado y pagado / entregado a crédito. */
function estadoCobroBadge(p) {
  if (p.estado !== 'Entregado') return el('span', { class: 'badge badge--pend', text: '🟠 Pendiente' });
  const cuenta = _cuentas.get(p.id);
  if (cuenta?.pendiente > 0) return el('span', { class: 'badge badge--adeudo', text: `Entregado · ${cuenta.abonado > 0 ? 'Pago parcial' : 'Por cobrar'} · Debe ${dinero(cuenta.pendiente)}` });
  return el('span', { class: 'badge badge--entreg', text: '🟢 Entregado · Pagado' });
}

function tarjetaPedido(p) {
  const cli = _mapa.get(p.clienteId);
  const nombre = cli ? cli.nombre : '— Cliente eliminado —';
  const folio = cli ? folioCliente(cli) : null;
  const resumen = resumenLineas(p);
  const canjeT = canjeTotalPedido(p);
  const main = el('div', { class: 'item__main' }, [
    el('div', { class: 'item__title', html: `${folio ? `<span class="num-inline">N.º ${folio}</span> ` : ''}${esc(nombre)} · ${esc(resumen)}` }),
    el('div', { class: 'item__meta', html: `${esc(fechaLegible(p.fecha))} · ${esc(p.metodoPago || '')} · <strong>${dinero(p.total)}</strong>` }),
    el('div', { class: 'tag-line mt' }, [
      estadoCobroBadge(p),
      canjeT ? el('span', { class: 'badge badge--info', text: `🔄 ${canjeT} canje` }) : null,
      p.observaciones ? el('span', { class: 'badge badge--info', text: '📝 ' + p.observaciones.slice(0, 20) }) : null
    ])
  ]);
  const actions = el('div', { class: 'item__actions' }, []);
  if (p.estado === 'Pendiente') {
    actions.appendChild(el('button', {
      class: 'icon-btn icon-btn--ok', title: 'Marcar entregado', text: '✓',
      onclick: () => marcarEntregado(p)
    }));
  }
  if (p.estado === 'Entregado' && (_cuentas.get(p.id)?.pendiente || 0) > 0) actions.appendChild(el('button', { class: 'btn btn--success', text: 'Registrar pago', onclick: () => formularioCobro({ cliente: cli, pedidoId: p.id, saldo: _cuentas.get(p.id).pendiente, alGuardar: recargar }) }));
  if (p.estado !== 'Entregado') actions.appendChild(el('button', { class: 'icon-btn', title: 'Editar', text: '✏️', onclick: () => formularioPedido(p) }));
  if (p.estado !== 'Entregado') actions.appendChild(el('button', { class: 'icon-btn icon-btn--danger', title: 'Eliminar', text: '🗑️', onclick: () => eliminarPedido(p) }));
  return el('div', { class: 'item' }, [main, actions]);
}

function marcarEntregado(p) {
  formularioPedido({ ...p, _entregar: true });
}

async function eliminarPedido(p) {
  if (!await confirmar('¿Eliminar este pedido pendiente?', { ok: 'Eliminar', peligro: true })) return;
  try { await eliminarPendiente(p.id); toast('Pedido eliminado', 'success'); await recargar(); }
  catch (error) { toast(error.message, 'error'); }
}

/* ===========================================================
   FORMULARIO DE PEDIDO (múltiples líneas)
   =========================================================== */

let _lineaIdCounter = 0;
function nuevaLineaId() { return 'linea_' + (++_lineaIdCounter) + '_' + Date.now(); }

function crearLinea(lineaExistente = null) {
  const preciosPorTamano = _cfg.preciosPorTamano || {};
  const tamanoInicial = lineaExistente?.tamano || TAMANO_DEFAULT;
  const linea = {
    id: nuevaLineaId(),
    tamano: tamanoInicial,
    cantidad: lineaExistente?.cantidad ?? 1,
    precioUnit: lineaExistente?.precioUnit ?? (preciosPorTamano[tamanoInicial] ?? 0),
    canjeCantidad: lineaExistente?.canjeCantidad ?? 0
  };
  return linea;
}

function renderLinea(linea, contenedor) {
  const preciosPorTamano = _cfg.preciosPorTamano || {};
  const preciosCanjePorTamano = _cfg.preciosCanjePorTamano || {};
  const fila = el('div', { class: 'linea-pedido', 'data-linea-id': linea.id, style: 'border:1px solid var(--bordo,#e0e0e0);border-radius:8px;padding:10px;margin-bottom:8px;background:var(--gris-claro,#f8f9fa)' });

  const tamanoSelect = el('select', { class: 'linea__tamano', style: 'width:100%' });
  tamanoSelect.innerHTML = TAMANOS_GARRAFON.map((t) =>
    `<option value="${esc(t)}" ${linea.tamano === t ? 'selected' : ''}>${esc(t)} (sugerido: ${dinero(preciosPorTamano[t] ?? 0)})</option>`
  ).join('');
  tamanoSelect.addEventListener('change', () => {
    linea.tamano = tamanoSelect.value;
    // Sugerir precio solo si el usuario no lo había editado manualmente
    const precioInput = fila.querySelector('.linea__precio');
    const sugerido = preciosPorTamano[linea.tamano] ?? 0;
    if (!fila.dataset.precioEditado || fila.dataset.precioEditado === 'false') {
      precioInput.value = sugerido;
      linea.precioUnit = sugerido;
    }
    actualizarHintCanje(fila, linea);
    recalcularTotal();
  });

  const cantidadInput = el('input', {
    class: 'linea__cantidad', type: 'number', min: '1', step: '1', inputmode: 'numeric',
    value: String(linea.cantidad), style: 'width:100%'
  });
  cantidadInput.addEventListener('input', () => {
    linea.cantidad = Number(cantidadInput.value) || 0;
    recalcularTotal();
  });

  const precioInput = el('input', {
    class: 'linea__precio', type: 'number', min: '0', step: '0.5', inputmode: 'decimal',
    value: String(linea.precioUnit), style: 'width:100%'
  });
  precioInput.addEventListener('input', () => {
    linea.precioUnit = Number(precioInput.value) || 0;
    const sugerido = preciosPorTamano[linea.tamano] ?? 0;
    fila.dataset.precioEditado = String(linea.precioUnit !== sugerido);
    recalcularTotal();
  });

  const canjeInput = el('input', {
    class: 'linea__canje', type: 'number', min: '0', step: '1', inputmode: 'numeric',
    value: String(linea.canjeCantidad), style: 'width:100%'
  });
  canjeInput.addEventListener('input', () => {
    linea.canjeCantidad = Number(canjeInput.value) || 0;
    recalcularTotal();
  });

  const btnQuitar = el('button', {
    type: 'button', class: 'btn btn--ghost btn--sm', title: 'Quitar esta línea', text: '🗑️',
    onclick: () => {
      const idx = _lineasActuales.findIndex((l) => l.id === linea.id);
      if (idx >= 0) _lineasActuales.splice(idx, 1);
      fila.remove();
      recalcularTotal();
      // Si solo queda una línea, ocultar su botón de quitar
      actualizarBotonesQuitar();
    }
  });

  fila.innerHTML = `
    <div class="field--row" style="align-items:end;gap:8px">
      <div class="field" style="flex:0 0 90px">
        <label style="font-weight:700;font-size:.85rem">Tamaño</label>
      </div>
      <div class="field" style="flex:1 1 80px">
        <label style="font-weight:700;font-size:.85rem">Cantidad</label>
      </div>
      <div class="field" style="flex:1 1 100px">
        <label style="font-weight:700;font-size:.85rem">Precio c/u</label>
      </div>
      <div class="field" style="flex:1 1 80px">
        <label style="font-weight:700;font-size:.85rem">Canje</label>
      </div>
      <div class="field" style="flex:0 0 40px"></div>
    </div>
    <div class="field--row" style="align-items:end;gap:8px">
      <div class="field" style="flex:0 0 90px" data-slot="tamano"></div>
      <div class="field" style="flex:1 1 80px" data-slot="cantidad"></div>
      <div class="field" style="flex:1 1 100px" data-slot="precio"></div>
      <div class="field" style="flex:1 1 80px" data-slot="canje"></div>
      <div class="field" style="flex:0 0 40px" data-slot="quitar"></div>
    </div>
    <p class="hint" style="margin:4px 0 0;font-size:.75rem" data-slot="hintCanje"></p>
  `;
  fila.querySelector('[data-slot="tamano"]').appendChild(tamanoSelect);
  fila.querySelector('[data-slot="cantidad"]').appendChild(cantidadInput);
  fila.querySelector('[data-slot="precio"]').appendChild(precioInput);
  fila.querySelector('[data-slot="canje"]').appendChild(canjeInput);
  fila.querySelector('[data-slot="quitar"]').appendChild(btnQuitar);

  contenedor.appendChild(fila);
  actualizarHintCanje(fila, linea);

  function actualizarHintCanje(f, l) {
    const hint = f.querySelector('[data-slot="hintCanje"]');
    if (!hint) return;
    const canjeSugerido = preciosCanjePorTamano[l.tamano] ?? 0;
    hint.textContent = `Canje: +${dinero(canjeSugerido)} c/u · descuenta garrafón nuevo de ${l.tamano} al entregar`;
  }

  return fila;
}

let _lineasActuales = [];
let _formRef = null;
let _recalcTotalFn = null;

function actualizarBotonesQuitar() {
  if (!_formRef) return;
  const botones = _formRef.querySelectorAll('.linea-pedido button[title*="Quitar"]');
  botones.forEach((b) => {
    b.style.display = _lineasActuales.length > 1 ? '' : 'none';
  });
}

function recalcularTotal() {
  if (!_formRef) return;
  const preciosCanjePorTamano = _cfg.preciosCanjePorTamano || {};
  let total = 0;
  _lineasActuales.forEach((l) => {
    const cant = Number(l.cantidad) || 0;
    const pu = Number(l.precioUnit) || 0;
    const canje = Number(l.canjeCantidad) || 0;
    const precioCanje = preciosCanjePorTamano[l.tamano] ?? 0;
    total += cant * pu + canje * precioCanje;
  });
  const span = _formRef.querySelector('#pTotal');
  if (span) span.textContent = dinero(Math.round(total * 100) / 100);
}

function formularioPedido(pedido = {}) {
  const esEdit = !!pedido.id;
  if (!_clientes.length) {
    toast('Primero registra al menos un cliente', 'warn');
    window.navegar('clientes/nuevo');
    return;
  }
  const f = el('form', { class: 'form' });
  _formRef = f;
  const cobroActual = pedido._entregar ? 'credito' : estadoCobroVal(pedido);

  // Inicializar líneas: si es edición, cargar las existentes; si no, una línea vacía
  _lineasActuales = lineasDePedido(pedido).map((l) => crearLinea(l));
  if (!_lineasActuales.length) _lineasActuales.push(crearLinea());

  f.innerHTML = `
    <div class="field">
      <label for="pCliente">Cliente *</label>
      <select id="pCliente" name="clienteId" required>
        <option value="">Selecciona…</option>
        ${_clientes.map((c) => `<option value="${c.id}" ${pedido.clienteId === c.id ? 'selected' : ''}>N.º ${folioCliente(c)} · ${esc(c.nombre)}${c.colonia ? ' — ' + esc(c.colonia) : ''}</option>`).join('')}
      </select>
    </div>
    <div class="field--row">
      <div class="field">
        <label for="pFecha">Fecha del pedido *</label>
        <input id="pFecha" name="fecha" type="date" required value="${esc(pedido.fecha || hoyISO())}" />
      </div>
    </div>
    <div class="field">
      <label style="font-weight:700">🛢️ Garrafones por tamaño</label>
      <p class="hint" style="margin:0 0 8px">Agrega una línea por cada tamaño que el cliente quiera. El total se calcula automáticamente.</p>
      <div id="pLineas"></div>
      <button type="button" class="btn btn--ghost btn--sm" id="btnAgregarLinea" style="margin-top:6px">➕ Agregar otro tamaño</button>
    </div>
    <div class="field--row">
      <div class="field">
        <label for="pCobro">Estado del pedido</label>
        <select id="pCobro" name="cobro">
          <option value="pendiente" ${cobroActual === 'pendiente' ? 'selected' : ''}>🟠 Pendiente (en camino)</option>
          <option value="pagado" ${cobroActual === 'pagado' ? 'selected' : ''}>🟢 Entregado y pagado</option>
          <option value="parcial">🟡 Entregado con pago parcial</option>
          <option value="credito" ${cobroActual === 'credito' ? 'selected' : ''}>🔴 Entregado a crédito (debe)</option>
        </select>
      </div>
      <div class="field">
        <label for="pMetodo">Método de pago</label>
        <select id="pMetodo" name="metodoPago">
          ${METODOS_PAGO.map((x) => `<option ${pedido.metodoPago === x ? 'selected' : ''}>${x}</option>`).join('')}
        </select>
      </div>
    </div>
    <div class="field" id="pAbonoField" hidden>
      <label for="pAbono">Abono recibido hoy</label>
      <input id="pAbono" name="abono" type="number" min="0.01" step="0.01" />
    </div>
    <p class="hint">La entrega y el cobro se registran con la fecha de hoy. La fecha del pedido se conserva.</p>
    <div class="field">
      <label for="pObs">Observaciones</label>
      <textarea id="pObs" name="observaciones" placeholder="Notas del pedido">${esc(pedido.observaciones || '')}</textarea>
    </div>
    <div class="card" style="margin:0;background:var(--azul-claro)">
      <div class="flex"><span class="grow"><strong>Total</strong></span><span id="pTotal" style="font-size:1.4rem;font-weight:800">$0</span></div>
      <p class="hint" style="margin:6px 0 0">Si el pedido queda "a crédito", el adeudo aparece automáticamente en Cobranza.</p>
    </div>
    <div class="form__actions">
      <button type="button" class="btn btn--ghost btn--lg grow" id="btnCancelar">Cancelar</button>
      <button type="submit" class="btn btn--primary btn--lg grow">${esEdit ? 'Guardar' : 'Registrar'}</button>
    </div>
  `;

  const actualizarCobro = () => {
    const parcial = f.querySelector('#pCobro').value === 'parcial';
    f.querySelector('#pAbonoField').hidden = !parcial;
    f.querySelector('#pAbono').required = parcial;
  };
  f.querySelector('#pCobro').addEventListener('change', actualizarCobro);
  actualizarCobro();
  // Renderizar las líneas iniciales
  const lineasCont = f.querySelector('#pLineas');
  _lineasActuales.forEach((l) => renderLinea(l, lineasCont));
  actualizarBotonesQuitar();

  // Botón "Agregar otro tamaño"
  f.querySelector('#btnAgregarLinea').addEventListener('click', () => {
    const nueva = crearLinea();
    _lineasActuales.push(nueva);
    renderLinea(nueva, lineasCont);
    actualizarBotonesQuitar();
    recalcularTotal();
  });

  f.querySelector('#btnCancelar').addEventListener('click', cerrarModal);

  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(f).entries());
    if (!fd.clienteId) { toast('Selecciona un cliente', 'error'); return; }

    // Validar y construir las líneas definitivas
    const lineas = _lineasActuales.map((l) => ({
      tamano: l.tamano || TAMANO_DEFAULT,
      cantidad: Math.max(0, Math.floor(Number(l.cantidad) || 0)),
      precioUnit: Number(l.precioUnit) || 0,
      canjeCantidad: Math.max(0, Math.floor(Number(l.canjeCantidad) || 0))
    })).filter((l) => l.cantidad > 0 || l.canjeCantidad > 0);

    if (!lineas.length) {
      toast('Agrega al menos una línea con cantidad mayor a 0', 'error');
      return;
    }

    // Estado de cobro
    const cobro = fd.cobro || 'pendiente';
    let estado = 'Pendiente';
    let pagado = false;
    if (cobro === 'pagado') { estado = 'Entregado'; pagado = true; }
    else if (cobro === 'credito' || cobro === 'parcial') { estado = 'Entregado'; pagado = false; }

    // Calcular total final
    const preciosCanjePorTamano = _cfg.preciosCanjePorTamano || {};
    const total = Math.round(lineas.reduce((s, l) => {
      const precioCanje = preciosCanjePorTamano[l.tamano] ?? 0;
      return s + l.cantidad * l.precioUnit + l.canjeCantidad * precioCanje;
    }, 0) * 100) / 100;

    const registro = {
      ...pedido,
      clienteId: Number(fd.clienteId),
      fecha: fd.fecha,
      lineas,
      total,
      estado,
      pagado,
      metodoPago: fd.metodoPago,
      observaciones: (fd.observaciones || '').trim()
    };
    if (estado === 'Entregado' && !registro.entregadoEn) registro.entregadoEn = new Date().toISOString();
    if (estado === 'Pendiente') delete registro.entregadoEn;

    // Mantener campos legacy sincronizados (para que reportes/exports viejos sigan funcionando)
    // Tomamos la primera línea como representativa para los campos escalares.
    const primera = lineas[0];
    registro.tamano = primera.tamano;
    registro.cantidad = lineas.reduce((s, l) => s + l.cantidad, 0);
    registro.precioUnit = primera.precioUnit;
    registro.canjeCantidad = lineas.reduce((s, l) => s + l.canjeCantidad, 0);
    registro.precioCanje = preciosCanjePorTamano[primera.tamano] ?? 0;

    const cobrado = cobro === 'pagado' ? total : cobro === 'parcial' ? Number(fd.abono) : 0;
    if (cobro === 'parcial' && (!Number.isFinite(cobrado) || cobrado <= 0 || cobrado >= total)) { toast('El abono debe ser mayor a cero y menor al total.', 'error'); return; }
    const submit = f.querySelector('[type="submit"]');
    if (submit.disabled) return;
    submit.disabled = true;
    try {
      delete registro._entregar;
      await guardarPedido(registro, cobrado);
      toast(esEdit ? 'Pedido actualizado' : 'Pedido registrado', 'success');
    } catch (error) { toast(error.message, 'error'); submit.disabled = false; return; }
    _formRef = null;
    _lineasActuales = [];
    cerrarModal();
    await recargar();
  });

  abrirModal(esEdit ? 'Editar pedido' : 'Nuevo pedido', f);
  recalcularTotal();
}

function aplicarFiltros() {
  const estado = $('#filtroEstado')?.value || '';
  const tam = $('#filtroTamano')?.value || '';
  const q = ($('#buscarPedido')?.value || '').toLowerCase().trim();
  const cont = $('#listaPedidos');
  if (!cont) return;

  let lista = _pedidos.slice();
  if (estado) lista = lista.filter((p) => p.estado === estado);
  if (tam) lista = lista.filter((p) => lineasDePedido(p).some((l) => l.tamano === tam));
  if (q) lista = lista.filter((p) => {
    const cli = _mapa.get(p.clienteId);
    const r = resumenLineas(p).toLowerCase();
    return (cli?.nombre || '').toLowerCase().includes(q)
      || (cli ? folioCliente(cli) : '').includes(q)
      || (p.observaciones || '').toLowerCase().includes(q)
      || r.includes(q);
  });
  lista.sort((a, b) => (b.fecha || '').localeCompare(a.fecha || '') || (b.id - a.id));

  cont.innerHTML = '';
  if (!lista.length) {
    cont.appendChild(el('div', { class: 'empty-state' }, [
      el('span', { class: 'emoji', text: '📦' }),
      el('p', { text: 'No hay pedidos que coincidan.' })
    ]));
    return;
  }
  lista.forEach((p) => cont.appendChild(tarjetaPedido(p)));
}

async function recargar() {
  [_pedidos, _clientes] = await Promise.all([getAll(STORES.pedidos), getAll(STORES.clientes)]);
  _mapa = await mapaClientes();
  _cuentas = cartera(_pedidos, await getAll(STORES.pagos)).porPedido;
  aplicarFiltros();
}

export async function render(root, params = []) {
  [_pedidos, _clientes, _cfg] = await Promise.all([getAll(STORES.pedidos), getAll(STORES.clientes), getConfig()]);
  _mapa = new Map(_clientes.map((c) => [c.id, c]));
  _cuentas = cartera(_pedidos, await getAll(STORES.pagos)).porPedido;

  root.innerHTML = '';
  root.appendChild(el('div', { class: 'page-head' }, [
    el('h2', { text: `Pedidos (${_pedidos.length})` }),
    el('button', { class: 'btn btn--primary', text: '➕ Nuevo', onclick: () => formularioPedido() })
  ]));

  const toolbar = el('div', { class: 'toolbar' }, [
    el('input', { id: 'buscarPedido', class: 'search', type: 'search', placeholder: '🔍 Buscar por cliente, N.º, tamaño u observación', oninput: debounce(aplicarFiltros, 200) }),
    (() => {
      const s = el('select', { id: 'filtroEstado', onchange: aplicarFiltros });
      s.innerHTML = '<option value="">Todos los estados</option>' + ESTADOS_PEDIDO.map((x) => `<option>${x}</option>`).join('');
      return s;
    })(),
    (() => {
      const s = el('select', { id: 'filtroTamano', onchange: aplicarFiltros });
      s.innerHTML = '<option value="">Todos los tamaños</option>' + TAMANOS_GARRAFON.map((t) => `<option value="${t}">${t}</option>`).join('');
      return s;
    })()
  ]);
  root.appendChild(toolbar);

  root.appendChild(el('div', { id: 'listaPedidos', class: 'list' }));
  root.appendChild(el('button', { class: 'fab', title: 'Nuevo pedido', text: '＋', onclick: () => formularioPedido() }));

  aplicarFiltros();
  if (params[0] === 'nuevo') formularioPedido(params[1] ? { clienteId: Number(params[1]) } : {});
}
