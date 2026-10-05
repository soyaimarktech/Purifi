/** Ventas por fecha de entrega; cartera calculada a partir de cargos y pagos independientes. */
import { cartera, generaCargo, fechaVenta } from './finanzas.js';
import { STORES, getAll, getByIndex } from './db.js';
import { hoyISO, inicioSemanaISO, inicioMesISO, diasEntre, sumarDiasISO, FRECUENCIA_DIAS, tipoGasto, TAMANOS_GARRAFON, TAMANO_DEFAULT, tamanoPedido, lineasDePedido, cantidadTotalPedido, canjeTotalPedido, resumenLineas } from './utils.js';

/**
 * Ruta sugerida para una fecha dada (v2.4).
 *
 * Para cada cliente con al menos una entrega previa, calcula:
 *  - interval: días esperados entre entregas (según su frecuencia)
 *  - dias: días transcurridos desde su última entrega hasta `fecha`
 *  - vencidoPor: dias - interval (>0 = ya se pasó, 0 = toca justo hoy, <0 = aún no toca)
 *
 * Devuelve solo los clientes que toca visitar en `fecha` (dias >= interval),
 * agrupados por zona (colonia), ordenados por más vencidos primero dentro de
 * cada zona.
 *
 * @param {string} fechaISO - YYYY-MM-DD. Default: hoy.
 * @returns {Promise<{fecha, paradas, porZona, total, vencidos, alDia}>}
 *   - paradas: [{ cliente, colonia, frecuencia, ultima, dias, interval, vencidoPor }]
 *   - porZona: [[zona, [paradas]]] (ordenado alfabéticamente por zona)
 *   - total: cantidad de paradas
 *   - vencidos: cuántos tienen vencidoPor > 0
 */
export async function rutaSugerida(fechaISO = hoyISO()) {
  const [clientes, pedidos] = await Promise.all([
    getAll(STORES.clientes), getAll(STORES.pedidos)
  ]);

  // Última fecha de entrega por cliente
  const ultima = new Map();
  pedidos.forEach((p) => {
    if (p.estado !== 'Entregado') return;
    const f = fechaVenta(p);
    if (!f) return;
    const prev = ultima.get(p.clienteId);
    if (!prev || f > prev) ultima.set(p.clienteId, f);
  });

  const paradas = [];
  clientes.forEach((c) => {
    const ult = ultima.get(c.id);
    if (!ult) return; // excluir sin compras registradas
    const interval = FRECUENCIA_DIAS[c.frecuencia] || 7;
    const dias = diasEntre(ult, fechaISO);
    if (dias < interval) return; // aún no toca
    const vencidoPor = dias - interval;
    paradas.push({
      cliente: c,
      colonia: (c.colonia || 'Sin colonia').trim() || 'Sin colonia',
      frecuencia: c.frecuencia || 'Semanal',
      ultima: ult,
      dias,
      interval,
      vencidoPor
    });
  });

  // Ordena por más vencidos primero
  paradas.sort((a, b) => b.vencidoPor - a.vencidoPor);

  // Agrupa por zona
  const porZonaMap = new Map();
  paradas.forEach((p) => {
    if (!porZonaMap.has(p.colonia)) porZonaMap.set(p.colonia, []);
    porZonaMap.get(p.colonia).push(p);
  });
  const porZona = Array.from(porZonaMap.entries())
    .sort((a, b) => a[0].localeCompare(b[0], 'es'));

  return {
    fecha: fechaISO,
    paradas,
    porZona,
    total: paradas.length,
    vencidos: paradas.filter((p) => p.vencidoPor > 0).length
  };
}

export const CREDITO = 'Crédito (adeudo)';

/** Cargo de cartera: permanece aunque se liquide, compensado por sus pagos. */
export function esAdeudoPedido(p) {
  return p && generaCargo(p);
}

/** ¿El pedido cuenta como venta? Cuando ya fue entregado. */
export function esVentaPedido(p) {
  return p && p.estado === 'Entregado';
}

