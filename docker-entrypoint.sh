#!/bin/sh
set -e

DATA_DIR="${DATA_DIR:-/data}"
UPLOAD_DIR="${UPLOAD_DIR:-$DATA_DIR/uploads}"
DB_FILE="${DB_PATH:-$DATA_DIR/family.db}"

mkdir -p "$DATA_DIR" "$UPLOAD_DIR"

# 首次部署：把镜像内的初始数据库放到持久化目录，之后重启不会覆盖
if [ ! -f "$DB_FILE" ] && [ -f /app/seed-data/family.db ]; then
  echo "初始化数据库: $DB_FILE"
  cp /app/seed-data/family.db "$DB_FILE"
fi

# 首次部署：迁移已有照片（上传目录为空时才复制）
if [ -d /app/static/uploads ] && [ -z "$(ls -A "$UPLOAD_DIR" 2>/dev/null)" ]; then
  echo "初始化上传文件: $UPLOAD_DIR"
  cp -a /app/static/uploads/. "$UPLOAD_DIR"/
fi

# SQLite 单文件，固定单 worker 多线程，避免多进程写锁冲突
exec gunicorn \
  --workers "${WORKERS:-1}" \
  --threads "${THREADS:-8}" \
  --timeout "${TIMEOUT:-120}" \
  --bind "0.0.0.0:${PORT:-80}" \
  --access-logfile - \
  --error-logfile - \
  app:app
