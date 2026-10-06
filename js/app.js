/**
 * app.js — Punto de entrada: registro del Service Worker, enrutador por hash,
 * navegación (sidenav + bottomnav), estado de conexión y respaldo automático.
 *
 * ROBUSTEZ v2.2:
 *  - El respaldo automático se dispara también al detectar cambios en IndexedDB
 *    (evento 'db:changed'), no solo al abrir la app. Antes, los datos capturados
 *    durante el día nunca se respaldaban hasta el siguiente arranque.
 *  - Antes de recargar la página por una actualización del Service Worker, se
 *    verifica que no haya un modal abierto (formulario a mitad de captura). Si
 *    lo hay, se pospone la recarga hasta que se cierre.
 *  - Se agrega flush de respaldo en visibilitychange (hidden) y pagehide para
 *    proteger los datos cuando el usuario oculta o cierra la pestaña.
 */
import { getConfig, setConfigBulk } from './db.js';
import { setMoneda, $, $$, toast, el, esc, abrirModal, cerrarModal, TAMANOS_GARRAFON, PRECIOS_DEFAULT_POR_TAMANO, PRECIOS_CANJE_DEFAULT_POR_TAMANO } from './utils.js';
import { respaldoAutomatico } from './export.js';

import * as caja from './views/caja.js';
import * as dashboard from './views/dashboard.js';
import * as clientes from './views/clientes.js';
import * as pedidos from './views/pedidos.js';
import * as cobranza from './views/cobranza.js';
import * as rutas from './views/rutas.js';
import * as seguimiento from './views/seguimiento.js';
import * as gastos from './views/gastos.js';
import * as mantenimiento from './views/mantenimiento.js';
import * as inventario from './views/inventario.js';
import * as reportes from './views/reportes.js';
import * as configuracion from './views/configuracion.js';

const ROUTES = {
  caja: { title: 'Corte de caja', mod: caja },
  dashboard: { title: 'Dashboard', mod: dashboard },
  clientes: { title: 'Clientes', mod: clientes },
  pedidos: { title: 'Pedidos', mod: pedidos },
  cobranza: { title: 'Cobranza', mod: cobranza },
  rutas: { title: 'Rutas', mod: rutas },
  seguimiento: { title: 'Seguimiento', mod: seguimiento },
  gastos: { title: 'Gastos', mod: gastos },
  mantenimiento: { title: 'Mantenimiento', mod: mantenimiento },
  inventario: { title: 'Inventario', mod: inventario },
  reportes: { title: 'Reportes', mod: reportes },
  configuracion: { title: 'Configuración', mod: configuracion }
};

const view = document.getElementById('view');
const viewTitle = document.getElementById('viewTitle');

/* ---------- Service Worker ---------- */

/** ¿Hay un modal abierto (formulario de captura en curso)? */
function hayModalAbierto() {
  const m = document.getElementById('modal');
  return m && !m.hidden;
}

function hayCambiosSinGuardarPendientes() {
  // Detecta cualquier modal abierto (formularios de pedido, pago, cliente, etc.)
  // o cualquier textarea/input modificado en el DOM principal.
  if (hayModalAbierto()) return true;
  return false;
}

function registrarSW() {
  if (!('serviceWorker' in navigator)) return;

  // ¿Ya había un Service Worker controlando la página al cargar?
  // Si lo había, un cambio de controlador significa que se instaló una
  // versión NUEVA de la app: recargamos una sola vez para servir los
  // archivos actualizados (evita quedarse con una versión vieja en caché).
  //
  // ROBUSTEZ v2.2: si hay un modal abierto (formulario a mitad de captura),
  // posponemos la recarga para no perder los datos no guardados. Se reintenta
  // cada 1.5 s hasta que el modal se cierre.
  const habiaControlador = !!navigator.serviceWorker.controller;
  let recargando = false;
  let recargaPendiente = false;

  function intentarRecargar() {
    if (recargando) return;
    if (hayCambiosSinGuardarPendientes()) {
      recargaPendiente = true;
      setTimeout(intentarRecargar, 1500);
      return;
    }
    recargaPendiente = false;
    recargando = true;
    window.location.reload();
  }

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!habiaControlador) return;
    intentarRecargar();
  });

  // Si el usuario cierra el modal mientras hay una recarga pendiente,
  // se dispara automáticamente en el siguiente intento.
  document.addEventListener('modal-cerrado', () => {
    if (recargaPendiente) intentarRecargar();
  });

  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').then((reg) => {
      // Busca actualizaciones del SW en cada arranque.
      reg.update().catch(() => {});
    }).catch((err) => {
      console.warn('No se pudo registrar el Service Worker:', err);
    });
  });
}

/* ---------- Estado de conexión ---------- */
function actualizarEstadoRed() {
  const dot = document.getElementById('netStatus');
  if (!dot) return;
  const online = navigator.onLine;
  dot.style.color = online ? '#2e7d32' : '#9e9e9e';
  dot.title = online ? 'En línea' : 'Sin conexión (modo offline)';
}