export async function mapaClientes() {
  const clientes = await getAll(STORES.clientes);
  return new Map(clientes.map((c) => [c.id, c]));
}

export async function nombreCliente(clienteId, mapa) {
  const m = mapa || (await mapaClientes());
  const c = m.get(clienteId);
  return c ? c.nombre : '— Cliente eliminado —';
}

/** Saldo (adeudo) de un cliente. >0 significa que debe. */
export async function saldoCliente(clienteId) {
  return (await saldosTodos()).get(clienteId) || 0;
}
export async function saldosTodos() {
  const [pedidos, pagos] = await Promise.all([getAll(STORES.pedidos), getAll(STORES.pagos)]);
  return cartera(pedidos, pagos).saldos;
}

/** Ventas (suma de totales de pedidos) dentro de un rango de fechas ISO inclusivo. */
export function filtrarPorFecha(items, desdeISO, hastaISO) {
  return items.filter((it) => {
    const f = (it.estado === 'Entregado' ? fechaVenta(it) : it.fecha || '').slice(0, 10);
    if (desdeISO && f < desdeISO) return false;
    if (hastaISO && f > hastaISO) return false;
    return true;
  });
}

export async function resumenDashboard() {
  const [clientes, pedidos] = await Promise.all([
    getAll(STORES.clientes), getAll(STORES.pedidos)
  ]);
  const hoy = hoyISO();
  const lunes = inicioSemanaISO();
  const saldos = await saldosTodos();

  const pedidosHoy = filtrarPorFecha(pedidos, hoy, hoy);
  const pedidosSemana = filtrarPorFecha(pedidos, lunes, hoy);

  // Las ventas (ingresos) y garrafones vendidos cuentan solo lo ya ENTREGADO.
  const entregadosHoy = pedidosHoy.filter(esVentaPedido);
  const entregadosSemana = pedidosSemana.filter(esVentaPedido);
  const entregadosTotal = pedidos.filter(esVentaPedido);

  const ventasDia = entregadosHoy.reduce((s, p) => s + (Number(p.total) || 0), 0);
  const ventasSemana = entregadosSemana.reduce((s, p) => s + (Number(p.total) || 0), 0);
  // v2.6: usar cantidadTotalPedido (suma de líneas) en vez de p.cantidad escalar
  const garrafonesTotal = entregadosTotal.reduce((s, p) => s + cantidadTotalPedido(p), 0);
  const garrafonesHoy = entregadosHoy.reduce((s, p) => s + cantidadTotalPedido(p), 0);

  let adeudoTotal = 0; let clientesConAdeudo = 0;
  for (const v of saldos.values()) { if (v > 0.001) { adeudoTotal += v; clientesConAdeudo++; } }

  const pendientes = pedidos.filter((p) => p.estado === 'Pendiente').length;

  // KPIs ampliados
  const garrafonesSemana = entregadosSemana.reduce((s, p) => s + cantidadTotalPedido(p), 0);
  const pedidosEntregadosSemana = entregadosSemana.length;
  const ticketPromedio = pedidosEntregadosSemana ? ventasSemana / pedidosEntregadosSemana : 0;
  const pctConAdeudo = clientes.length ? (clientesConAdeudo / clientes.length) * 100 : 0;

  // v2.3: desglose por tamaño (total, hoy y semana)
  const garrafonesPorTamanoTotal = garrafonesPorTamano(entregadosTotal);
  const garrafonesPorTamanoHoy = garrafonesPorTamano(entregadosHoy);
  const garrafonesPorTamanoSemana = garrafonesPorTamano(entregadosSemana);

  return {
    ventasDia, ventasSemana,
    clientesActivos: clientes.length,
    adeudoTotal, clientesConAdeudo,
    garrafonesTotal, garrafonesHoy, garrafonesSemana,
    garrafonesPorTamanoTotal, garrafonesPorTamanoHoy, garrafonesPorTamanoSemana,
    pedidosHoy: pedidosHoy.length,
    pedidosEntregadosSemana,
    ticketPromedio,
    pctConAdeudo,
    pendientes
  };
}

