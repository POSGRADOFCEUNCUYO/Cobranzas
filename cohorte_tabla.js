/* ══════════════════════════════════════════════════════════════════
   cohorte_tabla.js — Lógica COMPARTIDA de la tabla de cuotas de una cohorte.

   Usado por las cuatro vistas de tabla de cohorte:
     - administrador_4_cohorte.html
     - coordinador_3_cohorte.html
     - Secretaria_4_Tabla.html
     - profesor_3_cohorte.html

   Objetivo: una sola fuente de verdad para la máquina de estados de cuotas
   y el cálculo de mora, evitando que cada vista mantenga su propia copia
   (que es como aparecían bugs corregidos en una vista pero no en otras).

   Depende de helpers definidos en supabase.js (cargar SIEMPRE después):
     redondear2, tieneMontoDefinido, calcMontoAbonado, vencioCuota, getSupabase
   ══════════════════════════════════════════════════════════════════ */

/* ══════════════════════════════════════════════════
   MÁQUINA DE ESTADOS DE CUOTAS — 7 reglas
══════════════════════════════════════════════════ */
function resolverEstadoCobro(c) {
    /* ──────────────────────────────────────────────────────
     * Implementa las 7 reglas del sistema de cuotas:
     * Regla 6: A_DEFINIR  → sin monto cargado
     * paso:    PENDIENTE  → comprobante subido, esperando revisión (sin recibo)
     * Regla 2: ABONADA    → recibo final aprobado, saldo = 0
     * Regla 3: PAGO_PARCIAL → recibo parcial, saldo > 0
     * Regla 5: EN_MORA    → venció + sin pago aprobado + sin comp. válido en revisión
     * default: NO_ABONADA → tiene monto, no venció, sin comprobante
     * ────────────────────────────────────────────────────── */
    if (c && c.no_aplica === true) return 'NO_APLICA';               // Cuota excluida
    if (!tieneMontoDefinido(c)) return 'A_DEFINIR';                     // Regla 6

    var estadoDb     = String((c && c.estado) || '').trim().toUpperCase();
    if (estadoDb === 'A_DEFINIR') return 'A_DEFINIR';                   // Regla 6b: estado explícito en BD
    var saldo        = (c && c.saldo_pendiente !== null && c.saldo_pendiente !== undefined && c.saldo_pendiente !== '')
                       ? redondear2(c.saldo_pendiente) : null;
    var montoFinal   = redondear2(c.monto_final);
    var montoAbonado = calcMontoAbonado(c);
    var tieneRecibo  = !!(c && c.recibo_url);
    var tieneComp    = !!(c && c.comprobante_url);

    // PENDIENTE: comprobante subido, esperando revisión cooperadora
    if (estadoDb === 'PENDIENTE' || (tieneComp && !tieneRecibo && montoAbonado <= 0)) return 'PENDIENTE';

    // ABONADA: recibo cargado + saldo = 0, o estado en BD ya es ABONADA con saldo = 0 (datos importados)
    if (saldo !== null && saldo <= 0 && (tieneRecibo || estadoDb === 'ABONADA')) return 'ABONADA';

    // EN_MORA sobre saldo parcial: recibo parcial vencido, saldo en mora, sin nuevo comprobante
    if (estadoDb === 'EN_MORA' && tieneRecibo && saldo !== null && saldo > 0 && montoAbonado > 0 && !tieneComp) return 'EN_MORA';

    // PAGO_PARCIAL: monto abonado con saldo pendiente, con o sin recibo (admin puede aprobar sin recibo)
    if (saldo !== null && saldo > 0 && montoAbonado > 0) return 'PAGO_PARCIAL';

    // EN_MORA: apenas vence sin pago aprobado y sin comprobante válido en revisión (Regla 5)
    // La BD puede tener EN_MORA (ya procesado) o puede ser nueva (recién venció)
    if (estadoDb === 'EN_MORA') return 'EN_MORA';
    if (vencioCuota(c) && montoAbonado <= 0 && !tieneComp) return 'EN_MORA';
    if (vencioCuota(c) && montoAbonado <= 0 && estadoDb !== 'PENDIENTE') return 'EN_MORA';

    return 'NO_ABONADA';
}

