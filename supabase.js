/**
 * ══════════════════════════════════════════════════════════════
 * supabase.js
 * Cliente Supabase + funciones de API para todas las vistas
 * ══════════════════════════════════════════════════════════════
 */

// La rueda del mouse sobre un <input type="number"> enfocado cambia el valor
// en un step (p.ej. 50000 → 49999.99 con step=0.01) sin que el usuario lo note.
// Quitamos el foco antes de que el navegador aplique el cambio.
document.addEventListener('wheel', function () {
    var el = document.activeElement;
    if (el && el.tagName === 'INPUT' && el.type === 'number') el.blur();
}, { passive: true });

function escapeHtml(str) {
    if (str == null) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// Escapa un valor para insertarlo en un string JS de comilla simple que vive
// dentro de un atributo HTML de comilla doble, p.ej.  onclick="fn('VALOR')".
// Necesario porque escapeHtml() por sí solo NO sirve en este contexto: el
// navegador decodifica las entidades del atributo ANTES de que el parser JS lo
// lea, así que un &#39; vuelve a ser ' y rompe/inyecta el string (XSS).
// Paso 1: escapar el contexto JS (\ y '). Paso 2: escapar el contexto HTML.
function escapeJsAttr(str) {
    return escapeHtml(String(str == null ? '' : str).replace(/\\/g, '\\\\').replace(/'/g, "\\'"));
}

// Escapa SOLO para string JS (\ y '), sin escape HTML. Para JS dentro de un
// atributo HTML (onclick="...") usar escapeJsAttr/escJs (que ademas escapa HTML).
function escapeJs(valor) { return String(valor==null?'':valor).replaceAll('\\','\\\\').replaceAll("'","\\'"); }

const SUPABASE_URL = 'https://fdevypdowdhqaxvfiywt.supabase.co';
const SUPABASE_KEY = 'sb_publishable_PxypVbCcQuum2EtxuJRmkg_korPHaCW';

// Preconnect al dominio de la API para reducir latencia TLS en cada página.
// Se inyecta una sola vez: si la etiqueta ya existe no se duplica.
(function() {
    if (typeof document === 'undefined') return;
    ['https://fdevypdowdhqaxvfiywt.supabase.co', 'https://cdn.jsdelivr.net'].forEach(function(origin) {
        if (document.querySelector('link[rel="preconnect"][href="' + origin + '"]')) return;
        var l = document.createElement('link');
        l.rel = 'preconnect'; l.href = origin; l.crossOrigin = '';
        document.head.appendChild(l);
    });
}());

// ══════════════════════════════════════════════════════════════
// INICIALIZAR CLIENTE
// ══════════════════════════════════════════════════════════════

let _supabase = null;

async function getSupabase() {
    if (_supabase) return _supabase;

    if (window.supabase && window.supabase.createClient) {
        _supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
        return _supabase;
    }

    await new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js';
        script.onload = resolve;
        script.onerror = reject;
        document.head.appendChild(script);
    });

    _supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
    return _supabase;
}

// ══════════════════════════════════════════════════════════════
// LEER TODAS LAS FILAS (paginado)
// PostgREST/Supabase devuelve como máximo 1000 filas por consulta. Para
// cohortes grandes (p.ej. 67 estudiantes × 24 cuotas = 1608 cobros) eso
// trunca los datos. Este helper trae TODO en bloques de 1000.
//
// Recibe una FÁBRICA que devuelve un query builder nuevo en cada llamada
// (un builder no se puede reejecutar después de await), ya con sus filtros
// y .order() aplicados. NO le agregues .range() vos: lo hace el helper.
//
//   var { data, error } = await sbFetchAll(function() {
//     return sb.from('cobros').select('...').eq('cohorte_id', id).order('fecha_vencimiento');
//   });
// ══════════════════════════════════════════════════════════════

async function sbFetchAll(makeQuery, pageSize) {
    pageSize = pageSize || 1000;
    var todas = [], desde = 0;
    while (true) {
        var { data, error } = await makeQuery().range(desde, desde + pageSize - 1);
        if (error) return { data: null, error: error };
        todas = todas.concat(data || []);
        if (!data || data.length < pageSize) break;
        desde += pageSize;
    }
    return { data: todas, error: null };
}

// ══════════════════════════════════════════════════════════════
// AUTENTICACIÓN
// ══════════════════════════════════════════════════════════════

async function login(dni, password) {
    const sb = await getSupabase();

    // Lookup por DNI via RPC (SECURITY DEFINER): evita exponer tabla usuarios a anon
    const { data: usuarioPre, error: errPre } = await sb
        .rpc('get_login_data', { user_dni: String(dni) });

    if (errPre || !usuarioPre) {
        return { ok: false, mensaje: 'DNI o contraseña incorrectos' };
    }
    if (!usuarioPre.activo) {
        return { ok: false, mensaje: 'Usuario inactivo' };
    }

    // Login con el email real del usuario
    const { data, error } = await sb.auth.signInWithPassword({
        email: usuarioPre.email,
        password: password
    });

    if (error) {
        return { ok: false, mensaje: 'DNI o contraseña incorrectos' };
    }

    const usuario = usuarioPre;

    localStorage.setItem('sigpo_rol',         usuario.rol);
    localStorage.setItem('sigpo_nombre',      usuario.nombre_completo);
    localStorage.setItem('sigpo_apellido',    usuario.apellido || '');
    localStorage.setItem('sigpo_nombre2',     usuario.nombre || '');
    localStorage.setItem('sigpo_dni',         usuario.dni);
    localStorage.setItem('sigpo_email',       usuario.email);
    localStorage.setItem('sigpo_programa_id', usuario.programa_id || '');
    localStorage.setItem('sigpo_usuario_id',  String(usuario.usuario_id || ''));

    return {
        ok: true,
        rol: usuario.rol,
        nombre: usuario.nombre_completo,
        email: usuario.email
    };
}

async function logout() {
    const sb = await getSupabase();
    await sb.auth.signOut();
    localStorage.removeItem('sigpo_rol');
    localStorage.removeItem('sigpo_nombre');
    localStorage.removeItem('sigpo_apellido');
    localStorage.removeItem('sigpo_nombre2');
    localStorage.removeItem('sigpo_dni');
    localStorage.removeItem('sigpo_email');
    localStorage.removeItem('sigpo_programa_id');
    localStorage.removeItem('sigpo_usuario_id');
    return { ok: true };
}

function getSesion() {
    let rol = localStorage.getItem('sigpo_rol');
    if (!rol) return null;
    // GERENTE_COOPERADORA es un clon de SECRETARIA: en todo el frontend se comporta
    // igual (mismas pantallas, mismos guardianes). El rol real queda en la BD.
    if (rol === 'GERENTE_COOPERADORA') rol = 'SECRETARIA';
    return {
        rol:         rol,
        nombre:      localStorage.getItem('sigpo_nombre'),
        nombre_pila: localStorage.getItem('sigpo_nombre2'),
        dni:         localStorage.getItem('sigpo_dni'),
        email:       localStorage.getItem('sigpo_email'),
        programa_id: localStorage.getItem('sigpo_programa_id'),
        usuario_id:  localStorage.getItem('sigpo_usuario_id') || null
    };
}

async function requireAuth() {
    const sb = await getSupabase();
    const { data: { session } } = await sb.auth.getSession();
    if (!session) {
        window.location.href = 'portal_login.html';
        return null;
    }
    // Verify role from DB using the authenticated JWT (not localStorage)
    const { data: usuario, error } = await sb
        .from('usuarios')
        .select('usuario_id, rol, nombre_completo, apellido, nombre, dni, email, programa_id, debe_cambiar_password')
        .eq('auth_user_id', session.user.id)
        .maybeSingle();
    if (error || !usuario) {
        window.location.href = 'portal_login.html';
        return null;
    }
    // Primer ingreso sin clave propia definida: volver al login, que fuerza
    // la pantalla de cambio de clave. Evita saltearla navegando directo a una URL.
    if (usuario.debe_cambiar_password) {
        window.location.href = 'portal_login.html';
        return null;
    }
    // Sync localStorage with server-verified data
    localStorage.setItem('sigpo_rol',         usuario.rol);
    localStorage.setItem('sigpo_nombre',      usuario.nombre_completo || '');
    localStorage.setItem('sigpo_apellido',    usuario.apellido || '');
    localStorage.setItem('sigpo_nombre2',     usuario.nombre  || '');
    localStorage.setItem('sigpo_dni',         usuario.dni);
    localStorage.setItem('sigpo_email',       usuario.email);
    localStorage.setItem('sigpo_programa_id', String(usuario.programa_id || ''));
    localStorage.setItem('sigpo_usuario_id',  String(usuario.usuario_id || ''));
    return getSesion();
}

async function recuperarPassword(dni) {
    const sb = await getSupabase();
    const { data: usuario } = await sb
        .from('usuarios')
        .select('email')
        .eq('dni', dni)
        .single();

    if (!usuario) return { ok: false };

    const { error } = await sb.auth.resetPasswordForEmail(usuario.email);
    if (error) return { ok: false };

    const email = usuario.email;
    const partes = email.split('@');
    const oculto = partes[0].substring(0, 3) + '***@' + partes[1];
    return { ok: true, email: oculto };
}

// ══════════════════════════════════════════════════════════════
// NAVEGACIÓN
// ══════════════════════════════════════════════════════════════

function navegar(pagina) {
    window.location.href = pagina;
}

function cerrarSesion(e) {
    if (e) e.preventDefault();
    if (!confirm('¿Querés cerrar la sesión?')) return false;
    logout().then(function () {
        window.location.href = 'portal_login.html';
    });
    return false;
}

const RUTAS_POR_ROL = {
    'ESTUDIANTE':    'portal_estudiante_2_dashboard.html',
    'COORDINADOR':   'coordinador_1_dashboard.html',
    'PROFESOR':      'profesor_1_dashboard.html',
    'SECRETARIA':    'secretaria_1_dashboard.html',
    'GERENTE_COOPERADORA': 'secretaria_1_dashboard.html',
    'COOPERADORA':   'cooperadora_2_Dashboard.html',
    'ADMINISTRADOR': 'administrador_2_dashboard.html'
};

// ══════════════════════════════════════════════════════════════
// TAXONOMÍA: PROGRAMAS vs CURSOS
// Programas (posgrado): DOCTORADO, MAESTRIA, ESPECIALIZACION → Cohorte
// Cursos: DIPLOMADO, DIPLOMATURA, CURSO, MICRO_MAESTRIA     → Edición
// ══════════════════════════════════════════════════════════════

var TIPOS_PROGRAMA = ['DOCTORADO', 'MAESTRIA', 'ESPECIALIZACION'];
var TIPOS_CURSO    = ['DIPLOMADO', 'DIPLOMATURA', 'CURSO', 'MICRO_MAESTRIA'];

function getCategoriaPrograma(tipo) {
    if (!tipo) return 'Programa';
    return TIPOS_PROGRAMA.indexOf((tipo || '').toUpperCase()) >= 0 ? 'Programa' : 'Curso';
}

function getLabelNomenclatura(tipo) {
    return getCategoriaPrograma(tipo) === 'Programa' ? 'Cohorte' : 'Edición';
}

function getLabelNomenclaturaPlural(tipo) {
    return getCategoriaPrograma(tipo) === 'Programa' ? 'Cohortes' : 'Ediciones';
}

function getIconoTipo(tipo) {
    var t = (tipo || '').toUpperCase();
    var iconos = {
        'DOCTORADO':      '🎓',
        'MAESTRIA':       '📊',
        'ESPECIALIZACION':'💼',
        'DIPLOMADO':      '🏅',
        'DIPLOMATURA':    '📜',
        'CURSO':          '📖',
        'MICRO_MAESTRIA': '🔬'
    };
    return iconos[t] || '📚';
}

// ══════════════════════════════════════════════════════════════
// ESTADOS ACADÉMICOS — constantes centralizadas
// El enum en la BD tiene: ACTIVO, BAJA
// ══════════════════════════════════════════════════════════════
var ESTADO_ACTIVO = 'ACTIVO';
var ESTADO_BAJA   = 'BAJA';

// ══════════════════════════════════════════════════════════════
// NOTIFICACIONES
// ══════════════════════════════════════════════════════════════

var _notifs = [];

async function obtenerNotificaciones(rol) {
    const sb = await getSupabase();
    const sesion = getSesion();
    if (!sesion) return [];

    const { data, error } = await sb
        .from('notificaciones')
        .select('*')
        .or('usuario_dni.eq.' + sesion.dni + ',rol_destino.eq.' + rol)
        .order('created_at', { ascending: false })
        .limit(20);

    return error ? [] : (data || []).map(function (n) {
        return {
            id: String(n.id),
            tipo: n.tipo,
            mensaje: n.mensaje,
            tiempo: tiempoRelativo(n.created_at),
            leida: n.leida
        };
    });
}

async function marcarNotificacionLeida(id) {
    const sb = await getSupabase();
    await sb.from('notificaciones').update({ leida: true }).eq('id', id);
}

async function marcarTodasNotificacionesLeidas() {
    const sb = await getSupabase();
    const sesion = getSesion();
    if (!sesion) return;
    // Marcar las personales (usuario_dni) y las del rol (rol_destino)
    await Promise.all([
        sb.from('notificaciones').update({ leida: true })
            .eq('usuario_dni', sesion.dni).eq('leida', false),
        sb.from('notificaciones').update({ leida: true })
            .eq('rol_destino', sesion.rol).eq('leida', false)
    ]);
}

/**
 * Formatea una fecha ISO (YYYY-MM-DD) a DD/MM/YYYY
 * Usada en todos los HTML del sistema
 */
function fFecha(fecha) {
    if (!fecha) return '—';
    var partes = String(fecha).split('T')[0].split('-');
    if (partes.length !== 3) return fecha;
    return partes[2] + '/' + partes[1] + '/' + partes[0];
}

// ══════════════════════════════════════════════════════════════
// UTILIDADES COMPARTIDAS DE NEGOCIO
// Disponibles en todos los HTML que incluyan supabase.js
// ══════════════════════════════════════════════════════════════

function hoy() { return new Date().toISOString().split('T')[0]; }

// Clave de mes 'YYYY-MM' a partir de una fecha ISO. Usada en reportes y cashflow.
function mesKey(iso) { return String(iso||'').split('T')[0].substring(0,7); }

// Etiqueta de mes 'Abr 2026' a partir de una fecha/clave ISO. Usada en reportes.
function mesLabel(iso) { var meses=['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic']; var p=String(iso||'').split('T')[0].split('-'); return p.length>=2 ? meses[parseInt(p[1])-1]+' '+p[0] : iso||''; }

// Fecha 'YYYY-MM-DD' -> 'DD/MM/YYYY' (vacio -> ''). Copia compartida del fmt() de reportes.
function fmt(iso) { if (!iso) return ''; var p = iso.split('-'); return p[2]+'/'+p[1]+'/'+p[0]; }

// True si la pagina corre embebida en Google Apps Script (entorno legacy).
function estaEnAppsScript() { return typeof google !== 'undefined' && google.script && google.script.run; }

// Exportar todas las <table> de la pagina a un .xlsx (carga SheetJS bajo demanda).
// Version generica compartida; las paginas con export propio la sobrescriben localmente.
function exportarExcel() {
        var loadXLSX = window.XLSX
            ? Promise.resolve()
            : new Promise(function(res, rej) {
                var s = document.createElement('script');
                s.src = 'https://cdn.sheetjs.com/xlsx-0.20.1/package/dist/xlsx.full.min.js';
                s.onload = res; s.onerror = rej;
                document.head.appendChild(s);
              });
        loadXLSX.then(function() {
            var wb = XLSX.utils.book_new();
            var tables = document.querySelectorAll('table');
            if (!tables.length) { alert('No hay tablas para exportar.'); return; }
            tables.forEach(function(tbl, i) {
                var ws = XLSX.utils.table_to_sheet(tbl);
                XLSX.utils.book_append_sheet(wb, ws, 'Hoja' + (i + 1));
            });
            var nombre = (document.title || 'reporte').replace(/[^a-zA-Z0-9 ]/g, '_').trim();
            XLSX.writeFile(wb, nombre + '.xlsx');
        }).catch(function(e) { alert('Error al exportar: ' + (e.message || e)); });
    }

// Exportar a PDF via el dialogo de impresion del navegador.
function exportarPDF() { window.print(); }

function redondear2(n) { return Math.round((Number(n)||0)*100)/100; }

function keyCuota(c, p) { return String(c||'')+'||'+String(p||''); }

function tieneMontoDefinido(c) {
    return !(c==null||c.monto_final===null||c.monto_final===undefined||c.monto_final===''||isNaN(Number(c.monto_final)));
}

function vencioCuota(c) {
    if (!c||!c.fecha_vencimiento) return false;
    return String(c.fecha_vencimiento) < hoy();
}

function calcMontoAbonado(c) {
    if (c && c.monto_abonado != null && Number(c.monto_abonado) > 0)
        return redondear2(Number(c.monto_abonado));
    return redondear2(Math.max(0,(Number(c&&c.monto_final)||0)-(Number(c&&c.saldo_pendiente)||0)));
}

/** Símbolo de la moneda: ARS → '$' · USD → 'U$D ' */
function simboloMoneda(moneda) {
    return (moneda === 'USD') ? 'U$D ' : '$';
}

/** Formato estándar: $90.000,50 (o U$D 90.000,50). moneda es opcional, default ARS. */
function fMonto(n, moneda) {
    if (n===null||n===undefined) return '–';
    return simboloMoneda(moneda)+Number(n).toLocaleString('es-AR',{minimumFractionDigits:2,maximumFractionDigits:2});
}

// Formato de moneda oficial del sistema: $1.234,00 (decision de Anneris 2026-06).
// fM era una copia local divergente en muchas paginas; ahora es esta unica version.
function fM(n) { return '$' + Number(n||0).toLocaleString('es-AR', {minimumFractionDigits:2, maximumFractionDigits:2}); }

/** Formato abreviado para dashboards: $1,5M · $90k · $500,00. moneda opcional. */
// Monto COMPLETO (decision de Anneris 2026-06: nada de abreviar $1,5M).
// Mantiene el nombre fMillones por compatibilidad y el soporte de moneda (ARS/USD).
function fMillones(n, moneda) {
    if (n===null||n===undefined||n==='') return '$0,00';
    var num = parseFloat(n);
    if (isNaN(num)) return '$0,00';
    var sim = simboloMoneda(moneda);
    return (num < 0 ? '-' + sim : sim) + Math.abs(num).toLocaleString('es-AR', {minimumFractionDigits:2, maximumFractionDigits:2});
}

/** Formato con signo para egresos/flujos: -$5.000,00. moneda opcional. */
function fMontoConSigno(n, moneda) {
    if (n===null||n===undefined) return '–';
    var num = parseFloat(n);
    if (isNaN(num)) return '–';
    var sim = simboloMoneda(moneda);
    return (num<0?'-'+sim:sim)+Math.abs(num).toLocaleString('es-AR',{minimumFractionDigits:2,maximumFractionDigits:2});
}

/** Fecha corta: "15 May" */
function fFechaCorta(str) {
    if (!str) return '—';
    var meses = ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];
    var p = String(str).split('T')[0].split('-');
    if (p.length!==3) return str;
    return p[2]+' '+meses[parseInt(p[1],10)-1];
}

