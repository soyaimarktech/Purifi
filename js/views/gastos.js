/**
 * gastos.js — Registro de gastos operativos para medir la utilidad real.
 * Categorías basadas en los costos reales del negocio (nómina, insumos,
 * gasolina, renta, filtros, servicios). Permite ver el total por periodo,
 * el desglose por categoría y exportar.
 */
import { STORES, getAll, add, put, remove } from '../db.js';
import {
  el, $, toast, abrirModal, cerrarModal, confirmar, esc,
  dinero, hoyISO, fechaLegible, inicioSemanaISO, inicioMesISO, nombreMes,
  METODOS_PAGO, GASTO_CATEGORIAS
} from '../utils.js';
import { filtrarPorFecha, gastosPorCategoria } from '../services.js';
import { exportarExcel, exportarPDF } from '../export.js';

let _gastos = [];
let _periodo = 'mes';

function rango(periodo) {
  const hoy = hoyISO();
  if (periodo === 'dia') return { desde: hoy, hasta: hoy, titulo: `Gastos del día · ${fechaLegible(hoy)}` };
  if (periodo === 'semana') return { desde: inicioSemanaISO(), hasta: hoy, titulo: 'Gastos de la semana' };
  return { desde: inicioMesISO(), hasta: hoy, titulo: `Gastos del mes · ${nombreMes()}` };
}

function gastosDelPeriodo() {
  const { desde, hasta } = rango(_periodo);
  return filtrarPorFecha(_gastos, desde, hasta)
    .slice()
    .sort((a, b) => (b.fecha || '').localeCompare(a.fecha || '') || (b.id || 0) - (a.id || 0));
}

/* ---------- Formulario ---------- */
function formularioGasto(gasto = {}) {
  const esEdit = !!gasto.id;
  const f = el('form', { class: 'form' });
  f.innerHTML = `
    <div class="field--row">
      <div class="field">
        <label for="gMonto">Monto *</label>
        <input id="gMonto" name="monto" type="number" min="0.5" step="0.5" inputmode="decimal" required value="${gasto.monto != null ? gasto.monto : ''}" placeholder="0.00" />
      </div>
      <div class="field">
        <label for="gFecha">Fecha</label>
        <input id="gFecha" name="fecha" type="date" value="${gasto.fecha || hoyISO()}" />
      </div>
    </div>
    <div class="field">
      <label for="gMetodo">Método de pago *</label>
      <select id="gMetodo" name="metodoPago" required>
        <option value="">Selecciona…</option>
        ${METODOS_PAGO.map(m => `<option ${gasto.metodoPago === m ? 'selected' : ''}>${m}</option>`).join('')}
      </select>
    </div>
    <div class="field">
      <label for="gCategoria">Categoría *</label>
      <select id="gCategoria" name="categoria" required>
        ${GASTO_CATEGORIAS.map((c) => `<option ${gasto.categoria === c ? 'selected' : ''}>${esc(c)}</option>`).join('')}
      </select>
    </div>
    <div class="field">
      <label for="gConcepto">Concepto / nota</label>
      <input id="gConcepto" name="concepto" placeholder="Ej. pago de tapas, gasolina semana, etc." value="${esc(gasto.concepto || '')}" />
    </div>
    <div class="form__actions">
      <button type="button" class="btn btn--ghost btn--lg grow" id="btnCancelar">Cancelar</button>
      <button type="submit" class="btn btn--primary btn--lg grow">${esEdit ? 'Guardar cambios' : 'Registrar gasto'}</button>
    </div>
  `;
  f.querySelector('#btnCancelar').addEventListener('click', cerrarModal);
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(f).entries());
    const monto = Number(fd.monto) || 0;
    if (!Number.isFinite(monto) || monto <= 0) { toast('Ingresa un monto válido', 'error'); return; }
    const submit = f.querySelector('[type="submit"]');
    if (submit.disabled) return;
    submit.disabled = true;
    const registro = {
      metodoPago: fd.metodoPago,
      categoria: fd.categoria || 'Otros',
      monto: Math.round(monto * 100) / 100,
      fecha: fd.fecha || hoyISO(),
      concepto: (fd.concepto || '').trim()
    };
    try { if (esEdit) {
      await put(STORES.gastos, { ...gasto, ...registro });
      toast('Gasto actualizado', 'success');
    } else {
      await add(STORES.gastos, { ...registro, creadoEn: new Date().toISOString() });
      toast('Gasto registrado', 'success');
    } } catch (error) { toast(error.message, 'error'); submit.disabled = false; return; }
    cerrarModal();
    await recargar();
  });
  abrirModal(esEdit ? 'Editar gasto' : 'Nuevo gasto', f);
}

async function eliminarGasto(g) {
  const ok = await confirmar(`¿Eliminar el gasto de ${dinero(g.monto)} (${g.categoria})?`, { ok: 'Eliminar', peligro: true });
  if (!ok) return;
  await remove(STORES.gastos, g.id);
  toast('Gasto eliminado', 'success');
  await recargar();
}

