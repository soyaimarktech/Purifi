import { el, esc, dinero, hoyISO, abrirModal, cerrarModal, toast, METODOS_PAGO } from '../utils.js';
import { registrarPago } from '../libro.js';

export function formularioCobro({ cliente, pedidoId, saldo, alGuardar }) {
  if (!cliente) { toast('No se encontró el cliente.', 'error'); return; }
  if (saldo <= 0) { toast('El cliente no tiene saldo por cobrar.', 'info'); return; }
  const f = el('form', { class: 'form' });
  f.innerHTML = `
    <p><strong>${esc(cliente.nombre)}</strong>${pedidoId ? ` · Pedido #${pedidoId}` : ''}<br>Saldo pendiente: ${dinero(saldo)}</p>
    <div class="field"><label for="cMonto">Monto recibido</label><input id="cMonto" name="monto" type="number" min="0.01" max="${saldo}" step="0.01" value="${saldo}" required></div>
    <div class="field"><label for="cFecha">Fecha en que se recibió el pago</label><input id="cFecha" name="fecha" type="date" value="${hoyISO()}" max="${hoyISO()}" required></div>
    <div class="field"><label for="cMetodo">Método de pago</label><select id="cMetodo" name="metodoPago" required><option value="">Selecciona…</option>${METODOS_PAGO.map(m => `<option>${m}</option>`).join('')}</select></div>
    <div class="field"><label for="cConcepto">Concepto</label><input id="cConcepto" name="concepto" placeholder="Abono o liquidación"></div>
    <p class="hint">${pedidoId ? 'Se abonará a este pedido.' : 'Se aplicará a los cargos pendientes más antiguos.'} El cobro aparecerá en la fecha indicada.</p>
    <div class="form__actions"><button type="button" class="btn btn--ghost">Cancelar</button><button type="submit" class="btn btn--success">Registrar pago</button></div>`;
  f.querySelector('[type="button"]').onclick = cerrarModal;
  f.onsubmit = async e => {
    e.preventDefault();
    const boton = f.querySelector('[type="submit"]');
    if (boton.disabled) return;
    boton.disabled = true;
    try {
      const datos = Object.fromEntries(new FormData(f));
      await registrarPago({ ...datos, monto: Number(datos.monto), clienteId: cliente.id, ...(pedidoId ? { pedidoId } : {}) });
      cerrarModal(); toast('Pago registrado con su fecha de cobro.', 'success');
      await alGuardar?.();
    } catch (error) { toast(error.message, 'error'); boton.disabled = false; }
  };
  abrirModal('Registrar pago', f);
}