/** Clientes ordenados por número de pedidos (más frecuentes primero). */
export async function clientesMasFrecuentes(limite = 10) {
  const [clientes, pedidos] = await Promise.all([
    getAll(STORES.clientes), getAll(STORES.pedidos)
  ]);
  const conteo = new Map();
  const garraf = new Map();
  pedidos.forEach((p) => {
    conteo.set(p.clienteId, (conteo.get(p.clienteId) || 0) + 1);
    // v2.6: usar cantidadTotalPedido (suma de líneas) en vez de p.cantidad escalar
    garraf.set(p.clienteId, (garraf.get(p.clienteId) || 0) + cantidadTotalPedido(p));
  });
  return clientes
    .map((c) => ({ cliente: c, pedidos: conteo.get(c.id) || 0, garrafones: garraf.get(c.id) || 0 }))
    .sort((a, b) => b.pedidos - a.pedidos || b.garrafones - a.garrafones)
    .slice(0, limite);
}

/** Seguimiento de clientes: a quién toca visitar y quién está en riesgo de fuga.
 * Calcula, según la frecuencia de cada cliente y su última entrega:
 *  - 'al_dia'      : comprado hace menos del intervalo de su frecuencia
 *  - 'por_visitar' : ya toca surtirle (entre 1x y 3x su intervalo)
 *  - 'inactivo'    : lleva 3x su intervalo o más sin comprar (riesgo de fuga)
 *  - 'sin_compras' : cliente registrado sin pedidos entregados
 */
export async function seguimientoClientes() {
  const [clientes, pedidos] = await Promise.all([getAll(STORES.clientes), getAll(STORES.pedidos)]);
  const ultima = new Map();
  pedidos.forEach((p) => {
    if (p.estado !== 'Entregado') return;
    const f = fechaVenta(p);
    if (!f) return;
    const prev = ultima.get(p.clienteId);
    if (!prev || f > prev) ultima.set(p.clienteId, f);
  });
  const hoy = hoyISO();
  return clientes.map((c) => {
    const interval = FRECUENCIA_DIAS[c.frecuencia] || 7;
    const ult = ultima.get(c.id) || null;
    const dias = ult ? diasEntre(ult, hoy) : null;
    let estado;
    if (!ult) estado = 'sin_compras';
    else if (dias >= interval * 3) estado = 'inactivo';
    else if (dias >= interval) estado = 'por_visitar';
    else estado = 'al_dia';
    return { cliente: c, ultima: ult, dias, interval, estado };
  });
}

/** Agrupa clientes por colonia (zona) para rutas. */
export async function clientesPorColonia() {
  const clientes = await getAll(STORES.clientes);
  const grupos = new Map();
  clientes.forEach((c) => {
    const zona = (c.colonia || 'Sin colonia').trim() || 'Sin colonia';
    if (!grupos.has(zona)) grupos.set(zona, []);
    grupos.get(zona).push(c);
  });
  // Ordenar zonas alfabéticamente y clientes por calle
  return Array.from(grupos.entries())
    .sort((a, b) => a[0].localeCompare(b[0], 'es'))
    .map(([zona, lista]) => [zona, lista.sort((a, b) => (a.calle || '').localeCompare(b.calle || '', 'es'))]);
}

/** Mapea un intervalo en días a la frecuencia más cercana de la lista. */
function frecuenciaDesdeDias(d) {
  let best = null; let bestDiff = Infinity;
  for (const [nombre, dias] of Object.entries(FRECUENCIA_DIAS)) {
    const diff = Math.abs(dias - d);
    if (diff < bestDiff) { bestDiff = diff; best = nombre; }
  }
  return best;
}

/** Analiza el historial de compras (entregadas) por cliente:
 *  última compra, días desde, número de compras, intervalo promedio real y
 *  frecuencia sugerida a partir de ese intervalo. Devuelve Map<clienteId, info>.
 */
