-- Migración: mora_parcial_incremental_desde_venc
-- Fecha: 2026-08-28
--
-- Corrige dos problemas en aplicar_mora_cohorte_impl:
--
-- 1) DOBLE APLICACIÓN DEL 5% EN PAGOS PARCIALES (Parte 3).
--    La versión anterior tomaba el saldo remanente (que ya incluía la mora del
--    mes) y le volvía a aplicar 5% dentro del mismo mes -> mora sobre mora.
--    Ej.: cuota 350.000 vencida, mora agosto -> 367.500; paga 350.000 -> debe
--    17.500; pero el sistema mostraba 17.500 x 1,05 = 18.375 (5% de más).
--    Ahora la Parte 3 es INCREMENTAL: aplica el 5% UNA sola vez por mes, sobre
--    el saldo remanente, y solo por los meses nuevos (m_mora > meses ya aplicados).
--    Un pago dentro del mismo mes solo baja el saldo, nunca dispara otro 5%.
--
-- 2) CONTEO DE MESES DESDE EL DÍA DE VENCIMIENTO (no desde el 1° del mes).
--    Las cuotas vencen el 15. El siguiente 5% debe caer el 15 del mes siguiente,
--    no el 1°. Se cuenta: apenas vencida = mes 1; +1 al cumplirse cada mes desde
--    el vencimiento (16/08 -> mes 1; 15/09 -> mes 2; 15/10 -> mes 3).
--
-- Regla unificada:
--   - SIN pago (Parte 2): interés compuesto desde monto_original (idempotente).
--   - CON pago parcial (Parte 3): 5% compuesto sobre el saldo remanente, una vez
--     por mes, incremental (path-dependiente pero sin duplicar).
--   - Con descuento: mes de gracia (primer mes sin 5%, ya perdió el descuento).

CREATE OR REPLACE FUNCTION public.aplicar_mora_cohorte_impl(p_cohorte_id bigint)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
    v_pct        numeric;
    v_afectados  integer := 0;
