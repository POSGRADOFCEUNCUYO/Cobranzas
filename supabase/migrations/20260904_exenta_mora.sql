-- Migración: exenta_mora
-- Fecha: 2026-09-04
--
-- Agrega una excepción manual de mora por cuota: si `cobros.exenta_mora = true`,
-- la función de mora NO le calcula intereses (la saltea). Sirve para casos donde
-- se decide no cobrarle intereses a una cuota puntual de una persona puntual.
--
-- Se agrega la condición `AND COALESCE(c.exenta_mora,false)=false` SOLO en las
-- partes 2 y 3 (las que calculan el monto de la mora). La parte 1 (corrección de
-- estado por recibo) se deja intacta, para que una cuota exenta que se pague igual
-- pueda pasar a ABONADA con normalidad.

ALTER TABLE public.cobros ADD COLUMN IF NOT EXISTS exenta_mora boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN public.cobros.exenta_mora IS 'Si true, la cuota queda exenta de mora (excepción manual). aplicar_mora_cohorte_impl la saltea en el cálculo de intereses.';

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

    -- Parte 2: SIN pago (monto_abonado = 0), vencida, sin recibo. Meses DESDE EL VENCIMIENTO.
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
           AND COALESCE(c.exenta_mora, false) = false
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
    -- UNA vez por mes (incremental): solo aplica los meses nuevos que falten.
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
           AND COALESCE(c.exenta_mora, false) = false
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
