/**
 * ══════════════════════════════════════════════════════════════
 * SiGPo — GAS DE RECIBOS TANGO
 * Google Apps Script — correr desde crm.posgrado@gmail.com
 *
 * DESPLIEGUE (una sola vez):
 *  1. script.google.com desde la cuenta crm.posgrado@gmail.com → Nuevo proyecto
 *  2. Pegar este código
 *  3. Servicios avanzados → habilitar "Drive API" (v3)
 *  4. Reemplazar los valores REEMPLAZAR_* de abajo
 *  5. Ejecutar configurarTriggers() una vez → autorizar permisos
 *  6. Para TEST: cambiar la hora del trigger en configurarTriggers() a la hora actual + 1
 *
 * LO QUE HACE EL SCRIPT:
 *  · Busca en Gmail emails no procesados del remitente configurado con PDF adjunto
 *  · Lee el texto del PDF (convierte a Google Doc temporario)
 *  · Detecta el tipo de PDF y lo enruta:
 *      – RECIBO  → lee la leyenda "Cobro <id> <período> <DNI>" y asigna el recibo al
 *                  cobro por su id (VÍA 1); registra en recibos_tango (o pendientes).
 *                  Recibos viejos sin "Cobro <id>" caen a la VÍA 2 (programa+período+DNI).
 *      – FACTURA → extrae el DNI/CUIT/CUIL del ESTUDIANTE, lo busca y guarda la
 *                  factura en la tabla `facturas` (vinculada al estudiante, NO a una cuota)
 *  · Normaliza el DNI: maneja CUIT (XX-XXXXXXXX-X) y ceros a la izquierda
 *  · Sube el PDF a Storage; si no puede asignar, avisa por email al admin
 *  · Etiqueta el thread de Gmail para no procesarlo dos veces
 * ══════════════════════════════════════════════════════════════
 */

var SUPABASE_URL   = 'https://fdevypdowdhqaxvfiywt.supabase.co';
var SUPABASE_KEY   = 'REEMPLAZAR_CON_SERVICE_ROLE_KEY';   // ← solo en script.google.com, nunca en el repo
var EMAIL_REMITENTE = 'mrsuncuyo@gmail.com';              // TEST — en producción: cooperadora.comprobantes@fce.uncu.edu.ar
var EMAIL_ADMIN    = 'REEMPLAZAR_CON_EMAIL_ADMIN';        // ← recibe avisos de recibos que no se pudieron asignar
var NOMBRE_INST    = 'Secretaría de Posgrado — FCE UNCUYO';
var LABEL_PROCESADOS = 'Recibos-Tango-Procesados';

// ══════════════════════════════════════════════════════════════
// TRIGGER
// ══════════════════════════════════════════════════════════════

function configurarTriggers() {
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === 'procesarRecibos') ScriptApp.deleteTrigger(t);
  });
  // Para TEST: cambiar atHour(8) por la hora que quieras probar (0-23, hora de Argentina = UTC-3)
  ScriptApp.newTrigger('procesarRecibos').timeBased().everyDays(1).atHour(8).create();
  Logger.log('✅ Trigger diario 08:00 configurado.');
}

// ══════════════════════════════════════════════════════════════
// FUNCIÓN PRINCIPAL
// ══════════════════════════════════════════════════════════════

function procesarRecibos() {
  Logger.log('=== SiGPo recibos-tango — ' + new Date().toISOString() + ' ===');
  var label = _obtenerOCrearLabel(LABEL_PROCESADOS);
  var query = 'from:' + EMAIL_REMITENTE + ' has:attachment filename:pdf -label:' + LABEL_PROCESADOS;
  var threads = GmailApp.search(query);
  Logger.log('Threads sin procesar: ' + threads.length);

  threads.forEach(function(thread) {
    thread.getMessages().forEach(function(msg) {
      msg.getAttachments().forEach(function(att) {
        var nombre = att.getName().toLowerCase();
        var tipo   = att.getContentType();
        if (tipo === 'application/pdf' || nombre.slice(-4) === '.pdf') {
          Logger.log('→ Procesando: ' + att.getName());
          try {
            _procesarUnPDF(att, msg);
          } catch(e) {
            Logger.log('ERROR no controlado en ' + att.getName() + ': ' + e.toString());
            _registrarPendiente({
              email_origen: msg.getFrom(),
              email_asunto: msg.getSubject()
            }, 'Excepción no controlada: ' + e.toString());
          }
        }
      });
    });
    thread.addLabel(label);
    thread.markRead();
  });
}

