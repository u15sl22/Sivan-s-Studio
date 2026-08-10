# Sivan’s Studio 后端、身份验证与数据架构

本文描述当前代码已经实现的架构，不是未来设想。当前系统使用 Node.js + SQLite + 本地文件存储，适合一台服务器运行的现阶段部署方式。

## 1. 选型结论

本阶段保留 SQLite，不迁移 PostgreSQL。

原因：应用目前只部署在一台主机，数据模型和所有现有数据都已在 SQLite 中；SQLite 的 WAL 模式足以承担当前教师、学生和约 200 份读物的规模。此时迁移 PostgreSQL 需要增加数据库服务、连接池、迁移工具、备份流程和运维成本，但不会直接改善主要功能。

在出现以下情况时再考虑 PostgreSQL：需要多台应用服务器同时写入、并发写入量明显增加、需要托管数据库的高可用能力，或需要复杂分析查询。届时应通过正式迁移脚本转换，不能只修改文档或连接字符串。

## 2. 当前部署结构

```text
浏览器（教师 / 学生）
        │ HTTP + HttpOnly Cookie
        ▼
Node.js 服务（默认 127.0.0.1:8766）
        ├── SQLite：data/sivan-studio.db
        ├── PDF 与页面图片：data/pdfs/
        ├── 学生录音：data/recordings/
        └── Python PDF 渲染/OCR 后台任务
```

生产环境应在 Node 服务前放置 Caddy 或 Nginx，由反向代理提供 HTTPS，并仅向外开放 80/443。Node 端口通过 `SIVAN_PORT` 配置，默认值和示例值均为 `8766`。

## 3. 身份验证与权限

系统只有两种身份：`teacher` 和 `student`。

- 教师使用用户名和密码登录。空数据库首次启动时由 `SIVAN_TEACHER_USERNAME` 和 `SIVAN_TEACHER_PASSWORD` 创建唯一教师账户。
- 学生使用姓名和教师设置的 code 登录。学生没有修改 code 的接口。
- 密码和 code 使用带随机盐的 scrypt 哈希保存，不保存明文。
- 登录后服务端签发 HMAC-SHA256 签名令牌，并写入 HttpOnly、SameSite=Lax Cookie。
- 令牌有效期为 30 分钟。用户状态或 `token_version` 不匹配时，会话立即失效。
- 教师删除学生后该学生记录不再可用，旧会话也不能继续调用学生接口。
- 所有 API 在后端校验角色。学生查询文章时还会校验学生仍为 active、文章已分配到该生班级且 PDF 状态为 ready。

部署时必须提供长期固定且足够随机的 `SIVAN_TOKEN_SECRET`。如果每次启动都随机生成，服务重启会使所有现有会话失效。

## 4. SQLite 数据结构

数据库启用 `foreign_keys = ON` 和 WAL 日志模式。

| 表 | 作用 | 主要关系 |
|---|---|---|
| `teachers` | 唯一教师账户、密码哈希、状态、令牌版本 | 独立账户 |
| `classes` | 班级 | 被学生与文章分配引用 |
| `students` | 学生姓名、班级、code 哈希、状态 | `class_id → classes` |
| `articles` | 读物、源 PDF 路径、书单、页数、处理状态 | 被页面、分配和提交引用 |
| `article_pages` | 每页图片路径及 OCR 文字 | `article_id → articles`，删除文章时级联删除 |
| `article_assignments` | 读物可供哪些班级选择 | 文章与班级的多对多关系 |
| `submissions` | 一次完整阅读的真实分数和错词统计 | 关联学生和文章 |
| `sentence_attempts` | 每句目标文本、转写、录音路径及错词 | `submission_id → submissions` |
| `attendance_daily` | 学生某个业务日期完成的阅读 | `(student_id, read_date)` 唯一 |

`articles.processing_status` 的合法业务状态为：

- `processing`：PDF 已安全写入磁盘，等待或正在渲染/OCR。
- `ready`：页面和文字已写入数据库，可以分配和阅读。
- `failed`：后台任务失败，保留源 PDF，可由教师重试或删除。

## 5. PDF 上传与异步 OCR

上传请求只完成以下快速步骤：校验 PDF、写入 `data/pdfs/<article-id>/source.pdf`、插入状态为 `processing` 的文章记录、加入内存队列，然后返回 HTTP 202。

后台 worker 单并发处理队列，避免一次批量上传大量文件时同时启动多个 OCR 进程耗尽内存。每个任务执行：

1. Python 将 PDF 每页渲染为图片。
2. 优先提取 PDF 自带文本；没有文本层时执行 OCR。
3. 生成页面清单。
4. SQLite 事务一次性替换该文章的页面记录。
5. 成功后改为 `ready`，失败后改为 `failed` 并记录错误摘要。

Python 子进程的单任务上限仍是 180 秒，但它不再占用上传 HTTP 请求。Node 服务启动时会重新查询所有 `processing` 文章并加入队列，因此应用重启不会永久遗失待处理任务。教师端每 2.5 秒轮询处理状态，并提供失败重试按钮。

这是单进程、单服务器方案。将来若运行多个 Node 实例，应改为带任务锁的持久队列（如 PostgreSQL job table、BullMQ/Redis 或托管任务队列），防止同一 PDF 被重复处理。

## 6. 上海业务日期

打卡不是按 UTC，也不是依赖服务器本地时区。后端使用 `Intl.DateTimeFormat` 并显式指定 `Asia/Shanghai` 生成 `YYYY-MM-DD`；学生首页、提交打卡、当天录音和教师每日完成情况都使用同一函数。

前端日历和月/年统计也显式以 `Asia/Shanghai` 取得当前年、月、日。因此上海时间 00:00–07:59 不会再被计入 UTC 的前一天。

## 7. 成绩与录音

- `submissions.score` 永远保存真实成绩，规则为 `10 × (1 - 错词数 / 总词数)`。
- 教师端读取真实成绩。
- 学生 API 输出时应用展示下限：低于 7.5 显示 7.5，高于 7.5 原样显示。
- 每句录音保存到 `data/recordings/`，数据库只保存相对路径。
- 发音准确度当前基于浏览器转写文本与目标词序列的对齐，不是音素级发音评分。

## 8. 数据存储与备份

SQLite 只保存结构化数据和文件相对路径，大文件不写入数据库 BLOB。整个 `data/` 都不进入 Git。

最安全的迁移和备份方式是先停止 Node 服务，再整体复制 `data/`。在线备份时必须使用 SQLite 官方备份方法，或同时正确处理 `.db`、`-wal` 和 `-shm` 文件，不能只复制主 `.db` 文件。恢复后还要检查数据库记录中的相对路径是否存在。

建议至少保留：每日增量备份、每周完整备份和定期恢复演练。录音和 PDF 属于学生数据，备份应加密并限制访问。

## 9. 配置与部署检查

生产启动至少配置：

```text
SIVAN_PORT=8766
SIVAN_TOKEN_SECRET=<长期随机密钥>
SIVAN_TEACHER_USERNAME=<教师用户名，仅首次建库使用>
SIVAN_TEACHER_PASSWORD=<至少 12 位，仅首次建库使用>
SIVAN_PYTHON=<可选，Python 绝对路径>
```

部署前应确认：

- Node.js 版本不低于 22.5，Python 依赖安装成功。
- 服务进程对 `data/` 有读写权限。
- HTTPS、主机防火墙和反向代理配置正确。
- `.env`、`data/`、数据库、PDF 和录音未提交到 GitHub。
- 重启后 pending PDF 能恢复处理，且备份可以实际恢复。
