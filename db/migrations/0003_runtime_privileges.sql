-- Third versioned migration. The three NOINHERIT/NO CREATEROLE roles must
-- already exist; role creation/password provisioning is an operator task.
-- This file creates no roles and contains no credentials.

REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;

REVOKE ALL ON ALL TABLES IN SCHEMA public FROM iub_public_runtime, iub_admin_runtime;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM iub_public_runtime, iub_admin_runtime;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM iub_public_runtime, iub_admin_runtime;

GRANT USAGE ON SCHEMA public TO iub_public_runtime, iub_admin_runtime;

-- Anonymous-facing Functions can read only the filtered catalogue and reserve
-- using a per-request opaque proof. They cannot write tables directly.
GRANT SELECT ON public.available_catalog TO iub_public_runtime;
GRANT EXECUTE ON FUNCTION public.reserve_copy(BIGINT, BIGINT, BYTEA, UUID) TO iub_public_runtime;

-- Administrative Functions can read operational records; mutations use
-- SECURITY DEFINER routines with fixed search_path and permission checks.
-- No direct INSERT/UPDATE/DELETE on state, inventory, history or audit tables.
GRANT SELECT ON public.app_users, public.roles, public.permissions, public.user_roles,
  public.role_permissions,
  public.privacy_notices, public.privacy_consents, public.publishers, public.genres,
  public.privacy_consent_events,
  public.bibliographic_records, public.copies, public.exchange_requests,
  public.offered_books, public.book_images, public.receptions,
  public.reception_custody_events, public.book_evaluations, public.cataloging_records,
  public.ownership_transfers, public.inventory_admissions, public.reservations,
  public.exchanges, public.deliveries, public.inventory_movements,
  public.state_history, public.audit_events TO iub_admin_runtime;

GRANT EXECUTE ON FUNCTION public.set_request_status(BIGINT, TEXT, BIGINT, TEXT) TO iub_admin_runtime;
GRANT EXECUTE ON FUNCTION public.get_participant_contact(BIGINT, BIGINT) TO iub_admin_runtime;
GRANT EXECUTE ON FUNCTION public.withdraw_privacy_consent(BIGINT, BIGINT, BYTEA, UUID) TO iub_admin_runtime;
GRANT EXECUTE ON FUNCTION public.set_reservation_policy(INTEGER, BIGINT) TO iub_admin_runtime;
GRANT EXECUTE ON FUNCTION public.expire_reservations(BIGINT, INTEGER) TO iub_admin_runtime;
GRANT EXECUTE ON FUNCTION public.plan_exchange(BIGINT, TEXT, UUID, BIGINT) TO iub_admin_runtime;
GRANT EXECUTE ON FUNCTION public.schedule_delivery(BIGINT, TEXT, TIMESTAMPTZ, UUID, BIGINT) TO iub_admin_runtime;
GRANT EXECUTE ON FUNCTION public.confirm_delivery(BIGINT, BIGINT, TEXT, TEXT, UUID) TO iub_admin_runtime;
GRANT EXECUTE ON FUNCTION public.place_reception_in_custody(BIGINT, BIGINT, TEXT, TEXT, TEXT, UUID) TO iub_admin_runtime;
GRANT EXECUTE ON FUNCTION public.evaluate_reception(BIGINT, BIGINT, TEXT, TEXT, TEXT, UUID, TEXT) TO iub_admin_runtime;
GRANT EXECUTE ON FUNCTION public.request_reception_return(BIGINT, BIGINT, TEXT) TO iub_admin_runtime;
GRANT EXECUTE ON FUNCTION public.record_cataloging_validation(BIGINT, BIGINT, BIGINT, UUID) TO iub_admin_runtime;
GRANT EXECUTE ON FUNCTION public.authorize_cataloging(BIGINT, BIGINT, UUID) TO iub_admin_runtime;
GRANT EXECUTE ON FUNCTION public.authorize_inventory_admission(BIGINT, BIGINT, UUID) TO iub_admin_runtime;
GRANT EXECUTE ON FUNCTION public.admit_received_book(BIGINT, TEXT, TEXT, BIGINT) TO iub_admin_runtime;
GRANT EXECUTE ON FUNCTION public.enable_received_copy(BIGINT, BIGINT) TO iub_admin_runtime;
GRANT EXECUTE ON FUNCTION public.start_exchange(BIGINT, BIGINT) TO iub_admin_runtime;
GRANT EXECUTE ON FUNCTION public.complete_exchange(BIGINT, UUID, BIGINT) TO iub_admin_runtime;
GRANT EXECUTE ON FUNCTION public.cancel_exchange(BIGINT, UUID, BIGINT, TEXT) TO iub_admin_runtime;

-- New objects created by the single migration owner remain inaccessible until
-- an explicit, reviewed grant is added here for that object.
ALTER DEFAULT PRIVILEGES FOR ROLE iub_schema_migrator IN SCHEMA public
  REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE iub_schema_migrator IN SCHEMA public
  REVOKE ALL ON SEQUENCES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE iub_schema_migrator
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
