# Sivan's Studio 部署与运维方案

> 冻结版本：`main@64cc26d84b40a9759b2c84ff1651e134fd281473`  
> 冻结日期：2026-08-10  
> 目标环境：家庭 Debian 服务器（Docker）+ 阿里云公网入口（Nginx + frps 0.38.0）  
> 公网域名：`sivanstudio.markyan04.com`

## 1. 部署结论

本项目使用单容器部署。Node.js 同时提供静态前端和 API，业务数据保存在 SQLite，PDF、逐页图片及学生录音保存在本地文件系统。所有持久化数据统一挂载到宿主机的 `data/`。

```text
公网浏览器
  -> https://sivanstudio.markyan04.com
  -> 阿里云 Nginx :443
  -> 阿里云 frps HTTP vhost :7008
  -> 家庭 Debian frpc
  -> Docker host 网络
  -> Node.js 127.0.0.1:8766
  -> data/sivan-studio.db + data/pdfs/ + data/recordings/
```

现有 Node 服务固定监听 `127.0.0.1:8766`，所以 Compose 使用 Debian/Linux 的 `network_mode: host`。应用端口不会暴露到家庭局域网，也不需要在 Debian UFW 或阿里云安全组中开放 `8766`。

PDF 上传完成后接口立即返回 HTTP 202。PDF 渲染和 OCR 在家庭 Debian 服务器中由单并发后台队列执行；应用重启后会重新加载数据库中状态为 `processing` 的任务。

## 2. 仓库内的部署文件

- `Dockerfile`：Node.js 22、Python 虚拟环境以及 PDF/OCR 系统依赖。
- `.dockerignore`：避免把 Git、环境变量、现有数据和开发缓存发送到 Docker 构建上下文。
- `docker-compose.yml`：host 网络、持久化数据、健康检查和基础资源限制。
- `.env.production`：仅在服务器本地创建，不提交 Git。

容器默认限制为 2 个 CPU 和 4 GiB 内存，用来减少 OCR 对同机其他服务的影响。大型 PDF 经常失败时，可以在确认服务器资源充足后调整 `cpus` 和 `mem_limit`。

## 3. 首次部署

### 3.1 获取代码

```bash
sudo mkdir -p /srv/apps
sudo chown markyan04:markyan04 /srv/apps

cd /srv/apps
git clone https://github.com/u15sl22/Sivan-s-Studio.git sivan-studio
cd sivan-studio

git switch main
git pull --ff-only origin main
git rev-parse HEAD
```

首次按本文冻结版本部署时，最后一条命令应输出：

```text
64cc26d84b40a9759b2c84ff1651e134fd281473
```

### 3.2 创建生产环境变量

复制示例文件：

```bash
cp .env.example .env.production
chmod 600 .env.production
```

将 `.env.production` 修改为：

```dotenv
NODE_ENV=production
TZ=Asia/Shanghai
SIVAN_PORT=8766
SIVAN_PYTHON=/opt/venv/bin/python
SIVAN_PDF_TIMEOUT_SECONDS=900

SIVAN_TOKEN_SECRET=<长期固定的随机密钥>
SIVAN_TEACHER_USERNAME=sivan.teacher
SIVAN_TEACHER_PASSWORD=<至少12位的教师强密码>
```

可使用以下命令生成 token secret，然后把输出粘贴到文件中：

```bash
openssl rand -hex 32
```

`SIVAN_TOKEN_SECRET` 必须长期固定，否则应用重启后所有现有会话都会失效。教师用户名和密码只在空数据库首次启动时用于创建教师；数据库已有教师后，修改环境变量不会修改教师密码。

### 3.3 创建持久化目录并启动

Dockerfile 中的 `node` 用户 UID/GID 为 `1000:1000`，宿主机数据目录应允许该用户写入：

```bash
sudo install -d -o 1000 -g 1000 /srv/apps/sivan-studio/data

cd /srv/apps/sivan-studio
docker compose build --pull
docker compose up -d
```

如果 Debian 安装的是旧版 Compose，将本文中的 `docker compose` 替换为 `docker-compose`。

检查容器：

```bash
docker compose ps
docker compose logs --tail=100
curl -f http://127.0.0.1:8766/
```

## 4. Debian frpc 配置

在 `/usr/local/frp/frpc.ini` 中增加：

```ini
[sivanstudio.markyan04.com]
type = http
local_ip = 127.0.0.1
local_port = 8766
custom_domains = sivanstudio.markyan04.com
```

应用配置：

```bash
sudo systemctl restart frpc
sudo systemctl status frpc
sudo journalctl -u frpc -n 100 --no-pager
```

这是 FRP HTTP vhost 服务，不需要修改 frps 的 `allow_ports`，也不需要新增公网 TCP 端口。

## 5. 阿里云 Nginx 配置

### 5.1 登录限流

创建 `/etc/nginx/conf.d/sivan-rate-limit.conf`：

```nginx
limit_req_zone $binary_remote_addr zone=sivan_login:10m rate=30r/m;
```

### 5.2 域名站点

创建 `/etc/nginx/sites-available/sivanstudio.markyan04.com`：