/** Muestra ARS y USD separados: "$X · U$D Y". Si USD=0 o no existe, solo muestra ARS.
    USD negativo también se muestra (p.ej. saldo USD deficitario). */
function fMontoDual(ars, usd) {
    var txt = fMonto(ars);
    if (Number(usd || 0) !== 0) txt += ' · ' + fMonto(usd, 'USD');
    return txt;
}
/** Versión abreviada para dashboards: "$1,5M · U$D 900k". Si USD=0, solo ARS. */
function fMillonesDual(ars, usd) {
    var txt = fMillones(ars);
    if (Number(usd || 0) > 0) txt += ' · ' + fMillones(usd, 'USD');
    return txt;
}

/** Alias de escapeHtml para compatibilidad con archivos que usan esc() */
var esc = escapeHtml;
var escJs = escapeJsAttr;

/** Toast de notificación unificado. tipo: 'ok' | 'err' | '' */
function toast(msg, tipo) {
    var cont = document.getElementById('toasts') || document.getElementById('toast');
    if (!cont) return;
    var d = document.createElement('div');
    // Aplica ambas convenciones de clase: '.toast.ok/.err' (mayoría de páginas)
    // y '.toast-ok/.toast-err' (consumidores previos de supabase.js).
    d.className = 'toast'+(tipo==='err'?' err toast-err':tipo==='ok'?' ok toast-ok':'');
    d.textContent = msg;
    cont.appendChild(d);
    setTimeout(function(){ if(d.parentNode) d.parentNode.removeChild(d); }, 3500);
}

