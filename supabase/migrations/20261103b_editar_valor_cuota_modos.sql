-- Migración: editar_valor_cuota con 3 modos (valor / a definir / no aplica)
-- Fecha: 2026-11-03
--
-- Reemplaza la versión de 2 argumentos por una de 3 (agrega p_no_aplica), para que el
-- popup de cooperadora pueda, con un solo RPC: poner un valor, dejar la cuota "a definir"
-- (sin monto) o marcarla "no aplica". Mantiene las invariantes (saldo = valor - pagado,
-- estado coherente) y la exención de mora al editar una cuota vencida.

DROP FUNCTION IF EXISTS public.editar_valor_cuota(bigint, numeric);

CREATE OR REPLACE FUNCTION public.editar_valor_cuota(p_cobro_id bigint, p_monto numeric, p_no_aplica boolean DEFAULT false)
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
  SELECT * INTO v_c FROM cobros WHERE cobro_id = p_cobro_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'mensaje', 'Cuota no encontrada'); END IF;
  v_ab := COALESCE(v_c.monto_abonado, 0);

  -- Modo NO_APLICA
  IF p_no_aplica THEN
    IF v_ab > 0 THEN RETURN jsonb_build_object('ok', false, 'mensaje', 'La cuota tiene pagos; no se puede marcar NO_APLICA'); END IF;
    UPDATE cobros SET estado='NO_APLICA'::estado_cobro, no_aplica=true,
       monto_original=NULL, monto_final=NULL, saldo_pendiente=NULL,
       descuento_porcentaje=0, exenta_mora=false, updated_at=now()
     WHERE cobro_id=p_cobro_id;
    RETURN jsonb_build_object('ok', true, 'estado', 'NO_APLICA');
  END IF;

  -- Modo A_DEFINIR (sin monto)
  IF p_monto IS NULL THEN
    IF v_ab > 0 THEN RETURN jsonb_build_object('ok', false, 'mensaje', 'La cuota tiene pagos; no se puede dejar A_DEFINIR'); END IF;
    UPDATE cobros SET estado='A_DEFINIR'::estado_cobro, no_aplica=false,
       monto_original=NULL, monto_final=NULL, saldo_pendiente=NULL, updated_at=now()
     WHERE cobro_id=p_cobro_id;
    RETURN jsonb_build_object('ok', true, 'estado', 'A_DEFINIR');
  END IF;

  -- Modo VALOR
  IF p_monto < 0 THEN RETURN jsonb_build_object('ok', false, 'mensaje', 'Monto inválido'); END IF;
  IF p_monto < v_ab THEN
    RETURN jsonb_build_object('ok', false, 'mensaje', 'El valor no puede ser menor a lo ya pagado (' || v_ab || ')'); END IF;
  v_saldo   := round(greatest(0, p_monto - v_ab), 2);
  v_vencida := (v_c.fecha_vencimiento IS NOT NULL AND v_c.fecha_vencimiento < CURRENT_DATE);
  v_estado  := CASE WHEN v_ab <= 0 AND v_vencida THEN 'EN_MORA'
                    WHEN v_ab <= 0 THEN 'NO_ABONADA'
                    WHEN v_saldo <= 0 THEN 'ABONADA'
                    ELSE 'PAGO_PARCIAL' END;
  UPDATE cobros SET monto_original=p_monto, monto_final=p_monto, saldo_pendiente=v_saldo,
     estado=v_estado::estado_cobro, no_aplica=false,
     exenta_mora=CASE WHEN v_vencida THEN true ELSE v_c.exenta_mora END, updated_at=now()
   WHERE cobro_id=p_cobro_id;
  RETURN jsonb_build_object('ok', true, 'estado', v_estado, 'saldo', v_saldo);
END;
$function$;

GRANT EXECUTE ON FUNCTION public.editar_valor_cuota(bigint, numeric, boolean) TO authenticated;
