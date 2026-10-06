import { cartera, fechaVenta } from './finanzas.js';
/**
 * export.js — Motor de exportación e importación.
 * Formatos: JSON (respaldo completo), CSV, Excel (.xlsx), PDF.
 * Usa librerías vendorizadas (SheetJS, jsPDF + AutoTable) cacheadas para offline.
 */
import { dumpAll, importAll, getConfig, setConfig, STORES, getAll } from './db.js';
import { descargarArchivo, hoyISO, toast, fechaHoraLegible, TAMANOS_GARRAFON, tamanoPedido, lineasDePedido, resumenLineas, cantidadTotalPedido, canjeTotalPedido } from './utils.js';

/* ---------- Respaldo completo JSON ---------- */
export async function exportarJSON() {
  const backup = await dumpAll();
  const json = JSON.stringify(backup, null, 2);
  descargarArchivo(`aquagestion-respaldo-${hoyISO()}.json`, json, 'application/json');
  await setConfig('ultimoRespaldo', new Date().toISOString());
  return backup;
}

/**
 * Comparte el respaldo como archivo usando la Web Share API (WhatsApp, Drive,
 * correo, etc.) para sacarlo del dispositivo. Si no está disponible, lo descarga.
 */
export async function compartirRespaldo() {
  const backup = await dumpAll();
  const json = JSON.stringify(backup, null, 2);
  const nombre = `aquagestion-respaldo-${hoyISO()}.json`;
  await setConfig('ultimoRespaldo', new Date().toISOString());
  try {
    if (navigator.canShare) {
      const file = new File([json], nombre, { type: 'application/json' });
      if (navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: 'Respaldo de datos', text: 'Respaldo de datos de la purificadora (guárdalo en un lugar seguro).' });
        return { compartido: true };
      }
    }
  } catch (e) {
    if (e && e.name === 'AbortError') return { compartido: false, cancelado: true };
  }
  descargarArchivo(nombre, json, 'application/json');
  return { compartido: false };
}

export function leerArchivoTexto(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsText(file);
  });
}

export async function importarJSON(file, opciones = {}) {
  const txt = await leerArchivoTexto(file);
  const backup = JSON.parse(txt);
  await importAll(backup, opciones);
  return backup;
}

/* ---------- Respaldo automático (a localStorage como red de seguridad) ----------
 *
 * ROBUSTEZ v2.2: Se mantienen hasta MAX_SNAPSHOTS respaldos rotativos en
 * localStorage (claves aquagestion_backup_auto_N). Antes se sobrescribía
 * uno solo, lo cual significaba que si el último arranque pisaba un
 * respaldo bueno con uno corrupto o vacío, se perdía la única red de
 * seguridad. Ahora siempre quedan los 3 más recientes.
 *
 * Compatibilidad: obtenerRespaldoAutoInfo() y restaurarRespaldoAuto()
 * siguen operando sobre el más reciente (índice 0), así que la UI de
 * Configuración no necesita cambios.
 */
const MAX_SNAPSHOTS = 3;
const LS_PREFIX = 'aquagestion_backup_auto_';
const LS_FECHA_PREFIX = 'aquagestion_backup_auto_fecha_';

function leerSnapshotEn(idx) {
  try {
    const raw = localStorage.getItem(LS_PREFIX + idx);
    const fecha = localStorage.getItem(LS_FECHA_PREFIX + idx);
    if (!raw) return null;
    return { idx, fecha, backup: JSON.parse(raw) };
  } catch (e) { return null; }
}

function escribirSnapshotEn(idx, backup, fechaIso) {
  try {
    localStorage.setItem(LS_PREFIX + idx, JSON.stringify(backup));
    localStorage.setItem(LS_FECHA_PREFIX + idx, fechaIso);
    return true;
  } catch (e) {
    console.warn('No se pudo guardar respaldo automático local (snapshot ' + idx + ')', e);
    return false;
  }
}