// ══════════════════════════════════════════════════════════════
// PROCESAR UN PDF
// ══════════════════════════════════════════════════════════════

function _procesarUnPDF(att, msg) {
  // 1. Extraer texto
  var texto = _extraerTextoPDF(att);
  Logger.log('--- TEXTO PDF (primeros 800 chars) ---\n' + texto.substring(0, 800));

  // 1b. ¿FACTURA o RECIBO? El recibo trae el descargo legal
  //     "DOCUMENTO NO VALIDO COMO FACTURA", que hacía que se confundiera
  //     con una factura. Detectamos primero el RECIBO por su encabezado
  //     "RECIBO OFICIAL"; solo si NO es recibo y aparece "FACTURA" fuera
  //     de ese descargo lo tratamos como factura (se vincula al ESTUDIANTE).
  var _esRecibo    = /RECIBO\s+OFICIAL/i.test(texto);
  var _sinDescargo = texto.replace(/NO\s+V[ÁA]LIDO\s+COMO\s+FACTURA/ig, '');
  if (!_esRecibo && /\bFACTURA\b/i.test(_sinDescargo)) {
    _procesarFactura(texto, att, msg);
    return;
  }

  // 2. Parsear campos del recibo
  var datos = _parsearRecibo(texto);
  datos.email_origen = msg.getFrom();
  datos.email_asunto = msg.getSubject();
  Logger.log('Datos extraídos: ' + JSON.stringify(datos));

  // 3. Evitar procesar dos veces el mismo recibo (aplica a ambas vías)
  if (datos.nro_recibo && _reciboDuplicado(datos.nro_recibo)) {
    Logger.log('Recibo ' + datos.nro_recibo + ' ya procesado. Saltando.');
    return;
  }

  // 4. Subir PDF a Storage SIEMPRE, antes de resolver el cobro, para que quede
  //    disponible tanto si se asigna solo como si va a pendientes.
  var fileBase = datos.nro_recibo || ('sin-nro-' + Date.now());
  var pdfUrl   = _subirStorage(att.copyBlob(), 'recibos-tango/' + fileBase + '.pdf');

  // ── VÍA 1: la leyenda trae "Cobro <n>" → llave directa e inequívoca ──
  if (datos.cobro_id) {
    var cobroIdOk = _buscarCobroPorId(datos.cobro_id, datos.dni_normalizado, datos);
    if (!cobroIdOk) {
      _registrarPendiente(datos, 'La leyenda indica Cobro ' + datos.cobro_id + ' pero no existe ese cobro en el sistema.', pdfUrl);
      return;
    }
    if (!pdfUrl) {
      _registrarPendiente(datos, 'Error al subir el PDF a Supabase Storage.', null);
      return;
    }
    var okId = _registrarExito(cobroIdOk, datos.nro_recibo, pdfUrl, datos);
    if (okId) {
      Logger.log('✅ Recibo ' + datos.nro_recibo + ' asignado por cobro_id=' + cobroIdOk);
    } else {
      _registrarPendiente(datos, 'Error al guardar en la BD (PDF ya subido a Storage: ' + pdfUrl + ').', pdfUrl);
    }
    return;
  }

  // ── VÍA 2 (fallback): recibos viejos sin "Cobro <n>" → método por período ──
  if (!datos.dni_normalizado) {
    _registrarPendiente(datos, 'No se pudo extraer DNI/CUIT del PDF (y la leyenda no trae "Cobro <n>").', pdfUrl);
    return;
  }
  if (!datos.programa_id || !datos.periodo_bd) {
    _registrarPendiente(datos,
      'No se pudo parsear el Concepto del PDF (y la leyenda no trae "Cobro <n>"). Texto extraído: "' + (datos.concepto_raw || '') + '"', pdfUrl);
    return;
  }
  var cobro = _buscarCobro(datos.dni_normalizado, datos.programa_id, datos.periodo_bd, datos.cohorte_token);
  if (cobro === 'MULTIPLE') {
    _registrarPendiente(datos, 'Se encontraron múltiples cuotas para los mismos datos. Revisión manual requerida.', pdfUrl);
    return;
  }
  if (!cobro) {
    _registrarPendiente(datos,
      'No se encontró cuota para: DNI=' + datos.dni_normalizado +
      ', Programa=' + datos.programa_id +
      ', Periodo=' + datos.periodo_bd,
      pdfUrl);
    return;
  }
  if (!pdfUrl) {
    _registrarPendiente(datos, 'Error al subir el PDF a Supabase Storage.', null);
    return;
  }
  var ok = _registrarExito(cobro.cobro_id, datos.nro_recibo, pdfUrl, datos);
  if (ok) {
    Logger.log('✅ Recibo ' + datos.nro_recibo + ' asignado a cobro_id=' + cobro.cobro_id);
  } else {
    _registrarPendiente(datos, 'Error al guardar en la BD (PDF ya subido a Storage: ' + pdfUrl + ').', pdfUrl);
  }
}

