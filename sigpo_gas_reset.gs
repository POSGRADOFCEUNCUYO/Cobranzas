/**
 * ══════════════════════════════════════════════════════════════
 * SiGPo — GAS CORREOS DE RESETEO DE CONTRASEÑA
 * Google Apps Script INDEPENDIENTE — correr desde crm.posgrado@fce.uncu.edu.ar
 *
 * DESPLIEGUE (una sola vez):
 *  1. script.google.com desde la cuenta crm.posgrado → Nuevo proyecto
 *  2. Pegar este código
 *  3. Poner la SUPABASE_KEY (service role) en la línea de abajo y Guardar
 *  4. Implementar → Aplicación web · Ejecutar como: Yo · Acceso: Cualquier persona
 *  5. Copiar la URL que termina en /exec y pasársela al asistente
 *     (va en portal_login.html y en las páginas con botón de reseteo → GAS_RESET_URL)
 *
 * QUÉ HACE (dos correos, según "action"):
 *  • action = 'solicitud' (lo que manda el botón "Recuperar acceso" del login):
 *      el alumno pidió recuperar su acceso → avisa al/los COORDINADOR(es) de su
 *      carrera (reply-to = el alumno). Si no hay coordinador cargado, cae al admin.
 *  • action = 'acceso' (lo que mandan los botones 🔑 al resetear):
 *      ya se le reseteó la clave → le escribe AL ALUMNO con su usuario y contraseña
 *      (su DNI) y el enlace al portal, con el nombre de su coordinación como
 *      remitente visible y reply-to = el coordinador.
 *
 *  En los dos casos el correo SALE de crm.posgrado (llega bien, no es spam ni un
 *  remitente desconocido). Los datos (alumno, programa, coordinadores) los resuelve
 *  el RPC get_datos_reseteo(p_dni) en Supabase.
 * ══════════════════════════════════════════════════════════════
 */

var SUPABASE_URL      = 'https://fdevypdowdhqaxvfiywt.supabase.co';
var SUPABASE_KEY      = 'REEMPLAZAR_CON_SERVICE_ROLE_KEY';   // service role — solo acá, nunca en el repo
var EMAIL_ADMIN_RESET = 'anneris.amarfil@fce.uncu.edu.ar';   // respaldo si el alumno no tiene coordinador
var NOMBRE_INST       = 'Secretaría de Posgrado — FCE UNCUYO';
var PORTAL_URL        = 'https://posgradofceuncuyo.github.io/Cobranzas/portal_login.html';

// ══════════════════════════════════════════════════════════════
// doPost — recibe {dni, action} (POST fire-and-forget desde el portal)
// ══════════════════════════════════════════════════════════════

function doPost(e) {
  var out = ContentService.createTextOutput();
  out.setMimeType(ContentService.MimeType.JSON);
  try {
    var data   = (e && e.postData && e.postData.contents) ? JSON.parse(e.postData.contents) : {};
    var dni    = String(data.dni || '').trim();
    var action = String(data.action || 'solicitud').trim();
    if (!dni) { out.setContent(JSON.stringify({ ok:false, error:'Sin DNI' })); return out; }

    // Resolver datos en Supabase (alumno + programa + coordinadores).
    var info = _sbRpc('get_datos_reseteo', { p_dni: dni });
    // Si no existe o no hay datos, respondemos ok igual (no revelar si está registrado).
    if (!info || !info.estudiante) { out.setContent(JSON.stringify({ ok:true })); return out; }

    if (action === 'acceso') _correoAcceso(dni, info);
    else                     _correoSolicitud(dni, info);

    out.setContent(JSON.stringify({ ok:true }));
  } catch(err) {
    Logger.log('doPost reset error: ' + err.message);
    out.setContent(JSON.stringify({ ok:false, error: err.message }));
  }
  return out;
}

// Health check: abrir la URL /exec en el navegador debe devolver ok:true.
function doGet() {
  return ContentService.createTextOutput(JSON.stringify({ ok:true, msg:'SiGPo reset activo' }))
    .setMimeType(ContentService.MimeType.JSON);
}

// ══════════════════════════════════════════════════════════════
// Correo 1 — SOLICITUD: el alumno pidió recuperar → avisar al coordinador
// ══════════════════════════════════════════════════════════════