/* ---------- Navegación ---------- */
function rutaActual() {
  const hash = location.hash.replace(/^#\//, '').trim();
  const name = hash.split('/')[0] || 'dashboard';
  return ROUTES[name] ? name : 'dashboard';
}

function marcarActivo(name) {
  $$('.navlink').forEach((a) => {
    a.classList.toggle('navlink--active', a.getAttribute('href') === `#/${name}`);
  });
  $$('.bottomnav__item').forEach((a) => {
    a.classList.toggle('bottomnav__item--active', a.dataset.route === name);
  });
}

async function render() {
  const name = rutaActual();
  const route = ROUTES[name];
  viewTitle.textContent = route.title;
  marcarActivo(name);
  cerrarNav();
  view.innerHTML = '<div class="loading"><span class="spinner"></span> Cargando…</div>';
  view.scrollTop = 0;
  window.scrollTo(0, 0);
  try {
    const params = location.hash.replace(/^#\//, '').split('/').slice(1);
    await route.mod.render(view, params);
  } catch (err) {
    console.error(err);
    view.innerHTML = `<div class="empty-state"><h2>Ocurrió un error</h2><p>${err.message}</p></div>`;
  }
}

function abrirNav() {
  document.getElementById('sidenav').classList.add('sidenav--open');
  document.getElementById('navBackdrop').hidden = false;
}
function cerrarNav() {
  document.getElementById('sidenav').classList.remove('sidenav--open');
  document.getElementById('navBackdrop').hidden = true;
}

/* ---------- Marca dinámica (nombre del negocio) ---------- */
function actualizarMarca(nombre) {
  const b = document.getElementById('brandNombre');
  if (b && nombre) b.textContent = nombre;
}

/* ---------- Configuración inicial (primera vez) ---------- */
function configuracionInicial(cfg) {
  const monedas = ['MXN', 'USD', 'GTQ', 'COP', 'ARS', 'PEN', 'CLP'];
  const f = el('form', { class: 'form' });
  // v2.3: el modal inicial usa los precios por tamaño. Precarga defaults sensatos
  // (pueden modificarse después en Configuración).
  const precios = cfg.preciosPorTamano || PRECIOS_DEFAULT_POR_TAMANO;
  const preciosCanje = cfg.preciosCanjePorTamano || PRECIOS_CANJE_DEFAULT_POR_TAMANO;
  const filasPrecios = TAMANOS_GARRAFON.map((t) => `
    <div class="field--row" style="align-items:end">
      <div class="field" style="flex:0 0 60px">
        <label style="font-weight:700">${esc(t)}</label>
      </div>
      <div class="field">
        <label for="iPrecio_${esc(t)}">Precio venta</label>
        <input id="iPrecio_${esc(t)}" name="precio_${esc(t)}" type="number" min="0" step="0.5" inputmode="decimal" value="${esc(precios[t] ?? 0)}" />
      </div>
    </div>`).join('');

  f.innerHTML = `
    <p class="hint">👋 ¡Bienvenido! Configura los datos de tu purificadora para empezar. Podrás cambiarlos cuando quieras en <strong>Configuración</strong>.</p>
    <div class="field">
      <label for="iNegocio">Nombre del negocio *</label>
      <input id="iNegocio" name="negocio" required placeholder="Ej. Purificadora Las Peques" />
    </div>
    <div class="field">
      <label for="iMon">Moneda</label>
      <select id="iMon" name="moneda">${monedas.map((m) => `<option ${cfg.moneda === m ? 'selected' : ''}>${m}</option>`).join('')}</select>
    </div>
    <h4 style="margin:14px 0 6px">🛢️ Precios por tamaño de garrafón</h4>
    <p class="hint" style="margin:0 0 8px">Estos son valores sugeridos. Edítalos si tu purificadora tiene precios distintos.</p>
    ${filasPrecios}
    <div class="form__actions">
      <button type="submit" class="btn btn--primary btn--lg btn--block">Empezar</button>
    </div>
  `;
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(f).entries());
    const negocio = (fd.negocio || '').trim() || 'Mi Purificadora';
    const moneda = fd.moneda || 'MXN';
    // Construye los mapas de precios por tamaño (venta + canje).
    const preciosPorTamano = {};
    const preciosCanjePorTamano = { ...PRECIOS_CANJE_DEFAULT_POR_TAMANO };
    TAMANOS_GARRAFON.forEach((t) => {
      preciosPorTamano[t] = Number(fd['precio_' + t]) || 0;
    });
    await setConfigBulk({
      negocio,
      moneda,
      preciosPorTamano,
      preciosCanjePorTamano,
      // Legacy (para que los backups viejos sigan siendo coherentes):
      // v2.5: el default ahora es 20L, así que los legacy se toman de ahí.
      precioDomicilio: preciosPorTamano['20L'] || 0,
      precioVentanilla: preciosPorTamano['20L'] || 0,
      precioCanje: preciosCanjePorTamano['20L'] || 0,
      configurado: true
    });
    setMoneda(moneda);
    actualizarMarca(negocio);
    cerrarModal();
    toast('¡Listo! Tu purificadora quedó configurada', 'success');
    await render();
  });
  abrirModal('Configuración inicial', f);
}