function tiempoRelativo(fecha) {
    var ahora = new Date();
    var diff = ahora - new Date(fecha);
    var mins = Math.floor(diff / 60000);
    if (mins < 1) return 'Ahora';
    if (mins < 60) return 'Hace ' + mins + ' min';
    var horas = Math.floor(mins / 60);
    if (horas < 24) return 'Hace ' + horas + (horas === 1 ? ' hora' : ' horas');
    var dias = Math.floor(horas / 24);
    if (dias < 7) return 'Hace ' + dias + (dias === 1 ? ' día' : ' días');
    return new Date(fecha).toLocaleDateString('es-AR');
}

function toggleNotif() {
    var dd = document.getElementById('notif-dropdown');
    if (!dd) return;
    dd.style.display = dd.style.display === 'block' ? 'none' : 'block';
}

function renderNotificaciones(datos) {
    _notifs = datos || [];
    var sinLeer = _notifs.filter(function (n) { return !n.leida; }).length;
    var badge = document.getElementById('notif-badge');
    if (badge) {
        badge.textContent = sinLeer;
        badge.style.display = sinLeer > 0 ? 'flex' : 'none';
    }
    var lista = document.getElementById('notif-list');
    if (!lista) return;
    if (_notifs.length === 0) {
        lista.innerHTML = '<div style="padding:32px 20px;text-align:center;color:#9ca3af;font-size:14px;">No hay notificaciones</div>';
        return;
    }
    var iconos = { pago: '💰', mora: '🔴', solicitud: '📋', reclamo: '⚠️', alerta: '🚨', cuota: '📅' };
    var colores = { pago: '#dcfce7', mora: '#fee2e2', solicitud: '#dbeafe', reclamo: '#fef3c7', alerta: '#fce7f3', cuota: '#dbeafe' };
    lista.innerHTML = _notifs.map(function (n) {
        return '<div style="display:flex;gap:12px;padding:14px 20px;border-bottom:1px solid #f3f4f6;cursor:pointer;background:' + (n.leida ? '#fff' : '#fffbeb') + ';" onclick="leerNotif(\'' + escapeHtml(n.id) + '\')">'
            + '<div style="width:38px;height:38px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:18px;flex-shrink:0;background:' + (colores[n.tipo] || '#f3f4f6') + ';">' + (iconos[n.tipo] || '🔔') + '</div>'
            + '<div style="flex:1;"><p style="font-size:13px;color:#000;line-height:1.4;">' + escapeHtml(n.mensaje) + '</p><div style="font-size:11px;color:#000;margin-top:3px;">' + escapeHtml(n.tiempo) + '</div></div></div>';
    }).join('');
}

function leerNotif(id) {
    _notifs.forEach(function (n) { if (n.id === id) n.leida = true; });
    renderNotificaciones(_notifs);
    marcarNotificacionLeida(id);
}

function marcarTodasLeidas() {
    _notifs.forEach(function (n) { n.leida = true; });
    renderNotificaciones(_notifs);
    marcarTodasNotificacionesLeidas();
}

document.addEventListener('click', function (e) {
    var w = document.querySelector('.notif-wrapper');
    if (w && !w.contains(e.target)) {
        var dd = document.getElementById('notif-dropdown');
        if (dd) dd.style.display = 'none';
    }
});

// ══════════════════════════════════════════════════════════════
// PROGRAMAS
// ══════════════════════════════════════════════════════════════

async function obtenerProgramas() {
    const sb = await getSupabase();
    const { data } = await sb.from('programas').select('*').order('nombre');
    return data || [];
}

