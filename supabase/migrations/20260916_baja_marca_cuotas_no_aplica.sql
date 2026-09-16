-- Al dar de baja a un estudiante en una cohorte, marcar "No aplica" sus cuotas
-- IMPAGAS pendientes (No abonada, En mora, A definir), para que no sigan generando
-- mora ni deuda. NO toca Abonada, Pago parcial ni Pendiente (comprobante en revisión).
-- Al dar de alta NO se revierte automáticamente: lo reactiva el administrador a mano.
--
-- Motivo: el cálculo de mora (resolverEstadoCobro) es por cuota (venció + impaga) y
-- no mira el estado del estudiante, por lo que a un dado de baja se le seguía
-- aplicando mora. Este trigger corta esa deuda al momento de la baja.

CREATE OR REPLACE FUNCTION public.baja_marca_cuotas_no_aplica()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.estado_academico = 'BAJA'
     AND (OLD.estado_academico IS DISTINCT FROM 'BAJA') THEN
    UPDATE cobros
       SET no_aplica = true, estado = 'NO_APLICA'
     WHERE estudiante_id = NEW.estudiante_id
       AND cohorte_id   = NEW.cohorte_id
       AND no_aplica    = false
       AND estado IN ('NO_ABONADA','EN_MORA','A_DEFINIR')
       AND COALESCE(monto_abonado, 0) <= 0;
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_baja_cuotas_no_aplica ON public.inscripciones;
CREATE TRIGGER trg_baja_cuotas_no_aplica
  AFTER UPDATE OF estado_academico ON public.inscripciones
  FOR EACH ROW
  EXECUTE FUNCTION public.baja_marca_cuotas_no_aplica();

-- Backfill: aplicar el mismo criterio a los estudiantes que YA estaban de baja
-- (91 cuotas / 8 estudiantes al momento de aplicar).
UPDATE cobros c
   SET no_aplica = true, estado = 'NO_APLICA'
  FROM inscripciones i
  JOIN estudiantes e ON e.id = i.estudiante_id
 WHERE i.estado_academico = 'BAJA'
   AND c.dni = e.dni
   AND c.cohorte_id = i.cohorte_id
   AND c.no_aplica = false
   AND c.estado IN ('NO_ABONADA','EN_MORA','A_DEFINIR')
   AND COALESCE(c.monto_abonado, 0) <= 0;