// ══════════════════════════════════════════════════════════════
// EXTRAER TEXTO DEL PDF
// Requiere: Servicios avanzados → Drive API (v3) habilitado
// ══════════════════════════════════════════════════════════════

function _extraerTextoPDF(attachment) {
  var blob = attachment.copyBlob().setContentType('application/pdf');
  var file = Drive.Files.create(
    { name: 'sigpo_tmp_' + Date.now(), mimeType: 'application/vnd.google-apps.document' },
    blob
  );
  var texto = DocumentApp.openById(file.id).getBody().getText();
  DriveApp.getFileById(file.id).setTrashed(true);
  return texto;
}

// ══════════════════════════════════════════════════════════════
// PARSEAR CAMPOS DEL RECIBO TANGO
// Leyenda ACTUAL (cooperadora la copia desde la tarjeta del dashboard):
//   Concepto : Cobro 4044 Agosto de 2026 36965305
//     · Cobro 4044     → cobro_id, LLAVE directa e inequívoca   [VÍA 1 — preferida]
//     · Agosto de 2026 → período de la cuota                    [legible]
//     · 36965305       → DNI del estudiante                     [control blando]
//   VÍA 1: se asigna por el cobro_id (sin ambigüedad de período: inscripción y
//          cuota 1 comparten mes). El DNI solo controla, no bloquea.
//   VÍA 2 (fallback): recibos VIEJOS sin "Cobro <n>" (formato "<prog> <cohorte>
//          <mes> <año> <DNI>") → se resuelve por programa+período+DNI, excluyendo
//          la Inscripción (que comparte período con la Cuota 1).
//   NºRecibo : X00004-00009901
// ══════════════════════════════════════════════════════════════

