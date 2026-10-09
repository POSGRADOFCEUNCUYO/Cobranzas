/**
 * ══════════════════════════════════════════════════════════════
 * SiGPo — GAS del ADMINISTRADOR
 * Google Apps Script — uno solo, en la cuenta del administrador
 *
 * DESPLIEGUE (una sola vez):
 *  1. script.google.com desde la cuenta del ADMINISTRADOR
 *  2. Pegar este código
 *  3. Configurar SUPABASE_KEY (service role key)
 *  4. Ejecutar configurarTriggers() una vez → autorizar permisos
 *  5. No necesita implementarse como Web App (no tiene doPost)
 *
 * FUNCIÓN AUTOMÁTICA (sale desde el email del administrador):
 *  · Todos los días a las 07:00 → Alerta cuotas A_DEFINIR
 *    Se dispara UNA SOLA VEZ cuando quedan 45 días o menos
 *    para el vencimiento de una cuota sin monto definido.
 *    Destinatarios: administrador y secretaría (global) + coordinador y profesor del programa.
 * ══════════════════════════════════════════════════════════════
 */

var SUPABASE_URL = 'https://fdevypdowdhqaxvfiywt.supabase.co';
var SUPABASE_KEY = 'REEMPLAZAR_CON_SERVICE_ROLE_KEY'; // ← solo en script.google.com, nunca en el repo
var NOMBRE_INST  = 'Secretaría de Posgrado — FCE UNCUYO';

// ══════════════════════════════════════════════════════════════
// TRIGGER PRINCIPAL
// ══════════════════════════════════════════════════════════════

function ejecutarTareasDiarias() {
  Logger.log('=== SiGPo admin — alerta A_DEFINIR ===');
  alertarCuotasADefinir();
}

function configurarTriggers() {
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === 'ejecutarTareasDiarias') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('ejecutarTareasDiarias').timeBased().everyDays(1).atHour(7).create();
  Logger.log('✅ Trigger diario 07:00 configurado.');
}

// ══════════════════════════════════════════════════════════════
// ALERTA CUOTAS A_DEFINIR
// Todos los días revisa cobros con estado A_DEFINIR cuyo
// vencimiento es dentro de 45 días o menos, y que todavía no
// recibieron aviso (aviso_coordinador_enviado = false).
// Marca el flag al enviar → cada cuota recibe el aviso una sola vez.
// ══════════════════════════════════════════════════════════════

