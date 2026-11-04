-- Regla: toda cuota marcada NO_APLICA no debe nada → saldo y monto en CERO.
-- Fecha: 2026-11-04
--
-- Motivo: había cuotas marcadas "no aplica" que conservaban su monto_final / saldo_pendiente
-- del valor viejo (p. ej. una alumna dada de baja mostraba $1.000.000 de "saldo a la fecha"
-- aunque todas sus cuotas eran NO_APLICA). Se fija como REGLA permanente (trigger BEFORE):
-- cada vez que una cuota queda NO_APLICA, se normaliza el flag/estado y se ponen en 0 el
-- monto y el saldo. NO se toca monto_abonado (si hubo un pago real, no se borra).

-- 1) Función de la regla
CREATE OR REPLACE FUNCTION public.cobros_no_aplica_cero()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.no_aplica IS TRUE OR NEW.estado = 'NO_APLICA'::estado_cobro THEN
    NEW.no_aplica      := true;                         -- normaliza el flag
    NEW.estado         := 'NO_APLICA'::estado_cobro;    -- normaliza el estado
    NEW.monto_final    := 0;                            -- no se cobra
    NEW.saldo_pendiente:= 0;                            -- no debe nada
    -- monto_abonado se deja como está: no borramos un pago real.
  END IF;
  RETURN NEW;
END;
$function$;

-- 2) Trigger BEFORE INSERT/UPDATE (se aplica venga de donde venga el cambio)
DROP TRIGGER IF EXISTS trg_cobros_no_aplica_cero ON public.cobros;
CREATE TRIGGER trg_cobros_no_aplica_cero
  BEFORE INSERT OR UPDATE ON public.cobros
  FOR EACH ROW
  EXECUTE FUNCTION public.cobros_no_aplica_cero();

-- 3) Corrección de las cuotas NO_APLICA existentes que quedaron con saldo/monto cargado
UPDATE public.cobros
   SET monto_final = 0, saldo_pendiente = 0
 WHERE (no_aplica IS TRUE OR estado = 'NO_APLICA'::estado_cobro)
   AND (COALESCE(saldo_pendiente, 0) <> 0 OR COALESCE(monto_final, 0) <> 0);