function _parsearRecibo(texto) {
  var datos = {
    nro_recibo:      null,
    cuit_raw:        null,
    dni_normalizado: null,
    concepto_raw:    null,
    cobro_id:        null,  // LLAVE directa: token "Cobro <n>" de la leyenda (identifica el cobro sin ambigüedad)
    programa_id:     null,  // ej: 11
    cohorte_token:   null,  // texto de cohorte/edición tal como se cargó (ej: "Cohorte 2025-2026")
    periodo_bd:      null   // ej: "Julio de 2026"
  };

  var MESES = 'enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre';

  // Nro. Recibo — ej: X00004-00009901 (letra + dígitos, guion, dígitos)
  var mRec = texto.match(/([A-Z]\d{3,6}[-]\d{5,10})/);
  if (mRec) datos.nro_recibo = mRec[1];

  // ── LEYENDA ACTUAL: "Cobro <id> <mes> [de] <año> <DNI>"
  //    ej: "Cobro 4044 Agosto de 2026 36965305"
  //    cobro_id = LLAVE (VÍA 1); período y DNI son legibles / control blando.
  var reLey = new RegExp(
    'Cobro\\s*[:#]?\\s*(\\d+)\\s+(' + MESES + ')\\s+(?:de\\s+)?(\\d{4})\\s+([A-Za-z0-9.\\-]{5,20})', 'i'
  );
  var mLey = texto.match(reLey);
  if (mLey) {
    datos.cobro_id        = parseInt(mLey[1], 10);
    datos.periodo_bd      = _normalizarMes(mLey[2]) + ' de ' + mLey[3];
    datos.concepto_raw    = mLey[0].replace(/\s+/g, ' ').trim();
    datos.dni_normalizado = _normalizarDni(mLey[4]);
  }

  // Si la leyenda no vino completa, capturar al menos el token "Cobro <n>" suelto (VÍA 1).
  if (!datos.cobro_id) {
    var mCobroId = texto.match(/Cobro\s*[:#]?\s*(\d+)\b/i);
    if (mCobroId) datos.cobro_id = parseInt(mCobroId[1], 10);
  }

  // ── FALLBACK (recibos VIEJOS sin "Cobro <n>"): "<prog> <cohorte> <mes> <año> [<DNI>]"
  //    Se mantiene por compatibilidad con recibos ya emitidos antes del cambio.
  if (!datos.periodo_bd || !datos.programa_id) {
    var reNuevo = new RegExp(
      'Concepto\\s*:?\\s*(\\d{1,3})\\s+(.+?)\\s+(' + MESES + ')\\s+(?:de\\s+)?(\\d{4})\\s+(\\d{7,8})\\b', 'i'
    );
    var mConc = texto.match(reNuevo);
    if (mConc) {
      if (!datos.concepto_raw)    datos.concepto_raw    = mConc[0].replace(/\s+/g, ' ').trim();
      datos.programa_id     = parseInt(mConc[1], 10);
      datos.cohorte_token   = mConc[2].replace(/\s+/g, ' ').trim();
      if (!datos.periodo_bd)      datos.periodo_bd      = _normalizarMes(mConc[3]) + ' de ' + mConc[4];
      if (!datos.dni_normalizado) datos.dni_normalizado = _normalizarDni(mConc[5]);
    } else {
      var reViejo = new RegExp(
        'Concepto\\s*:?\\s*(\\d{1,3})\\s+(.+?)\\s+(' + MESES + ')\\s+(?:de\\s+)?(\\d{4})', 'i'
      );
      var mViejo = texto.match(reViejo);
      if (mViejo) {
        if (!datos.concepto_raw)  datos.concepto_raw  = mViejo[0].replace(/\s+/g, ' ').trim();
        datos.programa_id   = parseInt(mViejo[1], 10);
        datos.cohorte_token = mViejo[2].replace(/\s+/g, ' ').trim();
        if (!datos.periodo_bd)    datos.periodo_bd    = _normalizarMes(mViejo[3]) + ' de ' + mViejo[4];
      } else if (!datos.concepto_raw) {
        var mConc2 = texto.match(/Concepto\s*[:\s]+(.{5,90})/i);
        if (mConc2) datos.concepto_raw = mConc2[1].trim();
      }
    }
  }

  // DNI: si aún no lo tenemos, tomarlo del campo CUIT del cliente.
  if (!datos.dni_normalizado) {
    var mCuit = texto.match(/C\.U\.I\.T\.\s*:?\s*([\d.\-]{7,14})/);
    if (mCuit) {
      datos.cuit_raw        = mCuit[1];
      datos.dni_normalizado = _normalizarDni(mCuit[1]);
    }
  }

  return datos;
}

// ══════════════════════════════════════════════════════════════
// NORMALIZAR DNI
// Maneja: "20-07654321-3" → "7654321"
//         "07654321"      → "7654321"
//         "24207661"      → "24207661"
// ══════════════════════════════════════════════════════════════

function _normalizarDni(valor) {
  var dig = valor.replace(/\D/g, '');
  if (dig.length === 11) {
    // Es CUIT/CUIL: los 8 dígitos del medio son el DNI (posiciones 2 a 9)
    dig = dig.substring(2, 10);
  }
  // Quitar ceros a la izquierda (resuelve el caso DNI guardado sin 0 inicial)
  dig = dig.replace(/^0+/, '') || '0';
  return dig;
}

// ══════════════════════════════════════════════════════════════
// NORMALIZAR MES: "marzo" → "Marzo"
// ══════════════════════════════════════════════════════════════

function _normalizarMes(mes) {
  var tabla = {
    enero:'Enero', febrero:'Febrero', marzo:'Marzo', abril:'Abril',
    mayo:'Mayo', junio:'Junio', julio:'Julio', agosto:'Agosto',
    septiembre:'Septiembre', octubre:'Octubre', noviembre:'Noviembre', diciembre:'Diciembre'
  };
  return tabla[mes.toLowerCase()] || (mes.charAt(0).toUpperCase() + mes.slice(1).toLowerCase());
}

// ══════════════════════════════════════════════════════════════
// BUSCAR COBRO EN SUPABASE
// Identifica la cuota por: programa_id + periodo + DNI (recibo sin asignar).
// El periodo (mes + año) ya determina la cuota exacta del programa.
// Si hubiera más de una coincidencia (ej: estudiante en dos cohortes/ediciones
// del mismo programa y periodo), desambigua comparando el nombre de
// cohorte/edición del concepto contra cohortes.nombre en la BD.
// Retorna: objeto cobro | null (no encontrado) | 'MULTIPLE'
// ══════════════════════════════════════════════════════════════

function _buscarCobro(dniNorm, programaId, periodoBD, cohorteToken) {
  // Buscar cobros del programa en ese periodo (sin filtrar por recibo_url para soportar pagos parciales).
  // Se EXCLUYE la Inscripción: comparte período con la Cuota 1 (ambas "Agosto de …"), lo que
  // producía "MULTIPLE". Un recibo por período apunta a la cuota; la inscripción se paga por
  // "Cobro <n>" (VÍA 1). Recibos viejos de inscripción quedan para resolución manual.
  var cobros = _sbGet(
    'cobros?select=cobro_id,dni,cohorte_id,cohortes(nombre)' +
    '&programa_id=eq.' + programaId +
    '&concepto=not.ilike.Inscrip*' +
    '&periodo=ilike.' + encodeURIComponent(periodoBD)
  );

  // Filtrar por DNI normalizado (maneja ceros a la izquierda en la BD)
  var coincidencias = cobros.filter(function(c) {
    return (String(c.dni).replace(/^0+/, '') || '0') === dniNorm;
  });

  if (coincidencias.length === 0) return null;
  if (coincidencias.length === 1) return coincidencias[0];

  // Más de una cuota: desambiguar por el nombre de cohorte/edición del concepto.
  if (cohorteToken) {
    var tok = _normalizarTexto(cohorteToken);
    var porNombre = coincidencias.filter(function(c) {
      var nom = (c.cohortes && c.cohortes.nombre) ? _normalizarTexto(c.cohortes.nombre) : '';
      return nom === tok;
    });
    if (porNombre.length === 1) return porNombre[0];
  }
  return 'MULTIPLE';
}

// ══════════════════════════════════════════════════════════════
// BUSCAR COBRO POR ID (VÍA 1 — llave directa desde "Cobro <n>" de la leyenda)
// El cobro_id es la PK: identifica UN cobro sin ambigüedad (inscripción, cuota,
// readmisión o cualquier concepto futuro, con cualquier nombre o numeración).
// El DNI es un control BLANDO: si no coincide, AVISA pero NO bloquea (el id manda).
// Retorna: cobro_id (number) | null (no existe ese cobro).
// ══════════════════════════════════════════════════════════════

function _buscarCobroPorId(cobroId, dniNorm, datos) {
  var rows = _sbGet('cobros?select=cobro_id,dni&cobro_id=eq.' + encodeURIComponent(cobroId));
  if (!rows.length) return null;
  var cobro = rows[0];

  // Chequeo DNI BLANDO: avisa, no descarta.
  if (dniNorm) {
    var bdDni = (String(cobro.dni).replace(/^0+/, '') || '0');
    if (bdDni !== dniNorm) {
      var aviso = 'DNI del recibo (' + dniNorm + ') no coincide con el del cobro ' +
                  cobro.cobro_id + ' (' + cobro.dni + '). Se asigna igual por cobro_id.';
      Logger.log('⚠ ' + aviso);
      if (datos) datos.aviso_dni = aviso;
    }
  }
  return cobro.cobro_id;
}

// ══════════════════════════════════════════════════════════════
// NORMALIZAR TEXTO (para cotejar cohorte/edición): minúsculas, sin acentos,
// y solo alfanumérico separado por espacios. "Cohorte 2025-2026" → "cohorte 2025 2026"
// ══════════════════════════════════════════════════════════════

function _normalizarTexto(s) {
  return String(s == null ? '' : s)
    .toLowerCase()
    .replace(/[áàä]/g, 'a').replace(/[éèë]/g, 'e').replace(/[íìï]/g, 'i')
    .replace(/[óòö]/g, 'o').replace(/[úùü]/g, 'u').replace(/ñ/g, 'n')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// ══════════════════════════════════════════════════════════════
// VERIFICAR RECIBO DUPLICADO
// ══════════════════════════════════════════════════════════════

function _reciboDuplicado(nroRecibo) {
  var r = _sbGet('recibos_tango?select=id&nro_recibo=eq.' + encodeURIComponent(nroRecibo));
  return r.length > 0;
}

// ══════════════════════════════════════════════════════════════
// SUBIR PDF A SUPABASE STORAGE (bucket: comprobantes)
// ══════════════════════════════════════════════════════════════

function _subirStorage(pdfBlob, fileName) {
  var url = SUPABASE_URL + '/storage/v1/object/comprobantes/' + fileName;
  try {
    var resp = UrlFetchApp.fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + SUPABASE_KEY,
        'Content-Type': 'application/pdf',
        'x-upsert': 'true'
      },
      payload: pdfBlob.getBytes(),
      muteHttpExceptions: true
    });
    var code = resp.getResponseCode();
    if (code === 200 || code === 201) {
      return SUPABASE_URL + '/storage/v1/object/public/comprobantes/' + fileName;
    }
    Logger.log('Storage error HTTP ' + code + ': ' + resp.getContentText().substring(0, 300));
    return null;
  } catch(e) {
    Logger.log('Storage excepción: ' + e.toString());
    return null;
  }
}

