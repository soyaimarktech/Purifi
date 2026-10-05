/**
 * dashboard.js — Vista principal con indicadores clave (KPIs).
 */
import { el, dinero, numero, hoyISO, fechaLegible, diasEntre, CAPACIDAD_DIARIA, TAMANOS_GARRAFON } from '../utils.js';
import { resumenDashboard, seguimientoClientes, inteligenciaPorGarrafon } from '../services.js';
import { resumenCaja } from '../finanzas.js';
import { STORES, getAll, getConfig } from '../db.js';

function kpi(icono, label, valor, clase) {
  return el('div', { class: `kpi kpi--${clase}` }, [
    el('div', { class: 'kpi__icon', text: icono }),
    el('div', { class: 'kpi__valor', text: valor }),
    el('div', { class: 'kpi__label', text: label })
  ]);
}

export async function render(root) {
  const [r, cfg, seg] = await Promise.all([resumenDashboard(), getConfig(), seguimientoClientes()]);
  const caja = resumenCaja(...await Promise.all([getAll(STORES.pedidos), getAll(STORES.pagos), getAll(STORES.gastos)]), hoyISO());
  const porVisitar = seg.filter((i) => i.estado === 'por_visitar').length;
  const inactivos = seg.filter((i) => i.estado === 'inactivo').length;
  const bi = await inteligenciaPorGarrafon(30);

  root.innerHTML = '';
  root.appendChild(el('div', { class: 'page-head' }, [
    el('div', {}, [
      el('h2', { text: `Hola, ${cfg.negocio}` }),
      el('p', { class: 'page-sub', text: `Resumen de hoy · ${fechaLegible(hoyISO())}` })
    ])
  ]));

  // KPIs principales
  const grid = el('div', { class: 'kpi-grid' }, [
    kpi('💰', 'Ventas del día', dinero(r.ventasDia), 'verde'),
    kpi('📅', 'Ventas de la semana', dinero(r.ventasSemana), 'azul'),
    kpi('👥', 'Clientes activos', numero(r.clientesActivos), 'azul'),
    kpi('💵', 'Cobros del día', dinero(caja.cobros), 'verde'),
    kpi('⚠️', 'Saldos por cobrar', dinero(r.adeudoTotal), 'rojo')
  ]);
  root.appendChild(grid);
  root.appendChild(el('a', { href: '#/caja', class: 'btn btn--primary', text: 'Ver corte de caja' }));
  root.appendChild(el('p', { class: 'hint', text: 'Ventas por fecha de entrega. Cobros por fecha de pago, incluyendo adeudos anteriores.' }));

  const grid2 = el('div', { class: 'kpi-grid' }, [
    kpi('🛢️', 'Garrafones vendidos (total)', numero(r.garrafonesTotal), 'naranja'),
    kpi('🚚', 'Garrafones hoy', numero(r.garrafonesHoy), 'azul'),
    kpi('📦', 'Pedidos hoy', numero(r.pedidosHoy), 'verde'),
    kpi('⏳', 'Pedidos pendientes', numero(r.pendientes), 'naranja')
  ]);
  root.appendChild(grid2);

  // v2.3: mini-desglose por tamaño (hoy)
  const desgloseHoy = r.garrafonesPorTamanoHoy || {};
  const hayDesgloseHoy = TAMANOS_GARRAFON.some((t) => (desgloseHoy[t] || 0) > 0);
  if (hayDesgloseHoy) {
    root.appendChild(el('div', { class: 'card', style: 'padding:10px 14px' }, [
      el('div', { class: 'flex', style: 'justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px' }, [
        el('span', { html: '<strong>🛢️ Garrafones hoy por tamaño</strong>' }),
        el('div', { class: 'tag-line', style: 'margin:0' },
          TAMANOS_GARRAFON.map((t) => {
            const n = desgloseHoy[t] || 0;
            if (!n) return null;
            return el('span', { class: 'badge badge--info', text: `${t}: ${numero(n)}` });
          }).filter(Boolean)
        )
      ])
    ]));
  }

  // Indicadores ampliados (KPIs de gestión)
  const pct = Math.min(100, Math.round((r.garrafonesHoy / CAPACIDAD_DIARIA) * 100));
  const ociosa = Math.max(0, CAPACIDAD_DIARIA - r.garrafonesHoy);
  const indicadores = el('div', { class: 'card' }, [
    el('h3', { text: '📊 Indicadores de gestión' }),
    el('div', { class: 'mini-grid' }, [
      el('div', { class: 'mini' }, [el('div', { class: 'mini__valor', text: dinero(r.ticketPromedio) }), el('div', { class: 'mini__label', text: 'Ticket promedio (semana)' })]),
      el('div', { class: 'mini' }, [el('div', { class: 'mini__valor', text: numero(r.garrafonesSemana) }), el('div', { class: 'mini__label', text: 'Garrafones de la semana' })]),
      el('div', { class: 'mini' }, [el('div', { class: 'mini__valor', text: `${Math.round(r.pctConAdeudo)}%` }), el('div', { class: 'mini__label', text: 'Cartera con adeudo' })]),
      el('div', { class: 'mini' }, [el('div', { class: 'mini__valor', text: numero(r.pedidosEntregadosSemana) }), el('div', { class: 'mini__label', text: 'Pedidos entregados (semana)' })])
    ]),
    el('div', { style: 'margin-top:14px' }, [
      el('div', { class: 'flex', style: 'justify-content:space-between;margin-bottom:4px' }, [
        el('span', { html: '<strong>Capacidad usada hoy</strong>' }),
        el('span', { text: `${numero(r.garrafonesHoy)} / ${numero(CAPACIDAD_DIARIA)} garrafones` })
      ]),
      el('div', { class: 'barra' }, [el('div', { class: `barra__fill ${pct >= 80 ? 'barra__fill--alto' : ''}`, style: `width:${pct}%` })]),
      el('p', { class: 'muted', style: 'margin:6px 0 0', text: `${pct}% de la capacidad · capacidad ociosa: ${numero(ociosa)} garrafón(es). ${pct < 60 ? 'Hay margen para crecer la demanda.' : ''}` })
    ])
  ]);
  root.appendChild(indicadores);

  // Inteligencia de negocio: costo y margen por garrafón (ventana móvil 30 días)
  const biCard = el('div', { class: 'card' }, [
    el('h3', { text: '🧠 Centro de Inteligencia Operativa' }),
    el('p', { class: 'muted', style: 'margin:0 0 10px', text: 'Costo y margen por garrafón · promedio de los últimos 30 días (suaviza las compras de pipa).' })
  ]);
  if (!bi.hayDatos) {
    biCard.appendChild(el('p', { class: 'muted', text: 'Aún no hay suficientes ventas/gastos en los últimos 30 días. Registra pedidos entregados y gastos (pipa, tapas, sellos) para ver estos indicadores.' }));
  } else {
    const utilNeg = bi.utilidadUnit < 0;
    biCard.appendChild(el('div', { class: 'mini-grid' }, [
      el('div', { class: 'mini' }, [el('div', { class: 'mini__valor', text: dinero(bi.costoDirectoUnit) }), el('div', { class: 'mini__label', text: 'Costo directo de producción' })]),
      el('div', { class: 'mini' }, [el('div', { class: 'mini__valor', text: dinero(bi.precioProm) }), el('div', { class: 'mini__label', text: 'Precio promedio de venta' })]),
      el('div', { class: 'mini' }, [el('div', { class: 'mini__valor', text: `${dinero(bi.margenBruto)} · ${Math.round(bi.margenPct)}%` }), el('div', { class: 'mini__label', text: 'Margen bruto por garrafón' })]),
      el('div', { class: 'mini', style: utilNeg ? 'background:var(--rojo-claro,#ffebee)' : '' }, [el('div', { class: 'mini__valor', text: dinero(bi.utilidadUnit) }), el('div', { class: 'mini__label', text: 'Utilidad neta estimada' })])
    ]));
    biCard.appendChild(el('p', { class: 'muted', style: 'margin:10px 0 0', text: `Basado en ${numero(bi.garrafones)} garrafón(es) entregado(s) en el periodo. Si el costo de producción sube sin cambiar precios, puede ser señal de mermas o desperdicio.` }));
  }
  root.appendChild(biCard);

  // Alertas / avisos
  const avisos = el('div', { class: 'card' }, [ el('h3', { text: 'Resumen rápido' }) ]);
  const ul = el('div', { class: 'list' });

  if (r.clientesConAdeudo > 0) {
    ul.appendChild(el('div', { class: 'item' }, [
      el('div', { class: 'item__main' }, [
        el('div', { class: 'item__title', text: `${r.clientesConAdeudo} cliente(s) con adeudo` }),
        el('div', { class: 'item__meta', text: `Total por cobrar: ${dinero(r.adeudoTotal)}` })
      ]),
      el('button', { class: 'btn btn--warn btn--sm', text: 'Ver cobranza', onclick: () => window.navegar('cobranza') })
    ]));
  }
  if (r.pendientes > 0) {
    ul.appendChild(el('div', { class: 'item' }, [
      el('div', { class: 'item__main' }, [
        el('div', { class: 'item__title', text: `${r.pendientes} pedido(s) pendiente(s)` }),
        el('div', { class: 'item__meta', text: 'Marca las entregas realizadas en Rutas o Pedidos.' })
      ]),
      el('button', { class: 'btn btn--primary btn--sm', text: 'Ver rutas', onclick: () => window.navegar('rutas') })
    ]));
  }
  if (porVisitar > 0) {
    ul.appendChild(el('div', { class: 'item' }, [
      el('div', { class: 'item__main' }, [
        el('div', { class: 'item__title', text: `${porVisitar} cliente(s) por visitar` }),
        el('div', { class: 'item__meta', text: 'Según su frecuencia de compra, ya toca surtirles.' })
      ]),
      el('button', { class: 'btn btn--warn btn--sm', text: 'Ver seguimiento', onclick: () => window.navegar('seguimiento') })
    ]));
  }
  if (inactivos > 0) {
    ul.appendChild(el('div', { class: 'item' }, [
      el('div', { class: 'item__main' }, [
        el('div', { class: 'item__title', text: `${inactivos} cliente(s) inactivo(s)` }),
        el('div', { class: 'item__meta', text: 'Llevan mucho sin comprar — posible riesgo de fuga.' })
      ]),
      el('button', { class: 'btn btn--ghost btn--sm', text: 'Ver seguimiento', onclick: () => window.navegar('seguimiento') })
    ]));
  }
  if (!r.clientesConAdeudo && !r.pendientes && !porVisitar && !inactivos) {
    ul.appendChild(el('p', { class: 'muted', text: '¡Todo al día! No hay adeudos, pendientes ni clientes por visitar.' }));
  }
  avisos.appendChild(ul);
  root.appendChild(avisos);

  // Recordatorio de respaldo fuera del dispositivo
  const ultBackup = cfg.ultimoRespaldo ? cfg.ultimoRespaldo.slice(0, 10) : null;
  const diasBackup = ultBackup ? diasEntre(ultBackup, hoyISO()) : null;
  if (diasBackup == null || diasBackup >= 7) {
    root.appendChild(el('div', { class: 'card', style: 'background:var(--naranja-claro)' }, [
      el('div', { class: 'flex' }, [
        el('div', { class: 'grow' }, [
          el('div', { html: '<strong>🛟 Respalda tus datos</strong>' }),
          el('p', { class: 'muted', style: 'margin:2px 0 0', text: diasBackup == null
            ? 'Aún no has hecho un respaldo. Tus datos están solo en este dispositivo.'
            : `Tu último respaldo fue hace ${diasBackup} día(s). Envíalo a WhatsApp o Drive.` })
        ]),
        el('button', { class: 'btn btn--warn btn--sm', text: 'Respaldar', onclick: () => window.navegar('configuracion') })
      ])
    ]));
  }

  // Accesos rápidos
  const acc = el('div', { class: 'card' }, [
    el('h3', { text: 'Acciones rápidas' }),
    el('div', { class: 'btn-row' }, [
      el('button', { class: 'btn btn--primary btn--lg', text: '➕ Nuevo pedido', onclick: () => window.navegar('pedidos/nuevo') }),
      el('button', { class: 'btn btn--ghost btn--lg', text: '👤 Nuevo cliente', onclick: () => window.navegar('clientes/nuevo') }),
      el('button', { class: 'btn btn--ghost btn--lg', text: '💵 Registrar pago', onclick: () => window.navegar('cobranza') })
    ])
  ]);
  root.appendChild(acc);
}