/* calcEstadoPostRechazo — Regla 4: rechazar nunca deja en PENDIENTE */
function calcEstadoPostRechazo(c) {
    if (!tieneMontoDefinido(c)) return 'A_DEFINIR';
    var montoAbonado = calcMontoAbonado(c);
    var saldo = redondear2(c.saldo_pendiente || 0);
    if (montoAbonado > 0 && saldo > 0) return vencioCuota(c) ? 'EN_MORA' : 'PAGO_PARCIAL';
    if (vencioCuota(c) && montoAbonado <= 0) return 'EN_MORA';
    return 'NO_ABONADA';
}

function etiquetaEstado(estado) {
    return {
        NO_ABONADA: 'No abonada',
        PENDIENTE: 'Pendiente',
        ABONADA: 'Abonada',
        PAGO_PARCIAL: 'Pago parcial',
        EN_MORA: 'En mora',
        A_DEFINIR: 'A definir'
    }[estado] || estado || '—';
}

function pesoEstado(estado) {
    return { EN_MORA: 6, PENDIENTE: 5, PAGO_PARCIAL: 4, NO_ABONADA: 3, A_DEFINIR: 2, ABONADA: 1, NO_APLICA: 0 }[estado] || 0;
}

function normalizarEstadoCuota(montoFinal, saldoPendiente, fechaVencimiento, estadoActual) {
    var mock = {
        monto_final: montoFinal,
        saldo_pendiente: saldoPendiente,
        fecha_vencimiento: fechaVencimiento,
        estado: estadoActual || '',
        recibo_url: ''
    };
    return resolverEstadoCobro(mock);
}

/* Estado general (peor estado) de un conjunto de cuotas de un estudiante */
function calcEstadoGeneral(cobros) {
    if (!cobros || cobros.length === 0) return 'A_DEFINIR';
    var peor = 'ABONADA';
    cobros.forEach(function(c) {
        var est = resolverEstadoCobro(c);
        if (pesoEstado(est) > pesoEstado(peor)) peor = est;
    });
    return peor;
}

/* ══════════════════════════════════════════════════
   MORA — recálculo del recargo vía RPC del servidor.
   El interés compuesto se calcula en la BD (aplicar_mora_cohorte_impl)
   para que el resultado sea idéntico en todas las vistas y en pg_cron.
══════════════════════════════════════════════════ */
async function aplicarMoraCohorteJS(cohorteId) {
    var sb = await getSupabase();
    await sb.rpc('aplicar_mora_cohorte', { p_cohorte_id: cohorteId });
}

/* ══════════════════════════════════════════════════
   FILTROS Y PAGINACIÓN DE LA TABLA
   Operan sobre el estado global `V` (V.data.estudiantes, V.filtro, V.page)
   y sobre el DOM estándar de las 4 vistas:
     .filter-btn[data-f]  → chips de filtro
     .fila-est[data-est]  → filas de estudiante (data-readmision opcional)
     #empty               → mensaje "sin resultados"
     #wrap-mas-est / #btn-mas-est → paginación (opcional; profesor no la usa)
   La paginación se autodetecta: si no existe #btn-mas-est, se muestran todas
   las filas (comportamiento de la vista profesor, sin "mostrar más").
══════════════════════════════════════════════════ */
var CT_PAGE_SIZE = 30;

function actualizarFiltros() {
    var ests = (typeof V !== 'undefined' && V.data && V.data.estudiantes) || [];
    var labels = {
        todos: 'Todos', ABONADA: 'Pagados', EN_MORA: 'En mora',
        PAGO_PARCIAL: 'Pago parcial', PENDIENTE: 'Pendiente',
        NO_ABONADA: 'No abonada', A_DEFINIR: 'A definir', READMISION: 'Readmisión'
    };
    document.querySelectorAll('.filter-btn').forEach(function(b) {
        var f = b.dataset.f;
        var n;
        if (f === 'todos') n = ests.length;
        else if (f === 'READMISION') n = ests.filter(function(e){ return (e.cobros||[]).some(function(c){ return c && c.es_readmision; }); }).length;
        else n = ests.filter(function(e){ return calcEstadoGeneral(e.cobros) === f; }).length;
        b.textContent = (labels[f] || f) + ' (' + n + ')';
    });
}

function initFiltros() {
    document.querySelectorAll('.filter-btn').forEach(function(b) {
        b.onclick = function() {
            V.filtro = b.dataset.f;
            document.querySelectorAll('.filter-btn').forEach(function(x){ x.classList.remove('active'); });
            b.classList.add('active');
            aplicarFiltro();
        };
    });
}

function aplicarFiltro() {
    V.page = 1;
    _aplicarFiltroYPag();
}

