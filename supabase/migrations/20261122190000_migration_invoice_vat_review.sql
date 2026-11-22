-- Confirm missing source VAT from the retained invoice, without touching bookkeeping.
-- pg-test: tests/pg/migration-invoice-vat-review.pg.test.ts
CREATE FUNCTION public.confirm_migration_invoice_vat(
  p_job_id uuid,p_record_id uuid,p_company_id uuid,p_user_id uuid,
  p_expected_updated_at timestamptz,p_vat numeric,p_rate integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=public AS $$
DECLARE j public.migration_jobs; c public.migration_job_chunks; i public.supplier_invoices; net numeric;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM company_members WHERE company_id=p_company_id AND user_id=p_user_id
    AND role IN ('owner','admin','member')) THEN RAISE EXCEPTION 'MIGRATION_WRITE_FORBIDDEN'; END IF;
  SELECT * INTO STRICT j FROM migration_jobs WHERE id=p_job_id AND company_id=p_company_id FOR UPDATE;
  IF j.state NOT IN ('completed','needs_attention') OR j.phase<>'completed' THEN RAISE EXCEPTION 'MIGRATION_REVIEW_BUSY'; END IF;
  SELECT * INTO STRICT c FROM migration_job_chunks WHERE id=p_record_id AND job_id=j.id AND company_id=p_company_id FOR UPDATE;
  IF c.resource<>'supplierInvoices' OR c.receipt->'warnings'->>'vatUnresolved' IS DISTINCT FROM 'true'
    THEN RAISE EXCEPTION 'MIGRATION_REVIEW_STALE'; END IF;
  SELECT * INTO STRICT i FROM supplier_invoices WHERE id=c.target_id AND company_id=p_company_id FOR UPDATE;
  IF p_expected_updated_at IS NULL OR i.updated_at IS DISTINCT FROM p_expected_updated_at THEN
    RAISE EXCEPTION 'MIGRATION_REVIEW_STALE'; END IF;
  -- An unattested, unpaid header only. No existing rows, booking or settlement is rewritten.
  IF i.status NOT IN ('registered','overdue') OR i.approved_at IS NOT NULL OR i.currency<>'SEK'
    OR COALESCE(i.is_credit_note,false) OR i.reverse_charge
    OR i.registration_journal_entry_id IS NOT NULL OR i.payment_journal_entry_id IS NOT NULL
    OR COALESCE(i.paid_amount,0)<>0 OR i.paid_at IS NOT NULL
    OR EXISTS(SELECT 1 FROM supplier_invoice_items WHERE supplier_invoice_id=i.id)
    OR EXISTS(SELECT 1 FROM supplier_invoice_payments WHERE supplier_invoice_id=i.id)
    OR EXISTS(SELECT 1 FROM supplier_invoice_attestations WHERE supplier_invoice_id=i.id)
    OR EXISTS(SELECT 1 FROM accrual_schedules WHERE supplier_invoice_id=i.id)
    OR EXISTS(SELECT 1 FROM supplier_payment_batch_items WHERE supplier_invoice_id=i.id)
    THEN RAISE EXCEPTION 'MIGRATION_REVIEW_BOOKED_CONFLICT'; END IF;
  IF p_vat IS NULL OR p_rate IS NULL OR p_rate NOT IN (6,12,25)
    OR p_vat::text IN ('NaN','Infinity','-Infinity') OR p_vat<>round(p_vat,2) OR p_vat<0 OR p_vat>=i.total
    THEN RAISE EXCEPTION 'MIGRATION_VAT_INVALID'; END IF;
  net:=i.total-p_vat;
  IF round(net*p_rate/100,2)<>p_vat THEN RAISE EXCEPTION 'MIGRATION_VAT_INVALID'; END IF;
  UPDATE supplier_invoices SET subtotal=net,subtotal_sek=net,vat_amount=p_vat,vat_amount_sek=p_vat,
    vat_treatment=CASE p_rate WHEN 25 THEN 'standard_25' WHEN 12 THEN 'reduced_12' ELSE 'reduced_6' END
    WHERE id=i.id;
  UPDATE migration_job_chunks SET receipt=jsonb_set(receipt,'{warnings,vatUnresolved}','false')||
    jsonb_build_object('vatReview',jsonb_build_object('by',p_user_id,'at',clock_timestamp(),
      'document_id',i.document_id,'source_id',c.source_id,'before',jsonb_build_object('subtotal',i.subtotal,'vat_amount',i.vat_amount,'vat_treatment',i.vat_treatment),
      'after',jsonb_build_object('subtotal',net,'vat_amount',p_vat,'rate',p_rate)))
    WHERE id=c.id;
  RETURN jsonb_build_object('invoiceId',i.id);
END $$;
REVOKE ALL ON FUNCTION public.confirm_migration_invoice_vat(uuid,uuid,uuid,uuid,timestamptz,numeric,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.confirm_migration_invoice_vat(uuid,uuid,uuid,uuid,timestamptz,numeric,integer) TO service_role;
NOTIFY pgrst,'reload schema';