export async function analisisComprasClientes() {
  const pedidos = await getAll(STORES.pedidos);
  const porCliente = new Map();
  pedidos.forEach((p) => {
    if (p.estado !== 'Entregado') return;
    const f = fechaVenta(p);
    if (!f) return;
    if (!porCliente.has(p.clienteId)) porCliente.set(p.clienteId, []);
    porCliente.get(p.clienteId).push(f);
  });
  const hoy = hoyISO();
  const res = new Map();
  for (const [id, fechas] of porCliente) {
    fechas.sort();
    const ultima = fechas[fechas.length - 1];
    const dias = diasEntre(ultima, hoy);
    let intervaloProm = null; let frecuenciaSugerida = null;
    if (fechas.length >= 2) {
      let suma = 0; let n = 0;
      for (let i = 1; i < fechas.length; i++) {
        const d = diasEntre(fechas[i - 1], fechas[i]);
        if (d > 0) { suma += d; n++; }
      }
      if (n > 0) { intervaloProm = Math.round(suma / n); frecuenciaSugerida = frecuenciaDesdeDias(intervaloProm); }
    }
    res.set(id, { ultima, dias, numCompras: fechas.length, intervaloProm, frecuenciaSugerida });
  }
  return res;
}

/** Inteligencia de negocio: costo, margen y utilidad por garrafón.
 * Usa una ventana móvil de los últimos `dias` días (por defecto 30) para suavizar
 * el "efecto sierra" de las compras grandes de pipa. El canje queda fuera del
 * cálculo del agua (no es venta de agua, es el envase).
 */
export async function inteligenciaPorGarrafon(dias = 30) {
  const [pedidos, gastos] = await Promise.all([getAll(STORES.pedidos), getAll(STORES.gastos)]);
  const hasta = hoyISO();
  const desde = sumarDiasISO(hasta, -(dias - 1));

  const entregados = filtrarPorFecha(pedidos.filter(esVentaPedido), desde, hasta);
  // v2.6: iterar líneas de cada pedido (un pedido puede tener múltiples tamaños)
  let garrafones = 0;
  let ingresoAgua = 0;
  entregados.forEach((p) => {
    lineasDePedido(p).forEach((l) => {
      const c = Number(l.cantidad) || 0;
      const pu = Number(l.precioUnit) || 0;
      garrafones += c;
      ingresoAgua += c * pu; // Ingreso SOLO por agua (excluye el cargo de canje del envase)
    });
  });

  let directo = 0; let distribucion = 0; let fijo = 0;
  filtrarPorFecha(gastos, desde, hasta).forEach((g) => {
    const m = Number(g.monto) || 0;
    const t = tipoGasto(g.categoria);
    if (t === 'directo') directo += m;
    else if (t === 'distribucion') distribucion += m;
    else fijo += m;
  });

  const hayDatos = garrafones > 0;
  const costoDirectoUnit = hayDatos ? directo / garrafones : 0;
  const precioProm = hayDatos ? ingresoAgua / garrafones : 0;
  const margenBruto = precioProm - costoDirectoUnit;
  const margenPct = precioProm > 0 ? (margenBruto / precioProm) * 100 : 0;
  const utilidadUnit = hayDatos ? (ingresoAgua - directo - distribucion - fijo) / garrafones : 0;

  return {
    desde, hasta, dias, hayDatos, garrafones, ingresoAgua,
    directo, distribucion, fijo,
    costoDirectoUnit, precioProm, margenBruto, margenPct, utilidadUnit
  };
}

/** Existencias de garrafones (nuevos / usados) calculadas desde los movimientos.
 *  v2.3: devuelve también el desglose por tamaño en `porTamano`.
 *  Cada movimiento puede tener los campos nuevos `nuevosPorTamano`/`usadosPorTamano`
 *  (objetos por tamaño) o los viejos `nuevos`/`usados` (escalares que asumimos
 *  pertenecen al `tamano` del movimiento o a 19L si no tiene). */
