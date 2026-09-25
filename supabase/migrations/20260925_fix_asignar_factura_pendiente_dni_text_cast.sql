-- Fix: al asignar manualmente una factura pendiente de Tango a un estudiante
-- (recibos_pendientes_tango.html → RPC asignar_factura_pendiente), fallaba con
-- "operator does not exist: text = bigint".
--
-- Causa: el parámetro p_estudiante_dni es bigint, pero estudiantes.dni es TEXT,
-- así que la comparación `dni = p_estudiante_dni` no tiene operador válido.
-- (facturas.estudiante_dni sí es bigint, por eso el INSERT no daba problema.)
--
-- Solución mínima y de bajo riesgo: castear el parámetro a text SOLO en la
-- comparación. No se cambia la firma (conserva permisos) ni el frontend.

CREATE OR REPLACE FUNCTION public.asignar_factura_pendiente(p_pendiente_id bigint, p_estudiante_dni bigint, p_resuelto_por text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_pend  facturas_pendientes_tango%ROWTYPE;
  v_desc  text;
  v_per   text;
BEGIN
  IF COALESCE(get_user_rol()::text, '') NOT IN ('COOPERADORA', 'ADMINISTRADOR') THEN
    RETURN jsonb_build_object('ok', false, 'mensaje', 'Sin permiso');
  END IF;

  SELECT * INTO v_pend FROM facturas_pendientes_tango WHERE id = p_pendiente_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'mensaje', 'Pendiente no encontrado');
  END IF;
  IF v_pend.resuelto THEN
    RETURN jsonb_build_object('ok', false, 'mensaje', 'Ya estaba resuelto');
  END IF;
  -- FIX: estudiantes.dni es TEXT; el parámetro llega como bigint. Casteamos a text para comparar.
  IF NOT EXISTS (SELECT 1 FROM estudiantes WHERE dni = p_estudiante_dni::text) THEN
    RETURN jsonb_build_object('ok', false, 'mensaje', 'No existe un estudiante con ese DNI');
  END IF;

  v_desc := COALESCE(v_pend.datos_extraidos->>'descripcion',
                     'Factura ' || COALESCE(v_pend.nro_factura, ''));
  v_per  := v_pend.datos_extraidos->>'periodo';

  INSERT INTO facturas (estudiante_dni, descripcion, periodo, archivo_url, subido_por_dni)
  VALUES (p_estudiante_dni, v_desc, v_per, v_pend.pdf_url, 'TANGO');

  UPDATE facturas_pendientes_tango
  SET resuelto = true, resuelto_por = p_resuelto_por, resuelto_en = now()
  WHERE id = p_pendiente_id;

  RETURN jsonb_build_object('ok', true);
END;
$function$;
