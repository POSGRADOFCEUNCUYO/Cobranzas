-- Migración: egresos — comprobante único parcial para permitir "reparto"
-- Fecha: 2026-09-06
--
-- CONTEXTO
-- Un "reparto" es una única factura/pago que corresponde a varios programas o
-- cohortes a la vez. Antes no se podía cargar: la restricción UNIQUE(proveedor,
-- nro_comprobante) permitía ese comprobante una sola vez.
--
-- DISEÑO (bajo riesgo)
-- Un reparto = N egresos NORMALES (uno por programa/cohorte), cada uno con SU
-- parte del monto. La suma de las partes = el total real, así los reportes que
-- suman egresos siguen funcionando sin cambios (no hay fila "padre" con el total
-- que se sumaría de más). Las partes se agrupan reutilizando la columna ya
-- existente y hasta ahora sin uso `egreso_padre_id`:
--   * Parte PRINCIPAL: egreso_padre_id IS NULL (se ve como un egreso normal).
--   * Partes HIJAS:     egreso_padre_id = egreso_id de la principal.
--
-- CAMBIO
-- Se reemplaza la restricción UNIQUE(proveedor, nro_comprobante) por un índice
-- único PARCIAL que solo aplica a filas con egreso_padre_id IS NULL. Efecto:
--   * Egresos normales y la parte principal: el comprobante sigue siendo único
--     por proveedor (se mantiene el anti-duplicado por carga accidental).
--   * Partes hijas de un reparto: quedan exentas, por lo que pueden compartir el
--     mismo comprobante que su principal.
--
-- Verificado antes de aplicar: 0 pares (proveedor, nro_comprobante) repetidos en
-- los datos actuales, por lo que el cambio no afecta ningún registro existente.

ALTER TABLE public.egresos
    DROP CONSTRAINT IF EXISTS egresos_proveedor_nrocomprobante_unique;

CREATE UNIQUE INDEX IF NOT EXISTS egresos_proveedor_nrocomprobante_unique
    ON public.egresos (proveedor, nro_comprobante)
    WHERE egreso_padre_id IS NULL;