// ══════════════════════════════════════════════════════════════
// REGISTRAR ÉXITO: insert recibos_tango + update cobros.recibo_url
// ══════════════════════════════════════════════════════════════

function _registrarExito(cobroId, nroRecibo, pdfUrl, datos) {
  var ok1 = _sbPost('recibos_tango', {
    cobro_id:         cobroId,
    nro_recibo:       nroRecibo,
    pdf_url:          pdfUrl,
    tango_datos_json: datos,
    estado:           'asignado'
  });
  var ok2 = _sbPatch('cobros?cobro_id=eq.' + cobroId, { recibo_url: pdfUrl });
  return ok1 && ok2;
}

// ══════════════════════════════════════════════════════════════
// REGISTRAR PENDIENTE: insert recibos_pendientes_tango + aviso email
// pdfUrl: URL del PDF ya subido al Storage (puede ser null si falló el upload)
// ══════════════════════════════════════════════════════════════

function _registrarPendiente(datos, motivo, pdfUrl) {
  Logger.log('⚠ PENDIENTE: ' + motivo);
  _sbPost('recibos_pendientes_tango', {
    email_origen:    datos.email_origen  || null,
    email_asunto:    datos.email_asunto  || null,
    nro_recibo:      datos.nro_recibo    || null,
    pdf_url:         pdfUrl || null,
    datos_extraidos: datos,
    motivo_fallo:    motivo,
    notificado_en:   new Date().toISOString(),
    resuelto:        false
  });
  try {
    GmailApp.sendEmail(
      EMAIL_ADMIN,
      '[SiGPo] Recibo Tango pendiente de revisión',
      'Un recibo no pudo asignarse automáticamente.\n\n' +
      'Motivo: ' + motivo + '\n' +
      'Recibo Nro: ' + (datos.nro_recibo || 'desconocido') + '\n' +
      'Email origen: ' + (datos.email_origen || 'desconocido') + '\n\n' +
      'Revisarlo en Supabase → tabla recibos_pendientes_tango',
      { name: NOMBRE_INST }
    );
  } catch(e) {
    Logger.log('No se pudo enviar email de aviso: ' + e.toString());
  }
}

