/**
 * db.js — Capa de acceso a datos con IndexedDB.
 * Provee un API sencillo tipo "repositorio" para cada almacén (store).
 *
 * Almacenes:
 *  - clientes   : datos del cliente
 *  - pedidos    : pedidos de garrafones
 *  - pagos      : registros de cobranza (pago / adeudo)
 *  - rutas      : rutas diarias agrupando clientes
 *  - config     : pares clave/valor de configuración
 *
 * Diseño preparado para futuras funciones de geolocalización:
 *  cada cliente puede almacenar { lat, lng } sin cambios de esquema.
 *
 * NOTA DE ROBUSTEZ (v2.2):
 *  Las operaciones de escritura (add/put/remove/clear) esperan al evento
 *  `transaction.oncomplete` antes de resolver la promesa. Esto garantiza que
 *  los datos realmente se persistieron a disco, incluso si el navegador
 *  cierra la pestaña justo después. Antes solo se esperaba `request.onsuccess`,
 *  lo cual podía reportar éxito en transacciones que el navegador abortaba al
 *  background (especialmente en iOS Safari y Android con poca RAM).
 *  Además, cada escritura exitosa emite un evento `db:changed` en `window`
 *  para que otros módulos (respaldo automático) puedan reaccionar.
 */

const DB_NAME = 'aquagestion';
const DB_VERSION = 6;

/* ---------- EventBus interno: emite 'db:changed' en cada escritura ---------- */
let _changeDebounce = null;
function notificarCambio() {
  // Debounce ligero: si hay varias escrituras seguidas en la misma tick,
  // emitimos un solo evento.
  if (_changeDebounce) clearTimeout(_changeDebounce);
  _changeDebounce = setTimeout(() => {
    try { window.dispatchEvent(new CustomEvent('db:changed')); } catch (e) { /* noop */ }
    _changeDebounce = null;
  }, 150);
}

export const STORES = {
  clientes: 'clientes',
  pedidos: 'pedidos',
  pagos: 'pagos',
  rutas: 'rutas',
  gastos: 'gastos',
  mantenimiento: 'mantenimiento',
  inventario: 'inventario',
  config: 'config'
};

let _dbPromise = null;
let _db = null;

