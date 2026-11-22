-- pg-test: tests/pg/sie-resync-gap-metadata.pg.test.ts

-- Read-only, tenant-scoped source comparison. Posted content remains immutable.
CREATE OR REPLACE FUNCTION public.classify_sie_resync_entries(p_company_id uuid,p_period_id uuid,p_entries jsonb)
RETURNS TABLE(source_ordinal integer,outcome text,entry_id uuid)
LANGUAGE plpgsql SECURITY INVOKER SET search_path=public AS $$
DECLARE e jsonb; ids uuid[]; original public.journal_entries; matches integer;
BEGIN
  IF jsonb_typeof(p_entries)<>'array' OR jsonb_array_length(p_entries)>200
    OR octet_length(p_entries::text)>2000000 THEN RAISE EXCEPTION 'SIE comparison too large'; END IF;
  IF NOT EXISTS(SELECT 1 FROM fiscal_periods WHERE id=p_period_id AND company_id=p_company_id) THEN
    RAISE EXCEPTION 'SIE comparison period unavailable' USING ERRCODE='42501'; END IF;
  FOR e IN SELECT value FROM jsonb_array_elements(p_entries) LOOP
    source_ordinal:=(e->>'sourceOrdinal')::integer; entry_id:=NULL;
    IF NULLIF(e->>'sourceSeries','') IS NULL OR e->>'sourceNumber' IS NULL THEN
      outcome:='unidentified'; RETURN NEXT; CONTINUE; END IF;
    SELECT array_agg(j.id) INTO ids FROM journal_entries j WHERE j.company_id=p_company_id AND j.fiscal_period_id=p_period_id
      AND j.source_type IN ('import','opening_balance') AND j.status='posted' AND j.reversed_by_id IS NULL
      AND j.source_voucher_series=e->>'sourceSeries' AND j.source_voucher_number=(e->>'sourceNumber')::integer;
    matches:=COALESCE(cardinality(ids),0);
    IF matches>1 THEN outcome:='ambiguous'; RETURN NEXT; CONTINUE; END IF;
    IF matches=0 THEN
      SELECT j.id INTO entry_id FROM journal_entries j WHERE j.company_id=p_company_id AND j.fiscal_period_id=p_period_id
        AND j.source_type IN ('import','opening_balance') AND j.source_voucher_series=e->>'sourceSeries'
        AND j.source_voucher_number=(e->>'sourceNumber')::integer ORDER BY j.created_at DESC,j.id LIMIT 1;
      outcome:=CASE WHEN entry_id IS NULL THEN 'new' ELSE 'changed' END; RETURN NEXT; CONTINUE;
    END IF;
    SELECT * INTO original FROM journal_entries WHERE id=ids[1] AND company_id=p_company_id;
    entry_id:=original.id;
    outcome:=CASE WHEN original.source_content_hash=encode(extensions.digest((e-'sieImportId'-'sourceOrdinal')::text,'sha256'),'hex')
      -- Older imports did not carry generated number-gap documentation.
      -- Every other prepared field must still match the stored source hash.
      OR (e ? 'numberGap' AND original.source_content_hash=encode(
        extensions.digest((e-'sieImportId'-'sourceOrdinal'-'numberGap')::text,'sha256'),'hex'))
      THEN 'unchanged' ELSE 'changed' END;
    RETURN NEXT;
  END LOOP;
END $$;
REVOKE ALL ON FUNCTION public.classify_sie_resync_entries(uuid,uuid,jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.classify_sie_resync_entries(uuid,uuid,jsonb) TO authenticated,service_role;

NOTIFY pgrst,'reload schema';