async function obtenerCohortes(programaId) {
    const sb = await getSupabase();
    let query = sb.from('cohortes').select('*').order('fecha_inicio', { ascending: false });
    if (programaId) query = query.eq('programa_id', programaId);
    const { data } = await query;
    return data || [];
}

/**
 * Obtener estudiantes de una cohorte.
 * CAMBIO: ahora usa la tabla inscripciones (N:N) en vez de
 * los campos directos estudiantes.programa_id / cohorte_id
 */
async function obtenerEstudiantes(programaId, cohorteId) {
    const sb = await getSupabase();

    if (cohorteId) {
        // Obtener IDs de estudiantes inscritos en esta cohorte
        const { data: insc } = await sb
            .from('inscripciones')
            .select('estudiante_id, descuento_porcentaje, estado_academico, fecha_inscripcion')
            .eq('cohorte_id', cohorteId);

        if (!insc || !insc.length) return [];

        const ids = insc.map(function(i) { return i.estudiante_id; });
        const { data: ests } = await sb
            .from('estudiantes')
            .select('*')
            .in('id', ids)
            .order('apellido');

        // Fusionar datos de inscripción en cada estudiante
        const inscMap = {};
        insc.forEach(function(i) { inscMap[i.estudiante_id] = i; });

        return (ests || []).map(function(e) {
            var i = inscMap[e.id] || {};
            return Object.assign({}, e, {
                descuento_porcentaje: i.descuento_porcentaje !== undefined ? i.descuento_porcentaje : e.descuento_porcentaje,
                estado_academico:     i.estado_academico || e.estado_academico,
                cohorte_id:           cohorteId,
                inscripcion_id:       i.id || null
            });
        });
    }

    if (programaId) {
        // Cohortes del programa → inscripciones → estudiantes
        const { data: cohs } = await sb
            .from('cohortes')
            .select('cohorte_id')
            .eq('programa_id', programaId);
        if (!cohs || !cohs.length) return [];

        const cohIds = cohs.map(function(c) { return c.cohorte_id; });
        const { data: insc } = await sb
            .from('inscripciones')
            .select('estudiante_id')
            .in('cohorte_id', cohIds);
        if (!insc || !insc.length) return [];

        const ids = [...new Set(insc.map(function(i) { return i.estudiante_id; }))];
        const { data: ests } = await sb
            .from('estudiantes')
            .select('*')
            .in('id', ids)
            .order('apellido');
        return ests || [];
    }

    // Sin filtros: todos
    const { data } = await sb.from('estudiantes').select('*').order('apellido');
    return data || [];
}

/**
 * Detalle de programa con sus cohortes y estadísticas.
 * Usa el RPC stats_programa — una sola llamada al servidor
 * en lugar de las 6 queries encadenadas anteriores.
 */
async function obtenerDetallePrograma(programaId) {
    const sb = await getSupabase();
    const { data, error } = await sb.rpc('stats_programa', { p_programa_id: Number(programaId) });
    if (error || !data) {
        console.error('stats_programa error:', error);
        return null;
    }

    var prog     = data.programa;
    var cohortes = data.cohortes || [];

    return {
        id:     prog.id,
        nombre: prog.nombre,
        tipo:   prog.tipo,
        cohortes: cohortes.map(function(coh) {
            var alDia          = Math.max(0, Number(coh.activos) - Number(coh.en_mora));
            var recaudadoARS   = Number(coh.ingresos_ars || 0);
            var recaudadoUSD   = Number(coh.ingresos_usd || 0);
            var egresosARS     = Number(coh.egresos_ars  || 0);
            var egresosUSD     = Number(coh.egresos_usd  || 0);
            return {
                id:               coh.id,
                nombre:           coh.nombre,
                estado:           coh.estado,
                fechaInicio:      coh.fecha_inicio,
                fechaFin:         coh.fecha_fin,
                estudiantes:      Number(coh.total),
                totalEstudiantes: Number(coh.total),
                activos:          Number(coh.activos),
                bajas:            Number(coh.bajas),
                alDia:            alDia,
                enMora:           Number(coh.en_mora),
                pagoParcial:      Number(coh.pago_parcial),
                readmision:       Number(coh.readmision),
                cuotasEnMora:     Number(coh.cuotas_en_mora),
                recaudado:        recaudadoARS,
                recaudadoARS:     recaudadoARS,
                recaudadoUSD:     recaudadoUSD,
                egresos:          egresosARS,
                egresosARS:       egresosARS,
                egresosUSD:       egresosUSD,
                saldo:            recaudadoARS - egresosARS
            };
        })
    };
}

// ══════════════════════════════════════════════════════════════
// CONFIGURACIÓN (con caché de sesión — 5 minutos)
// ══════════════════════════════════════════════════════════════

var _cfgCache = null;
var _cfgCacheTs = 0;
var _CFG_TTL = 5 * 60 * 1000;

async function obtenerConfiguracion() {
    var now = Date.now();
    if (_cfgCache && (now - _cfgCacheTs) < _CFG_TTL) return _cfgCache;
    var sb = await getSupabase();
    var { data } = await sb.from('configuracion').select('clave,valor');
    var cfg = {};
    (data || []).forEach(function(r) { cfg[r.clave] = r.valor; });
    cfg.moraPct = parseFloat(cfg.mora_porcentaje) || 5;
    _cfgCache = cfg;
    _cfgCacheTs = now;
    return cfg;
}

function invalidarConfiguracion() {
    _cfgCache = null;
    _cfgCacheTs = 0;
}

// COBROS (CUOTAS)
// ══════════════════════════════════════════════════════════════

async function obtenerCobros(filtros) {
    const sb = await getSupabase();
    let query = sb.from('cobros').select('*');
    if (filtros) {
        if (filtros.dni)         query = query.eq('dni', filtros.dni);
        if (filtros.programa_id) query = query.eq('programa_id', filtros.programa_id);
        if (filtros.cohorte_id)  query = query.eq('cohorte_id', filtros.cohorte_id);
        if (filtros.estado)      query = query.eq('estado', filtros.estado);
    }
    const { data } = await query.order('fecha_vencimiento');
    return data || [];
}

async function subirComprobante(cobroId, file, montoTransferido) {
    const sb = await getSupabase();
    const sesion = getSesion();
    if (!sesion) return { ok: false };

    const safeName = file.name
        .normalize('NFD').replace(/[̀-ͯ]/g, '')
        .replace(/[^a-zA-Z0-9._-]/g, '_');
    const fileName = sesion.dni + '/' + Date.now() + '_' + safeName;
    const { data: uploadData, error: uploadErr } = await sb.storage
        .from('comprobantes')
        .upload(fileName, file);

    if (uploadErr) return { ok: false, mensaje: 'Error al subir archivo: ' + uploadErr.message };

    const { data: urlData, error: urlErr } = sb.storage.from('comprobantes').getPublicUrl(fileName);
    if (urlErr || !urlData || !urlData.publicUrl) return { ok: false, mensaje: 'Error al obtener URL del archivo' };

    const ahora = new Date().toISOString();
    const updateData = {
        estado: 'PENDIENTE',
        comprobante_url: urlData.publicUrl,
        comprobante_fecha: ahora,
        fecha_pago: ahora.split('T')[0]
    };
    if (montoTransferido && Number(montoTransferido) > 0) updateData.monto_transferido = Number(montoTransferido);

    const { error: updateErr } = await sb.from('cobros').update(updateData).eq('cobro_id', cobroId);

    if (updateErr) return { ok: false, mensaje: 'Error al actualizar cobro' };
    return { ok: true, url: urlData.publicUrl };
}