function alertarCuotasADefinir() {
  var hoy        = new Date();
  var limite     = new Date(hoy.getTime() + 45 * 86400000);
  var fechaLimite = limite.toISOString().split('T')[0];

  Logger.log('--- Alerta A_DEFINIR: cuotas sin aviso que vencen hasta el ' + fechaLimite + ' ---');

  var cobros = _sbGet(
    'cobros?select=cobro_id,dni,cohorte_id,programa_id,concepto,periodo,fecha_vencimiento,monto_final,estudiantes!cobros_dni_fkey(nombre,apellido)' +
    '&estado=eq.A_DEFINIR' +
    '&no_aplica=not.is.true' +
    '&aviso_coordinador_enviado=eq.false' +
    '&fecha_vencimiento=lte.' + fechaLimite
  );

  if (!cobros.length) { Logger.log('Sin cuotas A_DEFINIR pendientes de aviso.'); return; }

  var porCohorte = {};
  cobros.forEach(function(c) {
    if (!porCohorte[c.cohorte_id]) porCohorte[c.cohorte_id] = [];
    porCohorte[c.cohorte_id].push(c);
  });

  var cohorteIds = Object.keys(porCohorte);
  var cohortes   = _sbGet('cohortes?select=cohorte_id,nombre,programa_id&cohorte_id=in.(' + cohorteIds.join(',') + ')');
  var programas  = _sbGet('programas?select=programa_id,nombre,email_remitente');
  var cohMap     = _indexar(cohortes,  'cohorte_id');
  var progMap    = _indexar(programas, 'programa_id');

  // Back-office global que SIEMPRE recibe (sin restricción de programa): ADMINISTRADOR y SECRETARIA.
  // NO incluye GERENTE_COOPERADORA ni COOPERADORA (no deben recibir estas alertas).
  var globalStaff  = _sbGet('usuarios?select=email&rol=in.(ADMINISTRADOR,SECRETARIA)&estado_usuario=eq.ACTIVO');
  var globalEmails = _uniq(globalStaff.filter(function(r){ return r.email; }).map(function(r){ return r.email; }));

  // Coordinadores y profesores vinculados a cada programa (tabla coordinadores_programas).
  // Se filtran POR PROGRAMA para que no reciban alertas de programas ajenos.
  var vinculos  = _sbGet('coordinadores_programas?select=coordinador_id,programa_id,cohorte_id');
  var staffIds  = _uniq(vinculos.map(function(v){ return v.coordinador_id; }).filter(function(x){ return x != null; }));
  var staffRows = staffIds.length
    ? _sbGet('usuarios?select=usuario_id,email,rol&estado_usuario=eq.ACTIVO&rol=in.(COORDINADOR,PROFESOR)&usuario_id=in.(' + staffIds.join(',') + ')')
    : [];
  var staffMap  = _indexar(staffRows, 'usuario_id'); // usuario_id -> {email, rol}

  // Coordinador/profesor de un programa (vínculo sin cohorte = todo el programa; con cohorte = solo esa cohorte).
  function _emailsPrograma(pid, cid) {
    return _uniq(vinculos.filter(function(v){
      return String(v.programa_id) === String(pid) &&
             (v.cohorte_id == null || String(v.cohorte_id) === String(cid));
    }).map(function(v){
      var u = staffMap[v.coordinador_id];
      return u ? u.email : null;
    }).filter(function(e){ return e; }));
  }

  var enviados = 0;
  cohorteIds.forEach(function(cid) {
    var coh       = cohMap[cid] || {};
    var prog      = progMap[coh.programa_id] || {};
    var cuotas    = porCohorte[cid];
    var nEst      = _uniq(cuotas.map(function(c){ return c.dni; })).length;
    var fechaVenc = cuotas[0] ? cuotas[0].fecha_vencimiento : '';
    var dias      = fechaVenc ? Math.round((new Date(fechaVenc) - hoy) / 86400000) : 0;

    // Destinatarios: back-office global (admin/secretaría/gerencia) + coordinador y profesor DEL programa
    var emails = _uniq(globalEmails.concat(_emailsPrograma(coh.programa_id, cid)));

    if (!emails.length) { Logger.log('Sin destinatarios para cohorte ' + cid); return; }

    var subject = '⚠️ Alerta: cuotas A_DEFINIR — ' + (coh.nombre||cid) + ' — ' + (prog.nombre||'Posgrado');
    var html    = _htmlADefinir(prog.nombre||'Posgrado', coh.nombre||cid, cuotas, nEst, _fmtFecha(fechaVenc), dias);

    var okEnvio = false;
    emails.forEach(function(email) {
      if (_enviarMail(email, subject, html)) { enviados++; okEnvio = true; }
    });

    // Marcar flag en cada cobro de esta cohorte para no volver a avisar
    if (okEnvio) {
      cuotas.forEach(function(c) {
        _sbPatch('cobros?cobro_id=eq.' + c.cobro_id, {
          aviso_coordinador_enviado: true,
          fecha_aviso_coordinador: new Date().toISOString()
        });
      });
    }
  });

  Logger.log('Alertas A_DEFINIR enviadas: ' + enviados);
}

// ══════════════════════════════════════════════════════════════
// HELPERS — SUPABASE
// ══════════════════════════════════════════════════════════════

function _sbGet(path) {
  try {
    var resp = UrlFetchApp.fetch(SUPABASE_URL + '/rest/v1/' + path, {
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY },
      muteHttpExceptions: true
    });
    if (resp.getResponseCode() !== 200) {
      Logger.log('Supabase error ' + resp.getResponseCode() + ': ' + resp.getContentText().substring(0,200));
      return [];
    }
    return JSON.parse(resp.getContentText()) || [];
  } catch(err) {
    Logger.log('_sbGet excepción: ' + err.message);
    return [];
  }
}

// ══════════════════════════════════════════════════════════════
// HELPERS — UTILIDADES
// ══════════════════════════════════════════════════════════════

function _indexar(arr, campo)  { var m={}; arr.forEach(function(x){ m[x[campo]] = x; }); return m; }
function _uniq(arr)            { return arr.filter(function(v,i,a){ return a.indexOf(v)===i; }); }
function _nombreCompleto(u)    { return ((u.nombre||'') + ' ' + (u.apellido||'')).trim(); }

function _fmtFecha(f) {
  if (!f) return '—';
  var p = f.split('T')[0].split('-');
  return p[2] + '/' + p[1] + '/' + p[0];
}

function _enviarMail(to, subject, html) {
  if (!to || !subject || !html) { Logger.log('_enviarMail: parámetros inválidos (llamada sin argumentos)'); return false; }
  try {
    MailApp.sendEmail(to, subject, html.replace(/<[^>]+>/g,''), { name: NOMBRE_INST, htmlBody: html });
    Logger.log('✅ → ' + to);
    return true;
  } catch(err) {
    Logger.log('❌ ' + to + ': ' + err.message);
    return false;
  }
}