function openDB() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      const txUpgrade = e.target.transaction; // transacción de upgrade (viva durante el upgrade)

      if (!db.objectStoreNames.contains(STORES.clientes)) {
        const s = db.createObjectStore(STORES.clientes, { keyPath: 'id', autoIncrement: true });
        s.createIndex('nombre', 'nombre', { unique: false });
        s.createIndex('colonia', 'colonia', { unique: false });
        s.createIndex('frecuencia', 'frecuencia', { unique: false });
      }

      if (!db.objectStoreNames.contains(STORES.pedidos)) {
        const s = db.createObjectStore(STORES.pedidos, { keyPath: 'id', autoIncrement: true });
        s.createIndex('clienteId', 'clienteId', { unique: false });
        s.createIndex('fecha', 'fecha', { unique: false });
        s.createIndex('estado', 'estado', { unique: false });
        s.createIndex('tamano', 'tamano', { unique: false }); // v5: índice por tamaño
      } else if (txUpgrade) {
        // v5: si el store ya existía, agregar el índice tamano si falta.
        const store = txUpgrade.objectStore(STORES.pedidos);
        if (!store.indexNames.contains('tamano')) {
          try { store.createIndex('tamano', 'tamano', { unique: false }); } catch (err) { /* noop */ }
        }
      }

      if (!db.objectStoreNames.contains(STORES.pagos)) {
        const s = db.createObjectStore(STORES.pagos, { keyPath: 'id', autoIncrement: true });
        s.createIndex('clienteId', 'clienteId', { unique: false });
        s.createIndex('fecha', 'fecha', { unique: false });
        s.createIndex('tipo', 'tipo', { unique: false }); // 'pago' | 'adeudo'
      }

      if (!db.objectStoreNames.contains(STORES.rutas)) {
        const s = db.createObjectStore(STORES.rutas, { keyPath: 'id', autoIncrement: true });
        s.createIndex('fecha', 'fecha', { unique: false });
      }

      // v2: almacén de gastos para medir la utilidad real del negocio.
      if (!db.objectStoreNames.contains(STORES.gastos)) {
        const s = db.createObjectStore(STORES.gastos, { keyPath: 'id', autoIncrement: true });
        s.createIndex('fecha', 'fecha', { unique: false });
        s.createIndex('categoria', 'categoria', { unique: false });
      }

      // v3: bitácora de mantenimiento y calidad (trazabilidad técnica).
      if (!db.objectStoreNames.contains(STORES.mantenimiento)) {
        const s = db.createObjectStore(STORES.mantenimiento, { keyPath: 'id', autoIncrement: true });
        s.createIndex('fecha', 'fecha', { unique: false });
        s.createIndex('tipo', 'tipo', { unique: false });
      }

      // v4: inventario de garrafones (nuevos / usados) por movimientos.
      if (!db.objectStoreNames.contains(STORES.inventario)) {
        const s = db.createObjectStore(STORES.inventario, { keyPath: 'id', autoIncrement: true });
        s.createIndex('fecha', 'fecha', { unique: false });
        s.createIndex('tipo', 'tipo', { unique: false });
        s.createIndex('pedidoId', 'pedidoId', { unique: false });
      }

      if (!db.objectStoreNames.contains(STORES.config)) {
        db.createObjectStore(STORES.config, { keyPath: 'clave' });
      }

      // v5: MIGRACIÓN DE DATOS — pedidos existentes sin tamano -> '19L'
      // (tamanoPedido() ya lo hace en lectura, pero materializarlo en disco
      // permite que el índice funcione y que las consultas por tamaño sean
      // eficientes. También migra el inventario al formato por tamaño.)
      if (txUpgrade && e.oldVersion < 5) {
        try {
          // 1) Pedidos: agregar tamano='19L' donde falte
          const pedStore = txUpgrade.objectStore(STORES.pedidos);
          pedStore.openCursor().onsuccess = (ev) => {
            const cursor = ev.target.result;
            if (!cursor) return;
            const v = cursor.value;
            if (!v.tamano) {
              v.tamano = '19L';
              cursor.update(v);
            }
            cursor.continue();
          };

          // 2) Inventario: migrar nuevos/usados (escalares) a nuevosPorTamano/usadosPorTamano (objetos)
          // Mantenemos los campos viejos por compatibilidad hacia atrás en el mismo ciclo.
          const invStore = txUpgrade.objectStore(STORES.inventario);
          invStore.openCursor().onsuccess = (ev) => {
            const cursor = ev.target.result;
            if (!cursor) return;
            const v = cursor.value;
            let changed = false;
            if (!v.nuevosPorTamano) {
              // El campo viejo 'nuevos' era un delta escalar (ej. +5 o -3); lo asignamos todo a 19L.
              const viejo = Number(v.nuevos) || 0;
              v.nuevosPorTamano = { '20L': 0, '19L': viejo, '12L': 0, '10L': 0 };
              changed = true;
            }
            if (!v.usadosPorTamano) {
              const viejo = Number(v.usados) || 0;
              v.usadosPorTamano = { '20L': 0, '19L': viejo, '12L': 0, '10L': 0 };
              changed = true;
            }
            if (!v.tamano) {
              // El movimiento original era implícitamente de 19L
              v.tamano = '19L';
              changed = true;
            }
            if (changed) cursor.update(v);
            cursor.continue();
          };
        } catch (migErr) {
          console.warn('Migración v5 (tamaños) falló parcialmente:', migErr);
        }
      }

      // v6: MIGRACIÓN — cambiar default de tamaño de 19L a 20L.
      // A petición de David: el garrafón de 20L es el más común en su purificadora.
      // Como TODOS los pedidos viejos (sin tamaño original) fueron migrados a 19L
      // en v5, y ahora el default cambia a 20L, reasignamos los pedidos con
      // tamano='19L' a '20L'. Esto puede afectar algunos pedidos legítimamente
      // capturados como 19L después de v2.3, pero David puede corregirlos a mano.
      // También mueve los deltas de inventario y los precios configurados.
      if (txUpgrade && e.oldVersion < 6) {
        try {
          // 1) Pedidos: tamano='19L' → '20L'
          const pedStore = txUpgrade.objectStore(STORES.pedidos);
          pedStore.openCursor().onsuccess = (ev) => {
            const cursor = ev.target.result;
            if (!cursor) return;
            const v = cursor.value;
            if (v.tamano === '19L') {
              v.tamano = '20L';
              cursor.update(v);
            }
            cursor.continue();
          };

          // 2) Inventario: tamano='19L' → '20L' y mover deltas de la clave '19L' a '20L'
          const invStore = txUpgrade.objectStore(STORES.inventario);
          invStore.openCursor().onsuccess = (ev) => {
            const cursor = ev.target.result;
            if (!cursor) return;
            const v = cursor.value;
            let changed = false;
            // Mover deltas de la clave '19L' a '20L' (sumando a lo que ya tuviera)
            if (v.nuevosPorTamano && typeof v.nuevosPorTamano === 'object') {
              const delta19 = Number(v.nuevosPorTamano['19L']) || 0;
              const delta20 = Number(v.nuevosPorTamano['20L']) || 0;
              if (delta19 !== 0) {
                v.nuevosPorTamano['20L'] = delta20 + delta19;
                v.nuevosPorTamano['19L'] = 0;
                changed = true;
              }
            }
            if (v.usadosPorTamano && typeof v.usadosPorTamano === 'object') {
              const delta19 = Number(v.usadosPorTamano['19L']) || 0;
              const delta20 = Number(v.usadosPorTamano['20L']) || 0;
              if (delta19 !== 0) {
                v.usadosPorTamano['20L'] = delta20 + delta19;
                v.usadosPorTamano['19L'] = 0;
                changed = true;
              }
            }
            // Cambiar el campo tamano del movimiento
            if (v.tamano === '19L') {
              v.tamano = '20L';
              changed = true;
            }
            if (changed) cursor.update(v);
            cursor.continue();
          };

          // 3) Configuración: NO se migran los precios automáticamente.
          //    Si David editó el precio de 19L manualmente (ej. $22 porque en su
          //    zona cuesta eso), no queremos mover ese valor a 20L sin su consentimiento.
          //    Los defaults ya son coherentes (20L=$25, 19L=$20) y David puede
          //    ajustarlos en Configuración si lo necesita.
        } catch (migErr) {
          console.warn('Migración v6 (default 20L) falló parcialmente:', migErr);
        }
      }
    };

    req.onsuccess = () => { _db = req.result; resolve(_db); };
    req.onerror = () => reject(req.error);
  });
  return _dbPromise;
}

