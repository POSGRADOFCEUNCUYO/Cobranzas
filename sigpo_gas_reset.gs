/**
 * ══════════════════════════════════════════════════════════════
 * SiGPo — GAS SOLICITUD DE RESETEO DE CONTRASEÑA
 * Google Apps Script INDEPENDIENTE — correr desde crm.posgrado@fce.uncu.edu.ar
 *
 * DESPLIEGUE (una sola vez):
 *  1. script.google.com desde la cuenta crm.posgrado → Nuevo proyecto
 *  2. Pegar este código
 *  3. Poner la SUPABASE_KEY (service role) en la línea de abajo y Guardar
 *  4. Implementar → Aplicación web · Ejecutar como: Yo · Acceso: Cualquier persona
 *  5. Copiar la URL que termina en /exec y pasársela al asistente
 *     (va en portal_login.html → GAS_RESET_URL)
 *
 * QUÉ HACE:
 *  El botón "Recuperar acceso" del portal manda {dni} (POST fire-and-forget).
 *  Este GAS busca al usuario en Supabase y envía un mail —DESDE esta cuenta—
 *  al administrador y al propio solicitante, con el detalle de quién lo pidió.
 * ══════════════════════════════════════════════════════════════
 */

var SUPABASE_URL      = 'https://fdevypdowdhqaxvfiywt.supabase.co';
var SUPABASE_KEY      = 'REEMPLAZAR_CON_SERVICE_ROLE_KEY';   // service role — solo acá, nunca en el repo
var EMAIL_ADMIN_RESET = 'anneris.amarfil@fce.uncu.edu.ar';   // a quién le llega la solicitud
var NOMBRE_INST       = 'Secretaría de Posgrado — FCE UNCUYO';

// ══════════════════════════════════════════════════════════════
// doPost — recibe la solicitud desde la pantalla de login (fire-and-forget)
// ══════════════════════════════════════════════════════════════

function doPost(e) {
  var out = ContentService.createTextOutput();
  out.setMimeType(ContentService.MimeType.JSON);
  try {
    var data = (e && e.postData && e.postData.contents) ? JSON.parse(e.postData.contents) : {};
    var dni  = String(data.dni || '').trim();
    if (!dni) { out.setContent(JSON.stringify({ ok:false, error:'Sin DNI' })); return out; }

    // Buscar al usuario. Si no existe, respondemos ok igual (no revelar si está registrado).
    var us = _sbGet('usuarios?select=dni,nombre_completo,email,rol&dni=eq.' + encodeURIComponent(dni));
    if (!us.length) { out.setContent(JSON.stringify({ ok:true })); return out; }
    var u = us[0];

    var ahora   = Utilities.formatDate(new Date(), 'America/Argentina/Mendoza', 'dd/MM/yyyy HH:mm');
    var subject = 'Solicitud de reseteo de contraseña — ' + (u.nombre_completo || ('DNI ' + dni));
    var cuerpo  =
      'Se recibió una solicitud de reseteo de contraseña desde el portal.\n\n' +
      'Datos del solicitante:\n' +
      '• DNI: '          + (u.dni || dni)          + '\n' +
      '• Nombre: '       + (u.nombre_completo||'—') + '\n' +
      '• Email: '        + (u.email||'—')          + '\n' +
      '• Rol: '          + (u.rol||'—')            + '\n' +
      '• Fecha y hora: ' + ahora                   + '\n\n' +
      'La Secretaría de Posgrado se contactará para restablecer el acceso.';

    var destinatarios = [EMAIL_ADMIN_RESET];
    if (u.email) destinatarios.push(u.email);

    MailApp.sendEmail(destinatarios.join(','), subject, cuerpo, { name: NOMBRE_INST });
    Logger.log('Solicitud reseteo enviada: ' + destinatarios.join(', '));
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
// Lectura a Supabase (REST) con la service role key.
// ══════════════════════════════════════════════════════════════

function _sbGet(path) {
  try {
    var resp = UrlFetchApp.fetch(SUPABASE_URL + '/rest/v1/' + path, {
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY },
      muteHttpExceptions: true
    });
    if (resp.getResponseCode() !== 200) {
      Logger.log('_sbGet error ' + resp.getResponseCode() + ': ' + resp.getContentText().substring(0, 200));
      return [];
    }
    return JSON.parse(resp.getContentText()) || [];
  } catch(e) {
    Logger.log('_sbGet excepción: ' + e.toString());
    return [];
  }
}

// Prueba manual desde el editor (opcional).
function testReset() {
  doPost({ postData: { contents: JSON.stringify({ dni: '36134839' }) } });
}