BEGIN
    SELECT COALESCE(NULLIF(valor, '')::numeric, 5) / 100.0
      INTO v_pct
      FROM configuracion
     WHERE clave = 'mora_porcentaje';
    IF v_pct IS NULL THEN
        v_pct := 0.05;
    END IF;

    -- Parte 1: Cobros CON recibo -- solo corregir estado, sin tocar saldo.
    -- Excluye EN_MORA proveniente de pago parcial (saldo_mora_base IS NOT NULL).
    WITH afectados AS (
        UPDATE cobros c
           SET estado = CASE WHEN COALESCE(c.saldo_pendiente, 0) <= 0
                             THEN 'ABONADA'::estado_cobro
                             ELSE 'PAGO_PARCIAL'::estado_cobro END
         WHERE c.cohorte_id = p_cohorte_id
           AND NOT public.es_baja_en_cohorte(c.dni, c.cohorte_id)
           AND c.recibo_url IS NOT NULL
           AND btrim(c.recibo_url) <> ''
           AND COALESCE(c.monto_final, 0) > 0
           AND c.fecha_vencimiento IS NOT NULL
           AND c.fecha_vencimiento < CURRENT_DATE
           AND COALESCE(c.no_aplica, false) = false
           AND c.estado NOT IN ('ABONADA','NO_APLICA','PENDIENTE','A_DEFINIR')
           AND NOT (c.estado = 'EN_MORA'
                    AND COALESCE(c.saldo_pendiente, 0) > 0
                    AND c.saldo_mora_base IS NOT NULL)
           AND c.estado <> CASE WHEN COALESCE(c.saldo_pendiente, 0) <= 0
                                THEN 'ABONADA'::estado_cobro
                                ELSE 'PAGO_PARCIAL'::estado_cobro END
        RETURNING 1
    )
    SELECT v_afectados + count(*) INTO v_afectados FROM afectados;

    -- Parte 2: SIN pago (monto_abonado = 0), vencida, sin recibo.
    -- Interés compuesto desde monto_original. Meses contados DESDE EL VENCIMIENTO.
    WITH calc AS (
        SELECT
            c.cobro_id,
            c.fecha_vencimiento,
            c.fecha_mora,
            ( (extract(year from CURRENT_DATE)::int*12 + extract(month from CURRENT_DATE)::int)
            - (extract(year from c.fecha_vencimiento)::int*12 + extract(month from c.fecha_vencimiento)::int)
            - (CASE WHEN extract(day from CURRENT_DATE) < extract(day from c.fecha_vencimiento) THEN 1 ELSE 0 END)
            + 1 )                                                     AS m_mora,
            COALESCE(NULLIF(c.monto_original, 0), c.monto_final, 0)    AS precio_base,
            (COALESCE(c.descuento_porcentaje, 0) > 0
             OR EXISTS (
                 SELECT 1
                   FROM inscripciones i
                   JOIN estudiantes e ON e.id = i.estudiante_id
                  WHERE i.cohorte_id = c.cohorte_id
                    AND e.dni = c.dni
                    AND COALESCE(i.descuento_porcentaje, 0) > 0
             ))                                                         AS con_descuento
          FROM cobros c
         WHERE c.cohorte_id = p_cohorte_id
           AND NOT public.es_baja_en_cohorte(c.dni, c.cohorte_id)
           AND (c.recibo_url IS NULL OR btrim(c.recibo_url) = '')
           AND COALESCE(c.monto_abonado, 0) = 0
           AND COALESCE(c.monto_final, 0) > 0
           AND c.fecha_vencimiento IS NOT NULL
           AND c.fecha_vencimiento < CURRENT_DATE
           AND COALESCE(c.no_aplica, false) = false
           AND c.estado NOT IN ('ABONADA','NO_APLICA','PENDIENTE','A_DEFINIR')
    ),
    nuevo AS (
        SELECT
            cobro_id, fecha_vencimiento, fecha_mora, m_mora,
            round(
                CASE
                    WHEN con_descuento THEN precio_base * power(1 + v_pct, greatest(m_mora - 1, 0))
                    ELSE                    precio_base * power(1 + v_pct, m_mora)
                END
            , 2) AS nuevo_saldo
          FROM calc
         WHERE precio_base > 0
    ),
    afectados2 AS (
        UPDATE cobros c
           SET estado          = 'EN_MORA'::estado_cobro,
               monto_final     = n.nuevo_saldo,
               saldo_pendiente = n.nuevo_saldo,
               meses_mora      = n.m_mora::integer,
               fecha_mora      = COALESCE(c.fecha_mora, c.fecha_vencimiento + 1),
               updated_at      = now()
          FROM nuevo n
         WHERE c.cobro_id = n.cobro_id
           AND (
                 abs(COALESCE(c.monto_final, 0)     - n.nuevo_saldo) > 0.01
              OR abs(COALESCE(c.saldo_pendiente, 0) - n.nuevo_saldo) > 0.01
              OR c.estado <> 'EN_MORA'::estado_cobro
               )
        RETURNING 1
    )
    SELECT v_afectados + count(*) INTO v_afectados FROM afectados2;

    -- Parte 3: CON pago parcial, vencida -- 5% compuesto sobre el saldo remanente,
    -- UNA vez por mes (incremental). Solo aplica los meses nuevos que falten
    -- (m_mora contado desde el vencimiento > meses_mora ya aplicados).
    WITH calc_parcial AS (
        SELECT
            c.cobro_id,
            ( (extract(year from CURRENT_DATE)::int*12 + extract(month from CURRENT_DATE)::int)
            - (extract(year from c.fecha_vencimiento)::int*12 + extract(month from c.fecha_vencimiento)::int)
            - (CASE WHEN extract(day from CURRENT_DATE) < extract(day from c.fecha_vencimiento) THEN 1 ELSE 0 END)
            + 1 )                                               AS m_mora,
            COALESCE(c.meses_mora, 0)                           AS m_aplicados,
            COALESCE(c.saldo_pendiente, 0)                      AS saldo_rem,
            COALESCE(c.monto_abonado, 0)                        AS abonado
          FROM cobros c
         WHERE c.cohorte_id = p_cohorte_id
           AND NOT public.es_baja_en_cohorte(c.dni, c.cohorte_id)
           AND COALESCE(c.monto_abonado, 0) > 0
           AND COALESCE(c.saldo_pendiente, 0) > 0
           AND COALESCE(c.monto_final, 0) > 0
           AND c.fecha_vencimiento IS NOT NULL
           AND c.fecha_vencimiento < CURRENT_DATE
           AND COALESCE(c.no_aplica, false) = false
           AND c.estado NOT IN ('ABONADA','NO_APLICA','PENDIENTE','A_DEFINIR')
    ),
    nuevo_parcial AS (
        SELECT
            cobro_id, m_mora, saldo_rem, abonado,
            round(saldo_rem * power(1 + v_pct, greatest(m_mora - m_aplicados, 0)), 2) AS nuevo_saldo
          FROM calc_parcial
         WHERE m_mora > m_aplicados
           AND saldo_rem > 0
    ),
    afectados3 AS (
        UPDATE cobros c
           SET estado          = 'EN_MORA'::estado_cobro,
               saldo_pendiente = n.nuevo_saldo,
               monto_final     = round(n.nuevo_saldo + n.abonado, 2),
               saldo_mora_base = COALESCE(c.saldo_mora_base, n.saldo_rem),
               meses_mora      = n.m_mora::integer,
               fecha_mora      = COALESCE(c.fecha_mora, c.fecha_vencimiento + 1),
               updated_at      = now()
          FROM nuevo_parcial n
         WHERE c.cobro_id = n.cobro_id
        RETURNING 1
    )
    SELECT v_afectados + count(*) INTO v_afectados FROM afectados3;

    RETURN v_afectados;
END;
$function$;