// ══════════════════════════════════════════════════════════════
// PROCESAR UNA FACTURA TANGO
// La factura NO se vincula a una cuota: se asigna al ESTUDIANTE por su
// DNI/CUIT/CUIL y se guarda en la tabla `facturas` (estudiante_dni).
// ══════════════════════════════════════════════════════════════

function _procesarFactura(texto, att, msg) {
  var datos = _parsearFactura(texto);
  datos.email_origen = msg.getFrom();
  datos.email_asunto = msg.getSubject();
  Logger.log('Datos factura: ' + JSON.stringify(datos));

  // Subir el PDF SIEMPRE (quede asignado o no, así no se pierde)
  var fileBase = (datos.nro_factura || ('factura-' + Date.now())).replace(/[^\w\-]/g, '_');
  var pdfUrl   = _subirStorage(att.copyBlob(), 'facturas-tango/' + fileBase + '.pdf');

  if (!datos.dni_normalizado) {
    _avisarFacturaPendiente(datos, 'No se pudo extraer el DNI/CUIT/CUIL del estudiante de la factura.', pdfUrl);
    return;
  }

  var est = _buscarEstudiante(datos.dni_normalizado);
  if (!est) {
    _avisarFacturaPendiente(datos, 'No se encontró un estudiante con DNI=' + datos.dni_normalizado + '.', pdfUrl);
    return;
  }

  if (datos.nro_factura && _facturaDuplicada(datos.nro_factura, est.dni)) {
    Logger.log('Factura ' + datos.nro_factura + ' ya cargada para dni=' + est.dni + '. Saltando.');
    return;
  }

  if (!pdfUrl) {
    _avisarFacturaPendiente(datos, 'Error al subir el PDF de la factura a Storage.', null);
    return;
  }

  var ok = _sbPost('facturas', {
    estudiante_dni: est.dni,
    descripcion:    datos.descripcion || ('Factura ' + (datos.nro_factura || '')),
    periodo:        datos.periodo || null,
    archivo_url:    pdfUrl,
    subido_por_dni: 'TANGO'
  });

  if (ok) {
    Logger.log('✅ Factura ' + datos.nro_factura + ' asignada a ' +
               (est.apellido || '') + ', ' + (est.nombre || '') + ' (dni=' + est.dni + ')');
  } else {
    _avisarFacturaPendiente(datos, 'Error al guardar la factura en la BD (PDF en Storage: ' + pdfUrl + ').', pdfUrl);
  }
}