/**
 * Devuelve { store, transaction } para operaciones que necesitan acceder a la
 * transacción completa (esperar oncomplete). En lecturas, transaction puede
 * ignorarse. El nombre de la función es openTx (no tx) para evitar colisión
 * con la variable local `transaction` en quien la invoca.
 */
function openTx(storeName, mode = 'readonly') {
  return openDB().then((db) => {
    const t = db.transaction(storeName, mode);
    return { store: t.objectStore(storeName), transaction: t };
  });
}

function reqToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/**
 * Espera a que la transacción se complete (datos realmente en disco) y
 * resuelve con el valor que devolvió el request. Si la transacción aborta
 * (ej. navegador cerró la pestaña, quota excedida), rechaza con el error.
 */
function reqWithTx(request, transaction) {
  return new Promise((resolve, reject) => {
    let resolved = false;
    let result;
    request.onsuccess = () => { result = request.result; /* esperar al tx */ };
    request.onerror = () => { if (!resolved) { resolved = true; reject(request.error); } };
    transaction.oncomplete = () => {
      if (!resolved) { resolved = true; resolve(result); }
    };
    transaction.onabort = () => {
      if (!resolved) { resolved = true; reject(transaction.error || new Error('Transacción abortada')); }
    };
    transaction.onerror = () => {
      if (!resolved) { resolved = true; reject(transaction.error || request.error || new Error('Error en transacción')); }
    };
  });
}