async function aprobarPago(cobroId, tipo, montoAprobado, reciboFile) {
    const sb = await getSupabase();

    let reciboUrl = null;
    if (reciboFile) {
        const safeName = reciboFile.name
            .normalize('NFD').replace(/[̀-ͯ]/g, '')
            .replace(/[^a-zA-Z0-9._-]/g, '_');
        const fileName = 'recibos/' + cobroId + '/' + Date.now() + '_' + safeName;
        const { error: uploadErr } = await sb.storage.from('comprobantes').upload(fileName, reciboFile);
        if (uploadErr) return { ok: false, mensaje: 'Error al subir recibo' };
        const { data: urlData } = sb.storage.from('comprobantes').getPublicUrl(fileName);
        reciboUrl = urlData.publicUrl;
    }

    // Validación rápida de saldo en cliente para mejor UX en pago parcial
    if (tipo !== 'COMPLETO' && tipo !== 'total') {
        var montoInc = Number(montoAprobado);
        if (!(montoInc > 0)) return { ok: false, mensaje: 'El monto del pago debe ser mayor a cero' };
        const { data: cobroCheck } = await sb.from('cobros')
            .select('saldo_pendiente').eq('cobro_id', cobroId).single();
        if (cobroCheck) {
            var saldoActual = Number(cobroCheck.saldo_pendiente);
            if (!isNaN(saldoActual) && saldoActual > 0 && montoInc > saldoActual + 0.01) {
                return { ok: false, mensaje: 'El monto (' + fMonto(montoInc) + ') supera el saldo pendiente (' + fMonto(saldoActual) + ')' };
            }
        }
    }

    // La lógica de aprobación (update cobros + insert pagos) corre en el servidor
    // vía RPC con SECURITY DEFINER para no requerir RLS de escritura en cobros/pagos.
    const { data: rpcRes, error: rpcErr } = await sb.rpc('aprobar_cobro', {
        p_cobro_id:   cobroId,
        p_tipo:       tipo,
        p_monto:      Number(montoAprobado) || null,
        p_recibo_url: reciboUrl
    });
    if (rpcErr) return { ok: false, mensaje: rpcErr.message || 'Error al aprobar' };
    if (rpcRes && !rpcRes.ok) return { ok: false, mensaje: rpcRes.mensaje || 'Error al aprobar' };
    return { ok: true, url: reciboUrl };
}

async function obtenerUrlFirmadaComprobante(comprobanteUrl) {
    if (!comprobanteUrl) return null;
    var match = String(comprobanteUrl).match(/\/object\/(?:public|sign)\/comprobantes\/(.+)/);
    if (!match) return comprobanteUrl;
    var filePath = match[1];
    var sb = await getSupabase();
    var result = await sb.storage.from('comprobantes').createSignedUrl(filePath, 3600);
    if (result.error || !result.data) return null;
    return result.data.signedUrl;
}

async function rechazarPago(cobroId, forzar, motivoRechazo) {
    const sb = await getSupabase();

    // Se pre-fetcha el cobro solo para los datos que necesita el email de notificación.
    const { data: cobro } = await sb.from('cobros').select('*').eq('cobro_id', cobroId).single();
    if (!cobro) return { ok: false };

    const motivo = (motivoRechazo || '').trim();

    // La lógica de rechazo (validación, update cobros) corre en el servidor
    // vía RPC con SECURITY DEFINER.
    const { data: rpcRes, error: rpcErr } = await sb.rpc('rechazar_cobro', {
        p_cobro_id: cobroId,
        p_motivo:   motivo || null,
        p_forzar:   forzar || false
    });
    if (rpcErr) return { ok: false, mensaje: rpcErr.message || 'Error al rechazar' };
    if (rpcRes && !rpcRes.ok) return { ok: false, mensaje: rpcRes.mensaje };

    var nuevoEstado = (rpcRes && rpcRes.nuevo_estado) || 'NO_ABONADA';

    // Notificar al estudiante por email
    try {
        const { data: est } = await sb.from('estudiantes')
            .select('nombre, apellido, email')
            .eq('dni', cobro.dni)
            .single();
        const { data: prog } = await sb.from('programas')
            .select('nombre, programa_id')
            .eq('programa_id', cobro.programa_id)
            .single();
        if (est && est.email && prog) {
            const concepto = cobro.concepto || 'cuota';
            const periodo  = cobro.periodo  || '';
            await sb.from('reclamos_pendientes').insert({
                programa_id: prog.programa_id,
                to_email:    est.email,
                subject:     'Comprobante rechazado: ' + concepto + (periodo ? ' (' + periodo + ')' : '') + ' — ' + prog.nombre,
                body:        'Estimado/a ' + est.nombre + ' ' + est.apellido + ',\n\n'
                           + 'Tu comprobante de pago para la siguiente cuota fue revisado y NO pudo ser aprobado:\n\n'
                           + '  • Concepto: ' + concepto + '\n'
                           + (periodo ? '  • Período: ' + periodo + '\n' : '')
                           + '  • Programa: ' + prog.nombre + '\n\n'
                           + (motivo ? 'Motivo del rechazo: ' + motivo + '\n\n' : '')
                           + 'Por favor, volvé a ingresar al portal, verificá los datos y subí el comprobante correcto.\n\n'
                           + 'Portal de estudiantes: https://posgradofceuncuyo.github.io/Cobranzas/portal_login.html\n\n'
                           + 'Ante cualquier consulta, respondé este correo.\n\n'
                           + 'Secretaría de Posgrado — FCE UNCUYO',
                reply_to:    null,
                estado:      'pendiente'
            });
        }
    } catch (e) {
        console.warn('No se pudo encolar email de rechazo:', e.message || e);
    }

    return { ok: true, nuevoEstado: nuevoEstado };
}

// ══════════════════════════════════════════════════════════════
// INSCRIPCIONES — alta/baja de estudiante en una cohorte
// CAMBIO: ya no toca estudiantes.estado_academico sino inscripciones
// ══════════════════════════════════════════════════════════════

/**
 * Cambiar estado académico de un estudiante EN UNA COHORTE específica.
 * nuevoEstado debe ser 'ACTIVO' o 'BAJA' (valores del enum en la BD).
 */
async function cambiarEstadoInscripcion(estudianteId, cohorteId, nuevoEstado) {
    const sb = await getSupabase();
    const { error } = await sb
        .from('inscripciones')
        .update({ estado_academico: nuevoEstado })
        .eq('estudiante_id', estudianteId)
        .eq('cohorte_id', cohorteId);
    return { ok: !error, error: error };
}

/**
 * Obtener el estado académico de un estudiante en una cohorte concreta.
 */
async function getEstadoInscripcion(estudianteId, cohorteId) {
    const sb = await getSupabase();
    const { data } = await sb
        .from('inscripciones')
        .select('estado_academico, descuento_porcentaje, id')
        .eq('estudiante_id', estudianteId)
        .eq('cohorte_id', cohorteId)
        .single();
    return data || null;
}

// ══════════════════════════════════════════════════════════════
// EGRESOS
// ══════════════════════════════════════════════════════════════

async function obtenerEgresos(filtros) {
    const sb = await getSupabase();
    let query = sb.from('egresos').select('*');
    if (filtros) {
        if (filtros.programa_id) query = query.eq('programa_id', filtros.programa_id);
        if (filtros.cohorte_id)  query = query.eq('cohorte_id', filtros.cohorte_id);
        if (filtros.tipo)        query = query.eq('tipo', filtros.tipo);
    }
    const { data } = await query.order('fecha_estimada');
    return data || [];
}

// Resumen ligero de egresos de una cohorte (tipo, monto_pagado, monto_original)
// Idéntico en: administrador_4_cohorte, cooperadora_5_cohorte, coordinador_3_cohorte,
//              profesor_2_cohorte, Secretaria_4_Tabla, secretaria_3_detalle_cohorte
async function obtenerEgresosResumenPorCohorte(cohorteId) {
    const sb = await getSupabase();
    const { data, error } = await sb.from('egresos')
        .select('tipo, monto_pagado, monto_original')
        .eq('cohorte_id', cohorteId);
    if (error) throw error;
    return data || [];
}

// Inscripciones de una cohorte. campos: string de columnas para SELECT (opcional)
async function obtenerInscripcionesPorCohorte(cohorteId, campos) {
    const sb = await getSupabase();
    const select = campos || 'estudiante_id, descuento_porcentaje, estado_academico, descuento_motivo, descuento_desde, descuento_hasta';
    const { data, error } = await sb.from('inscripciones')
        .select(select)
        .eq('cohorte_id', cohorteId);
    if (error) throw error;
    // Normalizar campos opcionales para evitar 'undefined' en la UI
    return (data || []).map(function(r) {
        return Object.assign({ descuento_motivo: null, descuento_desde: null, descuento_hasta: null }, r);
    });
}