// ══════════════════════════════════════════════════════════════
// PARSEAR FACTURA TANGO
// Lo único imprescindible es el DNI/CUIT/CUIL del estudiante.
// El resto (descripción, cuota, nro) es informativo para la tarjeta.
// ══════════════════════════════════════════════════════════════

function _parsearFactura(texto) {
  var datos = {
    nro_factura:     null,
    dni_normalizado: null,
    alumno_nombre:   null,
    descripcion:     null,
    periodo:         null
  };

  // Nro de factura — ej: "Nro: C00009-00000295"
  var mNro = texto.match(/Nro\.?\s*:?\s*([A-Z]?\d{3,5}-\d{5,10})/i);
  if (mNro) datos.nro_factura = mNro[1];

  // DNI / CUIT / CUIL del estudiante (descarta el CUIT de la empresa que paga)
  datos.dni_normalizado = _extraerDniEstudiante(texto);

  // Nombre del alumno: "Corresponde a APELLIDO, Nombre" o, si no está,
  // la línea del cliente "(1B1014 ) - BAIGORRIA, Ernesto"
  var mNom = texto.match(/Corresponde a\s+([^\n]+)/i);
  if (mNom) {
    datos.alumno_nombre = mNom[1].trim();
  } else {
    var mCli = texto.match(/\)\s*-\s*([A-ZÁÉÍÓÚÑ][^\n]+)/);
    if (mCli) datos.alumno_nombre = mCli[1].trim();
  }

  // Item / concepto — la línea con letras seguida de cantidad y montos
  // ej: "MAESTRÍA RESP. SOCIAL Y DES. SOST. 19/20 1.00 9,560.00 9,560.00"
  var mItem = texto.match(/([A-ZÁÉÍÓÚÑ][^\n]*?)\s+\d+[.,]\d{2}\s+[\d.,]+\s+[\d.,]+/);
  var item  = mItem ? mItem[1].replace(/\s{2,}/g, ' ').trim() : null;

  // Periodo — mes + año, ej: "mayo 2021"
  var mPer = texto.match(/(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre)\s+(\d{4})/i);
  if (mPer) datos.periodo = _normalizarMes(mPer[1]) + ' ' + mPer[2];

  // Cuota Nº (no siempre aparece) — ej: "Cuota Nº 1"
  var mCuota = texto.match(/Cuota\s*N[ºo°]?\s*(\d+)/i);

  // Descripción legible (incluye el Nro para poder deduplicar)
  var partes = [];
  if (item)               partes.push(item);
  if (mCuota)             partes.push('Cuota ' + mCuota[1]);
  if (datos.periodo)      partes.push(datos.periodo);
  if (datos.nro_factura)  partes.push('Factura ' + datos.nro_factura);
  datos.descripcion = partes.join(' · ') || 'Factura';

  return datos;
}

// ══════════════════════════════════════════════════════════════
// EXTRAER DNI DEL ESTUDIANTE DE LA FACTURA
// Única fuente: el campo "Corresponde a", que en Tango se carga SIEMPRE
// con el DNI del estudiante. No importa a nombre de quién esté la factura
// (estudiante, empresa o Estado): el alumno se identifica por ese número.
// Si no aparece, la factura NO se asigna y pasa a revisión manual
// (igual que los recibos). No se adivina por CUIT/CUIL.
// ══════════════════════════════════════════════════════════════

function _extraerDniEstudiante(texto) {
  // Campo "Corresponde a" — con o sin la etiqueta "DNI"
  //   ej: "Corresponde a 28123456"  ó  "Corresponde a LEZZIERI, Mariela DNI 28123456"
  var mCorr = texto.match(/Corresponde a[^\n]*?\b(\d{7,8})\b/i);
  if (mCorr) return _normalizarDni(mCorr[1]);

  return null;
}

// ══════════════════════════════════════════════════════════════
// BUSCAR ESTUDIANTE POR DNI (dni en la BD es numérico, sin ceros previos)
// ══════════════════════════════════════════════════════════════