/* ---------- Tarjeta ---------- */
function tarjetaGasto(g) {
  const main = el('div', { class: 'item__main' }, [
    el('div', { class: 'item__title', text: g.categoria || 'Otros' }),
    el('div', { class: 'item__meta', html: `${fechaLegible(g.fecha)}${g.concepto ? ' · ' + esc(g.concepto) : ''}` })
  ]);
  const monto = el('span', { class: 'badge badge--adeudo', text: dinero(g.monto) });
  const actions = el('div', { class: 'item__actions' }, [
    monto,
    el('button', { class: 'icon-btn', title: 'Editar', text: '✏️', onclick: () => formularioGasto(g) }),
    el('button', { class: 'icon-btn icon-btn--danger', title: 'Eliminar', text: '🗑️', onclick: () => eliminarGasto(g) })
  ]);
  return el('div', { class: 'item' }, [main, actions]);
}

/* ---------- Exportaciones ---------- */
function expExcel() {
  const lista = gastosDelPeriodo();
  if (!lista.length) { toast('No hay gastos en el periodo', 'info'); return; }
  exportarExcel(`gastos-${_periodo}-${hoyISO()}`, [
    {
      nombre: 'Gastos',
      rows: lista.map((g) => ({ Fecha: g.fecha, Categoria: g.categoria, Concepto: g.concepto || '', Monto: g.monto })),
    }
  ]);
  toast('Excel generado', 'success');
}

async function expPDF() {
  const { desde, hasta, titulo } = rango(_periodo);
  const lista = gastosDelPeriodo();
  if (!lista.length) { toast('No hay gastos en el periodo', 'info'); return; }
  const total = lista.reduce((s, g) => s + (Number(g.monto) || 0), 0);
  const porCat = gastosPorCategoria(_gastos, desde, hasta);
  await exportarPDF(`gastos-${_periodo}-${hoyISO()}`, titulo, [
    {
      titulo: 'Gastos por categoría',
      columns: [{ label: 'Categoría' }, { label: 'Total' }],
      rows: porCat.map((c) => [c.categoria, dinero(c.total)]),
      resumen: `Total de gastos del periodo: ${dinero(total)}.`
    },
    {
      titulo: 'Detalle de gastos',
      columns: [{ label: 'Fecha' }, { label: 'Categoría' }, { label: 'Concepto' }, { label: 'Monto' }],
      rows: lista.map((g) => [fechaLegible(g.fecha), g.categoria, g.concepto || '—', dinero(g.monto)])
    }
  ]);
  toast('PDF generado', 'success');
}

/* ---------- Render ---------- */
function pintar() {
  const { desde, hasta } = rango(_periodo);
  const lista = gastosDelPeriodo();
  const total = lista.reduce((s, g) => s + (Number(g.monto) || 0), 0);
  const porCat = gastosPorCategoria(_gastos, desde, hasta);

  const resumen = $('#resumenGastos');
  if (resumen) {
    resumen.innerHTML = `<strong>${lista.length}</strong> gasto(s) en el periodo · Total: <strong>${esc(dinero(total))}</strong>`;
  }

  const cont = $('#listaGastos');
  if (!cont) return;
  cont.innerHTML = '';

  if (porCat.length) {
    const chips = el('div', { class: 'tag-line mb' }, porCat.map((c) =>
      el('span', { class: 'badge badge--info', text: `${c.categoria}: ${dinero(c.total)}` })));
    cont.appendChild(chips);
  }

  if (!lista.length) {
    cont.appendChild(el('div', { class: 'empty-state' }, [
      el('span', { class: 'emoji', text: '🧾' }),
      el('p', { text: 'Sin gastos en este periodo. Registra el primero con el botón “＋ Nuevo gasto”.' })
    ]));
    return;
  }
  const list = el('div', { class: 'list' });
  lista.forEach((g) => list.appendChild(tarjetaGasto(g)));
  cont.appendChild(list);
}

async function recargar() {
  _gastos = await getAll(STORES.gastos);
  pintar();
}

export async function render(root) {
  _gastos = await getAll(STORES.gastos);

  root.innerHTML = '';
  root.appendChild(el('div', { class: 'page-head' }, [
    el('h2', { text: 'Gastos' }),
    el('button', { class: 'btn btn--primary', text: '＋ Nuevo gasto', onclick: () => formularioGasto() })
  ]));

  root.appendChild(el('div', { class: 'card', id: 'resumenGastos', style: 'background:var(--naranja-claro)' }));

  const selPeriodo = el('select', { id: 'selPeriodoGasto', onchange: (e) => { _periodo = e.target.value; pintar(); } });
  selPeriodo.innerHTML = `
    <option value="dia">Hoy</option>
    <option value="semana">Esta semana</option>
    <option value="mes" selected>Este mes</option>`;

  root.appendChild(el('div', { class: 'toolbar' }, [
    el('label', { class: 'flex grow', style: 'gap:8px' }, [el('span', { text: 'Periodo:' }), selPeriodo]),
    el('div', { class: 'btn-row' }, [
      el('button', { class: 'btn btn--success', text: '📊 Excel', onclick: expExcel }),
      el('button', { class: 'btn btn--danger', text: '📄 PDF', onclick: expPDF })
    ])
  ]));

  root.appendChild(el('div', { id: 'listaGastos' }));

  pintar();
}