// Recibos Tango para un conjunto de cobro_ids. Retorna mapa { cobro_id: [recibo, ...] }
async function obtenerRecibosTango(cobroIds) {
    if (!cobroIds || cobroIds.length === 0) return {};
    const sb = await getSupabase();
    const { data, error } = await sb
        .from('recibos_tango')
        .select('id, cobro_id, nro_recibo, pdf_url, estado, procesado_en')
        .in('cobro_id', cobroIds)
        .order('procesado_en', { ascending: true });
    if (error) { console.error('obtenerRecibosTango:', error); return {}; }
    const map = {};
    (data || []).forEach(r => {
        if (!map[r.cobro_id]) map[r.cobro_id] = [];
        map[r.cobro_id].push(r);
    });
    return map;
}

// Cobros para reportes de tasa de deserción (campo fijo, todos los programas)
async function obtenerCobrosParaDesercion() {
    const sb = await getSupabase();
    const { data, error } = await sb.from('cobros')
        .select('programa_id, cohorte_id, dni, estado, fecha_vencimiento, monto_final, saldo_pendiente, no_aplica, recibo_url, comprobante_url');
    if (error) throw error;
    return data || [];
}

// Catálogo de programas con campos configurables
async function obtenerProgramasCatalogo(campos) {
    const sb = await getSupabase();
    const select = campos || 'programa_id, nombre, tipo';
    const { data, error } = await sb.from('programas').select(select).order('nombre');
    if (error) throw error;
    return data || [];
}

async function guardarEgreso(datos) {
    const sb = await getSupabase();
    if (datos.egreso_id) {
        const id = datos.egreso_id;
        const payload = Object.assign({}, datos);
        delete payload.egreso_id;
        const { error } = await sb.from('egresos').update(payload).eq('egreso_id', id);
        if (error) throw error;
        return { ok: true };
    } else {
        const { error } = await sb.from('egresos').insert(datos);
        if (error) throw error;
        return { ok: true };
    }
}

async function eliminarEgreso(egresoId) {
    const sb = await getSupabase();
    const { error } = await sb.from('egresos').delete().eq('egreso_id', egresoId);
    return { ok: !error };
}

async function guardarConfiguracion(datos) {
    const sb = await getSupabase();
    for (var clave in datos) {
        await sb.from('configuracion').upsert({ clave: clave, valor: String(datos[clave]) }, { onConflict: 'clave' });
    }
    return { ok: true };
}

// ══════════════════════════════════════════════════════════════
// CATEGORÍAS DE GASTOS
// ══════════════════════════════════════════════════════════════

async function obtenerCategoriasGastos() {
    const sb = await getSupabase();
    const { data } = await sb.from('categorias_gastos').select('*').order('id');
    return data || [];
}

async function guardarCategoriasGastos(cambios) {
    const sb = await getSupabase();
    for (var i = 0; i < cambios.length; i++) {
        await sb.from('categorias_gastos').update({ tipo: cambios[i].tipoNuevo }).eq('id', cambios[i].id);
    }
    return { ok: true };
}

// ══════════════════════════════════════════════════════════════
// USUARIOS
// ══════════════════════════════════════════════════════════════

async function obtenerUsuarios() {
    const sb = await getSupabase();
    const { data } = await sb.from('usuarios').select('*').order('nombre_completo');
    return data || [];
}

/**
 * Obtener programas asignados a un coordinador (via coordinadores_programas)
 */
async function obtenerProgramasCoordinador(usuarioId) {
    const sb = await getSupabase();
    const { data } = await sb
        .from('coordinadores_programas')
        .select('programa_id, programas(nombre, tipo)')
        .eq('coordinador_id', usuarioId);
    return data || [];
}

/**
 * Retorna un array de programa_id asignados al usuario con ese dni.
 * Usado por las páginas de coordinador/profesor para filtrar datos.
 * Usa usuario_id cacheado en localStorage para hacer una sola consulta.
 */
/**
 * Resuelve el usuario_id a partir del DNI de forma AUTORITATIVA (consulta la tabla
 * usuarios; la RLS permite leer la fila propia). NO usa el sigpo_usuario_id de
 * localStorage como fuente, porque ese valor es global al navegador y se contamina
 * cuando se inicia sesión con distintos usuarios en pestañas/sesiones distintas
 * (causa de que un profesor viera "0 asignaciones": leía el id de otro usuario).
 * Cachea en memoria por dni (no en localStorage) para evitar reconsultas en la página.
 */
var _uidPorDniCache = {};
async function _resolverUsuarioIdPorDni(sb, dni) {
    var key = String(dni);
    if (_uidPorDniCache[key]) return _uidPorDniCache[key];
    const { data: u } = await sb.from('usuarios').select('usuario_id').eq('dni', key).single();
    if (!u) return null;
    _uidPorDniCache[key] = String(u.usuario_id);
    return _uidPorDniCache[key];
}

async function obtenerProgramasAsignadosPorDni(dni) {
    const sb = await getSupabase();
    const uid = await _resolverUsuarioIdPorDni(sb, dni);
    if (!uid) return [];
    const { data: asignaciones } = await sb
        .from('coordinadores_programas')
        .select('programa_id')
        .eq('coordinador_id', uid);
    if (!asignaciones || !asignaciones.length) return [];
    return [...new Set(asignaciones.map(function(a){ return a.programa_id; }))];
}

/**
 * Retorna { progIds, cohIds } para un coordinador/profesor.
 * progIds = programas asignados sin cohorte específica (ve todas las cohortes del programa).
 * cohIds  = cohortes específicas asignadas.
 * Resuelve el usuario_id por DNI (autoritativo), no por el cache global de localStorage.
 */
async function obtenerAsignacionesCoordinador(dni) {
    const sb = await getSupabase();
    const uid = await _resolverUsuarioIdPorDni(sb, dni);
    if (!uid) return { progIds: [], cohIds: [] };
    const { data: asigs } = await sb
        .from('coordinadores_programas')
        .select('programa_id, cohorte_id')
        .eq('coordinador_id', uid);
    if (!asigs || !asigs.length) return { progIds: [], cohIds: [] };
    const progIds = [...new Set(asigs.filter(function(a){ return !a.cohorte_id; }).map(function(a){ return a.programa_id; }))];
    const cohIds  = [...new Set(asigs.filter(function(a){ return  a.cohorte_id; }).map(function(a){ return a.cohorte_id; }))];
    return { progIds, cohIds };
}

/**
 * Asignar programas/cohortes a un coordinador o profesor (reemplaza los existentes).
 * Acepta dos formatos en `asignaciones` (retrocompatible):
 *  - Array de ids de programa:        [7, 8]            → asignación a programa completo
 *  - Array de objetos:                [{programa_id, cohorte_id}, ...] → respeta cohorte específica
 * Si cohorte_id es null/undefined, queda como asignación a programa completo (ve todas las cohortes).
 */
async function asignarProgramasCoordinador(usuarioId, asignaciones) {
    const sb = await getSupabase();
    // Borrar asignaciones previas
    await sb.from('coordinadores_programas').delete().eq('coordinador_id', usuarioId);
    if (!asignaciones || !asignaciones.length) return { ok: true };
    // Insertar nuevas — normaliza ambos formatos a {coordinador_id, programa_id, cohorte_id}
    const rows = asignaciones.map(function(a) {
        if (a !== null && typeof a === 'object') {
            return {
                coordinador_id: usuarioId,
                programa_id: a.programa_id,
                cohorte_id: a.cohorte_id != null ? a.cohorte_id : null
            };
        }
        return { coordinador_id: usuarioId, programa_id: a, cohorte_id: null };
    });
    const { error } = await sb.from('coordinadores_programas').insert(rows);
    return { ok: !error };
}

async function guardarUsuario(datos) {
    const sb = await getSupabase();
    if (datos.usuario_id) {
        const { error } = await sb.from('usuarios').update(datos).eq('usuario_id', datos.usuario_id);
        return { ok: !error };
    } else {
        const { error } = await sb.from('usuarios').insert(datos);
        return { ok: !error };
    }
}