function _aplicarFiltroYPag() {
    var paginar = !!document.getElementById('btn-mas-est');
    var vis = 0, ocultas = 0;
    document.querySelectorAll('.fila-est').forEach(function(tr) {
        var ok = V.filtro === 'todos'
            ? true
            : V.filtro === 'READMISION'
                ? tr.dataset.readmision === '1'
                : tr.dataset.est === V.filtro;
        if (!ok) { tr.classList.add('oculta'); return; }
        vis++;
        var enPag = !paginar || vis <= V.page * CT_PAGE_SIZE;
        tr.classList.toggle('oculta', !enPag);
        if (!enPag) ocultas++;
    });
    var emptyEl = document.getElementById('empty');
    if (emptyEl) emptyEl.classList.toggle('show', vis === 0);
    var wrap = document.getElementById('wrap-mas-est');
    var btn  = document.getElementById('btn-mas-est');
    if (wrap && btn) {
        wrap.style.display = ocultas > 0 ? '' : 'none';
        btn.textContent = 'Mostrar ' + Math.min(ocultas, CT_PAGE_SIZE) + ' más (' + ocultas + ' restantes)';
    }
}

function mostrarMas() {
    V.page++;
    _aplicarFiltroYPag();
}

/* ══════════════════════════════════════════════════
   ESTADÍSTICAS DE LA CABECERA
   Cada stat se escribe solo si su elemento existe en el DOM, de modo que
   cada vista muestra las suyas:
     comunes  → s-aldia, s-mora, s-parcial, s-recaudado, s-egresos, s-saldo
     admin    → s-readmision (estudiantes con readmisión)
     profesor → s-mora-cuotas (cantidad de CUOTAS en mora, no estudiantes)
══════════════════════════════════════════════════ */
async function actualizarStats() {
    // Fuente única de verdad: el RPC stats_cohorte calcula TODO en el servidor
    // (misma máquina de 7 reglas + peor estado) para que cada rol vea
    // exactamente los mismos números. Acá solo se muestran.
    var cohorteId = (typeof COHORTE_ID !== 'undefined' && COHORTE_ID)
        ? COHORTE_ID
        : (new URLSearchParams(location.search).get('cohorte_id')
            || new URLSearchParams(location.search).get('cohorte') || null);
    if (!cohorteId) return;

    var sb = await getSupabase();
    var r = await sb.rpc('stats_cohorte', { p_cohorte_id: Number(cohorteId) });
    if (r.error || !r.data) { console.error('stats_cohorte:', r.error); return; }
    var st = r.data;

    function setTxt(id, val) { var el = document.getElementById(id); if (el) el.textContent = val; }

    setTxt('s-total',   st.total);
    setTxt('s-activos', st.activos);
    setTxt('s-bajas',   st.bajas);
    // 's-cancela' = "Cancela carrera": estudiantes activos con TODAS las cuotas abonadas
    setTxt('s-cancela', st.pagados);
    // 's-pendiente' = "Pendiente": cuotas esperando aprobación de cooperadora
    setTxt('s-pendiente', st.pendiente);
    setTxt('s-mora',    st.en_mora);
    // 's-aldia' = "Al día": activos, no en mora y que aún no cancelaron la carrera
    setTxt('s-aldia',   st.al_dia);
    setTxt('s-readmision', st.readmision);
    setTxt('s-mora-cuotas', st.cuotas_en_mora);
    // ARS y USD NUNCA se suman entre sí
    setTxt('s-recaudado', fMontoDual(st.ingresos_ars, st.ingresos_usd));
    setTxt('s-egresos',   fMontoDual(st.egresos_ars, st.egresos_usd));

    var saldo = Number(st.ingresos_ars || 0) - Number(st.egresos_ars || 0); // el neto es ARS
    var sEl = document.getElementById('s-saldo');
    if (sEl) {
        sEl.textContent = fMonto(saldo) + ((Number(st.ingresos_usd) > 0 || Number(st.egresos_usd) > 0) ? ' (ARS)' : '');
        sEl.style.color = saldo >= 0 ? 'var(--clr-success)' : 'var(--clr-danger)';
    }
}