function rotarSnapshots() {
  // Mueve cada snapshot al siguiente índice, descartando el más viejo.
  for (let i = MAX_SNAPSHOTS - 1; i > 0; i--) {
    const cur = leerSnapshotEn(i - 1);
    if (!cur) continue;
    try {
      localStorage.setItem(LS_PREFIX + i, JSON.stringify(cur.backup));
      localStorage.setItem(LS_FECHA_PREFIX + i, cur.fecha || '');
    } catch (e) { /* si cuota llena, paramos la rotación */ break; }
  }
  // Limpia el índice 0 (lo reescribiremos justo después).
  try {
    localStorage.removeItem(LS_PREFIX + '0');
    localStorage.removeItem(LS_FECHA_PREFIX + '0');
  } catch (e) { /* noop */ }

  // Migración: si existe el respaldo viejo (sin índice), muévelo al slot 0.
  try {
    const viejo = localStorage.getItem('aquagestion_backup_auto');
    const viejoFecha = localStorage.getItem('aquagestion_backup_auto_fecha');
    if (viejo && !leerSnapshotEn(1)) {
      localStorage.setItem(LS_PREFIX + '1', viejo);
      localStorage.setItem(LS_FECHA_PREFIX + '1', viejoFecha || '');
      localStorage.removeItem('aquagestion_backup_auto');
      localStorage.removeItem('aquagestion_backup_auto_fecha');
    }
  } catch (e) { /* noop */ }
}

export async function respaldoAutomatico() {
  // NOTA: la decisión de si se dispara o no se toma en app.js según la
  // configuración del usuario. Esta función siempre hace el snapshot cuando
  // se la invoca (se usa tanto al abrir la app como tras cambios en la DB).
  const backup = await dumpAll();
  rotarSnapshots();
  escribirSnapshotEn(0, backup, new Date().toISOString());

  // Limpieza de snapshots más allá de MAX_SNAPSHOTS (por si migración dejó restos).
  for (let i = MAX_SNAPSHOTS; i < MAX_SNAPSHOTS + 2; i++) {
    try {
      localStorage.removeItem(LS_PREFIX + i);
      localStorage.removeItem(LS_FECHA_PREFIX + i);
    } catch (e) { /* noop */ }
  }
  return backup;
}

export function obtenerRespaldoAutoInfo() {
  const s0 = leerSnapshotEn(0);
  if (s0 && s0.fecha) return { fecha: s0.fecha, legible: fechaHoraLegible(s0.fecha) };
  // Compatibilidad con respaldo viejo sin índice.
  const fecha = localStorage.getItem('aquagestion_backup_auto_fecha');
  return fecha ? { fecha, legible: fechaHoraLegible(fecha) } : null;
}

/**
 * Lista todos los snapshots disponibles con su índice y fecha, del más nuevo
 * al más viejo. Útil para mostrar un selector en la UI de restauración.
 */
export function listarRespaldosAuto() {
  const out = [];
  for (let i = 0; i < MAX_SNAPSHOTS; i++) {
    const s = leerSnapshotEn(i);
    if (s && s.fecha) {
      out.push({ idx: i, fecha: s.fecha, legible: fechaHoraLegible(s.fecha) });
    }
  }
  // Compatibilidad: respaldo viejo sin índice.
  const viejoFecha = localStorage.getItem('aquagestion_backup_auto_fecha');
  if (viejoFecha && out.length === 0) {
    out.push({ idx: -1, fecha: viejoFecha, legible: fechaHoraLegible(viejoFecha) });
  }
  return out;
}

export async function restaurarRespaldoAuto() {
  // Por defecto restaura el más reciente (índice 0).
  return restaurarRespaldoAutoEn(0);
}

export async function restaurarRespaldoAutoEn(idx) {
  let raw;
  if (idx === -1) {
    raw = localStorage.getItem('aquagestion_backup_auto'); // legacy
  } else {
    raw = localStorage.getItem(LS_PREFIX + idx);
  }
  if (!raw) throw new Error('No hay respaldo automático disponible en el índice ' + idx);
  await importAll(JSON.parse(raw));
}