```nginx
server {
    listen 80;
    server_name sivanstudio.markyan04.com;

    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name sivanstudio.markyan04.com;

    ssl_certificate /etc/nginx/ssl/markyan04.com/fullchain.pem;
    ssl_certificate_key /etc/nginx/ssl/markyan04.com/privkey.pem;

    client_max_body_size 128m;

    add_header X-Content-Type-Options nosniff always;
    add_header Referrer-Policy same-origin always;

    location ~ ^/api/auth/(student|teacher)/login$ {
        limit_req zone=sivan_login burst=10 nodelay;
        limit_req_status 429;

        proxy_pass http://127.0.0.1:7008;
        include snippets/proxy_common.conf;
    }

    location /api/ {
        proxy_pass http://127.0.0.1:7008;
        include snippets/proxy_common.conf;
    }

    # 当前 Node 静态服务器能够读取项目目录中的任意现存文件，
    # 公网入口只允许三个前端文件和根路径。
    location ~ ^/(?:index\.html|app\.js|styles\.css)?$ {
        proxy_pass http://127.0.0.1:7008;
        include snippets/proxy_common.conf;
    }

    location / {
        return 404;
    }
}
```

启用站点：

```bash
sudo ln -sf \
  /etc/nginx/sites-available/sivanstudio.markyan04.com \
  /etc/nginx/sites-enabled/sivanstudio.markyan04.com

sudo nginx -t
sudo systemctl reload nginx
```

通用反代片段必须保留原始 Host，供 frps 按域名分流：

```nginx
proxy_http_version 1.1;
proxy_set_header Host $host;
proxy_set_header X-Real-IP $remote_addr;
proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
proxy_set_header X-Forwarded-Proto $scheme;
proxy_set_header Upgrade $http_upgrade;
proxy_set_header Connection $connection_upgrade;
proxy_read_timeout 300s;
proxy_send_timeout 300s;
```

现有 `*.markyan04.com` 通配符 DNS 和通配符证书可以直接覆盖该域名。如果 wildcard DNS 尚未配置，则增加：

```text
sivanstudio.markyan04.com  A  <阿里云公网 IP>
```

## 6. 验收

家庭 Debian：

```bash
curl -I http://127.0.0.1:8766/
docker compose ps
docker compose logs --tail=100
docker stats sivan-studio
```

阿里云：

```bash
curl -I -H "Host: sivanstudio.markyan04.com" http://127.0.0.1:7008/
```

公网：

```bash
curl -I https://sivanstudio.markyan04.com/
```

浏览器验收步骤：

1. 教师登录。
2. 上传一个小型 PDF。
3. 确认上传接口很快返回，教师端显示 PDF/OCR 正在后台处理。
4. 等待状态变为 ready，然后分配班级。
5. 使用学生账号打开读物，测试麦克风录音、提交和回听。
6. OCR 处理中重启容器，确认任务恢复并最终完成。

## 7. 数据备份

必须备份整个 `data/`，不能只复制 `sivan-studio.db`。SQLite 使用 WAL，在线直接复制单个数据库文件可能产生不一致。

最稳妥的个人服务器备份方式：

```bash
cd /srv/apps/sivan-studio

docker compose stop
sudo tar -C /srv/apps/sivan-studio \
  -czf /srv/backups/sivan-studio-$(date +%F-%H%M%S).tar.gz \
  data
docker compose start
```

备份内容包含：

- SQLite 主文件、WAL 和 SHM 文件。
- 原始 PDF。
- PDF 逐页图片和 OCR manifest。
- 学生录音。

备份应加密并限制访问，因为其中包含学生数据。

## 8. 版本更新

更新前先按上一节备份，然后执行：

```bash
cd /srv/apps/sivan-studio

git status --short
git pull --ff-only origin main

docker compose build
docker compose up -d

docker compose ps
docker compose logs --tail=100
curl -f https://sivanstudio.markyan04.com/
```

构建新镜像时旧容器会继续运行；`docker compose up -d` 切换到新镜像时会产生短暂中断。中断时仍为 `processing` 的 PDF/OCR 任务会在新容器启动后恢复。

## 9. 回滚

先停止容器并记录现场，然后切换到已知可用的提交：

```bash
cd /srv/apps/sivan-studio
docker compose stop

git switch --detach <已知可用的提交ID或版本标签>
docker compose build
docker compose up -d
```

如果新版本改变过数据库结构或数据语义，还应恢复对应版本更新前的完整 `data/` 备份。完成排障后可用 `git switch main` 返回主分支。

## 10. 当前限制与安全边界

- 只能运行一个应用容器。SQLite 和进程内 PDF 队列都不适合多副本部署。
- `8766` 不得直接公开；它只允许 Debian 本机 frpc 访问。
- Nginx 必须使用本文的静态文件白名单，避免公开 `server.mjs`、`.env`、`data/` 和其他内部文件。
- `NODE_ENV=production` 必须设置，否则 Cookie 不会附带 `Secure`。
- Node 请求体限制为 120 MiB；PDF 以 Base64 包装，因此单个原始 PDF 的实际可用上限约为 90 MiB。
- OCR 仍在家庭 Debian 服务器消耗 CPU、内存和磁盘 I/O；阿里云主要负责 HTTPS、Nginx 和 FRP 流量转发。
- 当前健康检查使用 `/`，项目尚未提供独立的 `/healthz` 接口。
- 当前仓库自动检查只有 JavaScript 语法检查，生产更新后仍需执行一次登录、PDF 上传和录音回听的人工冒烟测试。