function _correoSolicitud(dni, info) {
  var est    = info.estudiante || {};
  var coords = info.coordinadores || [];
  var destinatarios = coords.map(function(c){ return c.email; }).filter(function(x){ return x; });
  if (!destinatarios.length) destinatarios = [EMAIL_ADMIN_RESET];   // respaldo: sin coordinador → admin

  var ahora   = Utilities.formatDate(new Date(), 'America/Argentina/Mendoza', 'dd/MM/yyyy HH:mm');
  var subject = 'Solicitud de reseteo de contraseña — ' + (est.nombre || ('DNI ' + dni));
  var cuerpo  =
    'Un estudiante solicitó restablecer su acceso al Portal de Posgrado.\n\n' +
    'Datos del estudiante:\n' +
    '• DNI: '      + (est.dni || dni)   + '\n' +
    '• Nombre: '   + (est.nombre || '—')+ '\n' +
    '• Email: '    + (est.email  || '—')+ '\n' +
    '• Programa: ' + (info.programa||'—')+ '\n' +
    '• Fecha y hora: ' + ahora          + '\n\n' +
    'Para restablecerlo, ingresá al Portal (página de la cohorte) y usá el botón 🔑 junto al estudiante.\n' +
    PORTAL_URL + '\n';

  var opts = { name: NOMBRE_INST };
  if (est.email) opts.replyTo = est.email;
  MailApp.sendEmail(destinatarios.join(','), subject, cuerpo, opts);
  Logger.log('Correo solicitud enviado a: ' + destinatarios.join(', '));
}

// ══════════════════════════════════════════════════════════════
// Correo 2 — ACCESO: ya se reseteó → avisar al alumno con sus datos
// ══════════════════════════════════════════════════════════════

function _correoAcceso(dni, info) {
  var est = info.estudiante || {};
  if (!est.email) { Logger.log('Sin email del estudiante ' + dni + ', no se envía correo de acceso.'); return; }
  var coords = info.coordinadores || [];
  var coord  = coords.length ? coords[0] : null;

  var nombreDe = (coord && coord.nombre) ? (coord.nombre + ' — ' + NOMBRE_INST) : NOMBRE_INST;
  var replyTo  = (coord && coord.email)  ? coord.email : EMAIL_ADMIN_RESET;

  var subject = 'Restablecimos tu acceso al Portal de Posgrado';
  var cuerpo  =
    'Hola ' + (est.nombre || '') + ',\n\n' +
    'Restablecimos el acceso a tu cuenta del Portal de Posgrado — FCE UNCUYO.\n\n' +
    '• Usuario: tu DNI (' + (est.dni || dni) + ')\n' +
    '• Contraseña: '       + (est.dni || dni) + '\n\n' +
    'Ingresá en el siguiente enlace y, por seguridad, el sistema te pedirá definir una contraseña nueva:\n' +
    PORTAL_URL + '\n\n' +
    'Si tenés algún problema, respondé este correo.\n\n' +
    ((coord && coord.nombre) ? coord.nombre : NOMBRE_INST);

  MailApp.sendEmail(est.email, subject, cuerpo, { name: nombreDe, replyTo: replyTo });
  Logger.log('Correo acceso enviado a: ' + est.email);
}

// ══════════════════════════════════════════════════════════════
// Llamada a un RPC de Supabase (REST) con la service role key.
// ══════════════════════════════════════════════════════════════

function _sbRpc(fn, body) {
  try {
    var resp = UrlFetchApp.fetch(SUPABASE_URL + '/rest/v1/rpc/' + fn, {
      method: 'post',
      contentType: 'application/json',
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY },
      payload: JSON.stringify(body || {}),
      muteHttpExceptions: true
    });
    var code = resp.getResponseCode();
    if (code !== 200) {
      Logger.log('_sbRpc ' + fn + ' error ' + code + ': ' + resp.getContentText().substring(0, 200));
      return null;
    }
    return JSON.parse(resp.getContentText());
  } catch(e) {
    Logger.log('_sbRpc excepción: ' + e.toString());
    return null;
  }
}

// ══════════════════════════════════════════════════════════════
// Pruebas manuales desde el editor (opcionales).
// ══════════════════════════════════════════════════════════════
function testSolicitud() {
  doPost({ postData: { contents: JSON.stringify({ dni: '39532873', action: 'solicitud' }) } });
}
function testAcceso() {
  doPost({ postData: { contents: JSON.stringify({ dni: '39532873', action: 'acceso' }) } });
}