/* ---------- API genérico CRUD ---------- */

// Lee y escribe dentro de la misma transacción para evitar cobros duplicados
// entre pestañas. El callback es síncrono; las escrituras usan stores nativos.
export async function transaccionFinanciera(fn) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const names = ['pedidos', 'pagos', 'gastos', 'config', 'inventario'];
    const tx = db.transaction(names, 'readwrite');
    const stores = Object.fromEntries(names.map(n => [n, tx.objectStore(n)]));
    const datos = {}; let restantes = names.length; let resultado; let error;
    tx.oncomplete = () => { notificarCambio(); resolve(resultado); };
    tx.onabort = () => reject(error || tx.error || new Error('No se guardó el movimiento.'));
    tx.onerror = () => {};
    names.forEach(n => {
      const req = stores[n].getAll();
      req.onsuccess = () => {
        datos[n] = req.result;
        if (--restantes) return;
        try { fn(datos, stores, valor => { resultado = valor; }, e => { error = e; tx.abort(); }); }
        catch (e) { error = e; tx.abort(); }
      };
    });
  });
}

export async function getAll(storeName) {
  const { store } = await openTx(storeName);
  return reqToPromise(store.getAll());
}

export async function get(storeName, id) {
  const { store } = await openTx(storeName);
  return reqToPromise(store.get(id));
}

export async function add(storeName, value) {
  const { store, transaction } = await openTx(storeName, 'readwrite');
  const id = await reqWithTx(store.add(value), transaction);
  notificarCambio();
  return id;
}

export async function put(storeName, value) {
  const { store, transaction } = await openTx(storeName, 'readwrite');
  const r = await reqWithTx(store.put(value), transaction);
  notificarCambio();
  return r;
}

export async function remove(storeName, id) {
  const { store, transaction } = await openTx(storeName, 'readwrite');
  const r = await reqWithTx(store.delete(id), transaction);
  notificarCambio();
  return r;
}

export async function clear(storeName) {
  const { store, transaction } = await openTx(storeName, 'readwrite');
  const r = await reqWithTx(store.clear(), transaction);
  notificarCambio();
  return r;
}

export async function getByIndex(storeName, indexName, value) {
  const { store } = await openTx(storeName);
  const idx = store.index(indexName);
  return reqToPromise(idx.getAll(value));
}

export async function count(storeName) {
  const { store } = await openTx(storeName);
  return reqToPromise(store.count());
}

/* ---------- Configuración (clave/valor) ---------- */

const DEFAULT_CONFIG = {
  negocio: 'Mi Purificadora',
  // v2.2 legacy (se conservan para compatibilidad con backups viejos):
  precioDomicilio: 20,
  precioVentanilla: 15,
  precioCanje: 50,
  // v2.3: precios por tamaño (4 tamaños × venta + 4 × canje = 8 precios).
  // Estos son los defaults sugeridos; el usuario los edita en Configuración.
  preciosPorTamano: {
    '20L': 25,
    '19L': 20,
    '12L': 12,
    '10L': 10
  },
  preciosCanjePorTamano: {
    '20L': 60,
    '19L': 50,
    '12L': 30,
    '10L': 25
  },
  moneda: 'MXN',
  respaldoAuto: true,
  ultimoRespaldo: null,
  configurado: false
};