async function darDeBaja(usuarioId) {
    const sb = await getSupabase();
    const { error } = await sb.from('usuarios').update({ activo: false }).eq('usuario_id', usuarioId);
    return { ok: !error };
}

async function darDeAlta(usuarioId) {
    const sb = await getSupabase();
    const { error } = await sb.from('usuarios').update({ activo: true }).eq('usuario_id', usuarioId);
    return { ok: !error };
}

// ══════════════════════════════════════════════════════════════
// DASHBOARD ADMIN
// CAMBIO: cuenta estudiantes via inscripciones, no via programa_id directo
// ══════════════════════════════════════════════════════════════

async function obtenerDashboardAdmin() {
    const sb = await getSupabase();
    const { data, error } = await sb.rpc('dashboard_stats_admin');
    if (error) throw error;

    var r = data; // JSON returned by the RPC
    var totalInscriptos = Number(r.totalInscriptos || 0);
    var totalEnMora     = Number(r.totalEnMora     || 0);

    return {
        totalProgramas:         (r.programas || []).length,
        totalProgramasPosgrado: Number(r.totalProgramasPosgrado || 0),
        totalCursos:            Number(r.totalCursos            || 0),
        totalEstudiantes:       Number(r.totalEstudiantes || totalInscriptos),
        estudiantesActivos:     totalInscriptos,
        bajas:                  Number(r.totalBajas || 0),
        alDia:                  Math.max(0, totalInscriptos - totalEnMora),
        enMora:                 totalEnMora,
        cuotasEnMora:           Number(r.totalCuotasEnMora  || 0),
        totalReadmisiones:      Number(r.totalReadmisiones  || 0),
        totalReadmisionesPendientes: Number(r.totalReadmisionesPendientes || 0),
        recaudado:              Number(r.totalIngresosARS   || 0),
        recaudadoARS:           Number(r.totalIngresosARS   || 0),
        recaudadoUSD:           Number(r.totalIngresosUSD   || 0),
        egresos:                Number(r.totalEgresos       || 0),
        egresosUSD:             Number(r.totalEgresosUSD    || 0),
        saldo:                  Number(r.saldoNeto          || 0),
        saldoUSD:               Number(r.saldoNetoUSD       || 0),
        programas: (r.programas || []).map(function(p) {
            var inscriptos = Number(p.inscriptos || 0);
            var enMora     = Number(p.enMora     || 0);
            return {
                id:                p.programa_id,
                nombre:            p.nombre,
                tipo:              p.tipo,
                estado:            p.estado,
                categoria:         p.categoria,
                labelNomenclatura: getLabelNomenclaturaPlural(p.tipo),
                estudiantes:       inscriptos,
                totalEstudiantes:  Number(p.totalEstudiantes || inscriptos),
                bajas:             Number(p.bajas || 0),
                cohortes:          Number(p.numCohortes      || 0),
                alDia:             Math.max(0, inscriptos - enMora),
                enMora:            enMora,
                cuotasEnMora:      Number(p.cuotasEnMora     || 0),
                pendCooperadora:   Number(p.pendCooperadora  || 0),
                recaudado:         Number(p.ingresosARS      || 0),
                recaudadoARS:      Number(p.ingresosARS      || 0),
                recaudadoUSD:      Number(p.ingresosUSD      || 0),
                egresos:           Number(p.egresosTotales   || 0),
                egresosUSD:        Number(p.egresosUSD       || 0),
                saldo:             Number(p.saldoNeto        || 0),
                saldoUSD:          Number(p.saldoNetoUSD     || 0)
            };
        })
    };
}

// ══════════════════════════════════════════════════════════════
// FACTURACIÓN (ESTUDIANTE)
// ══════════════════════════════════════════════════════════════

// ══════════════════════════════════════════════════════════════
// PERFIL DE USUARIO
// ══════════════════════════════════════════════════════════════

async function obtenerPerfilUsuario() {
    var sesion = getSesion();
    if (!sesion) return null;
    const sb = await getSupabase();
    // Traer apellido y nombre directamente de la BD
    var r = await sb.from('usuarios').select('apellido, nombre, nombre_completo, dni, email, rol').eq('dni', sesion.dni).single();
    if (!r.data) return null;
    return {
        apellido: r.data.apellido || r.data.nombre_completo || '',
        nombre:   r.data.nombre  || '',
        dni:      r.data.dni,
        email:    r.data.email,
        rol:      r.data.rol
    };
}

// ══════════════════════════════════════════════════════════════
// INICIALIZACIÓN AUTOMÁTICA DE NOTIFICACIONES
// ══════════════════════════════════════════════════════════════

document.addEventListener('DOMContentLoaded', async function () {
    var sesion = getSesion();
    if (sesion && document.getElementById('notif-badge')) {
        var notifs = await obtenerNotificaciones(sesion.rol);
        renderNotificaciones(notifs);
    }
});

// Cierre de modales con tecla ESC — funciona en todos los archivos
document.addEventListener('keydown', function(e) {
    if (e.key !== 'Escape') return;
    // Buscar modal visible (.modal-overlay.show o [id^="modal-"].show)
    var abierto = document.querySelector('.modal-overlay.show');
    if (abierto) {
        abierto.classList.remove('show');
        return;
    }
    // Alternativa: paneles tipo sidebar con clase .show
    var panel = document.querySelector('.panel.show, .drawer.show');
    if (panel) panel.classList.remove('show');
});

// ══════════════════════════════════════════════════════════════
// POLYFILL: google.script.run → Supabase
// Intercepta las llamadas antiguas de GAS y las redirige a Supabase
// ══════════════════════════════════════════════════════════════

