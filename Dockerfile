FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    TZ=Asia/Shanghai \
    DATA_DIR=/data \
    PORT=80

WORKDIR /app

# 依赖层单独缓存；如镜像源不可用可改为官方源
COPY requirements.txt .
RUN pip install --no-cache-dir -i https://mirrors.aliyun.com/pypi/simple/ -r requirements.txt

COPY app.py .
COPY static ./static
# 仅作为首次部署的初始数据，由入口脚本在 CFS 中不存在数据库时复制
COPY data ./seed-data

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh \
    && mkdir -p /data/uploads

EXPOSE 80

ENTRYPOINT ["docker-entrypoint.sh"]