/* ══════════════════════════════════════════════════
   RENDER DE LA TABLA — esqueleto común dirigido por configuración de vista.

   Cada vista define en su <script> un objeto global `CT_VIEW` con el HTML
   específico de su rol (que difiere de verdad: columnas, botones, edición),
   manteniendo sus propios helpers locales (encodeAttr, verDocumento,
   abrirCeldaPopup, navegar, etc.) por cierre. El módulo aporta el armado
   del thead, el recorrido de estudiantes, el cobrosMap, los totales y el
   filtrado, que es la parte realmente compartida.

   CT_VIEW = {
     leadingHeader: '<th>…</th>…',  // columnas ANTES de las cuotas (check, nombre, desc, email, estado cohorte)
     totales(est, columnas, cobrosMap) -> { p, a, s },
     celda(c, est, estado, montoAbonado, col) -> '<td>…</td>',   // cobro existente
     celdaVacia(est, col) -> '<td>…</td>',                       // sin cobro en esa columna
     fila(est, estadoGen, celdas, totP, totA, totS) -> <tr> | string,
     afterRender()  // opcional (p.ej. onChk)
   }
   La cabecera de cuotas y la de totales son idénticas en las 4 vistas, así
   que las genera el módulo.
══════════════════════════════════════════════════ */
var CT_TRAILING_HEADER =
      '<th class="tot-hdr th-pagar">Total a<br>Pagar</th>'
    + '<th class="tot-hdr th-abonado">Total<br>Abonado</th>'
    + '<th class="tot-hdr th-saldo">Saldo<br>Pendiente</th>';

function renderTabla() {
    var cfg = window.CT_VIEW || {};
    V.page = 1;
    var columnas = V.data.columnas, estudiantes = V.data.estudiantes;
    var thead = document.getElementById('t-head');
    var tbody = document.getElementById('t-body');

    // Valor base de cada cuota (precio de lista = monto_original, igual para todos
    // los alumnos). Se toma el máximo por columna para ignorar los "no aplica" (0).
    var basePorCol = {};
    (estudiantes || []).forEach(function(est) {
        (est.cobros || []).forEach(function(c) {
            if (!c) return;
            var k = keyCuota(c.concepto_base || c.concepto, c.periodo);
            var mo = Number(c.monto_original) || 0;
            if (!basePorCol[k] || mo > basePorCol[k].monto) {
                basePorCol[k] = { monto: mo, moneda: c.moneda || 'ARS' };
            }
        });
    });

    var colsHtml = columnas.map(function(c) {
        var b = basePorCol[keyCuota(c.concepto_base, c.periodo)];
        var baseHtml = (b && b.monto > 0)
            ? '<br><span class="col-cuota-base" style="font-weight:700;color:#F5D372;font-size:10px;">' + escapeHtml(fMonto(b.monto, b.moneda)) + '</span>'
            : '';
        return '<th class="col-cuota">' + escapeHtml(c.concepto_base)
             + '<br><span style="font-weight:400;color:#fff;font-size:9px;">' + escapeHtml(c.periodo || '') + '</span>'
             + baseHtml + '</th>';
    }).join('');
    thead.innerHTML = '<tr>' + (cfg.leadingHeader || '') + colsHtml + CT_TRAILING_HEADER + '</tr>';

    tbody.innerHTML = '';
    estudiantes.forEach(function(est) {
        var estadoGen = calcEstadoGeneral(est.cobros);

        var cobrosMap = {};
        (est.cobros || []).forEach(function(c) {
            if (!c) return;
            cobrosMap[keyCuota(c.concepto_base || c.concepto, c.periodo)] = c;
            cobrosMap[keyCuota(c.concepto, c.periodo)] = c;
            c._estado_resuelto = resolverEstadoCobro(c);
            c.monto_abonado = calcMontoAbonado(c);
        });

        var tot = cfg.totales ? cfg.totales(est, columnas, cobrosMap) : { p: 0, a: 0, s: 0 };

        var celdas = columnas.map(function(col) {
            var c = cobrosMap[keyCuota(col.concepto_base, col.periodo)];
            if (!c) return cfg.celdaVacia ? cfg.celdaVacia(est, col) : '<td></td>';
            return cfg.celda(c, est, c._estado_resuelto, c.monto_abonado, col);
        }).join('');

        var fila = cfg.fila(est, estadoGen, celdas, tot.p, tot.a, tot.s);
        if (typeof fila === 'string') {
            var tmp = document.createElement('tbody');
            tmp.innerHTML = fila;
            while (tmp.firstChild) tbody.appendChild(tmp.firstChild);
        } else if (fila) {
            tbody.appendChild(fila);
        }
    });

    aplicarFiltro();
    if (typeof cfg.afterRender === 'function') cfg.afterRender();
}