export async function stockGarrafones() {
  const movs = await getAll(STORES.inventario);
  const porTamano = {};
  TAMANOS_GARRAFON.forEach((t) => { porTamano[t] = { nuevos: 0, usados: 0 }; });
  let nuevosTotal = 0, usadosTotal = 0;
  movs.forEach((m) => {
    const tam = m.tamano || TAMANO_DEFAULT;
    if (m.nuevosPorTamano && typeof m.nuevosPorTamano === 'object') {
      TAMANOS_GARRAFON.forEach((t) => {
        const v = Number(m.nuevosPorTamano[t]) || 0;
        porTamano[t].nuevos += v;
        nuevosTotal += v;
      });
    } else {
      const v = Number(m.nuevos) || 0;
      if (porTamano[tam]) porTamano[tam].nuevos += v;
      nuevosTotal += v;
    }
    if (m.usadosPorTamano && typeof m.usadosPorTamano === 'object') {
      TAMANOS_GARRAFON.forEach((t) => {
        const v = Number(m.usadosPorTamano[t]) || 0;
        porTamano[t].usados += v;
        usadosTotal += v;
      });
    } else {
      const v = Number(m.usados) || 0;
      if (porTamano[tam]) porTamano[tam].usados += v;
      usadosTotal += v;
    }
  });
  // Redondea todo
  TAMANOS_GARRAFON.forEach((t) => {
    porTamano[t].nuevos = Math.round(porTamano[t].nuevos);
    porTamano[t].usados = Math.round(porTamano[t].usados);
  });
  return {
    nuevos: Math.round(nuevosTotal),
    usados: Math.round(usadosTotal),
    total: Math.round(nuevosTotal + usadosTotal),
    porTamano
  };
}

/** Cuenta garrafones de una lista de pedidos, agrupados por tamaño.
 *  v2.6: ahora itera las líneas de cada pedido (un pedido puede tener
 *  múltiples tamaños). Devuelve { '20L': n, '19L': n, '12L': n, '10L': n, _total: n }. */
export function garrafonesPorTamano(pedidos) {
  const out = {};
  TAMANOS_GARRAFON.forEach((t) => { out[t] = 0; });
  let total = 0;
  (pedidos || []).forEach((p) => {
    lineasDePedido(p).forEach((l) => {
      const tam = l.tamano || TAMANO_DEFAULT;
      const c = Number(l.cantidad) || 0;
      if (out[tam] != null) out[tam] += c;
      else out[tam] = c;
      total += c;
    });
  });
  out._total = total;
  return out;
}

/** Ventas agregadas por día dentro de un rango. */
export function ventasPorDia(pedidos, desdeISO, hastaISO) {
  const map = new Map();
  filtrarPorFecha(pedidos, desdeISO, hastaISO).forEach((p) => {
    const f = (fechaVenta(p) || '').slice(0, 10);
    const cur = map.get(f) || { fecha: f, total: 0, garrafones: 0, pedidos: 0 };
    cur.total += Number(p.total) || 0;
    // v2.6: usar cantidadTotalPedido (suma de líneas) en vez de p.cantidad escalar
    cur.garrafones += cantidadTotalPedido(p);
    cur.pedidos += 1;
    map.set(f, cur);
  });
  return Array.from(map.values()).sort((a, b) => a.fecha.localeCompare(b.fecha));
}

/** Suma total de gastos dentro de un rango de fechas ISO inclusivo. */
export function totalGastos(gastos, desdeISO, hastaISO) {
  return filtrarPorFecha(gastos, desdeISO, hastaISO)
    .reduce((s, g) => s + (Number(g.monto) || 0), 0);
}

/** Gastos agrupados por categoría dentro de un rango. Devuelve [ {categoria, total} ] desc. */
export function gastosPorCategoria(gastos, desdeISO, hastaISO) {
  const map = new Map();
  filtrarPorFecha(gastos, desdeISO, hastaISO).forEach((g) => {
    const cat = g.categoria || 'Otros';
    map.set(cat, (map.get(cat) || 0) + (Number(g.monto) || 0));
  });
  return Array.from(map.entries())
    .map(([categoria, total]) => ({ categoria, total }))
    .sort((a, b) => b.total - a.total);
}