var _gasFunctions = {
    // Auth
    login:                    login,
    logout:                   logout,
    getSesion:                getSesion,
    recuperarPassword:        recuperarPassword,
    obtenerPerfilUsuario:     obtenerPerfilUsuario,

    // Notificaciones
    obtenerNotificaciones:                      obtenerNotificaciones,
    marcarNotificacionLeida:                    marcarNotificacionLeida,
    marcarTodasNotificacionesLeidas:            marcarTodasNotificacionesLeidas,
    obtenerNotificacionesCoordinador:           function() { return obtenerNotificaciones('COORDINADOR'); },
    marcarNotificacionesCooperadoraLeidas:      marcarTodasNotificacionesLeidas,
    marcarNotificacionesCoordinadorLeidas:      marcarTodasNotificacionesLeidas,

    // Dashboard
    obtenerDashboardAdmin:       obtenerDashboardAdmin,
    obtenerDashboardCoordinador: async function() {
        const sb = await getSupabase();
        const { data, error } = await sb.rpc('dashboard_stats_coordinador');
        if (error) throw error;
        var r = data;
        var totalInscriptos = Number(r.totalInscriptos || 0);
        var totalEnMora     = Number(r.totalEnMora     || 0);
        return {
            totalProgramas:        (r.programas || []).length,
            totalEstudiantes:      Number(r.totalEstudiantes || totalInscriptos),
            estudiantesActivos:    totalInscriptos,
            bajas:                 Number(r.totalBajas || 0),
            alDia:                 Math.max(0, totalInscriptos - totalEnMora),
            enMora:                totalEnMora,
            cuotasEnMora:          Number(r.totalCuotasEnMora || 0),
            recaudado:             Number(r.totalIngresosARS  || 0),
            recaudadoARS:          Number(r.totalIngresosARS  || 0),
            recaudadoUSD:          Number(r.totalIngresosUSD  || 0),
            egresos:               Number(r.totalEgresos      || 0),
            egresosUSD:            Number(r.totalEgresosUSD   || 0),
            saldo:                 Number(r.saldoNeto         || 0),
            saldoUSD:              Number(r.saldoNetoUSD      || 0),
            programas: (r.programas || []).map(function(p) {
                var inscriptos = Number(p.inscriptos || 0);
                var enMora     = Number(p.enMora     || 0);
                return {
                    id:                p.programa_id,
                    nombre:            p.nombre,
                    tipo:              p.tipo,
                    estado:            p.estado,
                    categoria:         p.categoria,
                    labelNomenclatura: getLabelNomenclaturaPlural(p.tipo),
                    estudiantes:       inscriptos,
                    totalEstudiantes:  Number(p.totalEstudiantes || inscriptos),
                    bajas:             Number(p.bajas || 0),
                    cohortes:          Number(p.numCohortes      || 0),
                    alDia:             Math.max(0, inscriptos - enMora),
                    enMora:            enMora,
                    cuotasEnMora:      Number(p.cuotasEnMora     || 0),
                    pendCooperadora:   Number(p.pendCooperadora  || 0),
                    recaudado:         Number(p.ingresosARS      || 0),
                    recaudadoARS:      Number(p.ingresosARS      || 0),
                    recaudadoUSD:      Number(p.ingresosUSD      || 0),
                    egresos:           Number(p.egresosTotales   || 0),
                    egresosUSD:        Number(p.egresosUSD       || 0),
                    saldo:             Number(p.saldoNeto        || 0),
                    saldoUSD:          Number(p.saldoNetoUSD     || 0)
                };
            })
        };
    },

    // Programas / Cohortes
    obtenerDetallePrograma:            obtenerDetallePrograma,
    getProgramas:                      obtenerProgramas,
    obtenerProgramasCatalogo:          obtenerProgramasCatalogo,
    obtenerEgresosResumenPorCohorte:   obtenerEgresosResumenPorCohorte,
    obtenerInscripcionesPorCohorte:    obtenerInscripcionesPorCohorte,
    obtenerCobrosParaDesercion:        obtenerCobrosParaDesercion,
    cambiarEstadoCohorte:   async function(id, estado) {
        var sb = await getSupabase();
        var r = await sb.from('cohortes').update({ estado: estado }).eq('cohorte_id', id);
        return { ok: !r.error };
    },

    // Inscripciones / estado académico por cohorte
    cambiarEstadoInscripcion: cambiarEstadoInscripcion,
    getEstadoInscripcion:     getEstadoInscripcion,

    // Cobros
    subirComprobante: subirComprobante,
    obtenerUrlComprobante: async function(cobroId) {
        var sb = await getSupabase();
        var r = await sb.from('cobros').select('comprobante_url').eq('cobro_id', cobroId).single();
        return r.data ? r.data.comprobante_url : null;
    },
    obtenerUrlFirmadaComprobante: async function(comprobanteUrl) {
        if (!comprobanteUrl) return null;
        // Extraer la ruta dentro del bucket desde la URL almacenada
        var match = String(comprobanteUrl).match(/\/object\/(?:public|sign)\/comprobantes\/(.+)/);
        if (!match) return comprobanteUrl; // URL no reconocida, devolver tal cual
        var filePath = match[1];
        var sb = await getSupabase();
        var { data, error } = await sb.storage.from('comprobantes').createSignedUrl(filePath, 3600);
        if (error || !data) return null;
        return data.signedUrl;
    },

    // Configuración
    obtenerConfiguracion:    obtenerConfiguracion,
    guardarConfiguracion:    guardarConfiguracion,
    obtenerCategoriasGastos: obtenerCategoriasGastos,
    guardarCategoriasGastos: guardarCategoriasGastos,

    // Usuarios
    guardarUsuario:                 guardarUsuario,
    darDeBaja:                      darDeBaja,
    darDeAlta:                      darDeAlta,
    eliminarUsuario:                async function(id) { return darDeBaja(id); },
    obtenerProgramasCoordinador:    obtenerProgramasCoordinador,
    asignarProgramasCoordinador:    asignarProgramasCoordinador,
    eliminarRegistroCompleto:       async function(id) {
        var sb = await getSupabase();
        await sb.from('usuarios').delete().eq('usuario_id', id);
        return { ok: true };
    },
    getUsuario: async function(id) {
        var sb = await getSupabase();
        var r = await sb.from('usuarios').select('*').eq('usuario_id', id).single();
        return r.data;
    },

    // Reportes / Exportaciones (en desarrollo)
    getDatosComparativo:              async function() { return { periodos: [], datos: [] }; },
    exportarCashflow:                 async function() { alert('Exportación en desarrollo'); return null; },
    exportarReporteExcel:             async function() { alert('Exportación en desarrollo'); return null; },
    exportarEstadoPagosExcel:         async function() { alert('Exportación en desarrollo'); return null; },
    exportarEstadoPagosPDF:           async function() { alert('Exportación en desarrollo'); return null; },
    exportarDesercionExcel:           async function() { alert('Exportación en desarrollo'); return null; },
    exportarDesercionPDF:             async function() { alert('Exportación en desarrollo'); return null; },
    exportarImpactoDescuentosExcel:   async function() { alert('Exportación en desarrollo'); return null; },
    exportarImpactoDescuentosPDF:     async function() { alert('Exportación en desarrollo'); return null; },
    exportarComparativoExcel:         async function() { alert('Exportación en desarrollo'); return null; },
    exportarComparativoPDF:           async function() { alert('Exportación en desarrollo'); return null; },
    exportarLogsExcel:                async function() { alert('Exportación en desarrollo'); return null; },

    // Coordinador
    enviarSolicitudProgramaCurso: async function(datos) {
        console.log('Solicitud programa:', datos);
        return { ok: true };
    },

    // Cooperadora - detalle cohorte
    obtenerDetalleCohorteCooperadora: async function(programaId, cohorteId) {
        return obtenerEstudiantes(programaId, cohorteId);
    },

    // Cooperadora - aprobar pagos
    obtenerListadoAprobarPagosCooperadora: async function(programaId, cohorteId) {
        var sb = await getSupabase();
        var query = sb.from('cobros').select('*');
        if (programaId) query = query.eq('programa_id', programaId);
        if (cohorteId)  query = query.eq('cohorte_id', cohorteId);
        var r = await query.order('fecha_vencimiento');
        return r.data || [];
    }
};

// Proxy para interceptar google.script.run
window.google = window.google || {};
window.google.script = window.google.script || {};
window.google.script.run = new Proxy({}, {
    get: function(target, prop) {
        if (prop === 'withSuccessHandler') {
            return function(successFn) {
                return new Proxy({}, {
                    get: function(t2, prop2) {
                        if (prop2 === 'withFailureHandler') {
                            return function(failFn) {
                                return new Proxy({}, {
                                    get: function(t3, prop3) {
                                        return function() {
                                            var args = Array.from(arguments);
                                            var fn = _gasFunctions[prop3];
                                            if (fn) {
                                                Promise.resolve(fn.apply(null, args))
                                                    .then(successFn).catch(failFn);
                                            } else {
                                                console.warn('GAS polyfill: función no encontrada:', prop3);
                                                failFn(new Error('Función no implementada: ' + prop3));
                                            }
                                        };
                                    }
                                });
                            };
                        }
                        return function() {
                            var args = Array.from(arguments);
                            var fn = _gasFunctions[prop2];
                            if (fn) {
                                Promise.resolve(fn.apply(null, args))
                                    .then(successFn)
                                    .catch(function(e) { console.error('GAS polyfill error:', prop2, e); });
                            } else {
                                console.warn('GAS polyfill: función no encontrada:', prop2);
                            }
                        };
                    }
                });
            };
        }
        if (prop === 'withFailureHandler') {
            return function(failFn) {
                return new Proxy({}, {
                    get: function(t2, prop2) {
                        if (prop2 === 'withSuccessHandler') {
                            return function(successFn) {
                                return new Proxy({}, {
                                    get: function(t3, prop3) {
                                        return function() {
                                            var args = Array.from(arguments);
                                            var fn = _gasFunctions[prop3];
                                            if (fn) {
                                                Promise.resolve(fn.apply(null, args))
                                                    .then(successFn).catch(failFn);
                                            } else {
                                                failFn(new Error('Función no implementada: ' + prop3));
                                            }
                                        };
                                    }
                                });
                            };
                        }
                        return function() {
                            var args = Array.from(arguments);
                            var fn = _gasFunctions[prop2];
                            if (fn) {
                                Promise.resolve(fn.apply(null, args)).catch(failFn);
                            }
                        };
                    }
                });
            };
        }
        // Llamada directa: google.script.run.functionName()
        return function() {
            var args = Array.from(arguments);
            var fn = _gasFunctions[prop];
            if (fn) {
                return Promise.resolve(fn.apply(null, args));
            } else {
                console.warn('GAS polyfill: función no encontrada:', prop);
            }
        };
    }
});