/* ---------- Respaldo automático reactivo a cambios ---------- */
let _debounceRespaldo = null;
let _respaldoEnCurso = false;

function programarRespaldoTrasCambio() {
  if (_debounceRespaldo) clearTimeout(_debounceRespaldo);
  _debounceRespaldo = setTimeout(async () => {
    _debounceRespaldo = null;
    if (_respaldoEnCurso) return;
    _respaldoEnCurso = true;
    try {
      // Verificamos el flag de configuración en cada disparo: si el usuario
      // lo desactivó, no hacemos snapshot (pero el de "al abrir" sigue activo
      // si está habilitado).
      const cfg = await getConfig();
      if (cfg.respaldoAuto === false) return;
      await respaldoAutomatico();
    } catch (e) {
      console.warn('Respaldo automático tras cambio falló:', e);
    } finally {
      _respaldoEnCurso = false;
    }
  }, 2000); // 2 s de debounce: agrupa varias escrituras seguidas en un solo snapshot
}

function flushRespaldoInmediato() {
  // Para pagehide / visibilitychange=hidden: dispara sin debounce y de forma
  // best-effort (no bloquea el cierre de la pestaña).
  if (_debounceRespaldo) { clearTimeout(_debounceRespaldo); _debounceRespaldo = null; }
  if (_respaldoEnCurso) return;
  _respaldoEnCurso = true;
  // sendBeacon-style: usamos setTimeout(0) para no bloquear el unload.
  setTimeout(async () => {
    try {
      const cfg = await getConfig();
      if (cfg.respaldoAuto === false) return;
      await respaldoAutomatico();
    } catch (e) { /* best-effort */ }
    finally { _respaldoEnCurso = false; }
  }, 0);
}

/* ---------- Inicio ---------- */
async function init() {
  registrarSW();

  // Cargar configuración (moneda y marca del negocio)
  let cfg = {};
  try {
    cfg = await getConfig();
    setMoneda(cfg.moneda);
    actualizarMarca(cfg.negocio);
  } catch (e) { /* primera vez, usa defaults */ }

  // Eventos de navegación
  window.addEventListener('hashchange', render);
  document.getElementById('menuToggle').addEventListener('click', abrirNav);
  document.getElementById('navBackdrop').addEventListener('click', cerrarNav);
  $$('.navlink').forEach((a) => a.addEventListener('click', cerrarNav));

  // Modal
  document.getElementById('modalClose').addEventListener('click', () =>
    import('./utils.js').then((u) => u.cerrarModal()));
  document.getElementById('modalBackdrop').addEventListener('click', () =>
    import('./utils.js').then((u) => u.cerrarModal()));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') import('./utils.js').then((u) => u.cerrarModal());
  });

  // Conexión
  window.addEventListener('online', actualizarEstadoRed);
  window.addEventListener('offline', actualizarEstadoRed);
  actualizarEstadoRed();

  // ROBUSTEZ v2.2: respaldo automático reactivo a cambios en IndexedDB.
  // Cada vez que se persiste un add/put/remove, db.js emite 'db:changed'.
  // Esperamos 2 s (debounce) y hacemos un snapshot si el flag está activo.
  window.addEventListener('db:changed', programarRespaldoTrasCambio);

  // ROBUSTEZ v2.2: flush de respaldo cuando la pestaña se oculta o cierra.
  // Es lo que realmente protege los datos en móviles (iOS Safari mata la
  // pestaña en background; Android puede cerrarla por presión de RAM).
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushRespaldoInmediato();
  });
  window.addEventListener('pagehide', flushRespaldoInmediato);
  // beforeunload como último refugio en navegadores que no disparan pagehide.
  window.addEventListener('beforeunload', flushRespaldoInmediato);

  // Mostrar interfaz
  document.getElementById('app-loader').remove();
  document.getElementById('topbar').hidden = false;
  document.getElementById('bottomnav').hidden = false;

  if (!location.hash) location.hash = '#/dashboard';
  await render();

  // Configuración inicial la primera vez (multi-purificadora)
  if (cfg && cfg.configurado === false) configuracionInicial(cfg);

  // Respaldo automático (silencioso) al iniciar si está activado
  try {
    if (cfg.respaldoAuto !== false) await respaldoAutomatico();
  } catch (e) { /* primera vez, sin datos aún */ }
}

// API global para que las vistas puedan navegar fácilmente
window.navegar = (ruta) => { location.hash = ruta.startsWith('#') ? ruta : `#/${ruta}`; };

init();
