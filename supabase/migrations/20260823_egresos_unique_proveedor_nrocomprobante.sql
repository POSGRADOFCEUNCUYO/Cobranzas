-- Egresos: cambiar la regla de unicidad.
-- Antes: UNIQUE (programa_id, cohorte_id, concepto) — demasiado estricta, bloqueaba
-- conceptos legítimamente repetidos (ej. varios jurados en una misma defensa, o el mismo
-- concepto para proveedores/facturas distintas).
-- Ahora: UNIQUE (proveedor, nro_comprobante) — no se puede cargar dos veces la misma
-- factura del mismo proveedor; el resto (concepto incluido) puede repetirse.
-- Nada del sistema dependía de la restricción anterior (no hay ON CONFLICT sobre concepto).

alter table public.egresos drop constraint if exists egresos_programa_cohorte_concepto_unique;
alter table public.egresos add constraint egresos_proveedor_nrocomprobante_unique unique (proveedor, nro_comprobante);
