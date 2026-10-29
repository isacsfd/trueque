#!/usr/bin/env python3
"""Verify the local institutional inventory import without writing data."""

from __future__ import annotations

import json
import os
import sys
from urllib.parse import urlparse

import psycopg

LOCAL_HOSTS = {"localhost", "127.0.0.1", "::1", "postgres"}
EXPECTED_DUPLICATES = [("La Celestina", 2), ("Las Mujeres del Quijote", 2)]


def main() -> int:
    url = os.environ.get("DATABASE_MIGRATION_URL")
    if not url:
        raise SystemExit("DATABASE_MIGRATION_URL is required.")
    host = (urlparse(url).hostname or "").lower()
    if host not in LOCAL_HOSTS:
        raise SystemExit(f"Refusing non-local database host: {host}")

    with psycopg.connect(url) as connection:
        with connection.cursor() as cursor:
            cursor.execute(
                "SELECT count(*) FROM public.copies WHERE inventory_code LIKE 'IUB-PAZ-%'"
            )
            copies = cursor.fetchone()[0]
            cursor.execute(
                "SELECT count(DISTINCT inventory_code) FROM public.copies WHERE inventory_code LIKE 'IUB-PAZ-%'"
            )
            distinct_copies = cursor.fetchone()[0]
            cursor.execute(
                """
                SELECT inventory_code, count(*)
                FROM public.copies
                WHERE inventory_code LIKE 'IUB-PAZ-%'
                GROUP BY inventory_code
                HAVING count(*) > 1
                ORDER BY inventory_code
                """
            )
            duplicate_codes = [(row[0], row[1]) for row in cursor.fetchall()]
            cursor.execute(
                """
                SELECT count(DISTINCT c.bibliographic_record_id)
                FROM public.copies c
                WHERE c.inventory_code LIKE 'IUB-PAZ-%'
                """
            )
            bibliographic = cursor.fetchone()[0]
            cursor.execute(
                "SELECT count(*) FROM public.available_catalog WHERE inventory_code LIKE 'IUB-PAZ-%'"
            )
            catalog = cursor.fetchone()[0]
            cursor.execute(
                """
                SELECT b.title, count(*)
                FROM public.copies c
                JOIN public.bibliographic_records b ON b.id = c.bibliographic_record_id
                WHERE c.inventory_code LIKE 'IUB-PAZ-%'
                GROUP BY b.title HAVING count(*) > 1 ORDER BY b.title
                """
            )
            duplicates = [(row[0], row[1]) for row in cursor.fetchall()]
            cursor.execute(
                """
                SELECT count(*) FROM public.copies
                WHERE inventory_code LIKE 'IUB-PAZ-%'
                  AND (provenance_type <> 'institutional'
                       OR location IS NULL
                       OR provenance_reference NOT LIKE 'inventory-import:%')
                """
            )
            invalid_copies = cursor.fetchone()[0]
            cursor.execute(
                """
                SELECT count(*) FROM public.copies
                WHERE inventory_code LIKE 'IUB-PAZ-%'
                  AND availability = 'unavailable'
                  AND verified_at IS NULL
                """
            )
            withheld_copies = cursor.fetchone()[0]
            cursor.execute(
                """
                SELECT count(*) FROM public.copies
                WHERE inventory_code LIKE 'IUB-PAZ-%'
                  AND verified_at IS NOT NULL
                """
            )
            verified_copies = cursor.fetchone()[0]
            cursor.execute(
                """
                SELECT count(*) FROM public.bibliographic_records b
                JOIN public.copies c ON c.bibliographic_record_id = b.id
                WHERE c.inventory_code LIKE 'IUB-PAZ-%'
                  AND (b.isbn IS NOT NULL OR b.isbn_normalized IS NOT NULL)
                """
            )
            isbn_rows = cursor.fetchone()[0]
            cursor.execute(
                """
                SELECT count(*) FROM public.inventory_movements m
                JOIN public.copies c ON c.id = m.copy_id
                WHERE c.inventory_code LIKE 'IUB-PAZ-%'
                """
            )
            movements = cursor.fetchone()[0]
            cursor.execute(
                """
                SELECT count(*) FROM public.exchange_requests r
                JOIN public.copies c ON c.id = r.requested_copy_id
                WHERE c.inventory_code LIKE 'IUB-PAZ-%'
                """
            )
            requests = cursor.fetchone()[0]
            cursor.execute(
                """
                SELECT status, count(*) FROM public.inventory_import_rows
                GROUP BY status ORDER BY status
                """
            )
            row_statuses = {row[0]: row[1] for row in cursor.fetchall()}
            cursor.execute(
                """
                SELECT total_rows, imported_rows, reused_rows, skipped_rows, rejected_rows
                FROM public.inventory_import_batches
                ORDER BY id DESC LIMIT 1
                """
            )
            batch = cursor.fetchone()

    summary = {
        "copies": copies,
        "distinct_copies": distinct_copies,
        "duplicate_codes": duplicate_codes,
        "bibliographic_records": bibliographic,
        "catalog": catalog,
        "duplicates": duplicates,
        "invalid_copies": invalid_copies,
        "withheld_copies": withheld_copies,
        "verified_copies": verified_copies,
        "isbn_rows": isbn_rows,
        "inventory_movements": movements,
        "persistent_requests": requests,
        "row_statuses": row_statuses,
        "latest_batch": {
            "total": batch[0],
            "imported": batch[1],
            "reused": batch[2],
            "skipped": batch[3],
            "rejected": batch[4],
        } if batch else None,
    }
    print(json.dumps(summary, ensure_ascii=False, indent=2))

    expected = (
        copies == 67
        and distinct_copies == 67
        and duplicate_codes == []
        and bibliographic == 65
        and catalog == 0
        and duplicates == EXPECTED_DUPLICATES
        and invalid_copies == 0
        and withheld_copies == 67
        and verified_copies == 0
        and isbn_rows == 0
        and movements == 0
        and requests == 0
        and row_statuses.get("imported", 0) + row_statuses.get("reused", 0) == 67
        and row_statuses.get("skipped", 0) == 70
        and row_statuses.get("rejected", 0) == 0
    )
    if not expected:
        print("Inventory verification failed.", file=sys.stderr)
        return 1
    print("Inventory verification passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