function _buscarEstudiante(dniNorm) {
  var ests = _sbGet('estudiantes?select=dni,nombre,apellido&dni=eq.' + dniNorm);
  return ests.length ? ests[0] : null;
}

// ══════════════════════════════════════════════════════════════
// VERIFICAR FACTURA DUPLICADA (por Nro dentro de la descripción del alumno)
// ══════════════════════════════════════════════════════════════

function _facturaDuplicada(nroFactura, estDni) {
  var r = _sbGet('facturas?select=id&estudiante_dni=eq.' + estDni +
                 '&descripcion=ilike.*' + encodeURIComponent(nroFactura) + '*');
  return r.length > 0;
}

// ══════════════════════════════════════════════════════════════
// AVISO DE FACTURA NO ASIGNADA
// Registra en facturas_pendientes_tango + aviso por email (igual que recibos)
// ══════════════════════════════════════════════════════════════

function _avisarFacturaPendiente(datos, motivo, pdfUrl) {
  Logger.log('⚠ FACTURA PENDIENTE: ' + motivo);
  _sbPost('facturas_pendientes_tango', {
    email_origen:    datos.email_origen  || null,
    email_asunto:    datos.email_asunto  || null,
    nro_factura:     datos.nro_factura   || null,
    pdf_url:         pdfUrl || null,
    datos_extraidos: datos,
    motivo_fallo:    motivo,
    notificado_en:   new Date().toISOString(),
    resuelto:        false
  });
  try {
    GmailApp.sendEmail(
      EMAIL_ADMIN,
      '[SiGPo] Factura Tango pendiente de revisión',
      'Una factura no pudo asignarse automáticamente a un estudiante.\n\n' +
      'Motivo: ' + motivo + '\n' +
      'Factura Nro: ' + (datos.nro_factura || 'desconocido') + '\n' +
      'Alumno (texto del PDF): ' + (datos.alumno_nombre || 'desconocido') + '\n' +
      'DNI detectado: ' + (datos.dni_normalizado || 'ninguno') + '\n' +
      'PDF: ' + (pdfUrl || 'no se pudo subir') + '\n' +
      'Email origen: ' + (datos.email_origen || 'desconocido') + '\n\n' +
      'Cargala manualmente desde vista_facturacion_estudiante.html (rol Cooperadora).',
      { name: NOMBRE_INST }
    );
  } catch(e) {
    Logger.log('No se pudo enviar email de aviso de factura: ' + e.toString());
  }
}

// ══════════════════════════════════════════════════════════════
// HELPERS — GMAIL
// ══════════════════════════════════════════════════════════════

function _obtenerOCrearLabel(nombre) {
  var lbl = GmailApp.getUserLabelByName(nombre);
  if (!lbl) lbl = GmailApp.createLabel(nombre);
  return lbl;
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
      Logger.log('_sbGet error ' + resp.getResponseCode() + ': ' + resp.getContentText().substring(0, 200));
      return [];
    }
    return JSON.parse(resp.getContentText()) || [];
  } catch(e) {
    Logger.log('_sbGet excepción: ' + e.toString());
    return [];
  }
}

function _sbPost(table, data) {
  try {
    var resp = UrlFetchApp.fetch(SUPABASE_URL + '/rest/v1/' + table, {
      method: 'post',
      contentType: 'application/json',
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': 'Bearer ' + SUPABASE_KEY,
        'Prefer': 'return=minimal'
      },
      payload: JSON.stringify(data),
      muteHttpExceptions: true
    });
    if (resp.getResponseCode() >= 300) {
      Logger.log('_sbPost error ' + resp.getResponseCode() + ': ' + resp.getContentText().substring(0, 200));
      return false;
    }
    return true;
  } catch(e) {
    Logger.log('_sbPost excepción: ' + e.toString());
    return false;
  }
}

function _sbPatch(path, data) {
  try {
    var resp = UrlFetchApp.fetch(SUPABASE_URL + '/rest/v1/' + path, {
      method: 'patch',
      contentType: 'application/json',
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': 'Bearer ' + SUPABASE_KEY,
        'Prefer': 'return=minimal'
      },
      payload: JSON.stringify(data),
      muteHttpExceptions: true
    });
    if (resp.getResponseCode() >= 300) {
      Logger.log('_sbPatch error ' + resp.getResponseCode() + ': ' + resp.getContentText().substring(0, 200));
      return false;
    }
    return true;
  } catch(e) {
    Logger.log('_sbPatch excepción: ' + e.toString());
    return false;
  }
}