/* ---------- CSV ---------- */
function csvCell(v) {
  if (v == null) return '';
  const s = String(v);
  return /[",\n;]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

/**
 * rows: array de objetos. columns: [{key, label}] opcional.
 * Devuelve string CSV con separador ';' (amigable para Excel en es-MX) y BOM.
 */
export function generarCSV(rows, columns) {
  if (!columns) {
    const keys = rows.length ? Object.keys(rows[0]) : [];
    columns = keys.map((k) => ({ key: k, label: k }));
  }
  const head = columns.map((c) => csvCell(c.label)).join(';');
  const body = rows.map((row) => columns.map((c) => csvCell(row[c.key])).join(';')).join('\n');
  return '\uFEFF' + head + '\n' + body;
}

export function exportarCSV(nombre, rows, columns) {
  const csv = generarCSV(rows, columns);
  descargarArchivo(nombre.endsWith('.csv') ? nombre : `${nombre}.csv`, csv, 'text/csv;charset=utf-8');
}

/* ---------- Excel (.xlsx) ---------- */
function asegurarXLSX() {
  if (!window.XLSX) throw new Error('La librería de Excel no está disponible. Revisa tu conexión la primera vez.');
  return window.XLSX;
}

/**
 * sheets: [{ nombre, rows, columns }]
 * Cada hoja se construye a partir de filas de objetos.
 */
export function exportarExcel(nombre, sheets) {
  const XLSX = asegurarXLSX();
  const wb = XLSX.utils.book_new();
  sheets.forEach((sh) => {
    let aoa;
    if (sh.columns) {
      const head = sh.columns.map((c) => c.label);
      const body = sh.rows.map((r) => sh.columns.map((c) => r[c.key]));
      aoa = [head, ...body];
    } else {
      const keys = sh.rows.length ? Object.keys(sh.rows[0]) : [];
      aoa = [keys, ...sh.rows.map((r) => keys.map((k) => r[k]))];
    }
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    // Ancho de columnas automático básico
    const colCount = aoa[0] ? aoa[0].length : 0;
    ws['!cols'] = Array.from({ length: colCount }, (_, i) => {
      const max = aoa.reduce((m, row) => Math.max(m, String(row[i] ?? '').length), 10);
      return { wch: Math.min(max + 2, 40) };
    });
    XLSX.utils.book_append_sheet(wb, ws, (sh.nombre || 'Hoja').slice(0, 31));
  });
  XLSX.writeFile(wb, nombre.endsWith('.xlsx') ? nombre : `${nombre}.xlsx`);
}

/** Exporta TODO el sistema como un libro Excel con varias hojas. */
export async function exportarExcelCompleto() {
  const [clientes, pedidos, pagos, gastos, mantenimiento, inventario] = await Promise.all([
    getAll(STORES.clientes), getAll(STORES.pedidos), getAll(STORES.pagos),
    getAll(STORES.gastos), getAll(STORES.mantenimiento), getAll(STORES.inventario)
  ]);
  const mapaCliente = new Map(clientes.map((c) => [c.id, c.nombre]));
  const cuentas = cartera(pedidos, pagos).porPedido;

  exportarExcel(`aquagestion-datos-${hoyISO()}`, [
    {
      nombre: 'Clientes',
      rows: clientes,
      columns: [
        { key: 'id', label: 'ID' }, { key: 'nombre', label: 'Nombre' },
        { key: 'telefono', label: 'Teléfono' }, { key: 'calle', label: 'Calle' },
        { key: 'colonia', label: 'Colonia' }, { key: 'referencia', label: 'Referencia' },
        { key: 'frecuencia', label: 'Frecuencia' }, { key: 'notas', label: 'Notas' }
      ]
    },
    {
      nombre: 'Pedidos',
      rows: pedidos.map((p) => ({
        id: p.id,
        fecha: p.fecha,
        fechaEntrega: p.estado === "Entregado" ? fechaVenta(p) : "",
        saldoPendiente: cuentas.get(p.id)?.pendiente || 0,
        cliente: mapaCliente.get(p.clienteId) || '—',
        lineas: resumenLineas(p), // v2.6: resumen compacto "3×20L + 2×10L"
        garrafones: cantidadTotalPedido(p),
        total: p.total,
        estado: p.estado,
        metodoPago: p.metodoPago,
        observaciones: p.observaciones || ''
      })),
      columns: [
        { key: 'id', label: 'ID' }, { key: 'fecha', label: 'Fecha' },
        { key: 'cliente', label: 'Cliente' }, { key: 'lineas', label: 'Líneas' },
        { key: 'garrafones', label: 'Garrafones totales' },
        { key: 'total', label: 'Total' }, { key: 'fechaEntrega', label: 'Fecha de entrega' }, { key: 'saldoPendiente', label: 'Saldo pendiente' },
        { key: 'estado', label: 'Estado' }, { key: 'metodoPago', label: 'Método de pago' },
        { key: 'observaciones', label: 'Observaciones' }
      ]
    },
    {
      // v2.6: hoja detallada con una fila por línea de pedido
      nombre: 'Líneas de pedidos',
      rows: pedidos.flatMap((p) => {
        const cliente = mapaCliente.get(p.clienteId) || '—';
        return lineasDePedido(p).map((l, idx) => ({
          pedidoId: p.id,
          fecha: p.fecha,
          cliente,
          linea: idx + 1,
          tamano: l.tamano || '20L',
          cantidad: l.cantidad,
          precioUnit: l.precioUnit,
          subtotal: (Number(l.cantidad) || 0) * (Number(l.precioUnit) || 0),
          canjeCantidad: l.canjeCantidad || 0,
          estado: p.estado
        }));
      }),
      columns: [
        { key: 'pedidoId', label: 'Pedido ID' }, { key: 'fecha', label: 'Fecha' },
        { key: 'cliente', label: 'Cliente' }, { key: 'linea', label: 'Línea' },
        { key: 'tamano', label: 'Tamaño' }, { key: 'cantidad', label: 'Cantidad' },
        { key: 'precioUnit', label: 'Precio Unit.' }, { key: 'subtotal', label: 'Subtotal' },
        { key: 'canjeCantidad', label: 'Canje' }, { key: 'estado', label: 'Estado pedido' }
      ]
    },
    {
      nombre: 'Cobranza',
      rows: pagos.map((p) => ({ ...p, cliente: mapaCliente.get(p.clienteId) || '—' })),
      columns: [
        { key: 'id', label: 'ID' }, { key: 'fecha', label: 'Fecha' },
        { key: 'cliente', label: 'Cliente' }, { key: 'tipo', label: 'Tipo' },
        { key: 'monto', label: 'Monto' }, { key: 'concepto', label: 'Concepto' }, { key: 'metodoPago', label: 'Método de pago' }, { key: 'pedidoId', label: 'Pedido ID' }, { key: 'anuladoEn', label: 'Anulado en' }
      ]
    },
    {
      nombre: 'Gastos',
      rows: gastos,
      columns: [
        { key: 'id', label: 'ID' }, { key: 'fecha', label: 'Fecha' },
        { key: 'categoria', label: 'Categoría' }, { key: 'monto', label: 'Monto' },
        { key: 'concepto', label: 'Concepto' }
      ]
    },
    {
      nombre: 'Mantenimiento',
      rows: mantenimiento,
      columns: [
        { key: 'id', label: 'ID' }, { key: 'fecha', label: 'Fecha' },
        { key: 'tipo', label: 'Tipo' }, { key: 'descripcion', label: 'Descripción' },
        { key: 'tecnico', label: 'Técnico' }, { key: 'costo', label: 'Costo' },
        { key: 'proximoCambio', label: 'Próximo cambio' }
      ]
    },
    {
      nombre: 'Inventario',
      rows: inventario.map((m) => ({
        ...m,
        tamano: m.tamano || '19L',
        nuevos20L: m.nuevosPorTamano?.['20L'] || 0,
        nuevos19L: m.nuevosPorTamano?.['19L'] || 0,
        nuevos12L: m.nuevosPorTamano?.['12L'] || 0,
        nuevos10L: m.nuevosPorTamano?.['10L'] || 0,
        usados20L: m.usadosPorTamano?.['20L'] || 0,
        usados19L: m.usadosPorTamano?.['19L'] || 0,
        usados12L: m.usadosPorTamano?.['12L'] || 0,
        usados10L: m.usadosPorTamano?.['10L'] || 0
      })),
      columns: [
        { key: 'id', label: 'ID' }, { key: 'fecha', label: 'Fecha' },
        { key: 'tipo', label: 'Tipo' }, { key: 'tamano', label: 'Tamaño' },
        { key: 'cantidad', label: 'Cantidad' },
        { key: 'nuevos20L', label: 'Δ Nuevos 20L' }, { key: 'nuevos19L', label: 'Δ Nuevos 19L' },
        { key: 'nuevos12L', label: 'Δ Nuevos 12L' }, { key: 'nuevos10L', label: 'Δ Nuevos 10L' },
        { key: 'usados20L', label: 'Δ Usados 20L' }, { key: 'usados19L', label: 'Δ Usados 19L' },
        { key: 'usados12L', label: 'Δ Usados 12L' }, { key: 'usados10L', label: 'Δ Usados 10L' },
        { key: 'concepto', label: 'Concepto' }, { key: 'pedidoId', label: 'Pedido' }
      ]
    }
  ]);
}

/* ---------- PDF ---------- */
function obtenerJsPDF() {
  const ns = window.jspdf || window.jsPDF;
  const ctor = ns && (ns.jsPDF || ns);
  if (!ctor) throw new Error('La librería de PDF no está disponible. Revisa tu conexión la primera vez.');
  return ctor;
}

/**
 * Genera un PDF con encabezado + una o varias tablas.
 * secciones: [{ titulo, columns:[{label}], rows:[[...]], resumen?:string }]
 */
export async function exportarPDF(nombreArchivo, tituloDoc, secciones) {
  const JsPDF = obtenerJsPDF();
  const cfg = await getConfig();
  const doc = new JsPDF({ unit: 'pt', format: 'a4' });
  const ancho = doc.internal.pageSize.getWidth();

  // Encabezado
  doc.setFillColor(2, 119, 189);
  doc.rect(0, 0, ancho, 70, 'F');
  doc.setTextColor(255, 255, 255);
  doc.setFontSize(18);
  doc.text(cfg.negocio || 'Purificadora', 40, 32);
  doc.setFontSize(12);
  doc.text(tituloDoc, 40, 52);
  doc.setFontSize(9);
  doc.text(`Generado: ${fechaHoraLegible(new Date().toISOString())}`, ancho - 40, 52, { align: 'right' });

  let y = 90;
  doc.setTextColor(38, 50, 56);

  secciones.forEach((sec) => {
    if (sec.titulo) {
      doc.setFontSize(13);
      doc.text(sec.titulo, 40, y);
      y += 8;
    }
    doc.autoTable({
      startY: y + 6,
      head: [sec.columns.map((c) => c.label)],
      body: sec.rows,
      styles: { fontSize: 9, cellPadding: 5 },
      headStyles: { fillColor: [2, 119, 189], textColor: 255 },
      alternateRowStyles: { fillColor: [245, 250, 252] },
      margin: { left: 40, right: 40 }
    });
    y = doc.lastAutoTable.finalY + 16;
    if (sec.resumen) {
      doc.setFontSize(11);
      doc.text(sec.resumen, 40, y);
      y += 20;
    }
    if (y > doc.internal.pageSize.getHeight() - 80) {
      doc.addPage();
      y = 60;
    }
  });

  doc.save(nombreArchivo.endsWith('.pdf') ? nombreArchivo : `${nombreArchivo}.pdf`);
}

export default {
  exportarJSON, compartirRespaldo, importarJSON, leerArchivoTexto,
  respaldoAutomatico, obtenerRespaldoAutoInfo, restaurarRespaldoAuto,
  restaurarRespaldoAutoEn, listarRespaldosAuto,
  generarCSV, exportarCSV, exportarExcel, exportarExcelCompleto, exportarPDF
};
