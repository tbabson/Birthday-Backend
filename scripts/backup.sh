#!/usr/bin/env bash
#
# Nightly backup (§6.7). The contact list is irreplaceable user data — other
# people's birthdays cannot be reconstructed from anywhere else.
#
# Cron, on the host:
#   0 3 * * *  /path/to/scripts/backup.sh >> /var/log/birthday-backup.log 2>&1
#
# A backup you have never restored is a hypothesis, not a backup. Test it:
#   gunzip -c backups/birthday-YYYY-MM-DD.sql.gz | psql "$RESTORE_TARGET_URL"

set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-./backups}"
RETENTION_DAYS="${RETENTION_DAYS:-30}"
CONTAINER="${POSTGRES_CONTAINER:-birthdaybackend-postgres-1}"
DB_USER="${POSTGRES_USER:-birthday}"
DB_NAME="${POSTGRES_DB:-birthday}"

timestamp="$(date +%F)"
target="${BACKUP_DIR}/birthday-${timestamp}.sql.gz"

mkdir -p "${BACKUP_DIR}"

echo "[$(date -Is)] dumping ${DB_NAME} -> ${target}"

# Written to a temp file first, then moved into place: a half-finished dump
# that shares the final name is worse than no dump, because it looks like one.
tmp="${target}.partial"
docker exec "${CONTAINER}" pg_dump -U "${DB_USER}" -d "${DB_NAME}" --clean --if-exists \
  | gzip -9 > "${tmp}"

if [ ! -s "${tmp}" ]; then
  echo "[$(date -Is)] ERROR: dump is empty, refusing to keep it" >&2
  rm -f "${tmp}"
  exit 1
fi

mv "${tmp}" "${target}"
echo "[$(date -Is)] wrote $(du -h "${target}" | cut -f1)"

deleted=$(find "${BACKUP_DIR}" -name 'birthday-*.sql.gz' -mtime "+${RETENTION_DAYS}" -print -delete | wc -l)
echo "[$(date -Is)] pruned ${deleted} backup(s) older than ${RETENTION_DAYS} days"