export async function getConfig() {
  const rows = await getAll(STORES.config);
  const cfg = { ...DEFAULT_CONFIG };
  rows.forEach((r) => { cfg[r.clave] = r.valor; });
  // Migración suave: si un backup viejo no trae los mapas de precios por tamaño,
  // los reconstruimos a partir de los precios legacy o de los defaults.
  // v2.5: el default ahora es 20L (no 19L), así que los precios legacy van a 20L.
  if (!cfg.preciosPorTamano || typeof cfg.preciosPorTamano !== 'object') {
    cfg.preciosPorTamano = { ...DEFAULT_CONFIG.preciosPorTamano };
    // Si había un precioDomicilio legacy, asumimos que era para 20L (default actual)
    if (Number(cfg.precioDomicilio) > 0) cfg.preciosPorTamano['20L'] = Number(cfg.precioDomicilio);
  }
  if (!cfg.preciosCanjePorTamano || typeof cfg.preciosCanjePorTamano !== 'object') {
    cfg.preciosCanjePorTamano = { ...DEFAULT_CONFIG.preciosCanjePorTamano };
    if (Number(cfg.precioCanje) > 0) cfg.preciosCanjePorTamano['20L'] = Number(cfg.precioCanje);
  }
  return cfg;
}

export async function setConfig(clave, valor) {
  return put(STORES.config, { clave, valor });
}

export async function setConfigBulk(obj) {
  await Promise.all(Object.entries(obj).map(([clave, valor]) => setConfig(clave, valor)));
}

/* ---------- Respaldo total (export/import completo) ---------- */

export async function dumpAll() {
  const [clientes, pedidos, pagos, rutas, gastos, mantenimiento, inventario, config] = await Promise.all([
    getAll(STORES.clientes),
    getAll(STORES.pedidos),
    getAll(STORES.pagos),
    getAll(STORES.rutas),
    getAll(STORES.gastos),
    getAll(STORES.mantenimiento),
    getAll(STORES.inventario),
    getAll(STORES.config)
  ]);
  return {
    app: 'AquaGestion',
    version: DB_VERSION,
    exportadoEn: new Date().toISOString(),
    datos: { clientes, pedidos, pagos, rutas, gastos, mantenimiento, inventario, config }
  };
}

export async function importAll(backup, { merge = false } = {}) {
  if (!backup || !backup.datos) throw new Error('Respaldo inválido');
  const d = backup.datos;
  const db = await openDB();

  const storesToWrite = [STORES.clientes, STORES.pedidos, STORES.pagos, STORES.rutas, STORES.gastos, STORES.mantenimiento, STORES.inventario, STORES.config];
  await new Promise((resolve, reject) => {
    const t = db.transaction(storesToWrite, 'readwrite');
    t.oncomplete = resolve;
    t.onerror = () => reject(t.error);

    if (!merge) {
      storesToWrite.forEach((s) => t.objectStore(s).clear());
    }
    (d.clientes || []).forEach((r) => t.objectStore(STORES.clientes).put(r));
    (d.pedidos || []).forEach((r) => t.objectStore(STORES.pedidos).put(r));
    (d.pagos || []).forEach((r) => t.objectStore(STORES.pagos).put(r));
    (d.rutas || []).forEach((r) => t.objectStore(STORES.rutas).put(r));
    (d.gastos || []).forEach((r) => t.objectStore(STORES.gastos).put(r));
    (d.mantenimiento || []).forEach((r) => t.objectStore(STORES.mantenimiento).put(r));
    (d.inventario || []).forEach((r) => t.objectStore(STORES.inventario).put(r));
    (d.config || []).forEach((r) => t.objectStore(STORES.config).put(r));
  });
  notificarCambio();
}

/**
 * Reinicio total de fábrica: elimina toda la base de datos (datos + configuración)
 * y la recrea vacía. A diferencia de clear(), esto SÍ reinicia los contadores
 * autoincrement, por lo que el primer cliente vuelve a ser el N.º 001.
 * Tras llamarla, la app vuelve a su estado inicial (pedirá la configuración).
 */
export async function resetAll() {
  if (_db) { _db.close(); _db = null; }
  _dbPromise = null;
  await new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => resolve(); // continúa aunque otra pestaña la tenga abierta
  });
  await openDB(); // recrea los almacenes vacíos con contadores en cero
  notificarCambio();
}

export default {
  STORES, getAll, get, add, put, remove, clear, getByIndex, count,
  getConfig, setConfig, setConfigBulk, dumpAll, importAll, resetAll
};
