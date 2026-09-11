-- Readmisiones en el dashboard admin: contar ESTUDIANTES (COUNT DISTINCT dni),
-- no cuotas. total_readmisiones = alumnos con al menos una cuota de readmisión;
-- total_readmisiones_pendientes = alumnos que aún no cancelaron todas sus cuotas
-- de readmisión. El frontend muestra "X pagaron · Y pendientes"
-- (pagaron = total - pendientes).

CREATE OR REPLACE FUNCTION public.dashboard_stats_admin_impl()
 RETURNS json
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
WITH
coh_prog AS (
  SELECT cohorte_id, programa_id FROM cohortes
),
inscriptos AS (
  SELECT DISTINCT i.estudiante_id, e.dni, cp.programa_id,
         COALESCE(i.estado_academico::text, 'ACTIVO') AS estado_academico
  FROM inscripciones i
  JOIN coh_prog cp ON cp.cohorte_id = i.cohorte_id
  JOIN estudiantes e ON e.id = i.estudiante_id
),
activos AS (
  SELECT DISTINCT estudiante_id, dni, programa_id
  FROM inscriptos WHERE estado_academico = 'ACTIVO'
),
active_dnis AS (
  SELECT DISTINCT dni FROM activos
),
cobros_eff AS (
  SELECT
    c.cobro_id,
    c.dni,
    c.estado,
    c.comprobante_url,
    c.es_readmision,
    COALESCE(c.moneda, 'ARS')                                                    AS moneda,
    COALESCE(c.programa_id, cp.programa_id)                                      AS prog_id,
    CASE WHEN COALESCE(c.monto_abonado, 0) > 0
         THEN GREATEST(0, c.monto_abonado)
         ELSE GREATEST(0, COALESCE(c.monto_final, 0) - COALESCE(c.saldo_pendiente, 0))
    END                                                                          AS abonado,
    (c.estado = 'EN_MORA'
      OR (c.estado = 'NO_ABONADA'
          AND c.fecha_vencimiento < CURRENT_DATE
          AND c.comprobante_url IS NULL
          AND COALESCE(c.saldo_pendiente, c.monto_final, 0) > 0))                AS overdue_impaga,
    (c.dni IN (SELECT dni FROM active_dnis))                                     AS es_activo
  FROM cobros c
  LEFT JOIN coh_prog cp ON cp.cohorte_id = c.cohorte_id
),
egresos_eff AS (
  SELECT
    e.egreso_id,
    COALESCE(e.programa_id, cp.programa_id) AS prog_id,
    COALESCE(e.moneda, 'ARS')               AS moneda,
    COALESCE(e.monto_pagado, 0)             AS monto
  FROM egresos e
  LEFT JOIN coh_prog cp ON cp.cohorte_id = e.cohorte_id
  WHERE e.tipo::text = 'EJECUTADO'
),
cohortes_by_prog AS (
  SELECT programa_id, COUNT(DISTINCT cohorte_id) AS num_cohortes
  FROM cohortes
  GROUP BY programa_id
),
prog_cobros AS (
  SELECT
    prog_id,
    COUNT(DISTINCT CASE WHEN overdue_impaga AND es_activo THEN dni END)                                           AS en_mora,
    COUNT(CASE WHEN overdue_impaga AND es_activo THEN 1 END)                                                      AS cuotas_en_mora,
    COUNT(DISTINCT CASE WHEN estado IN ('EN_MORA','NO_ABONADA','PAGO_PARCIAL','PENDIENTE') AND es_activo THEN cobro_id END)     AS deuda_count,
    COUNT(DISTINCT CASE WHEN estado = 'PENDIENTE' AND comprobante_url IS NOT NULL THEN cobro_id END)              AS pend_cooperadora,
    COUNT(DISTINCT CASE WHEN comprobante_url IS NOT NULL THEN cobro_id END)                                        AS comprobantes,
    COALESCE(SUM(CASE WHEN moneda = 'ARS' THEN abonado ELSE 0 END), 0)                                            AS ingresos_ars,
    COALESCE(SUM(CASE WHEN moneda = 'USD' THEN abonado ELSE 0 END), 0)                                            AS ingresos_usd
  FROM cobros_eff
  GROUP BY prog_id
),
prog_egresos AS (
  SELECT prog_id,
         COALESCE(SUM(CASE WHEN moneda = 'ARS' THEN monto ELSE 0 END), 0) AS egresos_ars,
         COALESCE(SUM(CASE WHEN moneda = 'USD' THEN monto ELSE 0 END), 0) AS egresos_usd
  FROM egresos_eff
  GROUP BY prog_id
),
prog_inscriptos AS (
  SELECT programa_id,
         COUNT(DISTINCT estudiante_id)                                              AS estudiantes,
         COUNT(DISTINCT estudiante_id) FILTER (WHERE estado_academico = 'ACTIVO')   AS activos,
         COUNT(DISTINCT estudiante_id) FILTER (WHERE estado_academico <> 'ACTIVO')  AS bajas
  FROM inscriptos
  GROUP BY programa_id
),
prog_stats AS (
  SELECT
    p.programa_id,
    p.nombre,
    p.tipo::text                                                                                          AS tipo,
    p.estado::text                                                                                        AS estado,
    CASE WHEN p.tipo::text IN ('DOCTORADO','MAESTRIA','ESPECIALIZACION') THEN 'Programa' ELSE 'Curso' END AS categoria,
    COALESCE(pi2.activos, 0)                                                                              AS inscriptos,
    COALESCE(pi2.estudiantes, 0)                                                                          AS total_estudiantes,
    COALESCE(pi2.bajas, 0)                                                                                AS bajas,
    COALESCE(cbp.en_mora, 0)                                                                              AS en_mora,
    COALESCE(cbp.cuotas_en_mora, 0)                                                                       AS cuotas_en_mora,
    COALESCE(cbp.deuda_count, 0)                                                                          AS cuotas_pendientes,
    COALESCE(cbp.pend_cooperadora, 0)                                                                     AS pend_cooperadora,
    COALESCE(cbp.comprobantes, 0)                                                                         AS comprobantes,
    COALESCE(cbp.ingresos_ars, 0)                                                                         AS ingresos_ars,
    COALESCE(cbp.ingresos_usd, 0)                                                                         AS ingresos_usd,
    COALESCE(cbp.ingresos_ars, 0) + COALESCE(cbp.ingresos_usd, 0)                                        AS ingresos_estimados,
    COALESCE(peg.egresos_ars, 0)                                                                          AS egresos_ars,
    COALESCE(peg.egresos_usd, 0)                                                                          AS egresos_usd,
    COALESCE(cbp.ingresos_ars, 0) - COALESCE(peg.egresos_ars, 0)                                         AS saldo_neto_ars,
    COALESCE(cbp.ingresos_usd, 0) - COALESCE(peg.egresos_usd, 0)                                         AS saldo_neto_usd,
    COALESCE(cbpg.num_cohortes, 0)                                                                        AS num_cohortes
  FROM programas p
  LEFT JOIN prog_inscriptos   pi2  ON pi2.programa_id  = p.programa_id
  LEFT JOIN prog_cobros       cbp  ON cbp.prog_id       = p.programa_id
  LEFT JOIN prog_egresos      peg  ON peg.prog_id        = p.programa_id
  LEFT JOIN cohortes_by_prog  cbpg ON cbpg.programa_id  = p.programa_id
),
global_stats AS (
  SELECT
    (SELECT COUNT(*) FROM programas WHERE tipo::text IN ('DOCTORADO','MAESTRIA','ESPECIALIZACION'))              AS total_programas_posgrado,
    (SELECT COUNT(*) FROM programas WHERE tipo::text NOT IN ('DOCTORADO','MAESTRIA','ESPECIALIZACION'))          AS total_cursos,
    (SELECT COUNT(DISTINCT cohorte_id) FROM cohortes)                                                            AS total_cohortes,
    (SELECT COUNT(DISTINCT estudiante_id) FROM activos)                                                          AS total_inscriptos,
    (SELECT COUNT(DISTINCT estudiante_id) FROM inscriptos)                                                       AS total_estudiantes,
    (SELECT COUNT(DISTINCT estudiante_id) FROM inscriptos WHERE estado_academico <> 'ACTIVO')                    AS total_bajas,
    (SELECT COUNT(DISTINCT dni) FROM cobros_eff WHERE overdue_impaga AND es_activo)                              AS total_en_mora,
    (SELECT COUNT(*) FROM cobros_eff WHERE overdue_impaga AND es_activo)                                         AS total_cuotas_en_mora,
    (SELECT COALESCE(SUM(CASE WHEN moneda='ARS' THEN abonado ELSE 0 END),0) FROM cobros_eff)                    AS total_ingresos_ars,
    (SELECT COALESCE(SUM(CASE WHEN moneda='USD' THEN abonado ELSE 0 END),0) FROM cobros_eff)                    AS total_ingresos_usd,
    (SELECT COALESCE(SUM(CASE WHEN moneda='ARS' THEN monto ELSE 0 END), 0) FROM egresos_eff)                    AS total_egresos,
    (SELECT COALESCE(SUM(CASE WHEN moneda='USD' THEN monto ELSE 0 END), 0) FROM egresos_eff)                    AS total_egresos_usd,
    (SELECT COUNT(*) FROM cobros WHERE comprobante_url IS NOT NULL)                                              AS total_comprobantes,
    (SELECT COUNT(*) FROM cobros_eff WHERE estado IN ('EN_MORA','NO_ABONADA','PAGO_PARCIAL','PENDIENTE') AND es_activo)            AS total_cuotas_pendientes,
    (SELECT COUNT(DISTINCT dni) FROM cobros WHERE es_readmision = true)                                          AS total_readmisiones,
    (SELECT COUNT(DISTINCT dni) FROM cobros WHERE es_readmision = true AND estado NOT IN ('ABONADA','NO_APLICA')) AS total_readmisiones_pendientes
)
SELECT json_build_object(
  'totalProgramasPosgrado',       gs.total_programas_posgrado,
  'totalCursos',                   gs.total_cursos,
  'totalCohortes',                 gs.total_cohortes,
  'totalInscriptos',               gs.total_inscriptos,
  'totalEstudiantes',              gs.total_estudiantes,
  'totalBajas',                    gs.total_bajas,
  'totalEnMora',                   gs.total_en_mora,
  'totalCuotasEnMora',             gs.total_cuotas_en_mora,
  'totalIngresos',                 gs.total_ingresos_ars,
  'totalIngresosARS',              gs.total_ingresos_ars,
  'totalIngresosUSD',              gs.total_ingresos_usd,
  'totalEgresos',                  gs.total_egresos,
  'totalEgresosUSD',               gs.total_egresos_usd,
  'totalComprobantes',             gs.total_comprobantes,
  'totalCuotasPendientes',         gs.total_cuotas_pendientes,
  'saldoNeto',                     gs.total_ingresos_ars - gs.total_egresos,
  'saldoNetoUSD',                  gs.total_ingresos_usd - gs.total_egresos_usd,
  'totalReadmisiones',             gs.total_readmisiones,
  'totalReadmisionesPendientes',   gs.total_readmisiones_pendientes,
  'programas', (
    SELECT json_agg(
      json_build_object(
        'programa_id',       ps.programa_id,
        'nombre',            ps.nombre,
        'tipo',              ps.tipo,
        'estado',            ps.estado,
        'categoria',         ps.categoria,
        'inscriptos',        ps.inscriptos,
        'totalEstudiantes',  ps.total_estudiantes,
        'bajas',             ps.bajas,
        'enMora',            ps.en_mora,
        'cuotasEnMora',      ps.cuotas_en_mora,
        'cuotasPendientes',  ps.cuotas_pendientes,
        'pendCooperadora',   ps.pend_cooperadora,
        'comprobantes',      ps.comprobantes,
        'ingresosEstimados', ps.ingresos_estimados,
        'ingresosARS',       ps.ingresos_ars,
        'ingresosUSD',       ps.ingresos_usd,
        'egresosTotales',    ps.egresos_ars,
        'egresosUSD',        ps.egresos_usd,
        'saldoNeto',         ps.saldo_neto_ars,
        'saldoNetoUSD',      ps.saldo_neto_usd,
        'numCohortes',       ps.num_cohortes
      )
      ORDER BY ps.categoria, ps.nombre
    )
    FROM prog_stats ps
  )
)
FROM global_stats gs;
$function$;
