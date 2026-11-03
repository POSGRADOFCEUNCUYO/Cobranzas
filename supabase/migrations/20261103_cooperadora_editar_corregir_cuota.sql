-- Migración: Cooperadora puede EDITAR el valor de una cuota y CORREGIR un pago,
--            y el historial de cobros pasa a registrar QUIÉN hizo el cambio.
-- Fecha: 2026-11-03
--
-- Contexto: hoy COOPERADORA tiene solo lectura sobre `cobros` (la policy UPDATE no la
-- incluye). En vez de abrirle la tabla entera, se agregan DOS RPC SECURITY DEFINER acotadas
-- (mismo patrón que `aprobar_cobro`), que validan y mantienen la coherencia de la cuota:
--   saldo_pendiente = valor - pagado ; estado coherente ; `pagos` reconciliado.
-- Cooperadora sigue SIN UPDATE directo: solo puede llamar a estas funciones.

-- ──────────────────────────────────────────────────────────────────────────
-- 1) Historial con AUTOR + registra también cambios de monto (antes solo estado)
--    Captura al usuario autenticado (auth.uid -> usuarios). Si el cambio viene por
--    service_role / script admin (sin JWT), queda NULL => la web lo muestra como "SISTEMA".
-- ──────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.trg_historial_cobro()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid bigint;
BEGIN
  SELECT usuario_id INTO v_uid FROM usuarios WHERE auth_user_id = auth.uid();

  IF OLD.estado IS DISTINCT FROM NEW.estado
     OR COALESCE(OLD.monto_final, -1)   IS DISTINCT FROM COALESCE(NEW.monto_final, -1)
     OR COALESCE(OLD.monto_abonado, -1) IS DISTINCT FROM COALESCE(NEW.monto_abonado, -1) THEN
    INSERT INTO public.historial_cobros (
      cobro_id, dni, programa_id, cohorte_id,
      estado_anterior, estado_nuevo, monto_final, saldo_pendiente, registrado_por
    ) VALUES (
      NEW.cobro_id, NEW.dni, NEW.programa_id, NEW.cohorte_id,
      OLD.estado, NEW.estado, NEW.monto_final, NEW.saldo_pendiente, v_uid
    );
  END IF;
  RETURN NEW;
END;
$function$;

-- ──────────────────────────────────────────────────────────────────────────
-- 2) editar_valor_cuota: fija CUÁNTO DEBE ABONAR esa cuota (una sola).
--    Mantiene invariantes: saldo = valor - ya_pagado ; estado coherente.
--    Si la cuota está VENCIDA, la marca exenta_mora para que el valor fijado por
--    cooperadora sea el definitivo del momento (la mora automática no lo re-infla).
-- ──────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.editar_valor_cuota(p_cobro_id bigint, p_monto numeric)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_rol     rol_usuario;
  v_c       cobros%ROWTYPE;
  v_ab      numeric;
  v_saldo   numeric;
  v_estado  text;
  v_vencida boolean;
BEGIN
  v_rol := get_user_rol();
  IF COALESCE(v_rol::text,'') NOT IN ('COOPERADORA','ADMINISTRADOR') THEN
    RETURN jsonb_build_object('ok', false, 'mensaje', 'Sin permiso');
  END IF;
  IF p_monto IS NULL OR p_monto < 0 THEN
    RETURN jsonb_build_object('ok', false, 'mensaje', 'Monto inválido');
  END IF;

  SELECT * INTO v_c FROM cobros WHERE cobro_id = p_cobro_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'mensaje', 'Cuota no encontrada');
  END IF;
  IF v_c.no_aplica IS TRUE THEN
    RETURN jsonb_build_object('ok', false, 'mensaje', 'La cuota es NO_APLICA');
  END IF;

  v_ab := COALESCE(v_c.monto_abonado, 0);
  IF p_monto < v_ab THEN
    RETURN jsonb_build_object('ok', false, 'mensaje',
      'El valor no puede ser menor a lo ya pagado (' || v_ab || ')');
  END IF;

  v_saldo   := round(greatest(0, p_monto - v_ab), 2);
  v_vencida := (v_c.fecha_vencimiento IS NOT NULL AND v_c.fecha_vencimiento < CURRENT_DATE);
  v_estado  := CASE
                 WHEN v_ab <= 0 AND v_vencida THEN 'EN_MORA'
                 WHEN v_ab <= 0               THEN 'NO_ABONADA'
                 WHEN v_saldo <= 0            THEN 'ABONADA'
                 ELSE                              'PAGO_PARCIAL'
               END;

  UPDATE cobros SET
    monto_original  = p_monto,
    monto_final     = p_monto,
    saldo_pendiente = v_saldo,
    estado          = v_estado::estado_cobro,
    no_aplica       = false,
    exenta_mora     = CASE WHEN v_vencida THEN true ELSE v_c.exenta_mora END,
    updated_at      = now()
  WHERE cobro_id = p_cobro_id;

  RETURN jsonb_build_object('ok', true, 'estado', v_estado, 'saldo', v_saldo);
