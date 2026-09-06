-- Migración: sincronización de aprobar_cobro con la versión real en la base
-- Fecha: 2026-09-06
--
-- La función `aprobar_cobro` que corre en producción ya incorpora una mejora
-- respecto de la última migración versionada (20260628_harden_aprobar_cobro_null_guard):
-- cuando se aprueba un PAGO COMPLETO sobre una cuota que YA tenía un pago parcial,
-- en la tabla `pagos` se registra SOLO EL SALDO RESTANTE (monto_final - monto_abonado_previo),
-- no el total otra vez. Así el historial de `pagos` no se duplica y la suma de pagos
-- de una cuota siempre coincide con su monto_final.
--
-- Este archivo deja el repositorio sincronizado con la función real en Supabase.
-- No cambia el comportamiento en vivo: es idéntica a la que ya está corriendo.

CREATE OR REPLACE FUNCTION public.aprobar_cobro(p_cobro_id bigint, p_tipo text, p_monto numeric, p_recibo_url text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    v_rol          rol_usuario;
    v_cobro        cobros%ROWTYPE;
    v_abonado_prev NUMERIC;
    v_abonado_tot  NUMERIC;
    v_nuevo_saldo  NUMERIC;
    v_resto        NUMERIC;
    v_estado_nuevo TEXT;
    v_fecha_pago   DATE;
BEGIN
    v_rol := get_user_rol();
    IF COALESCE(v_rol::text, '') NOT IN ('COOPERADORA', 'ADMINISTRADOR') THEN
        RETURN jsonb_build_object('ok', false, 'mensaje', 'Sin permiso');
    END IF;

    SELECT * INTO v_cobro FROM cobros WHERE cobro_id = p_cobro_id;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', false, 'mensaje', 'Cobro no encontrado');
    END IF;

    IF v_cobro.estado = 'ABONADA' THEN
        RETURN jsonb_build_object('ok', false, 'mensaje', 'Esta cuota ya está abonada');
    END IF;

    v_fecha_pago := COALESCE(v_cobro.comprobante_fecha::DATE, CURRENT_DATE);

    IF p_tipo IN ('COMPLETO', 'total') THEN
        -- El "pago completo" finaliza la cuota. Si ya había un pago parcial previo,
        -- solo se registra en `pagos` el SALDO RESTANTE (no el total otra vez),
        -- para no duplicar el historial de pagos.
        v_abonado_prev := COALESCE(v_cobro.monto_abonado, 0);
        v_resto        := ROUND((COALESCE(v_cobro.monto_final, 0) - v_abonado_prev)::NUMERIC, 2);

        UPDATE cobros SET
            estado          = 'ABONADA',
            saldo_pendiente = 0,
            monto_abonado   = v_cobro.monto_final,
            fecha_aprobacion = CURRENT_DATE,
            recibo_url      = COALESCE(p_recibo_url, v_cobro.recibo_url),
            aprobado_por    = get_user_dni()
        WHERE cobro_id = p_cobro_id;

        IF v_resto > 0 THEN
            INSERT INTO pagos (cobro_id, monto, fecha_pago, recibo_url)
            VALUES (p_cobro_id, v_resto, v_fecha_pago, COALESCE(p_recibo_url, v_cobro.recibo_url));
        END IF;

    ELSE
        IF p_monto IS NULL OR p_monto <= 0 THEN
            RETURN jsonb_build_object('ok', false, 'mensaje', 'El monto debe ser mayor a cero');
        END IF;

        v_abonado_prev := COALESCE(v_cobro.monto_abonado, 0);
        v_abonado_tot  := ROUND((v_abonado_prev + p_monto)::NUMERIC, 2);
        v_nuevo_saldo  := ROUND((COALESCE(v_cobro.monto_final, 0) - v_abonado_tot)::NUMERIC, 2);
        v_estado_nuevo := CASE WHEN v_nuevo_saldo <= 0 THEN 'ABONADA' ELSE 'PAGO_PARCIAL' END;

        UPDATE cobros SET
            estado          = v_estado_nuevo::estado_cobro,
            saldo_pendiente = GREATEST(0, v_nuevo_saldo),
            monto_abonado   = v_abonado_tot,
            recibo_url      = COALESCE(p_recibo_url, v_cobro.recibo_url),
            aprobado_por    = get_user_dni(),
            saldo_mora_base = NULL,
            fecha_aprobacion = CASE WHEN v_estado_nuevo = 'ABONADA' THEN CURRENT_DATE ELSE NULL END
        WHERE cobro_id = p_cobro_id;

        INSERT INTO pagos (cobro_id, monto, fecha_pago, recibo_url)
        VALUES (p_cobro_id, p_monto, v_fecha_pago, COALESCE(p_recibo_url, v_cobro.recibo_url));
    END IF;

    RETURN jsonb_build_object('ok', true);
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.aprobar_cobro(bigint, text, numeric, text) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.aprobar_cobro(bigint, text, numeric, text) TO authenticated;