function _sbPatch(path, data) {
  try {
    var resp = UrlFetchApp.fetch(SUPABASE_URL + '/rest/v1/' + path, {
      method: 'PATCH',
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': 'Bearer ' + SUPABASE_KEY,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal'
      },
      payload: JSON.stringify(data),
      muteHttpExceptions: true
    });
    if (resp.getResponseCode() !== 204) {
      Logger.log('Supabase PATCH error ' + resp.getResponseCode() + ': ' + resp.getContentText().substring(0,200));
      return false;
    }
    return true;
  } catch(err) {
    Logger.log('_sbPatch excepción: ' + err.message);
    return false;
  }
}

// ══════════════════════════════════════════════════════════════
// TEMPLATE HTML
// ══════════════════════════════════════════════════════════════

var _CSS = '<style>' +
  'body{font-family:Arial,sans-serif;color:#1e3a5f;max-width:620px;margin:0 auto;padding:0;}' +
  '.hdr{background:#1e3a5f;color:#fff;padding:20px 28px;border-radius:8px 8px 0 0;}' +
  '.hdr h1{margin:0;font-size:20px;font-weight:700;}' +
  '.hdr p{margin:4px 0 0;font-size:13px;opacity:.8;}' +
  '.bod{background:#f8f6f1;padding:24px 28px;}' +
  '.ftr{background:#e5e7eb;padding:12px 28px;font-size:11px;color:#6b7280;border-radius:0 0 8px 8px;}' +
  'table{width:100%;border-collapse:collapse;margin:14px 0;font-size:13px;}' +
  'th{background:#1e3a5f;color:#fff;padding:7px 10px;text-align:left;}' +
  'td{padding:7px 10px;border-bottom:1px solid #e5e7eb;}' +
  '.warn{background:#fef3c7;border-left:4px solid #d4af37;padding:12px 16px;margin:16px 0;border-radius:0 4px 4px 0;font-size:14px;}' +
  'p{font-size:14px;line-height:1.6;}' +
  '</style>';

function _wrapHtml(contenido) {
  return '<!DOCTYPE html><html><head><meta charset="UTF-8">' + _CSS + '</head><body>' +
    '<div class="hdr"><h1>' + NOMBRE_INST + '</h1><p>Sistema de Gestión de Posgrado</p></div>' +
    '<div class="bod">' + contenido + '</div>' +
    '<div class="ftr">Mensaje automático del sistema SiGPo. Por consultas comuníquese con la Secretaría de Posgrado.</div>' +
    '</body></html>';
}

function _htmlADefinir(prog, cohorte, cuotas, nEst, fechaVenc, dias) {
  var filas = cuotas.map(function(c) {
    var apellido = (c.estudiantes && c.estudiantes.apellido) ? c.estudiantes.apellido : '—';
    var nombre   = (c.estudiantes && c.estudiantes.nombre)   ? c.estudiantes.nombre   : '—';
    return '<tr><td>' + apellido + '</td><td>' + nombre + '</td><td>' + c.dni + '</td>' +
           '<td>' + (c.concepto||'—') + '</td><td>' + (c.periodo||'—') + '</td>' +
           '<td>' + _fmtFecha(c.fecha_vencimiento) + '</td></tr>';
  }).join('');
  return _wrapHtml(
    '<div class="warn"><strong>⚠️ Alerta de gestión — acción requerida</strong><br>' +
    'Existen <strong>' + nEst + ' estudiante/s</strong> con cuotas cuyo monto está <strong>A DEFINIR</strong> ' +
    'y cuyo vencimiento es el <strong>' + fechaVenc + '</strong> (en <strong>' + dias + ' días</strong>).<br>' +
    'Es necesario definir los montos antes de esa fecha para habilitar los pagos.</div>' +
    '<p><strong>Programa:</strong> ' + prog + '<br><strong>Cohorte / Edición:</strong> ' + cohorte + '</p>' +
    '<table><tr><th>Apellido</th><th>Nombre</th><th>DNI</th><th>Concepto</th><th>Período</th><th>Vencimiento</th></tr>' + filas + '</table>'
  );
}

// ══════════════════════════════════════════════════════════════
// PRUEBA — ejecutar manualmente desde el editor
// ══════════════════════════════════════════════════════════════

function testADefinir()         { alertarCuotasADefinir(); }
function testConexionSupabase() {
  var programas = _sbGet('programas?select=programa_id,nombre&limit=3');
  Logger.log('Conexión OK — ' + programas.length + ' programas:');
  programas.forEach(function(p){ Logger.log('  · ' + p.programa_id + ': ' + p.nombre); });
}
