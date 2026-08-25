-- Mora por MES CALENDARIO (antes: fracción días/30).
-- Nueva regla pedida por Anneris:
--   * Apenas la cuota está vencida (aunque sea 1 día) ya cuenta como mes 1 de mora.
--   * Al entrar cada mes calendario siguiente, suma +1 mes.
--   M = (año_hoy*12 + mes_hoy) - (año_venc*12 + mes_venc) + 1
-- Interés 5% compuesto (config 'mora_porcentaje') sobre la base = monto_original (sin el
-- descuento por pago en término):
--   * Sin descuento:  saldo = base * 1,05^M
--   * Con descuento:  saldo = base * 1,05^(M-1)  (el 1er mes solo pierde el descuento, sin interés)
-- Aplica igual en cuota impaga (Parte 2) y en pago parcial vencido (Parte 3, sobre el saldo restante).

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

    -- Parte 2: Cobros SIN recibo y SIN pago parcial -- interes compuesto desde monto_original.
    -- Mora por MES CALENDARIO: apenas vencida (aunque sea 1 dia) = mes 1; +1 por cada mes calendario.
    WITH calc AS (
        SELECT
            c.cobro_id,
            c.fecha_vencimiento,
            c.fecha_mora,
            ( (extract(year from CURRENT_DATE)::int*12 + extract(month from CURRENT_DATE)::int)
            - (extract(year from c.fecha_vencimiento)::int*12 + extract(month from c.fecha_vencimiento)::int)
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

    -- Parte 3: PAGO PARCIAL vencido (con o SIN recibo) -- interes sobre el saldo restante.
    WITH calc_parcial AS (
        SELECT
            c.cobro_id,
            ( (extract(year from CURRENT_DATE)::int*12 + extract(month from CURRENT_DATE)::int)
            - (extract(year from c.fecha_vencimiento)::int*12 + extract(month from c.fecha_vencimiento)::int)
            + 1 )                                               AS m_mora,
            c.saldo_mora_base IS NULL                            AS es_primera_mora,
            COALESCE(
                c.saldo_mora_base,
                round(
                    COALESCE(NULLIF(c.monto_original,0), c.monto_final, 0)
                    * ( (COALESCE(NULLIF(c.monto_original,0), c.monto_final,0) * (1 - COALESCE(c.descuento_porcentaje,0)/100.0)) - COALESCE(c.monto_abonado,0) )
                    / NULLIF( COALESCE(NULLIF(c.monto_original,0), c.monto_final,0) * (1 - COALESCE(c.descuento_porcentaje,0)/100.0), 0)
                , 2)
            )                                                    AS precio_base_rem,
            (COALESCE(c.descuento_porcentaje, 0) > 0
             OR EXISTS (
                 SELECT 1 FROM inscripciones i
                 JOIN estudiantes e ON e.id = i.estudiante_id
                 WHERE i.cohorte_id = c.cohorte_id AND e.dni = c.dni
                   AND COALESCE(i.descuento_porcentaje, 0) > 0
             ))                                                  AS con_descuento
        FROM cobros c
        WHERE c.cohorte_id = p_cohorte_id
          AND NOT public.es_baja_en_cohorte(c.dni, c.cohorte_id)
          AND COALESCE(c.monto_abonado, 0) > 0
          AND COALESCE(c.monto_final, 0) > 0
          AND c.fecha_vencimiento IS NOT NULL
          AND c.fecha_vencimiento < CURRENT_DATE
          AND COALESCE(c.no_aplica, false) = false
          AND c.estado NOT IN ('ABONADA','NO_APLICA','PENDIENTE','A_DEFINIR')
    ),
    nuevo_parcial AS (
        SELECT
            cobro_id, es_primera_mora, precio_base_rem, m_mora,
            round(
                CASE
                    WHEN con_descuento THEN precio_base_rem * power(1 + v_pct, greatest(m_mora - 1, 0))
                    ELSE                    precio_base_rem * power(1 + v_pct, m_mora)
                END
            , 2) AS nuevo_saldo
        FROM calc_parcial
        WHERE precio_base_rem > 0
    ),
    afectados3 AS (
        UPDATE cobros c
           SET estado          = 'EN_MORA'::estado_cobro,
               saldo_pendiente = n.nuevo_saldo,
               monto_final     = n.nuevo_saldo,
               saldo_mora_base = CASE WHEN n.es_primera_mora THEN n.precio_base_rem
                                      ELSE c.saldo_mora_base END,
               meses_mora      = n.m_mora::integer,
               fecha_mora      = COALESCE(c.fecha_mora, c.fecha_vencimiento + 1),
               updated_at      = now()
          FROM nuevo_parcial n
         WHERE c.cobro_id = n.cobro_id
           AND (
                 abs(COALESCE(c.saldo_pendiente, 0) - n.nuevo_saldo) > 0.01
              OR c.estado <> 'EN_MORA'::estado_cobro
               )
        RETURNING 1
    )
    SELECT v_afectados + count(*) INTO v_afectados FROM afectados3;

    RETURN v_afectados;
END;
$function$;