END;
$function$;

-- ──────────────────────────────────────────────────────────────────────────
-- 3) corregir_pago: fija CUÁNTO PAGÓ realmente (corrige una aprobación mal cargada).
--    Reconcilia la tabla `pagos` con una fila de ajuste (puede ser negativa), de modo
--    que SUM(pagos) == monto_abonado, y recalcula saldo/estado.
--    Funciona aunque la cuota esté ABONADA y con recibo (el recibo puede cubrir N cuotas).
-- ──────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.corregir_pago(p_cobro_id bigint, p_total_pagado numeric)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_rol     rol_usuario;
  v_c       cobros%ROWTYPE;
  v_sum     numeric;
  v_delta   numeric;
  v_saldo   numeric;
  v_estado  text;
  v_vencida boolean;
BEGIN
  v_rol := get_user_rol();
  IF COALESCE(v_rol::text,'') NOT IN ('COOPERADORA','ADMINISTRADOR') THEN
    RETURN jsonb_build_object('ok', false, 'mensaje', 'Sin permiso');
  END IF;
  IF p_total_pagado IS NULL OR p_total_pagado < 0 THEN
    RETURN jsonb_build_object('ok', false, 'mensaje', 'Monto inválido');
  END IF;

  SELECT * INTO v_c FROM cobros WHERE cobro_id = p_cobro_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'mensaje', 'Cuota no encontrada');
  END IF;
  IF COALESCE(v_c.monto_final, 0) <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'mensaje', 'La cuota no tiene un valor definido');
  END IF;
  IF p_total_pagado > v_c.monto_final THEN
    RETURN jsonb_build_object('ok', false, 'mensaje',
      'Lo pagado no puede superar el valor de la cuota (' || v_c.monto_final || ')');
  END IF;

  SELECT COALESCE(SUM(monto), 0) INTO v_sum FROM pagos WHERE cobro_id = p_cobro_id;
  v_delta := round(p_total_pagado - v_sum, 2);
  IF v_delta <> 0 THEN
    INSERT INTO pagos (cobro_id, monto, fecha_pago, recibo_url)
    VALUES (p_cobro_id, v_delta, CURRENT_DATE, NULL);
  END IF;

  v_vencida := (v_c.fecha_vencimiento IS NOT NULL AND v_c.fecha_vencimiento < CURRENT_DATE);
  v_saldo   := round(greatest(0, v_c.monto_final - p_total_pagado), 2);
  v_estado  := CASE
                 WHEN p_total_pagado <= 0 AND v_vencida THEN 'EN_MORA'
                 WHEN p_total_pagado <= 0               THEN 'NO_ABONADA'
                 WHEN v_saldo <= 0                      THEN 'ABONADA'
                 ELSE                                        'PAGO_PARCIAL'
               END;

  UPDATE cobros SET
    monto_abonado   = p_total_pagado,
    saldo_pendiente = v_saldo,
    estado          = v_estado::estado_cobro,
    updated_at      = now()
  WHERE cobro_id = p_cobro_id;

  RETURN jsonb_build_object('ok', true, 'estado', v_estado, 'saldo', v_saldo, 'ajuste', v_delta);
END;
$function$;

-- ──────────────────────────────────────────────────────────────────────────
-- Permisos: cualquier usuario autenticado puede INVOCAR las funciones; el control de
-- rol (COOPERADORA/ADMINISTRADOR) está adentro. Cooperadora NO recibe UPDATE directo.
-- ──────────────────────────────────────────────────────────────────────────
GRANT EXECUTE ON FUNCTION public.editar_valor_cuota(bigint, numeric) TO authenticated;
GRANT EXECUTE ON FUNCTION public.corregir_pago(bigint, numeric)      TO authenticated;
